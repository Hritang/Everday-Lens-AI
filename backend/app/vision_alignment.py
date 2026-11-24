import logging
import os
from threading import Lock
from time import monotonic, perf_counter

from dotenv import dotenv_values
from fastapi import HTTPException
from PIL import Image

from .alignment import analyze_frame
from .qa import _env_file, _generate
from .schemas import Alignment, HybridAlignment, VisionAssessment, VisionStatus

_log = logging.getLogger('uvicorn.error')
_directions = {
    'move_left': 'Move your phone slightly left.',
    'move_right': 'Move your phone slightly right.',
    'move_up': 'Move your phone slightly up.',
    'move_down': 'Move your phone slightly down.',
}
_task = (
    'Assess framing of one printed document in an upright, unmirrored rear-camera image. '
    'Use its center: left means move_left, right means move_right, above means move_up, below means move_down. '
    'Choose the dominant axis. If cut off, prefer move_farther. '
    'Use uncertain for ambiguous evidence or multiple equally plausible documents. '
    'Do not read or transcribe the page. Return only the requested JSON fields.'
)


def fuse_alignment(local: Alignment, ai: VisionAssessment) -> tuple[Alignment, bool]:
    # OpenCV owns clearance in all cases, including any reliable motion direction, tilt and readiness.
    if local.detected or not ai.document_detected:
        return local, False
    action = ai.recommended_action
    message = None
    if action == 'move_farther' and (ai.too_close or not ai.document_fully_visible):
        message = 'Move farther away. I cannot see the full page.' if not ai.document_fully_visible else 'Move farther away.'
    elif ai.document_fully_visible and not ai.too_close:
        if action in _directions and not ai.blurry and not ai.tilted:
            horizontal = {'left': 'move_left', 'right': 'move_right'}.get(ai.horizontal_position)
            vertical = {'above': 'move_up', 'below': 'move_down'}.get(ai.vertical_position)
            if horizontal and ai.vertical_position == 'center':
                action = horizontal
                message = _directions[action]
            elif vertical and ai.horizontal_position == 'center':
                action = vertical
                message = _directions[action]
        elif (action == 'move_closer' and ai.too_far and not ai.blurry and not ai.tilted
              and ai.horizontal_position == 'center' and ai.vertical_position == 'center'):
            message = 'Move a little closer.'
        elif action == 'hold_still' and ai.blurry:
            message = 'The image looks blurry. Hold your phone steady.'
    if message is None:
        return local, False
    return local.model_copy(update={'detected': True, 'ready': False, 'direction': action, 'message': message}), True


class VisionAlignment:
    def __init__(self):
        self._lock = Lock()
        self._next_at = 0.0
        self._deferred: VisionStatus = 'rate_limited'

    def assess(self, image: Image.Image) -> HybridAlignment:
        start = perf_counter()
        local = analyze_frame(image)
        settings = dotenv_values(_env_file, interpolate=False)
        def setting(name, default):
            return os.getenv(name) or settings.get(name) or default

        if setting('GEMINI_ALIGNMENT_ENABLED', 'true').lower() in ('0', 'false', 'off'):
            return HybridAlignment(alignment=local, vision_status='disabled')
        try:
            interval = min(15.0, max(2.0, int(setting('GEMINI_ALIGNMENT_INTERVAL_MS', '2500')) / 1000))
        except ValueError:
            interval = 2.5
        if not self._lock.acquire(blocking=False):
            return HybridAlignment(alignment=local, vision_status='busy')
        try:
            now = monotonic()
            if now < self._next_at:
                return HybridAlignment(alignment=local, vision_status=self._deferred,
                                       retry_after_ms=max(1, round((self._next_at - now) * 1000)))
            self._next_at, self._deferred = now + interval, 'rate_limited'
            vision_start = perf_counter()
            try:
                ai = _generate(image, _task, {}, VisionAssessment, 'alignment',
                               max_side=480, timeout_ms=6500, alignment_model=setting('GEMINI_ALIGNMENT_MODEL', None))
            except HTTPException as exc:
                status: VisionStatus = 'quota' if exc.status_code == 429 else (
                    'timeout' if exc.status_code == 504 else 'unavailable')
                delay = 60_000 if status == 'quota' else 10_000
                self._next_at, self._deferred = monotonic() + delay / 1000, status
                _log.info('alignment vision=%s source=opencv action=%s elapsed_ms=%d',
                          status, local.direction, (perf_counter() - start) * 1000)
                return HybridAlignment(alignment=local, vision_status=status,
                                       vision_ms=round((perf_counter() - vision_start) * 1000), retry_after_ms=delay)
            alignment, used = fuse_alignment(local, ai)
            source = 'gemini' if used else 'opencv'
            geometry = local.metrics
            ms = round((perf_counter() - vision_start) * 1000)
            _log.info('alignment vision=ok source=%s action=%s center=%s area=%s vision_ms=%d elapsed_ms=%d',
                      source, alignment.direction, (geometry.center_x, geometry.center_y) if geometry else None,
                      geometry.area_ratio if geometry else None, ms, (perf_counter() - start) * 1000)
            return HybridAlignment(alignment=alignment, source=source, vision_status='ok', vision_ms=ms, assessment=ai)
        finally:
            self._lock.release()

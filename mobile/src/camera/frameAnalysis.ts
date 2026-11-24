import type { CameraView } from 'expo-camera';
import { useEffect, useEffectEvent, useRef, type RefObject } from 'react';
import { getAlignment, getVisionAlignment, ServiceError, type Alignment } from '../api/client';
import { discardPhoto, PortraitCaptureError, takeDocumentPhoto, takePreviewSample } from './capture';
import {
  AlignmentTracker, canAnnounce, framingFailure, guidanceProgress, localFrameLifetimeMs,
  progressionMessage, translationOffset, visionHintLifetimeMs, VisionHints,
} from './alignmentGuidance';

const configuredInterval = Number(process.env.EXPO_PUBLIC_ALIGNMENT_INTERVAL_MS || 2500);
const visionInterval = Number.isFinite(configuredInterval) ? Math.max(2000, Math.min(15000, configuredInterval)) : 2500;
const diagnostics = process.env.EXPO_PUBLIC_ALIGNMENT_DEBUG === '1';

export function useFrameGuidance(
  camera: RefObject<CameraView | null>,
  enabled: boolean,
  visionEnabled: boolean,
  speechWindow: boolean,
  maySpeak: () => boolean,
  onGuidance: (message: string, isCurrent: () => boolean) => boolean,
  onPreview?: (uri: string, time: number, quiet: boolean) => Promise<void>,
) {
  const capture = useRef<Promise<string> | null>(null);
  const latest = useRef<{ result: Alignment; time: number } | null>(null);
  const tracker = useRef(new AlignmentTracker());
  const visionHints = useRef(new VisionHints());
  const geometryAt = useRef(0);
  const missingSince = useRef<number | null>(null);
  const visionInFlight = useRef(false);
  const nextVisionAt = useRef(0);
  const pendingCue = useRef<{ direction: string; message: string; time: number; fromVision?: boolean; offset?: number } | null>(null);
  const lastSpoken = useRef<{ direction: string; time: number; offset?: number }>({ direction: '', time: 0 });
  const errors = useRef(0);
  const lastFailure = useRef<string | null>(null);
  const speakPending = useEffectEvent(() => {
    const cue = pendingCue.current;
    const now = Date.now();
    if (!enabled || !cue || (cue.fromVision && !visionEnabled) || !maySpeak()) return;
    const progress = cue.direction === lastSpoken.current.direction && guidanceProgress(lastSpoken.current.offset, cue.offset);
    const lifetime = cue.fromVision ? visionHintLifetimeMs : localFrameLifetimeMs;
    if (now - cue.time >= lifetime || !canAnnounce(cue.direction, lastSpoken.current.direction, now - lastSpoken.current.time, progress)) return;

    const message = (progress && progressionMessage(cue.direction)) || cue.message;
    if (onGuidance(message, () => {
      const current = pendingCue.current;
      return !!current && current.direction === cue.direction && current.fromVision === cue.fromVision
        && Date.now() - current.time < lifetime;
    })) {
      lastSpoken.current = { direction: cue.direction, time: Date.now(), offset: cue.offset };
      if (diagnostics) console.info('Everyday Lens framing requested:', cue.direction, message);
    }
  });
  useEffect(() => {
    if (speechWindow) speakPending();
  }, [speechWindow]);

  const update = useEffectEvent((result: Alignment, time: number) => {
    const { result: effective, confirmed } = tracker.current.observe(result, time);
    latest.current = { result: effective, time };
    if (result.detected) {
      geometryAt.current = time;
      missingSince.current = null;
      visionHints.current.reset();
    } else {
      missingSince.current ??= time;
    }
    lastFailure.current = null;
    if (errors.current >= 2 && lastSpoken.current.direction.startsWith('error_')) lastSpoken.current.direction = '';
    errors.current = 0;
    if (confirmed && !effective.ready && lastSpoken.current.direction === 'ready') {
      lastSpoken.current.direction = '';
    }
    const hint = visionEnabled && !result.detected ? visionHints.current.current(Date.now()) : null;
    pendingCue.current = hint ? { ...hint.result, time: hint.time, fromVision: true }
      : confirmed ? { ...effective, time, offset: translationOffset(effective) } : null;
    speakPending();
    return result.detected;
  });
  const applyVision = useEffectEvent((result: Alignment, sampledAt: number) => {
    if (!enabled || !visionEnabled || latest.current?.result.detected) return;
    visionHints.current.observe(result, sampledAt, Date.now(), geometryAt.current, Math.max(10000, 2 * visionInterval + 2500));
    const hint = visionHints.current.current(Date.now());
    if (hint) {
      pendingCue.current = { ...hint.result, time: hint.time, fromVision: true };
      speakPending();
    } else if (pendingCue.current?.fromVision) {
      pendingCue.current = null;
    }
  });
  const streamPreview = useEffectEvent(async (uri: string, sampledAt: number, result: Alignment) => {
    await onPreview?.(uri, sampledAt, result.ready || !result.detected);
  });
  const fail = useEffectEvent((kind: Parameters<typeof framingFailure>[0]) => {
    latest.current = null;
    tracker.current.reset();
    visionHints.current.reset();
    missingSince.current = null;
    errors.current++;
    if (errors.current === 2) console.info('Everyday Lens framing retry:', kind);
    lastFailure.current = errors.current >= 2 ? framingFailure(kind) : null;
    pendingCue.current = lastFailure.current ? { direction: 'error_' + kind, time: Date.now(),
      message: lastFailure.current } : null;
    speakPending();
  });

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    let visionRequest: AbortController | undefined;
    let previewSupported = true;
    let firstPreviewPoll = 0;
    let loggedAt = Date.now();
    let frameCount = 0;
    let endToEndMs = 0;
    const startVision = (uri: string, sampledAt: number) => {
      if (!visionEnabled || visionInFlight.current || Date.now() < nextVisionAt.current) return false;
      visionInFlight.current = true;
      nextVisionAt.current = Date.now() + visionInterval;
      const request = new AbortController();
      visionRequest = request;
      void getVisionAlignment(uri, request.signal).then(response => {
        if (request.signal.aborted) return;
        if (response.vision_status === 'disabled') nextVisionAt.current = Infinity;
        else if (response.retry_after_ms) nextVisionAt.current = Math.max(nextVisionAt.current, Date.now() + response.retry_after_ms);
        if (response.source === 'gemini') applyVision(response.alignment, sampledAt);
        else clearVisionCue();
      }).catch(() => {
        if (!request.signal.aborted) {
          clearVisionCue();
          nextVisionAt.current = Date.now() + 10000;
        }
      }).finally(() => {
        visionRequest = undefined;
        visionInFlight.current = false;
        discardPhoto(uri);
      });
      return true;
    };
    const sample = async () => {
      const started = Date.now();
      let uri: string | undefined;
      let ownedByVision = false;
      try {
        if (!camera.current || capture.current) return;
        let sampledAt: number;
        if (previewSupported) {
          if (!firstPreviewPoll) firstPreviewPoll = started;
          const preview = await takePreviewSample(camera.current);
          if (!preview && started - firstPreviewPoll < 1800) return;
          if (!preview || 'unsupported' in preview) {
            previewSupported = false;
            if (diagnostics) console.info('Everyday Lens framing using still-photo fallback.');
            return;
          }
          uri = preview.uri;
          sampledAt = Date.now() - preview.ageMs;
          firstPreviewPoll = started;
        } else {
          const pending = takeDocumentPhoto(camera.current, true);
          capture.current = pending;
          try {
            uri = await pending;
          } finally {
            capture.current = null;
          }
          sampledAt = Date.now();
        }
        if (controller.signal.aborted) return;
        const result = await getAlignment(uri, controller.signal);
        if (!controller.signal.aborted) {
          const elapsed = Date.now() - sampledAt;
          if (diagnostics) {
            frameCount++;
            endToEndMs += elapsed;
            const window = Date.now() - loggedAt;
            if (window >= 5000) {
              console.info('Everyday Lens framing performance:', previewSupported ? 'preview' : 'still',
                result.frame_width, result.frame_height, 'fps', (frameCount * 1000 / window).toFixed(2),
                'mean frame age ms', Math.round(endToEndMs / frameCount));
              loggedAt = Date.now();
              frameCount = endToEndMs = 0;
            }
          }
          if (elapsed >= localFrameLifetimeMs) fail('timeout');
          else {
            if (update(result, sampledAt)) visionRequest?.abort();
            else if (missingSince.current !== null && sampledAt - missingSince.current >= 750) {
              ownedByVision = startVision(uri, sampledAt);
            }
            await streamPreview(uri, sampledAt, result);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          fail(error instanceof PortraitCaptureError ? 'portrait'
            : error instanceof ServiceError ? error.kind
            : uri ? 'server' : 'camera');
        }
      } finally {
        if (uri && !ownedByVision) discardPhoto(uri);
        if (!controller.signal.aborted) {
          const delay = previewSupported ? Math.max(30, 255 - (Date.now() - started)) : 450;
          timer = setTimeout(() => void sample(), errors.current >= 2 ? Math.max(700, delay) : delay);
        }
      }
    };
    timer = setTimeout(() => void sample(), 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
      visionRequest?.abort();
      pendingCue.current = null;
    };
  }, [camera, enabled, visionEnabled]);

  function clearVisionCue() {
    visionHints.current.reset();
    if (pendingCue.current?.fromVision) pendingCue.current = null;
  }

  return {
    waitForCamera: async () => { await capture.current?.catch(() => {}); },
    current: () => {
      const now = Date.now();
      if (!latest.current || now - latest.current.time >= localFrameLifetimeMs) return null;
      return (visionEnabled && !latest.current.result.detected ? visionHints.current.current(now)?.result : undefined)
        ?? latest.current.result;
    },
    failure: () => lastFailure.current,
    clearVision: () => {
      clearVisionCue();
      nextVisionAt.current = 0;
    },
    reset: () => {
      latest.current = null;
      tracker.current.reset();
      visionHints.current.reset();
      geometryAt.current = 0;
      missingSince.current = null;
      nextVisionAt.current = 0;
      pendingCue.current = null;
      lastSpoken.current = { direction: '', time: 0 };
      errors.current = 0;
      lastFailure.current = null;
    },
  };
}

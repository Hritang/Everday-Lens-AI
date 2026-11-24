from dataclasses import dataclass
from math import sqrt

import cv2
import numpy as np
from PIL import Image

from .schemas import Alignment, FrameMetrics, Quality


@dataclass
class Boundary:
    corners: np.ndarray
    score: float


def _order_corners(quad: np.ndarray) -> np.ndarray:
    points = quad.reshape(4, 2)
    center = points.mean(axis=0)
    points = points[np.argsort(np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0]))]
    return np.roll(points, -int(np.argmin(points.sum(axis=1))), axis=0)


def _edge_clearance(points: np.ndarray, width: int, height: int) -> float:
    return float(min(points[:, 0].min() / width, points[:, 1].min() / height,
                     (width - 1 - points[:, 0].max()) / width, (height - 1 - points[:, 1].max()) / height))


def _boundary_evidence(gray: np.ndarray, points: np.ndarray) -> tuple[int, float]:
    height, width = gray.shape
    center = points.mean(axis=0)
    gap = max(3, min(width, height) * 0.011)
    contrasts = []
    for start, end in zip(points, np.roll(points, -1, axis=0)):
        edge = end - start
        length = np.linalg.norm(edge)
        if length < 13:
            continue
        normal = np.array([-edge[1], edge[0]]) / length
        if np.dot(center - (start + end) / 2, normal) < 0:
            normal = -normal
        middle = start + np.linspace(0.14, 0.86, 18)[:, None] * edge
        inside = np.rint(middle + gap * normal).astype(int)
        outside = np.rint(middle - gap * normal).astype(int)
        valid = ((inside >= 0) & (inside < (width, height)) &
                 (outside >= 0) & (outside < (width, height))).all(axis=1)
        if valid.sum() < 8:
            continue
        ix, iy = inside[valid].T
        ox, oy = outside[valid].T
        contrasts.append(float(np.median(gray[iy, ix].astype(float) - gray[oy, ox])))

    if not contrasts:
        return 0, 0.0
    polarity = 1 if max(contrasts) >= -min(contrasts) else -1
    contrast = [polarity * value for value in contrasts if polarity * value >= 11]
    return len(contrast), float(np.median(contrast)) if contrast else 0.0


def _document_boundary(gray: np.ndarray) -> Boundary | None:
    height, width = gray.shape
    frame_area = width * height
    smoothed = cv2.GaussianBlur(gray, (5, 5), 0)
    kernel = np.ones((5, 5), np.uint8)
    _, bright = cv2.threshold(smoothed, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    masks = [bright, cv2.bitwise_not(bright)]
    for low, high in ((25, 75), (60, 160)):
        masks.append(cv2.morphologyEx(cv2.Canny(smoothed, low, high), cv2.MORPH_CLOSE, kernel))

    candidates = []
    seen = set()
    for mask in masks:
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:24]:
            area = cv2.contourArea(contour)
            if not 0.018 * frame_area < area < 0.97 * frame_area:
                continue
            perimeter = cv2.arcLength(contour, True)
            quad = cv2.approxPolyDP(contour, 0.021 * perimeter, True)
            if len(quad) != 4 or not cv2.isContourConvex(quad):
                quad = cv2.approxPolyDP(contour, 0.034 * perimeter, True)
            if len(quad) != 4 or not cv2.isContourConvex(quad):
                continue
            corners = _order_corners(quad)
            key = tuple((corners // 3).flat)
            if key in seen:
                continue
            seen.add(key)
            rotated = cv2.minAreaRect(quad)
            short, long = sorted(rotated[1])
            box_area = short * long
            if short < 14 or long / short > 7 or area < 0.65 * box_area:
                continue
            clipped = _edge_clearance(corners, width, height) < 0.018
            supported, contrast = _boundary_evidence(smoothed, corners)
            # A small shape at a frame edge is often a background corner. Require
            # visible page evidence before asking the user to change their distance.
            if clipped and area < 0.035 * frame_area:
                continue
            if supported < (2 if clipped and area > 0.065 * frame_area and contrast >= 17 else 3):
                continue
            # Score local edge support before size. A larger table or background often has weaker edges.
            score = (supported * 0.14 + min(contrast, 110) / 110 * 0.31
                     + min(area / box_area, 1) * 0.09 + sqrt(area / frame_area) * 0.04)
            candidates.append(Boundary(corners, score))
    if not candidates:
        return None
    best = max(candidates, key=lambda candidate: candidate.score)
    for candidate in candidates:
        if candidate is best or best.score - candidate.score > 0.035:
            continue
        overlap, _ = cv2.intersectConvexConvex(best.corners, candidate.corners)
        if overlap < 0.1 * min(cv2.contourArea(best.corners), cv2.contourArea(candidate.corners)):
            return None
    return best


def analyze_frame(image: Image.Image) -> Alignment:
    frame = {'frame_width': image.width, 'frame_height': image.height}
    sample = image.copy()
    sample.thumbnail((640, 640))
    gray = np.asarray(sample.convert('L'))
    height, width = gray.shape
    boundary = _document_boundary(gray)
    if boundary is None:
        return Alignment(
            detected=False, ready=False, direction='find_document', quality=Quality(), **frame,
            message='I cannot determine the document position. Move your phone slowly or say capture anyway.',
        )

    points = boundary.corners
    contour = points.reshape(4, 1, 2)
    moments = cv2.moments(contour)
    cx = moments['m10'] / moments['m00'] / width
    cy = moments['m01'] / moments['m00'] / height
    dx, dy = cx - 0.5, cy - 0.5
    mask = np.zeros_like(gray)
    cv2.fillConvexPoly(mask, contour, 255)
    interior = cv2.erode(mask, np.ones((9, 9), np.uint8)).astype(bool)
    focus = cv2.Laplacian(gray, cv2.CV_64F)[interior]
    sharpness = float(focus.var()) if focus.size else 0.0
    angle = (cv2.minAreaRect(contour)[2] + 45) % 90 - 45
    area = cv2.contourArea(contour) / (width * height)
    _, _, box_width, box_height = cv2.boundingRect(contour)
    metrics = FrameMetrics(
        center_x=round(cx, 4), center_y=round(cy, 4), area_ratio=round(area, 4),
        tilt_degrees=round(angle, 2), sharpness=round(sharpness, 2),
        corners=[(round(x / width, 4), round(y / height, 4)) for x, y in points],
        boundary_score=round(boundary.score, 3),
    )
    quality = Quality(
        clipped=_edge_clearance(points, width, height) < 0.018,
        blurred=sharpness < 24,
        too_small=area < 0.075 or (area < 0.13 and max(box_width / width, box_height / height) < 0.48),
        tilted=abs(angle) > 10,
        too_close=area > 0.74,
    )

    # Portrait rear-camera pixels are unmirrored. Moving the phone toward the page reduces this offset.
    if quality.clipped or quality.too_close:
        direction = 'move_farther'
        message = 'Move farther away. Part of the page is cut off.' if quality.clipped else 'Move farther away.'
    elif quality.blurred:
        direction, message = 'hold_still', 'Image is blurry. Hold still.'
    elif max(abs(dx), abs(dy)) > 0.075:
        axis = ('right' if dx > 0 else 'left') if abs(dx) >= abs(dy) else ('down' if dy > 0 else 'up')
        direction, message = f'move_{axis}', f'Move {"slightly " if max(abs(dx), abs(dy)) < 0.15 else ""}{axis}.'
    elif quality.too_small:
        direction, message = 'move_closer', 'Move closer.'
    elif quality.tilted:
        rotation = 'clockwise' if angle > 0 else 'counterclockwise'
        direction, message = f'rotate_{rotation}', f'Rotate your phone slightly {rotation}.'
    else:
        direction, message = 'ready', 'The frame is clear.'

    return Alignment(
        detected=True, ready=direction == 'ready', direction=direction, message=message,
        quality=quality, metrics=metrics, **frame,
    )

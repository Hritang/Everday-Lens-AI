import type { Alignment } from '../api/client';

export const localFrameLifetimeMs = 1000;
export const visionHintLifetimeMs = 7200;
const directions = { move_left: 'left', move_right: 'right', move_up: 'up', move_down: 'down' } as const;
type Translation = keyof typeof directions;

function isTranslation(direction: string): direction is Translation {
  return Object.hasOwn(directions, direction);
}

export function translationOffset(frame: Alignment) {
  if (!frame.metrics || !isTranslation(frame.direction)) return undefined;
  return Math.abs((frame.direction === 'move_left' || frame.direction === 'move_right'
    ? frame.metrics.center_x : frame.metrics.center_y) - 0.5);
}

export function guidanceProgress(previous: number | undefined, current: number | undefined) {
  return previous !== undefined && current !== undefined && previous - current >= 0.045;
}

export function progressionMessage(direction: string) {
  return isTranslation(direction) ? `A little more ${directions[direction]}.` : undefined;
}

export class VisionHints {
  private observation: { direction: string; time: number; count: number } | null = null;
  private hint: { result: Alignment; time: number } | null = null;

  observe(result: Alignment, sampledAt: number, now: number, geometryAt: number, maxGap: number) {
    if (now - sampledAt >= visionHintLifetimeMs || geometryAt >= sampledAt || !result.detected || result.ready || result.metrics) {
      this.reset();
      return;
    }
    const previous = this.observation;
    const count = previous?.direction === result.direction && sampledAt > previous.time
      && sampledAt - previous.time <= maxGap ? previous.count + 1 : 1;
    this.observation = { direction: result.direction, time: sampledAt, count };
    this.hint = count >= 2 ? { result, time: sampledAt } : null;
  }

  current(now: number) {
    return this.hint && now - this.hint.time < visionHintLifetimeMs ? this.hint : null;
  }

  reset() {
    this.observation = null;
    this.hint = null;
  }
}

export function framesAgree(first: Alignment, second: Alignment) {
  const a = first.metrics;
  const b = second.metrics;
  return !!(first.ready && second.ready && a?.corners?.length === 4 && b?.corners?.length === 4
    && Math.hypot(a.center_x - b.center_x, a.center_y - b.center_y) <= 0.028
    && Math.abs(a.area_ratio - b.area_ratio) <= 0.03
    && Math.abs(a.tilt_degrees - b.tilt_degrees) <= 5
    && a.corners.every(([x, y], index) => Math.hypot(x - b.corners[index][0], y - b.corners[index][1]) <= 0.045));
}

export class AlignmentTracker {
  private anchor: Alignment | null = null;
  private lastTime = 0;
  private stableFrames = 0;
  private stableSince = 0;
  private direction = '';
  private observations = 0;
  private observedSince = 0;
  private translation?: Translation;

  observe(frame: Alignment, time: number) {
    if (time <= this.lastTime) return { result: frame, confirmed: false };
    if (time - this.lastTime > localFrameLifetimeMs) this.reset();
    this.lastTime = time;
    if (frame.metrics && (frame.ready || isTranslation(frame.direction))) {
      const dx = frame.metrics.center_x - 0.5;
      const dy = frame.metrics.center_y - 0.5;
      const x = Math.abs(dx);
      const y = Math.abs(dy);
      const previous = this.translation;
      const previousOffset = previous === (dx < 0 ? 'move_left' : 'move_right') ? x
        : previous === (dy < 0 ? 'move_up' : 'move_down') ? y : 0;
      if (previous && previousOffset > 0.055 && Math.max(x, y) - previousOffset < 0.035) {
        frame = { ...frame, ready: false, direction: previous,
          message: `Move ${previousOffset < 0.15 ? 'slightly ' : ''}${directions[previous]}.` };
      }
      this.translation = isTranslation(frame.direction) ? frame.direction : undefined;
    } else {
      this.translation = undefined;
    }
    if (!frame.ready || frame.metrics?.corners?.length !== 4) {
      this.anchor = null;
      this.stableFrames = 0;
    } else if (this.anchor && framesAgree(this.anchor, frame)) {
      this.stableFrames++;
    } else {
      this.anchor = frame;
      this.stableFrames = 1;
      this.stableSince = time;
    }

    const stable = this.stableFrames >= 3 && time - this.stableSince >= 550;
    const effective = frame.ready
      ? { ...frame, ready: stable, direction: stable ? 'ready' : 'stabilize',
        message: stable ? 'Alignment fixed. Document ready. Say capture.' : 'Centered. Hold still.' }
      : frame;
    if (effective.direction !== this.direction) {
      this.observedSince = time;
      this.observations = 0;
    }
    this.observations++;
    this.direction = effective.direction;
    const confirmed = effective.direction === 'find_document'
      ? this.observations >= 3 && time - this.observedSince >= 1000
      : this.observations >= 2;
    return { result: effective, confirmed: stable || confirmed };
  }

  reset() {
    this.anchor = null;
    this.lastTime = 0;
    this.stableFrames = 0;
    this.stableSince = 0;
    this.direction = '';
    this.observations = 0;
    this.observedSince = 0;
    this.translation = undefined;
  }
}

export function canAnnounce(direction: string, lastDirection: string, elapsedMs: number, progress = false) {
  if (direction !== lastDirection || progress) return elapsedMs >= 1250;
  return direction !== 'ready' && elapsedMs >= 10000;
}

export function framingFailure(kind: 'portrait' | 'camera' | 'server' | 'connection' | 'timeout' | 'image') {
  switch (kind) {
    case 'portrait': return 'The camera returned a sideways frame. Hold your phone upright while I retry.';
    case 'camera': return 'I could not read a camera sample. Point at the document while I retry.';
    case 'connection': return 'I could not reach the framing service. Check the connection. You can say capture anyway.';
    case 'timeout': return 'The framing service is slow. Hold the phone steady while I retry.';
    case 'image': return 'The framing service could not read the sample. Hold the phone steady while I retry.';
    case 'server': return 'The framing service could not process the sample. I will retry. You can say capture anyway.';
  }
}

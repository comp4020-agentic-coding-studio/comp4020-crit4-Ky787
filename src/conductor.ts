// Conductor input: turn a baton-like pointer gesture into a tempo multiplier,
// a dynamic level and an accent.
//
// The multiplier SCALES the MIDI's own tempo map rather than replacing it, so
// the recorded rubato survives: at 1.2x a passage that reads 110 -> 105 -> 98
// still reads 132 -> 126 -> 118. That is the whole point of the mode, and it is
// why the numbers below are a multiplier and never an absolute BPM.

export const MIN_MULTIPLIER = 0.4;
export const MAX_MULTIPLIER = 2.0;

/** Intervals outside this band are gesture noise, not beats. */
export const MIN_BEAT_INTERVAL = 0.16; // 375 BPM
export const MAX_BEAT_INTERVAL = 3.0; // 20 BPM

/** How hard each new beat pulls the multiplier. Low = steady, high = twitchy. */
export const TEMPO_SMOOTHING = 0.3;
/** How hard each beat pulls the dynamic level. */
export const DYNAMIC_SMOOTHING = 0.35;

/** No beat for this long and the multiplier eases back to 1.0. */
export const IDLE_RELEASE_SECONDS = 3.0;
/** Per-second share of the remaining distance covered while easing back. */
export const RELEASE_RATE = 0.8;

export function clampMultiplier(value: number): number {
  return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, value));
}

export function tempoFromInterval(seconds: number): number {
  return 60 / seconds;
}

/**
 * One-pole smoothing. `factor` is the share of the gap closed in one step.
 */
export function smoothToward(current: number, target: number, factor: number): number {
  return current + (target - current) * factor;
}

/**
 * Frame-rate independent easing: `rate` is the share of the gap closed per
 * second, so the result does not change when the frame budget does.
 */
export function easeToward(
  current: number,
  target: number,
  ratePerSecond: number,
  dt: number,
): number {
  return target + (current - target) * Math.exp(-ratePerSecond * dt);
}

/**
 * The multiplier, straight from the brief's formula and nothing else.
 *
 * An earlier version tried to be clever here: conductors often beat one to the
 * bar in an Allegro, so it snapped the player's rate onto the nearest
 * power-of-two subdivision before dividing. Two problems showed up as soon as
 * there were tests for it. Beating 1.4x the score's tempo was read as half-time
 * and the music slowed to 0.7x — the opposite of the gesture. And every
 * threshold that fixed that case just moved the discontinuity somewhere else
 * inside the range a hand can reach, so pushing the tempo up would, at one
 * particular speed, halve it. A conductor's arm is a continuous control and it
 * has to behave like one. Beating half-time now simply plays at half speed,
 * which is monotone, learnable, and what the hand asked for.
 */
export function multiplierFor(userTempo: number, referenceTempo: number): number {
  if (!(referenceTempo > 0)) return 1;
  return clampMultiplier(userTempo / referenceTempo);
}

/** Vertical travel between beats, as a share of the surface height. */
export function dynamicFromGesture(travelFraction: number): number {
  // A small flick is a hush; a full arm is a forte. Below 1.0 more than above,
  // because clipping a loud passage is worse than losing a little air.
  const t = Math.min(1, Math.max(0, (travelFraction - 0.04) / 0.36));
  return 0.55 + t * 0.8; // 0.55 .. 1.35
}

/** Downward pointer speed at the beat line, in surface heights per second. */
export function accentFromSpeed(speedFraction: number): number {
  const t = Math.min(1, Math.max(0, (speedFraction - 1.2) / 3.5));
  return t * 0.28; // 0 .. +28% for one beat
}

export interface ConductedBeat {
  /** Seconds since the previous beat, or undefined for the first. */
  interval?: number;
  /** Vertical travel since the previous beat, as a share of surface height. */
  travel: number;
  /** Downward speed at the crossing, in surface heights per second. */
  speed: number;
}

export interface ConductorState {
  multiplier: number;
  dynamic: number;
  /** Decays to zero over the beat that follows it. */
  accent: number;
  beats: number;
  lastBeatAt?: number;
}

export function initialConductorState(): ConductorState {
  return { multiplier: 1, dynamic: 1, accent: 0, beats: 0 };
}

/**
 * Fold one conducted beat into the running state. Pure, so the smoothing can
 * be reasoned about (and tested) without a pointer or an audio context.
 *
 * @param referenceTempo the music's own local tempo here, in BPM — a windowed
 *   average, never the instantaneous tempo-map value, which on a performance
 *   map swings between 5 and 480 BPM from one tick to the next.
 */
export function applyBeat(
  state: ConductorState,
  beat: ConductedBeat,
  referenceTempo: number,
  now: number,
): ConductorState {
  const next: ConductorState = { ...state, beats: state.beats + 1, lastBeatAt: now };
  next.accent = accentFromSpeed(beat.speed);

  if (beat.interval === undefined) return next;
  if (beat.interval < MIN_BEAT_INTERVAL || beat.interval > MAX_BEAT_INTERVAL) {
    // Out-of-band gap: keep the beat (it restarts the clock) but do not let a
    // stumble or a long pause yank the tempo.
    return { ...next, beats: 1 };
  }

  const userTempo = tempoFromInterval(beat.interval);
  const target = multiplierFor(userTempo, referenceTempo);
  // The first usable beat lands harder, so the music answers the player
  // straight away instead of creeping towards them over five beats.
  const factor = state.beats <= 1 ? 0.7 : TEMPO_SMOOTHING;
  next.multiplier = clampMultiplier(smoothToward(state.multiplier, target, factor));
  next.dynamic = smoothToward(state.dynamic, dynamicFromGesture(beat.travel), DYNAMIC_SMOOTHING);
  return next;
}

/**
 * Advance the state when no beat has arrived. Once the player stops, tempo and
 * dynamics ease back to the score's own reading rather than freezing wherever
 * the last gesture left them.
 */
export function relax(state: ConductorState, now: number, dt: number): ConductorState {
  const accent = state.accent > 0.001 ? easeToward(state.accent, 0, 6, dt) : 0;
  const idle = state.lastBeatAt === undefined ? Infinity : now - state.lastBeatAt;
  if (idle < IDLE_RELEASE_SECONDS) return { ...state, accent };
  return {
    ...state,
    accent,
    multiplier: easeToward(state.multiplier, 1, RELEASE_RATE, dt),
    dynamic: easeToward(state.dynamic, 1, RELEASE_RATE, dt),
    beats: 0,
  };
}

// --- pointer driver -------------------------------------------------------

export interface BatonSample {
  /** 0 at the left edge, 1 at the right. */
  x: number;
  /** 0 at the top, 1 at the bottom. */
  y: number;
  /** Seconds, from a monotonic clock. */
  t: number;
}

/**
 * Watches a stream of pointer samples over the conducting surface and reports
 * a beat each time the baton crosses the beat line on its way down.
 */
export class BatonTracker {
  private previous?: BatonSample;
  private lastBeatAt?: number;
  private minY = Infinity;
  private maxY = -Infinity;
  /** The most recent samples, for drawing the trail. */
  readonly trail: BatonSample[] = [];

  constructor(
    /** Height of the beat line, 0 (top) to 1 (bottom). */
    readonly beatLine: number,
    private readonly trailLength = 24,
  ) {}

  reset(): void {
    this.previous = undefined;
    this.lastBeatAt = undefined;
    this.minY = Infinity;
    this.maxY = -Infinity;
    this.trail.length = 0;
  }

  /** Feed a sample; returns a beat if this sample crossed the line downward. */
  push(sample: BatonSample): ConductedBeat | undefined {
    this.trail.push(sample);
    if (this.trail.length > this.trailLength) this.trail.shift();
    this.minY = Math.min(this.minY, sample.y);
    this.maxY = Math.max(this.maxY, sample.y);

    const previous = this.previous;
    this.previous = sample;
    if (!previous) return undefined;

    const dt = sample.t - previous.t;
    if (dt <= 0) return undefined;
    const crossedDown = previous.y < this.beatLine && sample.y >= this.beatLine;
    if (!crossedDown) return undefined;

    const travel = this.maxY > this.minY ? this.maxY - this.minY : 0;
    const speed = (sample.y - previous.y) / dt;
    const interval = this.lastBeatAt === undefined ? undefined : sample.t - this.lastBeatAt;
    this.lastBeatAt = sample.t;
    this.minY = sample.y;
    this.maxY = sample.y;
    return { interval, travel, speed };
  }
}

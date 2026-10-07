/**
 * Clip speed. A sped-up clip plays its source range `speed` times faster,
 * so it lasts ceil(source length / speed) in the output. Speeds are whole
 * numbers: output time maps to source time exactly, so splits, trims and
 * cuts inside a sped-up clip stay exact, and export keeps every Nth frame.
 */

export const clipSpeeds = Object.freeze([2, 3, 4, 8] as const);
export type ClipSpeed = 1 | (typeof clipSpeeds)[number];

/** Anything with a source range and an optional speed. */
interface SpeedClip {
  source_start_us: number;
  source_end_us: number;
  timeline_start_us: number;
  speed?: number;
}

export function isClipSpeed(value: unknown): value is ClipSpeed {
  return value === 1 || clipSpeeds.includes(value as never);
}

export function clipSpeed(clip: { speed?: number }): number {
  return clip.speed ?? 1;
}

/** Output length of a source length played at `speed`. */
export function speedLength(sourceLengthUs: number, speed: number): number {
  return Math.ceil(sourceLengthUs / speed);
}

/** Source time shown at output time `us` of the clip (exact). */
export function sourceAt(clip: SpeedClip, us: number): number {
  return clip.source_start_us + (us - clip.timeline_start_us) * clipSpeed(clip);
}

/** Output time at which source time `us` of the clip plays. */
export function timelineAt(clip: SpeedClip, us: number): number {
  return (
    clip.timeline_start_us +
    Math.round((us - clip.source_start_us) / clipSpeed(clip))
  );
}

/**
 * The FFmpeg `atempo` chain for a speed (each stage at most 2×), which
 * changes tempo while keeping pitch.
 */
export function atempoChain(speed: number): string {
  const stages: string[] = [];
  let rest = speed;
  while (rest > 2 + 1e-9) {
    stages.push("atempo=2");
    rest /= 2;
  }
  if (Math.abs(rest - 1) > 1e-9) stages.push(`atempo=${rest}`);
  return stages.join(",");
}

/** `sourceAt` for camel-case clip views. */
export function viewSourceAt(
  clip: { timelineStartUs: number; sourceStartUs: number; speed?: number },
  us: number,
): number {
  return clip.sourceStartUs + (us - clip.timelineStartUs) * clipSpeed(clip);
}

/** `timelineAt` for camel-case clip views. */
export function viewTimelineAt(
  clip: { timelineStartUs: number; sourceStartUs: number; speed?: number },
  us: number,
): number {
  return (
    clip.timelineStartUs +
    Math.round((us - clip.sourceStartUs) / clipSpeed(clip))
  );
}

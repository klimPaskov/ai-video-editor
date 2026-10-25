/**
 * Loudness over time of a recording's audio, in short frames. The tightening
 * pass uses it to put each cut where the audio is quietest (so a cut never
 * lands on a breath or the tail of a word) and to refuse to cut where there
 * is speech the transcript missed.
 */

export interface EnergyTrack {
  /** Length of one frame, in microseconds. */
  frameUs: number;
  /** Linear RMS of each frame, 0 to 1. */
  rms: ArrayLike<number>;
}

function clampIndex(track: EnergyTrack, index: number): number {
  return Math.min(track.rms.length, Math.max(0, index));
}

/** Mean RMS over [startUs, endUs). Zero for an empty or out-of-range span. */
export function meanEnergy(
  track: EnergyTrack,
  startUs: number,
  endUs: number,
): number {
  const from = clampIndex(track, Math.floor(startUs / track.frameUs));
  const to = clampIndex(track, Math.ceil(endUs / track.frameUs));
  if (to <= from) return 0;
  let total = 0;
  for (let index = from; index < to; index++) total += track.rms[index]!;
  return total / (to - from);
}

/**
 * The start of the quietest window of `lengthUs` that fits in [fromUs, toUs].
 * Windows are compared by mean energy; equally quiet windows resolve to the
 * one nearest the middle, so a silent gap is cut symmetrically.
 */
export function quietestWindowStart(
  track: EnergyTrack,
  fromUs: number,
  toUs: number,
  lengthUs: number,
): number {
  const slack = toUs - fromUs - lengthUs;
  if (slack <= 0) return fromUs;
  const stepUs = track.frameUs;
  const centre = fromUs + slack / 2;
  let best = fromUs;
  let bestEnergy = Infinity;
  let bestDistance = Infinity;
  for (let start = fromUs; start <= fromUs + slack; start += stepUs) {
    const energy = meanEnergy(track, start, start + lengthUs);
    const distance = Math.abs(start - centre);
    // A small tolerance keeps equal-looking windows from jittering.
    if (
      energy < bestEnergy - 1e-6 ||
      (Math.abs(energy - bestEnergy) <= 1e-6 && distance < bestDistance)
    ) {
      best = start;
      bestEnergy = energy;
      bestDistance = distance;
    }
  }
  return Math.round(best);
}

/**
 * Stretches of [fromUs, toUs) where the audio stays above `ratio` of the
 * speech level for at least `minimumUs`. Used to find sounds the transcript
 * does not hold (a drawn-out "um", a breath, a laugh).
 */
export function loudRuns(
  track: EnergyTrack,
  fromUs: number,
  toUs: number,
  level: number,
  minimumUs: number,
  ratio = 0.25,
): { startUs: number; endUs: number }[] {
  const runs: { startUs: number; endUs: number }[] = [];
  if (level <= 0) return runs;
  let start: number | null = null;
  const first = Math.max(0, Math.floor(fromUs / track.frameUs));
  const last = Math.min(track.rms.length, Math.ceil(toUs / track.frameUs));
  for (let index = first; index <= last; index++) {
    const loud = index < last && track.rms[index]! > level * ratio;
    if (loud && start === null) start = index;
    if (!loud && start !== null) {
      const startUs = start * track.frameUs;
      const endUs = index * track.frameUs;
      if (endUs - startUs >= minimumUs) runs.push({ startUs, endUs });
      start = null;
    }
  }
  return runs;
}

/**
 * How loud this recording's speech is: the 80th percentile of frame energy
 * among frames above the noise floor. Zero for a silent track.
 */
export function speechLevel(track: EnergyTrack): number {
  const frames = Array.from(track.rms).filter((value) => value > 0.003);
  if (frames.length === 0) return 0;
  frames.sort((a, b) => a - b);
  return frames[Math.min(frames.length - 1, Math.floor(frames.length * 0.8))]!;
}

/**
 * True when [startUs, endUs) is clearly not speech: its mean energy is well
 * under the recording's speech level. Used to refuse a cut that the
 * transcript calls empty but the audio says is not.
 */
export function isQuietSpan(
  track: EnergyTrack,
  startUs: number,
  endUs: number,
  level = speechLevel(track),
  ratio = 0.35,
): boolean {
  if (level === 0) return true;
  return meanEnergy(track, startUs, endUs) <= level * ratio;
}

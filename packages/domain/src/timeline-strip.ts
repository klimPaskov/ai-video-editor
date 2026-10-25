/**
 * Geometry of the timeline strip's filmstrip and time ruler, kept free of
 * the page so it can be tested: which output times the picture cells show,
 * and where the ruler puts its labelled ticks.
 */
import { maxStripFrames } from "./project-view.ts";

/** Width of one picture cell of the filmstrip, in pixels. */
export const stripCellWidthPx = 88;

/**
 * Output times at the centres of equal cells across the strip: increasing,
 * inside [0, durationUs), at most `maxStripFrames`. A strip too narrow for
 * one cell, or an empty edit, has none.
 */
export function stripCellTimes(
  durationUs: number,
  widthPx: number,
  cellPx = stripCellWidthPx,
): number[] {
  if (!(durationUs > 0) || !(widthPx > 0)) return [];
  const count = Math.min(
    maxStripFrames,
    Math.max(1, Math.round(widthPx / cellPx)),
  );
  const times: number[] = [];
  for (let index = 0; index < count; index++) {
    const time = Math.min(
      durationUs - 1,
      Math.floor(((index + 0.5) * durationUs) / count),
    );
    if (times.length === 0 || time > times.at(-1)!) times.push(time);
  }
  return times;
}

export interface RulerTick {
  us: number;
  label: string;
}

const steps = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200,
] as const;

/** m:ss, or h:mm:ss from an hour. */
export function rulerLabel(us: number): string {
  const total = Math.round(us / 1_000_000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Ticks at whole-second steps, the finest step whose labels are at least
 * `minGapPx` apart. The first tick is at zero; none lies past the end.
 */
export function rulerTicks(
  durationUs: number,
  widthPx: number,
  minGapPx = 72,
): RulerTick[] {
  if (!(durationUs > 0) || !(widthPx > 0)) return [];
  const seconds = durationUs / 1_000_000;
  const step =
    steps.find((candidate) => (candidate / seconds) * widthPx >= minGapPx) ??
    steps.at(-1)!;
  const ticks: RulerTick[] = [];
  for (let at = 0; at <= seconds + 1e-9; at += step)
    ticks.push({
      us: Math.round(at * 1_000_000),
      label: rulerLabel(at * 1_000_000),
    });
  return ticks;
}

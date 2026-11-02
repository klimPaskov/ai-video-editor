/**
 * A proposal for how a talk with a screen recording and a camera could be
 * laid out: the camera fills the picture while the speaker introduces,
 * explains and concludes; it sits in a corner, out of the way of what is
 * happening, while something is shown on screen; and it steps aside when
 * there is nowhere clear to put it. The plan only proposes. Claude (or the
 * user) decides what to apply.
 *
 * Evidence: where and when the screen changes (`screen-activity`), where the
 * sentences of the speech begin (changes happen at the start of a sentence)
 * and the span of the speech.
 */
import {
  layoutLimits,
  pipRect,
  defaultLayoutState,
  type LayoutCorner,
  type LayoutGeometry,
  type LayoutKind,
  type LayoutShape,
} from "./layouts.ts";

export interface PlanActivity {
  startUs: number;
  endUs: number;
  /** The rectangle that changes, as fractions of the picture. */
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

export interface PlanInput {
  durationUs: number;
  activity: readonly PlanActivity[];
  /** Where each sentence of the speech begins, in edit time, sorted. */
  sentenceStarts: readonly number[];
  /** The first and last spoken moment of the edit; null without speech. */
  speech: { startUs: number; endUs: number } | null;
  geometry: LayoutGeometry;
}

export interface PlanOptions {
  /** The camera fills the picture for this long at the start. */
  introUs?: number;
  /** ... and at the end. */
  outroUs?: number;
  /** No arrangement is held shorter than this. */
  minHoldUs?: number;
  /** A speaking stretch at least this long gets the camera full. */
  talkUs?: number;
  /** Largest share of a corner camera that may cover something that changes. */
  maxOverlap?: number;
}

export interface PlannedLayout {
  atUs: number;
  kind: LayoutKind;
  corner?: LayoutCorner;
  size?: number;
  shape?: LayoutShape;
  /** Why, in a few plain words. */
  reason: string;
}

const defaults = {
  introUs: 10_000_000,
  outroUs: 8_000_000,
  minHoldUs: 6_000_000,
  talkUs: 8_000_000,
  maxOverlap: 0.3,
};

const secondUs = 1_000_000;
const cornerOrder: readonly LayoutCorner[] = [
  "bottom_right",
  "bottom_left",
  "top_right",
  "top_left",
];

type Mode = "demo" | "talk";

/** The share of a corner camera's area that lies over changing parts. */
function overlap(
  corner: LayoutCorner,
  activity: readonly PlanActivity[],
  geometry: LayoutGeometry,
): number {
  const rect = pipRect(
    { ...defaultLayoutState, kind: "pip", corner, shape: "rounded" },
    geometry,
  );
  const area = rect.width * rect.height;
  if (area <= 0) return 0;
  let covered = 0;
  for (const item of activity) {
    const width =
      Math.min(rect.x + rect.width, item.x + item.width) -
      Math.max(rect.x, item.x);
    const height =
      Math.min(rect.y + rect.height, item.y + item.height) -
      Math.max(rect.y, item.y);
    if (width > 0 && height > 0) covered += width * height;
  }
  return Math.min(1, covered / area);
}

export function planLayouts(
  input: PlanInput,
  options: PlanOptions = {},
): PlannedLayout[] {
  const config = { ...defaults, ...options };
  const seconds = Math.ceil(input.durationUs / secondUs);
  if (!input.speech || seconds < 4) return [];
  // Which seconds have something changing on screen.
  const active = new Array<boolean>(seconds).fill(false);
  for (const item of input.activity)
    for (
      let second = Math.floor(item.startUs / secondUs);
      second <= Math.floor((item.endUs - 1) / secondUs);
      second++
    )
      if (second >= 0 && second < seconds) active[second] = true;
  // Smooth: a second counts as demonstration when most of its neighbourhood
  // is active, so a pause between two clicks does not flip the picture.
  const smooth = active.map((_, second) => {
    let hits = 0;
    let total = 0;
    for (
      let near = Math.max(0, second - 3);
      near <= Math.min(seconds - 1, second + 3);
      near++
    ) {
      total++;
      if (active[near]) hits++;
    }
    return hits / total >= 0.4;
  });
  // Runs of the same mode.
  const runs: { mode: Mode; from: number; to: number }[] = [];
  for (let second = 0; second < seconds; second++) {
    const mode: Mode = smooth[second] ? "demo" : "talk";
    const last = runs.at(-1);
    if (last && last.mode === mode) last.to = second + 1;
    else runs.push({ mode, from: second, to: second + 1 });
  }
  // A run shorter than the minimum hold joins its neighbour.
  const minSeconds = Math.ceil(config.minHoldUs / secondUs);
  for (let guard = 0; guard < 100; guard++) {
    const short = runs.findIndex(
      (run) => run.to - run.from < minSeconds && runs.length > 1,
    );
    if (short < 0) break;
    const neighbour = short > 0 ? short - 1 : short + 1;
    const run = runs[short]!;
    const other = runs[neighbour]!;
    other.from = Math.min(other.from, run.from);
    other.to = Math.max(other.to, run.to);
    runs.splice(short, 1);
    // Neighbours of the same mode now merge.
    for (let index = runs.length - 1; index > 0; index--)
      if (runs[index]!.mode === runs[index - 1]!.mode) {
        runs[index - 1]!.to = runs[index]!.to;
        runs.splice(index, 1);
      }
  }
  type Stretch = {
    fromUs: number;
    toUs: number;
    kind: LayoutKind;
    reason: string;
    mode: Mode;
  };
  const stretches: Stretch[] = [];
  const speechStart = Math.max(0, input.speech.startUs - 300_000);
  const speechEnd = Math.min(input.durationUs, input.speech.endUs + 300_000);
  for (const run of runs) {
    const fromUs = run.from * secondUs;
    const toUs = Math.min(input.durationUs, run.to * secondUs);
    if (run.mode === "demo")
      stretches.push({
        fromUs,
        toUs,
        kind: "pip",
        reason: "Something is happening on screen.",
        mode: "demo",
      });
    else
      stretches.push({
        fromUs,
        toUs,
        kind: toUs - fromUs >= config.talkUs ? "camera" : "pip",
        reason:
          toUs - fromUs >= config.talkUs
            ? "The speaker explains with nothing changing on screen."
            : "A short pause in the demonstration.",
        mode: "talk",
      });
  }
  // The opening and the close belong to the speaker.
  const intro = Math.min(config.introUs, input.durationUs / 3);
  const outro = Math.min(config.outroUs, input.durationUs / 4);
  const framed: Stretch[] = [];
  for (const stretch of stretches) {
    // Split a stretch around the intro and outro boundaries.
    const pieces: Stretch[] = [];
    let from = stretch.fromUs;
    const cuts = [
      speechStart + intro,
      Math.max(speechEnd - outro, speechStart + intro),
    ].filter((cut) => cut > stretch.fromUs && cut < stretch.toUs);
    for (const cut of cuts) {
      pieces.push({ ...stretch, fromUs: from, toUs: cut });
      from = cut;
    }
    pieces.push({ ...stretch, fromUs: from, toUs: stretch.toUs });
    for (const piece of pieces) {
      if (piece.toUs <= speechStart + intro && piece.toUs > piece.fromUs)
        framed.push({
          ...piece,
          kind: "camera",
          reason: "The speaker opens the video.",
        });
      else if (piece.fromUs >= speechEnd - outro)
        framed.push({
          ...piece,
          kind: "camera",
          reason: "The speaker closes the video.",
        });
      else framed.push(piece);
    }
  }
  // Pick a corner for each corner-camera stretch, away from what changes.
  const plan: PlannedLayout[] = [];
  let corner: LayoutCorner = "bottom_right";
  for (const stretch of framed) {
    if (stretch.toUs <= stretch.fromUs) continue;
    if (stretch.kind === "camera") {
      plan.push({
        atUs: stretch.fromUs,
        kind: "camera",
        reason: stretch.reason,
      });
      continue;
    }
    const events = input.activity.filter(
      (item) => item.endUs > stretch.fromUs && item.startUs < stretch.toUs,
    );
    const scores = new Map(
      cornerOrder.map((name) => [name, overlap(name, events, input.geometry)]),
    );
    const best = Math.min(...scores.values());
    const stays: boolean = (scores.get(corner) ?? 1) <= best * 1.15 + 0.02;
    const chosen: LayoutCorner = stays
      ? corner
      : (cornerOrder.find((name) => scores.get(name) === best) ?? corner);
    if (best > config.maxOverlap) {
      plan.push({
        atUs: stretch.fromUs,
        kind: "screen",
        reason: "The screen is too busy for the camera to fit anywhere.",
      });
      continue;
    }
    corner = chosen;
    plan.push({
      atUs: stretch.fromUs,
      kind: "pip",
      corner: chosen,
      size: layoutLimits.defaultSize,
      shape: "rounded",
      reason: `${stretch.reason} The camera sits ${chosen.replace("_", " ")} away from it.`,
    });
  }
  // Merge changes that repeat the previous arrangement, then move each to the
  // start of a sentence when one is near.
  const merged: PlannedLayout[] = [];
  for (const item of plan) {
    const last = merged.at(-1);
    if (
      last &&
      last.kind === item.kind &&
      last.corner === item.corner &&
      last.size === item.size
    )
      continue;
    merged.push(item);
  }
  const snapped: PlannedLayout[] = [];
  for (const item of merged) {
    let at = item.atUs;
    let distance = 1_500_000;
    for (const start of input.sentenceStarts)
      if (Math.abs(start - item.atUs) < distance) {
        distance = Math.abs(start - item.atUs);
        at = start;
      }
    const previous = snapped.at(-1);
    if (previous && at - previous.atUs < config.minHoldUs) continue;
    snapped.push({ ...item, atUs: Math.max(0, Math.round(at)) });
  }
  // Start from the screen alone unless the plan begins right away.
  return snapped;
}

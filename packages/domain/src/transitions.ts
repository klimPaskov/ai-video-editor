/**
 * Transitions: a styled overlay that hides a cut. A transition is anchored to
 * the source moment where the incoming clip starts, so it follows later cuts;
 * it plays only while a real cut is still there (a boundary where the source
 * does not continue unbroken) and is dormant otherwise.
 *
 * The overlay is drawn over the video like a motion graphic, so preview and
 * export render it the same way and the lossless frame path is untouched. It
 * is fully opaque (or fully covering) at the first frame of the incoming
 * clip, which is what hides the jump; before and after, the picture shows
 * through. Audio is not changed.
 */
import type { GraphicInterval } from "./graphics.ts";

export const transitionKinds = [
  "dip",
  "wipe_right",
  "wipe_left",
  "iris",
] as const;
export type TransitionKind = (typeof transitionKinds)[number];

export interface TransitionEffect {
  transition_id: string;
  /** The source and moment where the incoming clip starts. */
  source_id: string;
  source_us: number;
  kind: TransitionKind;
  /** Total time on screen, centred on the cut. */
  duration_us: number;
  /** Colour of the dip, panel or iris, as #rrggbb. */
  color: string;
}

export const transitionLimits = Object.freeze({
  maxTransitions: 256,
  minDurationUs: 200_000,
  maxDurationUs: 2_000_000,
  /** Drawn above every graphic (graphics stop at layer 99). */
  layer: 100,
  /** Half-windows shorter than this are not drawn. */
  minHalfUs: 40_000,
});

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const colorPattern = /^#[0-9a-fA-F]{6}$/u;
const keys = [
  "transition_id",
  "source_id",
  "source_us",
  "kind",
  "duration_us",
  "color",
] as const;

function invalid(): never {
  throw new Error("Invalid transition.");
}

export function assertTransitionEffect(
  value: unknown,
): asserts value is TransitionEffect {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  const transition = value as Record<string, unknown>;
  if (
    typeof transition.transition_id !== "string" ||
    !idPattern.test(transition.transition_id) ||
    typeof transition.source_id !== "string" ||
    !idPattern.test(transition.source_id) ||
    !Number.isSafeInteger(transition.source_us) ||
    (transition.source_us as number) < 0 ||
    !transitionKinds.includes(transition.kind as TransitionKind) ||
    !Number.isSafeInteger(transition.duration_us) ||
    (transition.duration_us as number) < transitionLimits.minDurationUs ||
    (transition.duration_us as number) > transitionLimits.maxDurationUs ||
    typeof transition.color !== "string" ||
    !colorPattern.test(transition.color)
  )
    invalid();
}

/**
 * Transitions of a draft: valid, inside their sources, unique ids and at most
 * one per cut.
 */
export function assertTransitionEffects(
  value: unknown,
  sources: readonly {
    source_id: string;
    source_start_us: number;
    source_end_us: number;
  }[],
): asserts value is TransitionEffect[] {
  if (!Array.isArray(value) || value.length > transitionLimits.maxTransitions)
    invalid();
  const ids = new Set<string>();
  const places = new Set<string>();
  for (const transition of value) {
    assertTransitionEffect(transition);
    const source = sources.find(
      (item) => item.source_id === transition.source_id,
    );
    const place = `${transition.source_id}\0${transition.source_us}`;
    if (
      !source ||
      transition.source_us < source.source_start_us ||
      transition.source_us >= source.source_end_us ||
      ids.has(transition.transition_id) ||
      places.has(place)
    )
      invalid();
    ids.add(transition.transition_id);
    places.add(place);
  }
}

export interface TransitionClip {
  sourceId: string;
  timelineStartUs: number;
  timelineEndUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
  speed?: number;
}

/** A boundary between two clips where the picture jumps. */
export interface TransitionCut {
  /** Output time of the incoming clip's first frame. */
  atUs: number;
  /** The incoming clip's source and first source moment: the anchor. */
  sourceId: string;
  sourceUs: number;
  /** Lengths of the clips on either side, in output time. */
  beforeUs: number;
  afterUs: number;
}

/**
 * The real cuts of a clip map: boundaries where the next clip does not
 * continue the previous one unbroken (a split or a speed change inside one
 * stretch of a source is not a cut).
 */
export function transitionCuts(
  clips: readonly TransitionClip[],
): TransitionCut[] {
  const ordered = [...clips].sort(
    (a, b) => a.timelineStartUs - b.timelineStartUs,
  );
  const cuts: TransitionCut[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const before = ordered[index - 1]!;
    const after = ordered[index]!;
    if (
      before.sourceId === after.sourceId &&
      before.sourceEndUs === after.sourceStartUs
    )
      continue;
    cuts.push({
      atUs: after.timelineStartUs,
      sourceId: after.sourceId,
      sourceUs: after.sourceStartUs,
      beforeUs: before.timelineEndUs - before.timelineStartUs,
      afterUs: after.timelineEndUs - after.timelineStartUs,
    });
  }
  return cuts;
}

/** The cut at output time `atUs` exactly, or null. */
export function cutAt(
  clips: readonly TransitionClip[],
  atUs: number,
): TransitionCut | null {
  return transitionCuts(clips).find((cut) => cut.atUs === atUs) ?? null;
}

/** The cut nearest to output time `us`, or null when there is none. */
export function nearestCut(
  clips: readonly TransitionClip[],
  us: number,
): TransitionCut | null {
  let best: TransitionCut | null = null;
  for (const cut of transitionCuts(clips))
    if (!best || Math.abs(cut.atUs - us) < Math.abs(best.atUs - us)) best = cut;
  return best;
}

/** A transition placed in output time. */
export interface TransitionInterval {
  transitionId: string;
  kind: TransitionKind;
  color: string;
  cutUs: number;
  startUs: number;
  endUs: number;
}

/**
 * Where each transition plays. A transition whose cut is gone is skipped.
 * The window is centred on the cut and never reaches into a third clip.
 */
export function transitionIntervals(
  transitions: readonly TransitionEffect[],
  clips: readonly TransitionClip[],
  durationUs: number,
): TransitionInterval[] {
  const cuts = transitionCuts(clips);
  const placed: TransitionInterval[] = [];
  for (const transition of transitions) {
    const cut = cuts.find(
      (item) =>
        item.sourceId === transition.source_id &&
        item.sourceUs === transition.source_us,
    );
    if (!cut) continue;
    const half = Math.min(
      Math.floor(transition.duration_us / 2),
      cut.beforeUs,
      cut.afterUs,
    );
    if (half < transitionLimits.minHalfUs) continue;
    const startUs = cut.atUs - half;
    const endUs = Math.min(durationUs, cut.atUs + half);
    if (endUs <= cut.atUs) continue;
    placed.push({
      transitionId: transition.transition_id,
      kind: transition.kind,
      color: transition.color,
      cutUs: cut.atUs,
      startUs,
      endUs,
    });
  }
  return placed.sort((a, b) => a.startUs - b.startUs);
}

function seconds(us: number): string {
  return (us / 1_000_000).toFixed(6);
}

const easeIn = "cubic-bezier(.42,0,1,1)";
const easeOut = "cubic-bezier(0,0,.58,1)";

/** The HTML fragment and stylesheet that draw one placed transition. */
export function transitionMarkup(interval: TransitionInterval): {
  html: string;
  css: string;
} {
  // The window is symmetric about the cut, so the cut is its midpoint; when
  // the end is clamped to the edit's end the animation simply stops early.
  const length = seconds((interval.cutUs - interval.startUs) * 2);
  const c = interval.color;
  const run = (name: string) => `animation:${name} ${length}s linear both`;
  if (interval.kind === "dip")
    return {
      html: `<div class="tr"></div>`,
      css: `.tr{position:absolute;inset:0;background:${c};opacity:0;${run("tr-dip")}}@keyframes tr-dip{0%{opacity:0;animation-timing-function:${easeIn}}50%{opacity:1;animation-timing-function:${easeOut}}100%{opacity:0}}`,
    };
  if (interval.kind === "iris")
    return {
      html: `<div class="tr"></div>`,
      css: `.tr{position:absolute;inset:0;background:${c};clip-path:circle(0% at 50% 50%);${run("tr-iris")}}@keyframes tr-iris{0%{clip-path:circle(0% at 50% 50%);animation-timing-function:${easeIn}}50%{clip-path:circle(75% at 50% 50%);animation-timing-function:${easeOut}}100%{clip-path:circle(0% at 50% 50%)}}`,
    };
  const right = interval.kind === "wipe_right";
  const from = right ? "-110%" : "110%";
  const to = right ? "110%" : "-110%";
  return {
    html: `<div class="tr-trail"></div><div class="tr"></div>`,
    css: `.tr,.tr-trail{position:absolute;top:0;bottom:0;left:-1%;width:102%;transform:translateX(${from})}.tr{background:${c};box-shadow:0 0 90px rgba(0,0,0,.35);${run("tr-wipe")}}.tr-trail{background:rgba(255,255,255,.55);${run("tr-trail")}}@keyframes tr-wipe{0%{transform:translateX(${from});animation-timing-function:${easeIn}}50%{transform:translateX(0);animation-timing-function:${easeOut}}100%{transform:translateX(${to})}}@keyframes tr-trail{0%{transform:translateX(${from});animation-timing-function:${easeIn}}44%{transform:translateX(${right ? "-8%" : "8%"});animation-timing-function:${easeOut}}100%{transform:translateX(${to})}}`,
  };
}

/** The placed transitions as graphic intervals the stage already draws. */
export function transitionGraphicIntervals(
  transitions: readonly TransitionEffect[],
  clips: readonly TransitionClip[],
  durationUs: number,
): GraphicInterval[] {
  return transitionIntervals(transitions, clips, durationUs).map(
    (interval) => ({
      graphicId: `transition-${interval.transitionId}`,
      name: "Transition",
      startUs: interval.startUs,
      endUs: interval.endUs,
      layer: transitionLimits.layer,
      ...transitionMarkup(interval),
    }),
  );
}

/**
 * Layouts: how the screen recording and the camera recording share the
 * picture. A layout change is a draft effect anchored to a moment of the
 * screen recording, so it follows cuts; it stays in effect until the next
 * change. Before the first change the picture is the screen alone.
 *
 * - `screen`: the screen only.
 * - `camera`: the camera fills the picture.
 * - `pip`: the camera sits in a corner of the screen, in a shape.
 *
 * The same pure functions place the camera in the preview and in export.
 */
import { viewTimelineAt } from "./speed.ts";

export type LayoutKind = "screen" | "camera" | "pip";
export type LayoutCorner =
  "top_left" | "top_right" | "bottom_left" | "bottom_right";
export type LayoutShape = "circle" | "rounded" | "rect";

export interface LayoutChange {
  layout_id: string;
  /** The recording and moment where the change starts. */
  source_id: string;
  source_us: number;
  kind: LayoutKind;
  /** Corner for `pip` (default bottom right). */
  corner?: LayoutCorner;
  /** Width of the camera as a share of the picture's width, `pip` only. */
  size?: number;
  shape?: LayoutShape;
  /** Magnification of the camera picture and the point it stays centred on. */
  face_zoom?: number;
  focus_x?: number;
  focus_y?: number;
  /** How long the change takes to play (default 600 ms). */
  move_us?: number;
}

export const layoutLimits = Object.freeze({
  maxLayouts: 256,
  minSize: 0.12,
  maxSize: 0.5,
  defaultSize: 0.24,
  minFaceZoom: 1,
  maxFaceZoom: 2.5,
  minMoveUs: 0,
  maxMoveUs: 2_000_000,
  defaultMoveUs: 600_000,
  /** The camera's distance from the picture's edge, as a share of its width. */
  marginShare: 0.03,
});

export const layoutKinds: readonly LayoutKind[] = ["screen", "camera", "pip"];
export const layoutCorners: readonly LayoutCorner[] = [
  "top_left",
  "top_right",
  "bottom_left",
  "bottom_right",
];
export const layoutShapes: readonly LayoutShape[] = [
  "circle",
  "rounded",
  "rect",
];

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalid(): never {
  throw new Error("Invalid layout.");
}

export function assertLayoutChange(
  value: unknown,
): asserts value is LayoutChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const layout = value as Record<string, unknown>;
  const allowed = new Set([
    "layout_id",
    "source_id",
    "source_us",
    "kind",
    "corner",
    "size",
    "shape",
    "face_zoom",
    "focus_x",
    "focus_y",
    "move_us",
  ]);
  for (const key of Object.keys(layout)) if (!allowed.has(key)) invalid();
  if (
    typeof layout.layout_id !== "string" ||
    !idPattern.test(layout.layout_id) ||
    typeof layout.source_id !== "string" ||
    !idPattern.test(layout.source_id) ||
    !Number.isSafeInteger(layout.source_us) ||
    (layout.source_us as number) < 0 ||
    !layoutKinds.includes(layout.kind as LayoutKind)
  )
    invalid();
  if (
    layout.corner !== undefined &&
    !layoutCorners.includes(layout.corner as LayoutCorner)
  )
    invalid();
  if (
    layout.shape !== undefined &&
    !layoutShapes.includes(layout.shape as LayoutShape)
  )
    invalid();
  const number = (key: string, min: number, max: number) => {
    const item = layout[key];
    if (item === undefined) return;
    if (
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      item < min ||
      item > max
    )
      invalid();
  };
  number("size", layoutLimits.minSize, layoutLimits.maxSize);
  number("face_zoom", layoutLimits.minFaceZoom, layoutLimits.maxFaceZoom);
  number("focus_x", 0, 1);
  number("focus_y", 0, 1);
  if (
    layout.move_us !== undefined &&
    (!Number.isSafeInteger(layout.move_us) ||
      (layout.move_us as number) < layoutLimits.minMoveUs ||
      (layout.move_us as number) > layoutLimits.maxMoveUs)
  )
    invalid();
  // Corner, size and shape only mean something for a corner camera.
  if (
    layout.kind !== "pip" &&
    (layout.corner !== undefined ||
      layout.size !== undefined ||
      layout.shape !== undefined)
  )
    invalid();
  if (
    layout.kind === "screen" &&
    (layout.face_zoom !== undefined ||
      layout.focus_x !== undefined ||
      layout.focus_y !== undefined)
  )
    invalid();
  if ((layout.focus_x === undefined) !== (layout.focus_y === undefined))
    invalid();
}

/** Layout changes of a draft: valid, in their sources' ranges, unique ids. */
export function assertLayoutChanges(
  value: unknown,
  sources: readonly {
    source_id: string;
    source_start_us: number;
    source_end_us: number;
  }[],
): asserts value is LayoutChange[] {
  if (!Array.isArray(value) || value.length > layoutLimits.maxLayouts)
    invalid();
  const ids = new Set<string>();
  const moments = new Set<string>();
  for (const layout of value) {
    assertLayoutChange(layout);
    const source = sources.find((item) => item.source_id === layout.source_id);
    const moment = `${layout.source_id}:${layout.source_us}`;
    if (
      !source ||
      layout.source_us < source.source_start_us ||
      layout.source_us >= source.source_end_us ||
      ids.has(layout.layout_id) ||
      moments.has(moment)
    )
      invalid();
    ids.add(layout.layout_id);
    moments.add(moment);
  }
}

export interface LayoutClip {
  sourceId: string;
  timelineStartUs: number;
  timelineEndUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
  speed?: number;
}

/** What the picture looks like from `startUs` until the next change. */
export interface LayoutState {
  kind: LayoutKind;
  corner: LayoutCorner;
  size: number;
  shape: LayoutShape;
  faceZoom: number;
  focusX: number;
  focusY: number;
}

export interface LayoutInterval {
  layoutId: string;
  /** Output time where the change takes effect. */
  startUs: number;
  moveUs: number;
  state: LayoutState;
}

export const defaultLayoutState: LayoutState = Object.freeze({
  kind: "screen",
  corner: "bottom_right",
  size: layoutLimits.defaultSize,
  shape: "rounded",
  faceZoom: 1,
  focusX: 0.5,
  focusY: 0.5,
});

function stateOf(layout: LayoutChange): LayoutState {
  return {
    kind: layout.kind,
    corner: layout.corner ?? defaultLayoutState.corner,
    size: layout.size ?? defaultLayoutState.size,
    shape: layout.shape ?? defaultLayoutState.shape,
    faceZoom: layout.face_zoom ?? 1,
    focusX: layout.focus_x ?? 0.5,
    focusY: layout.focus_y ?? 0.5,
  };
}

/**
 * Where each change takes effect in output time. A change whose moment was
 * cut away takes effect at the start of the next retained piece of that
 * recording; a change after everything retained is dormant and left out.
 * Sorted by time; a later change at the same time wins.
 */
export function layoutIntervals(
  layouts: readonly LayoutChange[],
  clips: readonly LayoutClip[],
): LayoutInterval[] {
  const found: (LayoutInterval & { order: number })[] = [];
  for (const layout of layouts) {
    let at: number | null = null;
    for (const clip of clips) {
      if (clip.sourceId !== layout.source_id) continue;
      if (clip.sourceEndUs <= layout.source_us) continue;
      const moment = Math.max(layout.source_us, clip.sourceStartUs);
      const start = viewTimelineAt(clip, moment);
      if (at === null || start < at) at = start;
    }
    if (at === null) continue;
    found.push({
      layoutId: layout.layout_id,
      startUs: at,
      moveUs: layout.move_us ?? layoutLimits.defaultMoveUs,
      state: stateOf(layout),
      order: layout.source_us,
    });
  }
  found.sort((a, b) => a.startUs - b.startUs || a.order - b.order);
  const intervals: LayoutInterval[] = [];
  for (const item of found) {
    const last = intervals.at(-1);
    const { order: _order, ...interval } = item;
    if (last && last.startUs === interval.startUs)
      intervals[intervals.length - 1] = interval;
    else intervals.push(interval);
  }
  return intervals;
}

/**
 * The camera as one or two layers over the screen. A corner camera is the
 * `pip` layer; a camera that fills the picture is the `full` layer. A change
 * dissolves between arrangements (the new layer fades in or the old one out)
 * and a corner camera glides to its new corner, so there is never a jump.
 */
export interface PipLayer {
  /** 0 hides the layer; 1 shows it fully. */
  opacity: number;
  /** Position and size as fractions of the picture's width and height. */
  x: number;
  y: number;
  width: number;
  height: number;
  shape: LayoutShape;
  faceZoom: number;
  focusX: number;
  focusY: number;
}

export interface CameraLayers {
  /** Opacity of the camera filling the picture (0 when absent). */
  full: number;
  fullZoom: number;
  fullFocusX: number;
  fullFocusY: number;
  /** The corner camera, or null when it is not shown. */
  pip: PipLayer | null;
}

export interface LayoutGeometry {
  /** The picture's width / height. */
  canvasAspect: number;
  /** The camera recording's width / height. */
  cameraAspect: number;
}

function smooth(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return x * x * (3 - 2 * x);
}

/** The corner camera's rectangle for a state. */
export function pipRect(
  state: LayoutState,
  geometry: LayoutGeometry,
): { x: number; y: number; width: number; height: number } {
  const width = state.size;
  // A circle is square; the others keep the camera's own shape.
  const aspect = state.shape === "circle" ? 1 : geometry.cameraAspect;
  const height = (width * geometry.canvasAspect) / aspect;
  const marginX = layoutLimits.marginShare;
  const marginY = marginX * geometry.canvasAspect;
  const left = state.corner.endsWith("left");
  const top = state.corner.startsWith("top");
  return {
    x: left ? marginX : 1 - marginX - width,
    y: top ? marginY : 1 - marginY - height,
    width,
    height,
  };
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

function pipOf(
  state: LayoutState,
  geometry: LayoutGeometry,
  opacity: number,
): PipLayer {
  return {
    opacity,
    ...pipRect(state, geometry),
    shape: state.shape,
    faceZoom: state.faceZoom,
    focusX: state.focusX,
    focusY: state.focusY,
  };
}

/** What each layer looks like in a steady state (no change under way). */
function steadyLayers(
  state: LayoutState,
  geometry: LayoutGeometry,
): CameraLayers {
  return {
    full: state.kind === "camera" ? 1 : 0,
    fullZoom: state.faceZoom,
    fullFocusX: state.focusX,
    fullFocusY: state.focusY,
    pip: state.kind === "pip" ? pipOf(state, geometry, 1) : null,
  };
}

/**
 * The camera layers at output time `us`. After a change the picture eases
 * from the old arrangement to the new one over `moveUs`.
 */
export function cameraLayersAt(
  intervals: readonly LayoutInterval[],
  us: number,
  geometry: LayoutGeometry,
): CameraLayers {
  let index = -1;
  for (let item = 0; item < intervals.length; item++)
    if (intervals[item]!.startUs <= us) index = item;
    else break;
  const current = index >= 0 ? intervals[index]!.state : defaultLayoutState;
  const previous = index > 0 ? intervals[index - 1]!.state : defaultLayoutState;
  const moveUs = index >= 0 ? intervals[index]!.moveUs : 0;
  const since = index >= 0 ? us - intervals[index]!.startUs : Infinity;
  if (index < 0 || moveUs <= 0 || since >= moveUs)
    return steadyLayers(current, geometry);
  const p = smooth(since / moveUs);
  const from = steadyLayers(previous, geometry);
  const to = steadyLayers(current, geometry);
  const full = lerp(from.full, to.full, p);
  const lens = current.kind === "camera" ? current : previous;
  let pip: PipLayer | null = null;
  if (from.pip && to.pip)
    pip = {
      opacity: 1,
      x: lerp(from.pip.x, to.pip.x, p),
      y: lerp(from.pip.y, to.pip.y, p),
      width: lerp(from.pip.width, to.pip.width, p),
      height: lerp(from.pip.height, to.pip.height, p),
      shape: to.pip.shape,
      faceZoom: lerp(from.pip.faceZoom, to.pip.faceZoom, p),
      focusX: lerp(from.pip.focusX, to.pip.focusX, p),
      focusY: lerp(from.pip.focusY, to.pip.focusY, p),
    };
  else if (to.pip) pip = { ...to.pip, opacity: p };
  else if (from.pip)
    // Leaving a corner for the full camera keeps the corner camera beneath
    // until the full one has covered it; leaving for the screen fades it.
    pip = { ...from.pip, opacity: current.kind === "camera" ? 1 : 1 - p };
  return {
    full,
    fullZoom: lens.faceZoom,
    fullFocusX: lens.focusX,
    fullFocusY: lens.focusY,
    pip: pip && pip.opacity > 0 ? pip : null,
  };
}

/**
 * The picture's timeline as pieces: each a span of output time with a
 * steady arrangement, or a change from one arrangement to the next. Export
 * renders each piece on its own.
 */
export type CameraPiece =
  | { kind: "steady"; startUs: number; endUs: number; state: LayoutState }
  | {
      kind: "change";
      startUs: number;
      endUs: number;
      from: LayoutState;
      to: LayoutState;
    };

/**
 * Splits [0, durationUs) into pieces. Spans where the camera is not shown
 * (the screen alone) are left out: nothing is drawn there.
 */
export function cameraPieces(
  intervals: readonly LayoutInterval[],
  durationUs: number,
): CameraPiece[] {
  const pieces: CameraPiece[] = [];
  const add = (piece: CameraPiece) => {
    if (piece.endUs > piece.startUs) pieces.push(piece);
  };
  let previous: LayoutState = defaultLayoutState;
  for (const [index, interval] of intervals.entries()) {
    if (interval.startUs >= durationUs) break;
    const end = Math.min(
      durationUs,
      intervals[index + 1]?.startUs ?? durationUs,
    );
    const moveEnd = Math.min(end, interval.startUs + interval.moveUs);
    const sameLook =
      previous.kind === interval.state.kind &&
      (previous.kind === "screen" ||
        (previous.kind === "camera" &&
          previous.faceZoom === interval.state.faceZoom &&
          previous.focusX === interval.state.focusX &&
          previous.focusY === interval.state.focusY) ||
        (previous.kind === "pip" &&
          previous.corner === interval.state.corner &&
          previous.size === interval.state.size &&
          previous.shape === interval.state.shape &&
          previous.faceZoom === interval.state.faceZoom &&
          previous.focusX === interval.state.focusX &&
          previous.focusY === interval.state.focusY));
    if (!sameLook && moveEnd > interval.startUs)
      add({
        kind: "change",
        startUs: interval.startUs,
        endUs: moveEnd,
        from: previous,
        to: interval.state,
      });
    if (interval.state.kind !== "screen")
      add({
        kind: "steady",
        startUs: sameLook ? interval.startUs : moveEnd,
        endUs: end,
        state: interval.state,
      });
    previous = interval.state;
  }
  return pieces;
}

/**
 * The layout intervals as seen by output window [startUs, endUs) whose own
 * time starts at 0 (a short clip). A change before the window sets its
 * opening arrangement.
 */
export function windowLayoutIntervals(
  intervals: readonly LayoutInterval[],
  startUs: number,
  endUs: number,
): LayoutInterval[] {
  const before = intervals.filter((interval) => interval.startUs <= startUs);
  const inside = intervals.filter(
    (interval) => interval.startUs > startUs && interval.startUs < endUs,
  );
  const opening = before.at(-1);
  return [
    ...(opening ? [{ ...opening, startUs: 0, moveUs: 0 }] : []),
    ...inside.map((interval) => ({
      ...interval,
      startUs: interval.startUs - startUs,
    })),
  ];
}

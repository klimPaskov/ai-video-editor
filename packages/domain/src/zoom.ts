/**
 * Zooms are draft edits anchored to source time, so they follow cuts. Each
 * one magnifies a point of the frame by `scale`, easing in at its start and
 * out at its end. A zoom can also push in slowly across its whole length
 * (`motion: "push"`) and pan to a second point (`end_center_x/y`). The same
 * math drives the preview and export.
 */
import { sourceAt, viewTimelineAt } from "./speed.ts";

export interface ZoomEffect {
  zoom_id: string;
  source_id: string;
  source_start_us: number;
  source_end_us: number;
  /** Point to magnify, as a fraction of frame width and height. */
  center_x: number;
  center_y: number;
  scale: number;
  /**
   * "hold" (default): ease in, stay, ease out. "push": the magnification
   * grows slowly across the whole zoom, then eases out.
   */
  motion?: "hold" | "push";
  /** Pan to this point across the zoom (both or neither). */
  end_center_x?: number;
  end_center_y?: number;
  /** Length of the ease in / out, in microseconds (default 400 ms). */
  ease_in_us?: number;
  ease_out_us?: number;
}

export interface ZoomClip {
  sourceId: string;
  timelineStartUs: number;
  timelineEndUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
  speed?: number;
}

/** A visible piece of a zoom in output time. */
export interface ZoomInterval {
  zoomId: string;
  startUs: number;
  endUs: number;
  centerX: number;
  centerY: number;
  scale: number;
  /** Ease in at the start / out at the end (the zoom's real edges). */
  easeIn: boolean;
  easeOut: boolean;
  motion: "hold" | "push";
  endCenterX: number;
  endCenterY: number;
  easeInUs: number;
  easeOutUs: number;
  /** The share of the whole zoom that this piece covers: [from, to]. */
  from: number;
  to: number;
}

export const zoomLimits = Object.freeze({
  minScale: 1.1,
  maxScale: 4,
  minDurationUs: 500_000,
  rampUs: 400_000,
  minEaseUs: 100_000,
  maxEaseUs: 1_500_000,
  maxZooms: 256,
});

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalid(): never {
  throw new Error("Invalid zoom.");
}

export function assertZoomEffect(value: unknown): asserts value is ZoomEffect {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length < 7
  )
    invalid();
  const zoom = value as Record<string, unknown>;
  const optional = new Set([
    "motion",
    "end_center_x",
    "end_center_y",
    "ease_in_us",
    "ease_out_us",
  ]);
  const required = new Set([
    "zoom_id",
    "source_id",
    "source_start_us",
    "source_end_us",
    "center_x",
    "center_y",
    "scale",
  ]);
  for (const key of Object.keys(zoom))
    if (!required.has(key) && !optional.has(key)) invalid();
  for (const key of required) if (!(key in zoom)) invalid();
  if (
    zoom.motion !== undefined &&
    zoom.motion !== "hold" &&
    zoom.motion !== "push"
  )
    invalid();
  if ((zoom.end_center_x === undefined) !== (zoom.end_center_y === undefined))
    invalid();
  for (const key of ["end_center_x", "end_center_y"] as const)
    if (
      zoom[key] !== undefined &&
      (typeof zoom[key] !== "number" ||
        !Number.isFinite(zoom[key]) ||
        (zoom[key] as number) < 0 ||
        (zoom[key] as number) > 1)
    )
      invalid();
  for (const key of ["ease_in_us", "ease_out_us"] as const)
    if (
      zoom[key] !== undefined &&
      (!Number.isSafeInteger(zoom[key]) ||
        (zoom[key] as number) < zoomLimits.minEaseUs ||
        (zoom[key] as number) > zoomLimits.maxEaseUs)
    )
      invalid();
  if (
    typeof zoom.zoom_id !== "string" ||
    !idPattern.test(zoom.zoom_id) ||
    typeof zoom.source_id !== "string" ||
    !idPattern.test(zoom.source_id) ||
    !Number.isSafeInteger(zoom.source_start_us) ||
    !Number.isSafeInteger(zoom.source_end_us) ||
    (zoom.source_start_us as number) < 0 ||
    (zoom.source_end_us as number) - (zoom.source_start_us as number) <
      zoomLimits.minDurationUs
  )
    invalid();
  for (const key of ["center_x", "center_y"] as const)
    if (
      typeof zoom[key] !== "number" ||
      !Number.isFinite(zoom[key]) ||
      (zoom[key] as number) < 0 ||
      (zoom[key] as number) > 1
    )
      invalid();
  if (
    typeof zoom.scale !== "number" ||
    !Number.isFinite(zoom.scale) ||
    zoom.scale < zoomLimits.minScale ||
    zoom.scale > zoomLimits.maxScale
  )
    invalid();
}

/**
 * Zooms of a draft: valid, within their sources' ranges, unique ids, and
 * never overlapping another zoom of the same source.
 */
export function assertZoomEffects(
  value: unknown,
  sources: readonly {
    source_id: string;
    source_start_us: number;
    source_end_us: number;
  }[],
): asserts value is ZoomEffect[] {
  if (!Array.isArray(value) || value.length > zoomLimits.maxZooms) invalid();
  const ids = new Set<string>();
  for (const zoom of value) {
    assertZoomEffect(zoom);
    const source = sources.find((item) => item.source_id === zoom.source_id);
    if (
      !source ||
      zoom.source_start_us < source.source_start_us ||
      zoom.source_end_us > source.source_end_us ||
      ids.has(zoom.zoom_id)
    )
      invalid();
    ids.add(zoom.zoom_id);
  }
  const zooms = value as ZoomEffect[];
  for (const [index, zoom] of zooms.entries())
    for (const other of zooms.slice(index + 1))
      if (
        other.source_id === zoom.source_id &&
        zoom.source_start_us < other.source_end_us &&
        other.source_start_us < zoom.source_end_us
      )
        invalid();
}

/**
 * Maps output range [startUs, endUs) to one source's time through the clip
 * map: the clips under its first and last microsecond must show the same
 * source. Returns null otherwise. The range may span cuts of that source.
 */
export function zoomSourceRange(
  clips: readonly {
    source_id: string;
    source_start_us: number;
    source_end_us: number;
    timeline_start_us: number;
    timeline_end_us: number;
    speed?: number;
  }[],
  startUs: number,
  endUs: number,
): {
  source_id: string;
  source_start_us: number;
  source_end_us: number;
} | null {
  const at = (us: number) =>
    clips.find(
      (clip) => us >= clip.timeline_start_us && us < clip.timeline_end_us,
    );
  const first = at(startUs);
  const last = at(endUs - 1);
  if (!first || !last || first.source_id !== last.source_id) return null;
  return {
    source_id: first.source_id,
    source_start_us: sourceAt(first, startUs),
    source_end_us:
      endUs === last.timeline_end_us
        ? last.source_end_us
        : sourceAt(last, endUs),
  };
}

/** Output-time pieces of each zoom that the clip map keeps visible. */
export function zoomIntervals(
  zooms: readonly ZoomEffect[],
  clips: readonly ZoomClip[],
): ZoomInterval[] {
  const pieces: ZoomInterval[] = [];
  for (const zoom of zooms)
    for (const clip of clips) {
      if (clip.sourceId !== zoom.source_id) continue;
      const from = Math.max(zoom.source_start_us, clip.sourceStartUs);
      const to = Math.min(zoom.source_end_us, clip.sourceEndUs);
      if (to <= from) continue;
      const whole = zoom.source_end_us - zoom.source_start_us;
      pieces.push({
        zoomId: zoom.zoom_id,
        startUs: viewTimelineAt(clip, from),
        endUs: Math.min(clip.timelineEndUs, viewTimelineAt(clip, to)),
        centerX: zoom.center_x,
        centerY: zoom.center_y,
        scale: zoom.scale,
        easeIn: from === zoom.source_start_us,
        easeOut: to === zoom.source_end_us,
        motion: zoom.motion ?? "hold",
        endCenterX: zoom.end_center_x ?? zoom.center_x,
        endCenterY: zoom.end_center_y ?? zoom.center_y,
        easeInUs: zoom.ease_in_us ?? zoomLimits.rampUs,
        easeOutUs: zoom.ease_out_us ?? zoomLimits.rampUs,
        from: (from - zoom.source_start_us) / whole,
        to: (to - zoom.source_start_us) / whole,
      });
    }
  return pieces.sort((a, b) => a.startUs - b.startUs);
}

function rampIn(interval: ZoomInterval): number {
  return Math.min(
    interval.easeInUs,
    Math.floor((interval.endUs - interval.startUs) / 3),
  );
}

function rampOut(interval: ZoomInterval): number {
  return Math.min(
    interval.easeOutUs,
    Math.floor((interval.endUs - interval.startUs) / 3),
  );
}

function smooth(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return x * x * (3 - 2 * x);
}

/** Magnification and centre at output time `us` (1 outside zooms). */
export function zoomAt(
  intervals: readonly ZoomInterval[],
  us: number,
): { scale: number; centerX: number; centerY: number } {
  const interval = intervals.find(
    (item) => us >= item.startUs && us < item.endUs,
  );
  if (!interval) return { scale: 1, centerX: 0.5, centerY: 0.5 };
  const rIn = rampIn(interval);
  const rOut = rampOut(interval);
  // How far through the whole zoom (not just this visible piece) we are.
  const progress =
    interval.from +
    ((interval.to - interval.from) * (us - interval.startUs)) /
      (interval.endUs - interval.startUs);
  let envelope = 1;
  if (interval.motion === "push") envelope = smooth(progress);
  else if (interval.easeIn && us < interval.startUs + rIn)
    envelope = smooth((us - interval.startUs) / rIn);
  if (interval.easeOut && us > interval.endUs - rOut)
    envelope = Math.min(envelope, smooth((interval.endUs - us) / rOut));
  const pan = smooth(progress);
  return {
    scale: 1 + (interval.scale - 1) * envelope,
    centerX: interval.centerX + (interval.endCenterX - interval.centerX) * pan,
    centerY: interval.centerY + (interval.endCenterY - interval.centerY) * pan,
  };
}

/**
 * The visible part of the frame at a magnification, as fractions of the
 * frame: centred on the point, kept inside the frame.
 */
export function zoomWindow(
  scale: number,
  centerX: number,
  centerY: number,
): { x: number; y: number; size: number } {
  const size = 1 / scale;
  const clamp = (center: number) =>
    Math.min(1 - size, Math.max(0, center - size / 2));
  return { x: clamp(centerX), y: clamp(centerY), size };
}

/**
 * The intervals as seen by output window [startUs, endUs) whose own time
 * starts at 0. Pieces keep their full extent so easing is unchanged at the
 * window's edges.
 */
export function windowZoomIntervals(
  intervals: readonly ZoomInterval[],
  startUs: number,
  endUs: number,
): ZoomInterval[] {
  return intervals
    .filter((interval) => interval.endUs > startUs && interval.startUs < endUs)
    .map((interval) => ({
      ...interval,
      startUs: interval.startUs - startUs,
      endUs: interval.endUs - startUs,
    }));
}

/** Seconds for a filter expression; negative values are parenthesised. */
function seconds(us: number): string {
  const text = (us / 1_000_000).toFixed(6);
  return us < 0 ? `(${text})` : text;
}

/**
 * FFmpeg filter that applies the zooms to frames of `width`×`height` whose
 * timestamps are output time. Outside zooms the magnification is exactly 1,
 * so those frames pass through unchanged.
 */
export function zoomFilter(
  intervals: readonly ZoomInterval[],
  width: number,
  height: number,
): string | null {
  if (intervals.length === 0) return null;
  // Expressions sit inside single quotes, so their commas need no escaping.
  const pieces = (
    value: (interval: ZoomInterval) => string,
    otherwise: string,
  ) =>
    intervals.reduceRight(
      (rest, interval) =>
        `if(between(t,${seconds(interval.startUs)},${seconds(interval.endUs - 1)}),${value(interval)},${rest})`,
      otherwise,
    );
  const smoothstep = (p: string) => `(${p})*(${p})*(3-2*(${p}))`;
  const clamp01 = (p: string) => `clip(${p},0,1)`;
  /** Share of the whole zoom elapsed at time t, within this piece. */
  const progress = (interval: ZoomInterval) =>
    `(${interval.from.toFixed(6)}+${(interval.to - interval.from).toFixed(6)}*(t-${seconds(interval.startUs)})/${seconds(interval.endUs - interval.startUs)})`;
  const envelope = (interval: ZoomInterval) => {
    const a = interval.startUs;
    const b = interval.endUs;
    const rIn = rampIn(interval);
    const rOut = rampOut(interval);
    const parts: string[] = [];
    if (interval.motion === "push") {
      const p = clamp01(progress(interval));
      parts.push(smoothstep(p));
    } else if (interval.easeIn && rIn > 0)
      parts.push(
        `if(lt(t,${seconds(a + rIn)}),${smoothstep(`(t-${seconds(a)})/${seconds(rIn)}`)},1)`,
      );
    if (interval.easeOut && rOut > 0)
      parts.push(
        `if(gt(t,${seconds(b - rOut)}),${smoothstep(`(${seconds(b)}-t)/${seconds(rOut)}`)},1)`,
      );
    return parts.length === 0
      ? "1"
      : parts.length === 1
        ? parts[0]!
        : `min(${parts[0]},${parts[1]})`;
  };
  const zoom = pieces(
    (interval) =>
      `(1+${(interval.scale - 1).toFixed(6)}*(${envelope(interval)}))`,
    "1",
  );
  const centre = (
    from: (interval: ZoomInterval) => number,
    to: (interval: ZoomInterval) => number,
  ) =>
    pieces((interval) => {
      if (from(interval) === to(interval)) return from(interval).toFixed(6);
      const p = smoothstep(clamp01(progress(interval)));
      return `(${from(interval).toFixed(6)}+${(to(interval) - from(interval)).toFixed(6)}*(${p}))`;
    }, "0.5");
  const cx = centre(
    (interval) => interval.centerX,
    (interval) => interval.endCenterX,
  );
  const cy = centre(
    (interval) => interval.centerY,
    (interval) => interval.endCenterY,
  );
  return [
    // At magnification 1 the size is the input's own, so the frame is
    // passed through untouched even when a dimension is odd.
    `scale=w='max(iw,trunc(iw*${zoom}/2)*2)':h='max(ih,trunc(ih*${zoom}/2)*2)':eval=frame:flags=lanczos`,
    `crop=${width}:${height}:x='max(0,min(iw-${width},iw*${cx}-${width}/2))':y='max(0,min(ih-${height},ih*${cy}-${height}/2))'`,
  ].join(",");
}

/**
 * Zooms are draft edits anchored to source time, so they follow cuts. Each
 * one magnifies a fixed point of the frame by `scale`, easing in at its
 * start and out at its end. The same math drives the preview and export.
 */

export interface ZoomEffect {
  zoom_id: string;
  source_id: string;
  source_start_us: number;
  source_end_us: number;
  /** Point to magnify, as a fraction of frame width and height. */
  center_x: number;
  center_y: number;
  scale: number;
}

export interface ZoomClip {
  sourceId: string;
  timelineStartUs: number;
  timelineEndUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
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
}

export const zoomLimits = Object.freeze({
  minScale: 1.1,
  maxScale: 4,
  minDurationUs: 500_000,
  rampUs: 400_000,
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
    Object.keys(value).length !== 7
  )
    invalid();
  const zoom = value as Record<string, unknown>;
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
      const offset = clip.timelineStartUs - clip.sourceStartUs;
      pieces.push({
        zoomId: zoom.zoom_id,
        startUs: from + offset,
        endUs: to + offset,
        centerX: zoom.center_x,
        centerY: zoom.center_y,
        scale: zoom.scale,
        easeIn: from === zoom.source_start_us,
        easeOut: to === zoom.source_end_us,
      });
    }
  return pieces.sort((a, b) => a.startUs - b.startUs);
}

function ramp(interval: ZoomInterval): number {
  return Math.min(
    zoomLimits.rampUs,
    Math.floor((interval.endUs - interval.startUs) / 3),
  );
}

function smooth(p: number): number {
  const x = Math.min(1, Math.max(0, p));
  return x * x * (3 - 2 * x);
}

/** Magnification at output time `us` (1 outside zooms). */
export function zoomAt(
  intervals: readonly ZoomInterval[],
  us: number,
): { scale: number; centerX: number; centerY: number } {
  const interval = intervals.find(
    (item) => us >= item.startUs && us < item.endUs,
  );
  if (!interval) return { scale: 1, centerX: 0.5, centerY: 0.5 };
  const r = ramp(interval);
  let envelope = 1;
  if (interval.easeIn && us < interval.startUs + r)
    envelope = smooth((us - interval.startUs) / r);
  if (interval.easeOut && us > interval.endUs - r)
    envelope = Math.min(envelope, smooth((interval.endUs - us) / r));
  return {
    scale: 1 + (interval.scale - 1) * envelope,
    centerX: interval.centerX,
    centerY: interval.centerY,
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
  const envelope = (interval: ZoomInterval) => {
    const r = ramp(interval);
    const a = interval.startUs;
    const b = interval.endUs;
    const parts: string[] = [];
    if (interval.easeIn && r > 0)
      parts.push(
        `if(lt(t,${seconds(a + r)}),${smoothstep(`(t-${seconds(a)})/${seconds(r)}`)},1)`,
      );
    if (interval.easeOut && r > 0)
      parts.push(
        `if(gt(t,${seconds(b - r)}),${smoothstep(`(${seconds(b)}-t)/${seconds(r)}`)},1)`,
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
  const cx = pieces((interval) => interval.centerX.toFixed(6), "0.5");
  const cy = pieces((interval) => interval.centerY.toFixed(6), "0.5");
  return [
    // At magnification 1 the size is the input's own, so the frame is
    // passed through untouched even when a dimension is odd.
    `scale=w='max(iw,trunc(iw*${zoom}/2)*2)':h='max(ih,trunc(ih*${zoom}/2)*2)':eval=frame:flags=lanczos`,
    `crop=${width}:${height}:x='max(0,min(iw-${width},iw*${cx}-${width}/2))':y='max(0,min(ih-${height},ih*${cy}-${height}/2))'`,
  ].join(",");
}

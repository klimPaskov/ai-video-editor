/**
 * Motion graphics: HTML and CSS fragments drawn over the video. A graphic
 * is anchored to a moment of a source recording, so it follows cuts, and
 * stays on screen for a fixed output duration. Its CSS animations start at
 * the graphic's own start; preview and export seek them to the same times.
 *
 * Graphics never run scripts or load anything from the network. The stage
 * page's Content Security Policy enforces that; this validator rejects such
 * content before it is saved, so stored drafts stay clean.
 */
import { viewTimelineAt } from "./speed.ts";

export interface GraphicEffect {
  graphic_id: string;
  /** Short label shown on the timeline, e.g. "Title card". */
  name: string;
  /** The source moment where the graphic starts. */
  source_id: string;
  source_us: number;
  /** Time on screen, in output time. */
  duration_us: number;
  /** Stacking order among graphics; higher draws on top. */
  layer: number;
  html: string;
  css: string;
}

export const graphicLimits = Object.freeze({
  maxGraphics: 256,
  maxNameChars: 80,
  maxHtmlBytes: 64 * 1024,
  maxCssBytes: 64 * 1024,
  minDurationUs: 100_000,
  maxDurationUs: 600_000_000,
  maxLayer: 99,
});

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const graphicKeys = [
  "graphic_id",
  "name",
  "source_id",
  "source_us",
  "duration_us",
  "layer",
  "html",
  "css",
] as const;

export class GraphicContentError extends Error {}

function invalid(): never {
  throw new Error("Invalid graphic.");
}

/**
 * Content a graphic may not contain, with the reason given to the author.
 * Matching is case-insensitive and also catches entity-encoded colons.
 */
const forbidden: readonly [RegExp, string][] = [
  [/<\s*script\b/iu, "Scripts are not allowed in graphics."],
  [
    /<\s*(?:iframe|frame|frameset|object|embed|applet|portal|webview)\b/iu,
    "Embedded documents are not allowed in graphics.",
  ],
  [
    /<\s*(?:link|meta|base)\b/iu,
    "Links, meta and base elements are not allowed in graphics.",
  ],
  [
    /<\s*(?:form|input|button|textarea|select)\b/iu,
    "Form controls are not allowed in graphics.",
  ],
  [
    /<\s*(?:audio|video|source|track)\b/iu,
    "Audio and video elements are not allowed in graphics.",
  ],
  [/\son[a-z]+\s*=/iu, "Event handler attributes are not allowed in graphics."],
  [
    /(?:java|vb)script\s*(?::|&#0*58;|&colon;)/iu,
    "Script URLs are not allowed in graphics.",
  ],
  [/@import\b/iu, "@import is not allowed in graphics."],
  [
    /\b(?:https?|ftp|file|ws|wss)\s*(?::|&#0*58;|&colon;)\s*\/\//iu,
    "Graphics cannot load anything from the network. Use inline SVG or data: images.",
  ],
  [
    /\b(?:src|href|xlink:href|srcset|poster|action|formaction)\s*=\s*["']?\s*(?!data:|#)[^"'\s>]/iu,
    "Images and links must be inline (data: URLs or #fragment references).",
  ],
  [
    /url\(\s*["']?\s*(?!data:|#)[^)"'\s]/iu,
    "CSS url() may only use data: URLs or #fragment references.",
  ],
];

/** Throws `GraphicContentError` with a reason if the content is unsafe. */
export function assertGraphicContent(html: string, css: string): void {
  for (const [pattern, reason] of forbidden)
    if (pattern.test(html) || pattern.test(css))
      throw new GraphicContentError(reason);
  // Styles cannot break out of the graphic's own <style> element.
  if (/<\s*\/\s*style/iu.test(css))
    throw new GraphicContentError("CSS cannot contain </style>.");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function assertGraphicEffect(
  value: unknown,
): asserts value is GraphicEffect {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== graphicKeys.length ||
    graphicKeys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  const graphic = value as Record<string, unknown>;
  if (
    typeof graphic.graphic_id !== "string" ||
    !idPattern.test(graphic.graphic_id) ||
    typeof graphic.source_id !== "string" ||
    !idPattern.test(graphic.source_id) ||
    typeof graphic.name !== "string" ||
    graphic.name.trim().length < 1 ||
    [...graphic.name].length > graphicLimits.maxNameChars ||
    /[\u0000-\u001f\u007f]/u.test(graphic.name) ||
    !Number.isSafeInteger(graphic.source_us) ||
    (graphic.source_us as number) < 0 ||
    !Number.isSafeInteger(graphic.duration_us) ||
    (graphic.duration_us as number) < graphicLimits.minDurationUs ||
    (graphic.duration_us as number) > graphicLimits.maxDurationUs ||
    !Number.isSafeInteger(graphic.layer) ||
    (graphic.layer as number) < 0 ||
    (graphic.layer as number) > graphicLimits.maxLayer ||
    typeof graphic.html !== "string" ||
    typeof graphic.css !== "string" ||
    utf8Bytes(graphic.html) > graphicLimits.maxHtmlBytes ||
    utf8Bytes(graphic.css) > graphicLimits.maxCssBytes
  )
    invalid();
  try {
    assertGraphicContent(graphic.html, graphic.css);
  } catch {
    invalid();
  }
}

/** Graphics of a draft: valid, inside their sources, with unique ids. */
export function assertGraphicEffects(
  value: unknown,
  sources: readonly {
    source_id: string;
    source_start_us: number;
    source_end_us: number;
  }[],
): asserts value is GraphicEffect[] {
  if (!Array.isArray(value) || value.length > graphicLimits.maxGraphics)
    invalid();
  const ids = new Set<string>();
  for (const graphic of value) {
    assertGraphicEffect(graphic);
    const source = sources.find((item) => item.source_id === graphic.source_id);
    if (
      !source ||
      graphic.source_us < source.source_start_us ||
      graphic.source_us >= source.source_end_us ||
      ids.has(graphic.graphic_id)
    )
      invalid();
    ids.add(graphic.graphic_id);
  }
}

export interface GraphicClip {
  sourceId: string;
  timelineStartUs: number;
  timelineEndUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
  speed?: number;
}

/** A graphic placed in output time. */
export interface GraphicInterval {
  graphicId: string;
  name: string;
  startUs: number;
  endUs: number;
  layer: number;
  html: string;
  css: string;
}

/**
 * Where each graphic plays in the edit. A graphic whose anchor moment was
 * cut away is not shown. Graphics end at the end of the edit at the latest.
 */
export function graphicIntervals(
  graphics: readonly GraphicEffect[],
  clips: readonly GraphicClip[],
  durationUs: number,
): GraphicInterval[] {
  const placed: GraphicInterval[] = [];
  for (const graphic of graphics) {
    const clip = clips.find(
      (item) =>
        item.sourceId === graphic.source_id &&
        graphic.source_us >= item.sourceStartUs &&
        graphic.source_us < item.sourceEndUs,
    );
    if (!clip) continue;
    const startUs = Math.min(
      clip.timelineEndUs - 1,
      viewTimelineAt(clip, graphic.source_us),
    );
    const endUs = Math.min(durationUs, startUs + graphic.duration_us);
    if (endUs <= startUs) continue;
    placed.push({
      graphicId: graphic.graphic_id,
      name: graphic.name,
      startUs,
      endUs,
      layer: graphic.layer,
      html: graphic.html,
      css: graphic.css,
    });
  }
  return placed.sort((a, b) => a.startUs - b.startUs || a.layer - b.layer);
}

/** The graphics on screen at output time `us`, bottom layer first. */
export function graphicsAt(
  intervals: readonly GraphicInterval[],
  us: number,
): GraphicInterval[] {
  return intervals
    .filter((interval) => us >= interval.startUs && us < interval.endUs)
    .sort((a, b) => a.layer - b.layer);
}

/** The source moment shown at output time `outputUs`, to anchor a graphic. */
export function graphicAnchor(
  clips: readonly {
    source_id: string;
    source_start_us: number;
    source_end_us: number;
    timeline_start_us: number;
    timeline_end_us: number;
    speed?: number;
  }[],
  outputUs: number,
): { source_id: string; source_us: number } | null {
  const clip = clips.find(
    (item) =>
      outputUs >= item.timeline_start_us && outputUs < item.timeline_end_us,
  );
  if (!clip) return null;
  return {
    source_id: clip.source_id,
    source_us: Math.min(
      clip.source_end_us - 1,
      clip.source_start_us +
        (outputUs - clip.timeline_start_us) * (clip.speed ?? 1),
    ),
  };
}

import type { GraphicInterval } from "../../../packages/domain/src/graphics.ts";

/** Frames [startFrame, startFrame + frameCount) of the output that show graphics. */
export interface GraphicsSegment {
  startFrame: number;
  frameCount: number;
}

/**
 * Rendered graphics: one FFV1 BGRA file (premultiplied alpha) per segment,
 * holding exactly that segment's frames.
 */
export interface GraphicsTrack {
  segments: (GraphicsSegment & { path: string })[];
}

export interface GraphicsRenderRequest {
  intervals: readonly GraphicInterval[];
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
  frameCount: number;
  directory: string;
  ffmpeg: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Segments closer than this many seconds are rendered as one. */
const mergeGapSeconds = 2;

/**
 * Output frames whose presentation time falls inside a graphic, grouped into
 * segments. Nearby segments are joined (the frames between them are
 * transparent) to keep the number of compositor inputs small.
 */
export function graphicsSegments(
  intervals: readonly GraphicInterval[],
  frameRate: { numerator: number; denominator: number },
  frameCount: number,
): GraphicsSegment[] {
  const gapFrames = Math.round(
    (mergeGapSeconds * frameRate.numerator) / frameRate.denominator,
  );
  const frameAt = (us: number) =>
    Math.min(
      frameCount,
      Math.ceil(
        (us * frameRate.numerator) / (frameRate.denominator * 1_000_000),
      ),
    );
  const ranges = intervals
    .map(
      (interval) =>
        [frameAt(interval.startUs), frameAt(interval.endUs)] as const,
    )
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const merged: GraphicsSegment[] = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last.startFrame + last.frameCount + gapFrames)
      last.frameCount = Math.max(last.frameCount, end - last.startFrame);
    else merged.push({ startFrame: start, frameCount: end - start });
  }
  return merged;
}

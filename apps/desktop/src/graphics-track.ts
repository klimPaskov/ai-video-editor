import type { GraphicInterval } from "../../../packages/domain/src/graphics.ts";

/** Frames [startFrame, startFrame + frameCount) of the output that show graphics. */
export interface GraphicsSegment {
  startFrame: number;
  frameCount: number;
}

/**
 * Rendered graphics: one FFV1 BGRA file (straight alpha) per segment,
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

/**
 * Converts a premultiplied BGRA capture (Chromium's bitmap layout) to
 * straight alpha in place. Opaque and fully transparent pixels are exact.
 * The compositor blends straight alpha because FFmpeg's premultiplied
 * overlay rounds opaque colours differently between builds (255 can become
 * 254), which would make an export depend on the installed FFmpeg.
 */
export function unpremultiplyBgra(bitmap: Buffer): Buffer {
  if (bitmap.length % 4 !== 0) throw new Error("Invalid BGRA bitmap.");
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const alpha = bitmap[offset + 3]!;
    if (alpha === 255) continue;
    if (alpha === 0) {
      bitmap[offset] = 0;
      bitmap[offset + 1] = 0;
      bitmap[offset + 2] = 0;
      continue;
    }
    for (let channel = 0; channel < 3; channel++)
      bitmap[offset + channel] = Math.min(
        255,
        Math.round((bitmap[offset + channel]! * 255) / alpha),
      );
  }
  return bitmap;
}

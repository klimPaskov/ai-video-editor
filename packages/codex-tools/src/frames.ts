/** Shared by the tool service and the transports; imports nothing heavy. */
export const frameToolLimits = Object.freeze({
  maxFrames: 3,
  minWidth: 320,
  maxWidth: 1280,
  defaultWidth: 960,
});

/**
 * Splits a `media.get_frames` result into JSON metadata and its images, so
 * transports can send pictures as image content instead of text.
 */
export function splitFrameResult(value: unknown): {
  metadata: unknown;
  images: { mimeType: "image/jpeg"; data: string }[];
} | null {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { frames?: unknown }).frames)
  )
    return null;
  const frames = (value as { frames: Record<string, unknown>[] }).frames;
  const images: { mimeType: "image/jpeg"; data: string }[] = [];
  const described: Record<string, unknown>[] = [];
  for (const frame of frames) {
    if (
      frame.mime_type !== "image/jpeg" ||
      typeof frame.data_base64 !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(frame.data_base64)
    )
      return null;
    images.push({ mimeType: "image/jpeg", data: frame.data_base64 });
    const rest = { ...frame };
    delete rest.data_base64;
    described.push({ ...rest, image_index: images.length - 1 });
  }
  return { metadata: { ...(value as object), frames: described }, images };
}

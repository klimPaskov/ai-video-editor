export interface MediaSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  durationUs: number;
  frameRate: number;
  previewAvailable: boolean;
}
export interface FrameRequest {
  id: string;
  timeUs: number;
}
export interface ThumbnailRequest {
  id: string;
}
/** Small cosmetic picture for library and project cards; never a review frame. */
export const thumbnailWidth = 320;
export interface MediaFrame {
  width: number;
  height: number;
  rgbaBase64: string;
}
export const mediaIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const maxFramePixels = 16_777_216;
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid media data.");
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Invalid media fields.");
}
function positive(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid media measurement.");
}
export function assertMediaSummary(
  value: unknown,
): asserts value is MediaSummary {
  record(value);
  exact(value, [
    "id",
    "name",
    "width",
    "height",
    "durationUs",
    "frameRate",
    "previewAvailable",
  ]);
  if (
    typeof value.id !== "string" ||
    !mediaIdPattern.test(value.id) ||
    typeof value.name !== "string" ||
    !value.name.length ||
    value.name.length > 255 ||
    /[\x00-\x1f/\\]/u.test(value.name)
  )
    throw new Error("Invalid media identity.");
  positive(value.width);
  positive(value.height);
  positive(value.durationUs);
  if (
    typeof value.frameRate !== "number" ||
    !Number.isFinite(value.frameRate) ||
    value.frameRate <= 0 ||
    typeof value.previewAvailable !== "boolean"
  )
    throw new Error("Invalid media format.");
}
export function assertFrameRequest(
  value: unknown,
): asserts value is FrameRequest {
  record(value);
  exact(value, ["id", "timeUs"]);
  if (
    typeof value.id !== "string" ||
    !mediaIdPattern.test(value.id) ||
    typeof value.timeUs !== "number" ||
    !Number.isSafeInteger(value.timeUs) ||
    value.timeUs < 0
  )
    throw new Error("Invalid frame request.");
}
export function assertThumbnailRequest(
  value: unknown,
): asserts value is ThumbnailRequest {
  record(value);
  exact(value, ["id"]);
  if (typeof value.id !== "string" || !mediaIdPattern.test(value.id))
    throw new Error("Invalid thumbnail request.");
}
export function assertThumbnail(value: unknown): asserts value is MediaFrame {
  assertMediaFrame(value);
  if (value.width > thumbnailWidth || value.height > 4 * thumbnailWidth)
    throw new Error("Invalid thumbnail size.");
}
export function assertMediaFrame(value: unknown): asserts value is MediaFrame {
  record(value);
  exact(value, ["width", "height", "rgbaBase64"]);
  positive(value.width);
  positive(value.height);
  const bytes = value.width * value.height * 4;
  if (
    value.width * value.height > maxFramePixels ||
    typeof value.rgbaBase64 !== "string" ||
    value.rgbaBase64.length !== 4 * Math.ceil(bytes / 3) ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.rgbaBase64)
  )
    throw new Error("Invalid frame payload.");
  const padding = (3 - (bytes % 3)) % 3;
  if ((value.rgbaBase64.match(/=+$/u)?.[0].length ?? 0) !== padding)
    throw new Error("Invalid frame padding.");
}
export function assertMediaList(
  value: unknown,
): asserts value is MediaSummary[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new Error("Invalid media list.");
  value.forEach(assertMediaSummary);
  if (new Set(value.map((item) => item.id)).size !== value.length)
    throw new Error("Duplicate media identity.");
}

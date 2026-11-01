/**
 * What the Camera tool shows and the requests it makes. The camera video is
 * chosen in a dialog owned by the main process; no file path crosses this
 * boundary.
 */

export interface CameraView {
  schema_version: "1.0";
  project_id: string;
  /** A camera recording is linked to this project's recording. */
  linked: boolean;
  /** The camera file's original name, when linked. */
  file_name: string | null;
  /** Camera time minus recording time at the same moment, in microseconds. */
  offset_us: number;
  /** The camera recording's picture size, when linked. */
  width: number | null;
  height: number | null;
}

export interface CameraRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface CameraOffsetRequest extends CameraRequest {
  offset_us: number;
}

export const cameraOffsetRangeUs = 600_000_000;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalid(): never {
  throw new Error("Invalid camera exchange.");
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value as Record<string, unknown>;
}

export function assertCameraRequest(
  value: unknown,
): asserts value is CameraRequest {
  const record = exact(value, ["schema_version", "project_id"]);
  if (record.schema_version !== "1.0") invalid();
  if (
    typeof record.project_id !== "string" ||
    !idPattern.test(record.project_id)
  )
    invalid();
}

export function assertCameraOffsetRequest(
  value: unknown,
): asserts value is CameraOffsetRequest {
  const record = exact(value, ["schema_version", "project_id", "offset_us"]);
  if (record.schema_version !== "1.0") invalid();
  if (
    typeof record.project_id !== "string" ||
    !idPattern.test(record.project_id)
  )
    invalid();
  if (
    !Number.isSafeInteger(record.offset_us) ||
    Math.abs(record.offset_us as number) > cameraOffsetRangeUs
  )
    invalid();
}

export function assertCameraView(value: unknown): asserts value is CameraView {
  const record = exact(value, [
    "schema_version",
    "project_id",
    "linked",
    "file_name",
    "offset_us",
    "width",
    "height",
  ]);
  if (
    record.schema_version !== "1.0" ||
    typeof record.project_id !== "string" ||
    !idPattern.test(record.project_id) ||
    typeof record.linked !== "boolean" ||
    !Number.isSafeInteger(record.offset_us) ||
    Math.abs(record.offset_us as number) > cameraOffsetRangeUs
  )
    invalid();
  if (record.linked) {
    if (
      typeof record.file_name !== "string" ||
      record.file_name.length < 1 ||
      record.file_name.length > 255 ||
      /[\u0000-\u001f\u007f/\\]/u.test(record.file_name) ||
      !Number.isSafeInteger(record.width) ||
      !Number.isSafeInteger(record.height) ||
      (record.width as number) < 1 ||
      (record.height as number) < 1
    )
      invalid();
  } else if (
    record.file_name !== null ||
    record.width !== null ||
    record.height !== null ||
    record.offset_us !== 0
  )
    invalid();
}

export function idleCameraView(projectId: string): CameraView {
  return {
    schema_version: "1.0",
    project_id: projectId,
    linked: false,
    file_name: null,
    offset_us: 0,
    width: null,
    height: null,
  };
}

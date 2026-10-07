import { assertMediaSummary, type MediaSummary } from "./library.ts";

/**
 * Renderer-visible screen recording state. Device names for FFmpeg, file
 * paths and capture logs stay in main; the renderer only sends opaque ids.
 */
export interface RecordingDisplay {
  id: string;
  label: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface RecordingMicrophone {
  id: string;
  label: string;
}

export interface RecordingDevices {
  displays: RecordingDisplay[];
  microphones: RecordingMicrophone[];
  /** Set when recording is not possible on this device. */
  message: string | null;
}

/** Part of a display to record, in its physical pixels. */
export interface RecordingRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecordingStartRequest {
  schema_version: "1.0";
  display_id: string;
  microphone_id: string | null;
  /** Omitted to record the whole display. */
  region?: RecordingRegion;
}

/** Ask main to let the user drag out an area of a display. */
export interface RecordingRegionRequest {
  schema_version: "1.0";
  display_id: string;
}

/** The chosen area, or null when the user cancelled. */
export interface RecordingRegionResult {
  region: RecordingRegion | null;
}

/** A take cut short by a crash or forced quit, offered for recovery. */
export interface InterruptedTake {
  id: string;
  /** When the take started (ISO 8601). */
  createdAt: string;
}

export interface InterruptedTakes {
  takes: InterruptedTake[];
}

export interface InterruptedTakeRequest {
  schema_version: "1.0";
  take_id: string;
}

/** Smallest area worth recording, in physical pixels. */
export const minimumRegionSize = 64;

export type RecordingStatus =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "finishing"
  | "finished"
  | "failed";

export interface RecordingView {
  status: RecordingStatus;
  elapsedUs: number;
  /** Frames FFmpeg had to repeat or drop because capture fell behind. */
  missedFrames: number;
  /** The imported take once finished. */
  media: MediaSummary | null;
  message: string | null;
}

export const recordingIssues = Object.freeze({
  unavailable: "Screen recording needs FFmpeg screen capture on this device.",
  wayland:
    "Screen recording needs an X11 session on Linux. Sign in with an X11 session to record.",
  busy: "A recording is already in progress.",
  device: "The selected screen or microphone is no longer available.",
  start:
    "Recording could not start. Check screen and microphone permissions and try again.",
  interrupted:
    "Recording stopped unexpectedly. The part recorded so far was kept.",
  finish: "The recording could not be saved. Try recording again.",
  empty: "Nothing was recorded.",
  region: "Choose a larger area to record.",
  recover:
    "This recording could not be recovered. You can try again or discard it.",
  regionUnavailable:
    "Recording part of the screen is not available on this device.",
} as const);

const messages = new Set<string>(Object.values(recordingIssues));
const statuses = new Set<string>([
  "idle",
  "starting",
  "recording",
  "paused",
  "finishing",
  "finished",
  "failed",
]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

function invalid(): never {
  throw new Error("Invalid recording exchange.");
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

function count(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid();
}

function label(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
}

function id(value: unknown): void {
  if (typeof value !== "string" || !idPattern.test(value)) invalid();
}

function message(value: unknown): void {
  if (value !== null && (typeof value !== "string" || !messages.has(value)))
    invalid();
}

/** A region with non-negative whole-pixel bounds of at least the minimum. */
export function assertRecordingRegion(
  value: unknown,
): asserts value is RecordingRegion {
  const region = exact(value, ["x", "y", "width", "height"]);
  for (const key of ["x", "y", "width", "height"] as const) count(region[key]);
  if (
    (region.width as number) < minimumRegionSize ||
    (region.height as number) < minimumRegionSize ||
    (region.width as number) > 16_384 ||
    (region.height as number) > 16_384
  )
    invalid();
}

export function assertRecordingStartRequest(
  value: unknown,
): asserts value is RecordingStartRequest {
  const hasRegion =
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "region");
  const request = exact(value, [
    "schema_version",
    "display_id",
    "microphone_id",
    ...(hasRegion ? ["region"] : []),
  ]);
  if (request.schema_version !== "1.0") invalid();
  id(request.display_id);
  if (request.microphone_id !== null) id(request.microphone_id);
  if (hasRegion) assertRecordingRegion(request.region);
}

const takeIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function assertInterruptedTakes(
  value: unknown,
): asserts value is InterruptedTakes {
  const result = exact(value, ["takes"]);
  if (!Array.isArray(result.takes) || result.takes.length > 32) invalid();
  for (const take of result.takes) {
    const item = exact(take, ["id", "createdAt"]);
    if (typeof item.id !== "string" || !takeIdPattern.test(item.id)) invalid();
    if (
      typeof item.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(item.createdAt)
    )
      invalid();
  }
}

export function assertInterruptedTakeRequest(
  value: unknown,
): asserts value is InterruptedTakeRequest {
  const request = exact(value, ["schema_version", "take_id"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.take_id !== "string" ||
    !takeIdPattern.test(request.take_id)
  )
    invalid();
}

export function assertRecordingRegionRequest(
  value: unknown,
): asserts value is RecordingRegionRequest {
  const request = exact(value, ["schema_version", "display_id"]);
  if (request.schema_version !== "1.0") invalid();
  id(request.display_id);
}

export function assertRecordingRegionResult(
  value: unknown,
): asserts value is RecordingRegionResult {
  const result = exact(value, ["region"]);
  if (result.region !== null) assertRecordingRegion(result.region);
}

export function assertRecordingDevices(
  value: unknown,
): asserts value is RecordingDevices {
  const devices = exact(value, ["displays", "microphones", "message"]);
  if (
    !Array.isArray(devices.displays) ||
    !Array.isArray(devices.microphones) ||
    devices.displays.length > 16 ||
    devices.microphones.length > 64
  )
    invalid();
  for (const display of devices.displays) {
    const item = exact(display, ["id", "label", "width", "height", "primary"]);
    id(item.id);
    label(item.label);
    count(item.width);
    count(item.height);
    if (typeof item.primary !== "boolean") invalid();
  }
  for (const microphone of devices.microphones) {
    const item = exact(microphone, ["id", "label"]);
    id(item.id);
    label(item.label);
  }
  message(devices.message);
}

export function assertRecordingView(
  value: unknown,
): asserts value is RecordingView {
  const view = exact(value, [
    "status",
    "elapsedUs",
    "missedFrames",
    "media",
    "message",
  ]);
  if (typeof view.status !== "string" || !statuses.has(view.status)) invalid();
  count(view.elapsedUs);
  count(view.missedFrames);
  if (view.media !== null) assertMediaSummary(view.media);
  if ((view.media !== null) !== (view.status === "finished")) invalid();
  message(view.message);
}

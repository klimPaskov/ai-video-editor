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

export interface RecordingStartRequest {
  schema_version: "1.0";
  display_id: string;
  microphone_id: string | null;
}

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

export function assertRecordingStartRequest(
  value: unknown,
): asserts value is RecordingStartRequest {
  const request = exact(value, [
    "schema_version",
    "display_id",
    "microphone_id",
  ]);
  if (request.schema_version !== "1.0") invalid();
  id(request.display_id);
  if (request.microphone_id !== null) id(request.microphone_id);
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

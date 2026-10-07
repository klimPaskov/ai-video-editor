import type {
  ShortCandidate,
  ShortFormat,
  ShortFraming,
} from "./short-clips.ts";

/** Renderer-visible short clips of a project; paths stay in main. */
export interface ShortClipsView {
  /** "stale" means the draft changed since the clips were found. */
  status: "none" | "ready" | "stale";
  candidates: ShortCandidate[];
  job: ShortJobView;
  message: string | null;
}

export interface ShortJobView {
  status: "idle" | "running" | "completed" | "failed";
  clipId: string | null;
  fraction: number | null;
  fileName: string | null;
  message: string | null;
}

export interface ShortProjectRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface ShortClipRequest extends ShortProjectRequest {
  clip_id: string;
}

export interface ShortExportRequest extends ShortClipRequest {
  format: ShortFormat;
  framing: ShortFraming;
  /** Crop position for "fill", 0..1. */
  position: number;
  captions: boolean;
}

export const shortIssues = Object.freeze({
  transcript: "Short clips use the transcript. Transcribe the video first.",
  none: "No self-contained moments of 15 to 60 seconds were found in this draft.",
  busy: "A clip is already exporting.",
  failed: "The clip could not be exported. Try again.",
  stale: "The draft changed since these clips were found. Find clips again.",
  unknown: "That clip is no longer available. Find clips again.",
} as const);

const messages = new Set<string>(Object.values(shortIssues));
const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const clipIdPattern = /^clip-\d{1,16}-\d{1,16}$/u;

function invalid(): never {
  throw new Error("Invalid short clip exchange.");
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

function text(value: unknown, max: number): void {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
}

function message(value: unknown): void {
  if (value !== null && (typeof value !== "string" || !messages.has(value)))
    invalid();
}

export function assertShortProjectRequest(
  value: unknown,
): asserts value is ShortProjectRequest {
  const request = exact(value, ["schema_version", "project_id"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !projectIdPattern.test(request.project_id)
  )
    invalid();
}

export function assertShortClipRequest(
  value: unknown,
): asserts value is ShortClipRequest {
  const request = exact(value, ["schema_version", "project_id", "clip_id"]);
  assertShortProjectRequest({
    schema_version: request.schema_version,
    project_id: request.project_id,
  });
  if (
    typeof request.clip_id !== "string" ||
    !clipIdPattern.test(request.clip_id)
  )
    invalid();
}

export function assertShortExportRequest(
  value: unknown,
): asserts value is ShortExportRequest {
  const request = exact(value, [
    "schema_version",
    "project_id",
    "clip_id",
    "format",
    "framing",
    "position",
    "captions",
  ]);
  assertShortClipRequest({
    schema_version: request.schema_version,
    project_id: request.project_id,
    clip_id: request.clip_id,
  });
  if (
    !["vertical", "square", "landscape"].includes(request.format as string) ||
    !["fit", "fill"].includes(request.framing as string) ||
    typeof request.position !== "number" ||
    !Number.isFinite(request.position) ||
    request.position < 0 ||
    request.position > 1 ||
    typeof request.captions !== "boolean"
  )
    invalid();
}

export function assertShortClipsView(
  value: unknown,
): asserts value is ShortClipsView {
  const view = exact(value, ["status", "candidates", "job", "message"]);
  if (!["none", "ready", "stale"].includes(view.status as string)) invalid();
  if (!Array.isArray(view.candidates) || view.candidates.length > 32) invalid();
  for (const candidate of view.candidates) {
    const item = exact(candidate, [
      "id",
      "title",
      "startUs",
      "endUs",
      "score",
      "reasons",
      "excerpt",
    ]);
    if (typeof item.id !== "string" || !clipIdPattern.test(item.id)) invalid();
    text(item.title, 120);
    text(item.excerpt, 400);
    count(item.startUs);
    count(item.endUs);
    if ((item.endUs as number) <= (item.startUs as number)) invalid();
    if (
      typeof item.score !== "number" ||
      !(item.score >= 0 && item.score <= 1) ||
      !Array.isArray(item.reasons) ||
      item.reasons.length > 8
    )
      invalid();
    for (const reason of item.reasons) text(reason, 80);
  }
  const job = exact(view.job, [
    "status",
    "clipId",
    "fraction",
    "fileName",
    "message",
  ]);
  if (
    !["idle", "running", "completed", "failed"].includes(job.status as string)
  )
    invalid();
  if (
    job.clipId !== null &&
    (typeof job.clipId !== "string" || !clipIdPattern.test(job.clipId))
  )
    invalid();
  if (
    job.fraction !== null &&
    (typeof job.fraction !== "number" ||
      !(job.fraction >= 0 && job.fraction <= 1))
  )
    invalid();
  if (
    job.fileName !== null &&
    (typeof job.fileName !== "string" ||
      job.fileName.length > 255 ||
      !/^[^\\/:\u0000-\u001f\u007f]+\.mp4$/u.test(job.fileName))
  )
    invalid();
  message(job.message);
  message(view.message);
}

import type {
  ShortCandidate,
  ShortFormat,
  ShortFraming,
  ShortSpeed,
} from "./short-clips.ts";

/** Renderer-visible short clips of a project; paths stay in main. */
export interface ShortClipsView {
  /** "stale" means the draft changed since the clips were found. */
  status: "none" | "ready" | "stale";
  candidates: ShortCandidate[];
  job: ShortJobView;
  message: string | null;
  /** Clips exported from this project, newest first. */
  library: ShortLibraryItem[];
  /** Claude choosing clips for this project. */
  pick: { running: boolean; message: string | null };
}

/** An exported clip as the clip library lists it; paths stay in main. */
export interface ShortLibraryItem {
  id: string;
  title: string;
  fileName: string;
  format: ShortFormat;
  speed: ShortSpeed;
  durationUs: number;
  createdAt: string;
  /** False when the file is no longer where it was saved. */
  exists: boolean;
}

export interface ShortJobView {
  status: "idle" | "running" | "completed" | "failed";
  clipId: string | null;
  fraction: number | null;
  fileName: string | null;
  message: string | null;
  /** Set while exporting every clip: which one of how many. */
  batch: { index: number; total: number } | null;
}

export interface ShortProjectRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface ShortClipRequest extends ShortProjectRequest {
  clip_id: string;
}

export interface ShortExportOptions {
  format: ShortFormat;
  framing: ShortFraming;
  /** Crop position for "fill", 0..1. */
  position: number;
  captions: boolean;
  /** Show the clip's own title over its first seconds. */
  title: boolean;
  /** Plays the clip at this speed. */
  speed: ShortSpeed;
}

export interface ShortExportRequest
  extends ShortClipRequest, ShortExportOptions {}

/**
 * Exports clips in one folder, one after another: the clips named in
 * `clip_ids` (the ones the user chose in Clips), or every clip when absent.
 */
export interface ShortExportAllRequest
  extends ShortProjectRequest, ShortExportOptions {
  clip_ids?: string[];
}

/** Acts on one entry of the clip library. */
export interface ShortLibraryRequest extends ShortProjectRequest {
  export_id: string;
}

export const shortIssues = Object.freeze({
  transcript: "Short clips use the transcript. Transcribe the video first.",
  none: "No self-contained moments of 15 to 60 seconds were found in this draft.",
  busy: "A clip is already exporting.",
  failed: "The clip could not be exported. Try again.",
  stale: "The draft changed since these clips were found. Find clips again.",
  unknown: "That clip is no longer available. Find clips again.",
  speed:
    "Parts of this clip are already sped up too far to play faster. Choose normal speed.",
  pickNone: "Claude did not choose any clips. Try again.",
  pickFailed: "Claude could not choose clips. Try again.",
  pickBusy: "Claude is busy with another task. Try again when it is done.",
  pickSignIn: "Sign in to Claude in Settings to let it choose clips.",
  noClips: "There are no clips to export.",
  libraryUnknown: "That clip is no longer in the list.",
} as const);

const messages = new Set<string>(Object.values(shortIssues));
const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const clipIdPattern = /^clip-\d{1,16}-\d{1,16}$/u;
const exportIdPattern = /^export-[A-Za-z0-9-]{8,48}$/u;

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

function assertExportOptions(request: Record<string, unknown>): void {
  if (
    !["vertical", "square", "landscape"].includes(request.format as string) ||
    !["fit", "fill"].includes(request.framing as string) ||
    typeof request.position !== "number" ||
    !Number.isFinite(request.position) ||
    request.position < 0 ||
    request.position > 1 ||
    typeof request.captions !== "boolean" ||
    typeof request.title !== "boolean" ||
    (request.speed !== 1 && request.speed !== 2)
  )
    invalid();
}

const optionKeys = [
  "format",
  "framing",
  "position",
  "captions",
  "title",
  "speed",
] as const;

export function assertShortExportRequest(
  value: unknown,
): asserts value is ShortExportRequest {
  const request = exact(value, [
    "schema_version",
    "project_id",
    "clip_id",
    ...optionKeys,
  ]);
  assertShortClipRequest({
    schema_version: request.schema_version,
    project_id: request.project_id,
    clip_id: request.clip_id,
  });
  assertExportOptions(request);
}

export function assertShortExportAllRequest(
  value: unknown,
): asserts value is ShortExportAllRequest {
  const chosen =
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, "clip_ids");
  const request = exact(value, [
    "schema_version",
    "project_id",
    ...optionKeys,
    ...(chosen ? ["clip_ids"] : []),
  ]);
  assertShortProjectRequest({
    schema_version: request.schema_version,
    project_id: request.project_id,
  });
  assertExportOptions(request);
  if (chosen) {
    const ids = request.clip_ids;
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 64 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !clipIdPattern.test(id))
    )
      invalid();
  }
}

export function assertShortLibraryRequest(
  value: unknown,
): asserts value is ShortLibraryRequest {
  const request = exact(value, ["schema_version", "project_id", "export_id"]);
  assertShortProjectRequest({
    schema_version: request.schema_version,
    project_id: request.project_id,
  });
  if (
    typeof request.export_id !== "string" ||
    !exportIdPattern.test(request.export_id)
  )
    invalid();
}

export function assertShortClipsView(
  value: unknown,
): asserts value is ShortClipsView {
  const view = exact(value, [
    "status",
    "candidates",
    "job",
    "message",
    "library",
    "pick",
  ]);
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
      "origin",
    ]);
    if (item.origin !== "rules" && item.origin !== "ai") invalid();
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
    "batch",
  ]);
  if (
    !["idle", "running", "completed", "failed"].includes(job.status as string)
  )
    invalid();
  if (job.batch !== null) {
    const batch = exact(job.batch, ["index", "total"]);
    count(batch.index);
    count(batch.total);
    if (
      (batch.total as number) < 1 ||
      (batch.total as number) > 32 ||
      (batch.index as number) >= (batch.total as number)
    )
      invalid();
  }
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
  if (!Array.isArray(view.library) || view.library.length > 100) invalid();
  for (const entry of view.library) {
    const item = exact(entry, [
      "id",
      "title",
      "fileName",
      "format",
      "speed",
      "durationUs",
      "createdAt",
      "exists",
    ]);
    if (typeof item.id !== "string" || !exportIdPattern.test(item.id))
      invalid();
    text(item.title, 120);
    if (
      typeof item.fileName !== "string" ||
      item.fileName.length > 255 ||
      !/^[^\\/:\u0000-\u001f\u007f]+\.mp4$/u.test(item.fileName) ||
      !["vertical", "square", "landscape"].includes(item.format as string) ||
      (item.speed !== 1 && item.speed !== 2) ||
      typeof item.exists !== "boolean"
    )
      invalid();
    count(item.durationUs);
    text(item.createdAt, 40);
  }
  const pick = exact(view.pick, ["running", "message"]);
  if (typeof pick.running !== "boolean") invalid();
  message(pick.message);
}

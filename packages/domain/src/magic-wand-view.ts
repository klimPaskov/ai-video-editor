import { magicWandPresets, type MagicWandPreset } from "./magic-wand.ts";

/** Renderer-visible Magic Edit state; ranges and transcript text stay in main. */
export interface MagicWandSummary {
  removedUs: number;
  cuts: number;
  pauses: number;
  fillers: number;
  repeatedTakes: number;
  leftForReview: number;
}

export interface MagicWandView {
  status:
    "idle" | "transcribing" | "applying" | "completed" | "stopped" | "failed";
  projectId: string | null;
  preset: MagicWandPreset | null;
  /** 0..1 while transcribing or applying. */
  progress: number | null;
  summary: MagicWandSummary | null;
  message: string | null;
}

export interface MagicWandProjectRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface MagicWandStartRequest extends MagicWandProjectRequest {
  preset: MagicWandPreset;
}

export const magicWandIssues = Object.freeze({
  busy: "Magic Edit is already running for this project.",
  transcription:
    "Magic Edit needs a local transcript, and transcription did not finish. Try again from Auto Edit.",
  noAudio: "Magic Edit needs a video with spoken audio.",
  changed:
    "The draft changed while Magic Edit was running. Applied cuts are kept and can be undone.",
  failed:
    "Magic Edit could not finish. Applied cuts are kept and can be undone.",
  stopped: "Magic Edit stopped. Applied cuts are kept and can be undone.",
  nothing: "No safe cuts were found for this preset.",
} as const);

const messages = new Set<string>(Object.values(magicWandIssues));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalid(): never {
  throw new Error("Invalid Magic Edit exchange.");
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

function preset(value: unknown): asserts value is MagicWandPreset {
  if (!magicWandPresets.includes(value as MagicWandPreset)) invalid();
}

export function assertMagicWandProjectRequest(
  value: unknown,
): asserts value is MagicWandProjectRequest {
  const request = exact(value, ["schema_version", "project_id"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !idPattern.test(request.project_id)
  )
    invalid();
}

export function assertMagicWandStartRequest(
  value: unknown,
): asserts value is MagicWandStartRequest {
  const request = exact(value, ["schema_version", "project_id", "preset"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !idPattern.test(request.project_id)
  )
    invalid();
  preset(request.preset);
}

export function assertMagicWandView(
  value: unknown,
): asserts value is MagicWandView {
  const view = exact(value, [
    "status",
    "projectId",
    "preset",
    "progress",
    "summary",
    "message",
  ]);
  if (
    ![
      "idle",
      "transcribing",
      "applying",
      "completed",
      "stopped",
      "failed",
    ].includes(view.status as string)
  )
    invalid();
  if (
    view.projectId !== null &&
    (typeof view.projectId !== "string" || !idPattern.test(view.projectId))
  )
    invalid();
  if (view.preset !== null) preset(view.preset);
  if (
    view.progress !== null &&
    (typeof view.progress !== "number" ||
      !Number.isFinite(view.progress) ||
      view.progress < 0 ||
      view.progress > 1)
  )
    invalid();
  if (view.message !== null && !messages.has(view.message as string)) invalid();
  const running = view.status === "transcribing" || view.status === "applying";
  if (
    running !== (view.progress !== null) ||
    (view.status === "idle") !== (view.projectId === null) ||
    (view.status === "idle" &&
      (view.preset !== null ||
        view.summary !== null ||
        view.message !== null)) ||
    (view.status !== "idle" && view.preset === null) ||
    (view.status === "completed" && view.summary === null) ||
    ((view.status === "failed" || view.status === "stopped") &&
      view.message === null)
  )
    invalid();
  if (view.summary !== null) {
    const summary = exact(view.summary, [
      "removedUs",
      "cuts",
      "pauses",
      "fillers",
      "repeatedTakes",
      "leftForReview",
    ]);
    for (const key of Object.keys(summary)) count(summary[key]);
  }
}

export function idleMagicWandView(): MagicWandView {
  return {
    status: "idle",
    projectId: null,
    preset: null,
    progress: null,
    summary: null,
    message: null,
  };
}

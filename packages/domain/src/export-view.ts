/** Renderer-visible export state. Paths stay in main; only the file name is shown. */

export const exportProfiles = ["lossless_master", "smaller_mp4"] as const;
export type ExportProfileChoice = (typeof exportProfiles)[number];

export const exportIssues = Object.freeze({
  busy: "Another export is running. Wait for it or cancel it first.",
  inactive: "Open this project before exporting.",
  failed: "The export could not be completed. Your project is unchanged.",
  verification:
    "The exported file did not match the edited draft, so it was not saved.",
  cancelled: "Export cancelled. No file was saved.",
  storage:
    "The export finished but its record could not be saved. The file is in place.",
  tools: "FFmpeg is needed to export. Install FFmpeg and try again.",
} as const);

/** Fixed explanations for drafts the verified exporter refuses to convert. */
export const exportUnsupported = Object.freeze([
  "This video's pixel format cannot be exported losslessly yet.",
  "This video's dimensions cannot be exported.",
  "Non-square pixels cannot be exported yet.",
  "Interlaced video cannot be exported yet.",
  "Rotated video cannot be exported yet.",
  "Variable frame rate video cannot be exported yet.",
  "This video's frame timing cannot be verified.",
  "This audio format cannot be exported losslessly yet.",
  "Audio that starts after the video cannot be exported yet.",
  "This audio channel layout cannot be exported yet.",
  "These sources use different video or audio formats. Exporting them together needs a conversion that is not available yet.",
  "This draft has no exportable clips.",
  "This draft has no exportable frames.",
  "A clip has an invalid source range.",
  "A clip refers to an unknown source.",
  "This source has no video stream.",
  "This source cannot be read.",
] as const);

const messageSet = new Set<string>([
  ...Object.values(exportIssues),
  ...exportUnsupported,
]);

export interface ExportResultView {
  fileName: string;
  profile: ExportProfileChoice;
  durationUs: number;
  frameCount: number;
  outputBytes: number;
  /** Decoded output equals the canonical render (master only). */
  samplesEqual: boolean;
  draftSequence: number;
}

export interface ExportView {
  status: "idle" | "running" | "cancelling" | "completed" | "failed";
  projectId: string | null;
  profile: ExportProfileChoice | null;
  phase: "rendering" | "verifying" | null;
  /** Whole-export completion between 0 and 1 while running. */
  fraction: number | null;
  result: ExportResultView | null;
  message: string | null;
}

export interface ExportProjectRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface ExportStartRequest extends ExportProjectRequest {
  profile: ExportProfileChoice;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalid(): never {
  throw new Error("Invalid export exchange.");
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
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value as Record<string, unknown>;
}

function nonNegative(value: unknown): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid();
}

function profile(value: unknown): asserts value is ExportProfileChoice {
  if (!exportProfiles.includes(value as ExportProfileChoice)) invalid();
}

export function assertExportProjectRequest(
  value: unknown,
): asserts value is ExportProjectRequest {
  const request = exact(value, ["schema_version", "project_id"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !idPattern.test(request.project_id)
  )
    invalid();
}

export function assertExportStartRequest(
  value: unknown,
): asserts value is ExportStartRequest {
  const request = exact(value, ["schema_version", "project_id", "profile"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !idPattern.test(request.project_id)
  )
    invalid();
  profile(request.profile);
}

/** A file name only: no directory separators, control characters or drive. */
function fileName(value: unknown): void {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 255 ||
    /[\\/:\u0000-\u001f\u007f]/u.test(value) ||
    !/\.(mkv|mp4)$/iu.test(value)
  )
    invalid();
}

export function assertExportView(value: unknown): asserts value is ExportView {
  const view = exact(value, [
    "status",
    "projectId",
    "profile",
    "phase",
    "fraction",
    "result",
    "message",
  ]);
  if (
    !["idle", "running", "cancelling", "completed", "failed"].includes(
      view.status as string,
    )
  )
    invalid();
  if (
    view.projectId !== null &&
    (typeof view.projectId !== "string" || !idPattern.test(view.projectId))
  )
    invalid();
  if (view.profile !== null) profile(view.profile);
  if (
    view.phase !== null &&
    view.phase !== "rendering" &&
    view.phase !== "verifying"
  )
    invalid();
  if (
    view.fraction !== null &&
    (typeof view.fraction !== "number" ||
      !Number.isFinite(view.fraction) ||
      view.fraction < 0 ||
      view.fraction > 1)
  )
    invalid();
  if (view.message !== null && !messageSet.has(view.message as string))
    invalid();
  const running = view.status === "running" || view.status === "cancelling";
  if (
    running !== (view.fraction !== null) ||
    (view.status === "running") !== (view.phase !== null) ||
    (view.status === "completed") !== (view.result !== null) ||
    (view.status === "idle" &&
      (view.projectId !== null ||
        view.profile !== null ||
        view.message !== null)) ||
    (view.status !== "idle" &&
      (view.projectId === null || view.profile === null)) ||
    (view.status === "failed" && view.message === null)
  )
    invalid();
  if (view.result !== null) {
    const result = exact(view.result, [
      "fileName",
      "profile",
      "durationUs",
      "frameCount",
      "outputBytes",
      "samplesEqual",
      "draftSequence",
    ]);
    fileName(result.fileName);
    profile(result.profile);
    nonNegative(result.durationUs);
    nonNegative(result.frameCount);
    nonNegative(result.outputBytes);
    nonNegative(result.draftSequence);
    if (typeof result.samplesEqual !== "boolean") invalid();
    if (result.profile === "lossless_master" && result.samplesEqual !== true)
      invalid();
  }
}

export function idleExportView(): ExportView {
  return {
    status: "idle",
    projectId: null,
    profile: null,
    phase: null,
    fraction: null,
    result: null,
    message: null,
  };
}

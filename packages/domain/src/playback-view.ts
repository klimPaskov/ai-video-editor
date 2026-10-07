/** Whether the active project's preview can play, and proxy progress. */
export interface PlaybackView {
  status: "ready" | "preparing" | "failed";
  /** 0..1 while preparing playback copies. */
  progress: number | null;
  message: string | null;
}

export interface PlaybackProjectRequest {
  schema_version: "1.0";
  project_id: string;
}

export const playbackIssues = Object.freeze({
  failed:
    "Playback could not be prepared for this video. Frame preview and export still work.",
} as const);

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalid(): never {
  throw new Error("Invalid playback exchange.");
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

export function assertPlaybackProjectRequest(
  value: unknown,
): asserts value is PlaybackProjectRequest {
  const request = exact(value, ["schema_version", "project_id"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !idPattern.test(request.project_id)
  )
    invalid();
}

export function assertPlaybackView(
  value: unknown,
): asserts value is PlaybackView {
  const view = exact(value, ["status", "progress", "message"]);
  if (!["ready", "preparing", "failed"].includes(view.status as string))
    invalid();
  if (
    view.progress !== null &&
    (typeof view.progress !== "number" ||
      !Number.isFinite(view.progress) ||
      view.progress < 0 ||
      view.progress > 1)
  )
    invalid();
  if ((view.progress !== null) !== (view.status === "preparing")) invalid();
  if (view.message !== null && view.message !== playbackIssues.failed)
    invalid();
  if ((view.message !== null) !== (view.status === "failed")) invalid();
}

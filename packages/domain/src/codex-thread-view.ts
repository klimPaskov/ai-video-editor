export type CodexThreadStatus =
  | "closed"
  | "opening"
  | "ready"
  | "starting"
  | "running"
  | "interrupting"
  | "uncertain"
  | "failed";

export interface CodexThreadMessage {
  id: string;
  role: "user" | "codex";
  text: string;
  complete: boolean;
}

export interface CodexThreadActivity {
  id: string;
  kind: "activity" | "subagent" | "edit";
  label: string;
  complete: boolean;
}

export interface CodexThreadView {
  status: CodexThreadStatus;
  projectId: string | null;
  messages: CodexThreadMessage[];
  activities: CodexThreadActivity[];
  message: string | null;
  retryable: boolean;
}

export interface CodexThreadProjectRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface CodexThreadSendRequest extends CodexThreadProjectRequest {
  text: string;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalid(): never {
  throw new Error("Invalid Codex conversation state.");
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

function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value)) invalid();
}

function prose(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    invalid();
}

export function assertCodexThreadProjectRequest(
  value: unknown,
): asserts value is CodexThreadProjectRequest {
  const request = exact(value, ["schema_version", "project_id"]);
  if (request.schema_version !== "1.0") invalid();
  id(request.project_id);
}

export function assertCodexThreadSendRequest(
  value: unknown,
): asserts value is CodexThreadSendRequest {
  const request = exact(value, ["schema_version", "project_id", "text"]);
  if (request.schema_version !== "1.0") invalid();
  id(request.project_id);
  prose(request.text, 16 * 1024);
}

export function assertCodexThreadView(
  value: unknown,
): asserts value is CodexThreadView {
  const view = exact(value, [
    "status",
    "projectId",
    "messages",
    "activities",
    "message",
    "retryable",
  ]);
  if (
    ![
      "closed",
      "opening",
      "ready",
      "starting",
      "running",
      "interrupting",
      "uncertain",
      "failed",
    ].includes(view.status as string) ||
    !Array.isArray(view.messages) ||
    view.messages.length > 200 ||
    !Array.isArray(view.activities) ||
    view.activities.length > 32 ||
    typeof view.retryable !== "boolean"
  )
    invalid();
  if (view.projectId !== null) id(view.projectId);
  if (view.message !== null) prose(view.message, 240);
  const ids = new Set<string>();
  for (const raw of view.messages) {
    const message = exact(raw, ["id", "role", "text", "complete"]);
    id(message.id);
    if (
      ids.has(message.id as string) ||
      !["user", "codex"].includes(message.role as string) ||
      typeof message.complete !== "boolean"
    )
      invalid();
    prose(message.text, 64 * 1024, true);
    ids.add(message.id as string);
  }
  for (const raw of view.activities) {
    const activity = exact(raw, ["id", "kind", "label", "complete"]);
    id(activity.id);
    if (
      ids.has(activity.id as string) ||
      !["activity", "subagent", "edit"].includes(activity.kind as string) ||
      typeof activity.complete !== "boolean"
    )
      invalid();
    prose(activity.label, 128);
    ids.add(activity.id as string);
  }
  if (
    (view.status === "closed" &&
      (view.projectId !== null ||
        view.messages.length !== 0 ||
        view.activities.length !== 0 ||
        view.message !== null ||
        view.retryable)) ||
    (view.retryable &&
      (view.status !== "ready" ||
        !view.messages.some((message) => message.role === "user"))) ||
    (view.status !== "closed" && view.projectId === null)
  )
    invalid();
}

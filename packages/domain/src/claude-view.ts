/**
 * Path-free, credential-free projections of the Claude connection. Claude
 * runs through the user's unmodified Claude Code CLI; sign-in completes in
 * Anthropic's own browser flow and the app never reads the stored login.
 */

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeModelOption {
  value: string;
  label: string;
  detail: string;
  efforts: ClaudeEffort[];
}

export interface ClaudeSelection {
  model: string;
  effort: ClaudeEffort | null;
}

export interface ClaudeView {
  status:
    | "checking"
    | "unavailable"
    | "signed_out"
    | "signing_in"
    | "signed_in"
    | "error";
  version: string | null;
  account: {
    billing: "subscription" | "api" | "other";
    plan: string | null;
  } | null;
  models: ClaudeModelOption[];
  selection: ClaudeSelection | null;
  message: string | null;
}

export interface ClaudeThreadView {
  status: "closed" | "ready" | "running" | "interrupting" | "failed";
  projectId: string | null;
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>;
  activities: Array<{ id: string; label: string; complete: boolean }>;
  streaming: string | null;
  billing: "subscription" | "api" | "other" | null;
  message: string | null;
}

export interface ClaudeThreadProjectRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface ClaudeThreadSendRequest extends ClaudeThreadProjectRequest {
  text: string;
}

export const claudeEfforts: readonly ClaudeEffort[] = Object.freeze([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Fixed user-facing connection issues; raw CLI output never reaches the renderer. */
export const claudeIssues = Object.freeze({
  missing:
    "Claude Code was not found. Install it from Anthropic, then choose Check again.",
  outdated:
    "This Claude Code version is too old. Update Claude Code, then choose Check again.",
  runtime:
    "Claude Code could not be started. Check the installation, then choose Check again.",
  status: "Claude sign-in status could not be read. Choose Check again.",
  signInFailed:
    "Sign-in did not finish. Choose Sign in with Claude to try again.",
  catalog:
    "Claude models could not be loaded. Choose Check again to refresh them.",
  selection: "Choose a model offered by your Claude account.",
  storage:
    "Claude settings could not be saved. Check local storage and try again.",
} as const);

/** Fixed conversation issues shown in the AI drawer. */
export const claudeThreadIssues = Object.freeze({
  signIn: "Sign in to Claude in Settings to continue.",
  model: "Choose a Claude model in Settings to continue.",
  limit:
    "Your Claude usage limit was reached. Wait for it to reset, then send again.",
  account:
    "Claude account access is unavailable. Check your Claude account, then send again.",
  modelUnavailable:
    "The selected Claude model is unavailable. Choose another model in Settings.",
  failed: "Claude could not complete this turn. Send again to retry.",
  turns:
    "Claude stopped after reaching the step limit. Review the draft before continuing.",
  stopped: "This turn stopped. Review the current draft before sending again.",
  uncertain:
    "The edit may have been saved. Reopen the project before sending again.",
  tools:
    "Claude did not start with the editor's restricted tools. Update the app or Claude Code, then try again.",
  resume:
    "The earlier Claude conversation could not be resumed. Your next message starts a new conversation.",
  storage:
    "The conversation could not be saved. Check local storage and reopen the project.",
} as const);

const issueSet = new Set<string>(Object.values(claudeIssues));
const threadIssueSet = new Set<string>(Object.values(claudeThreadIssues));
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/u;
const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/u;
const planPattern = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/u;

function invalid(): never {
  throw new Error("Invalid Claude exchange.");
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

function prose(value: unknown, maximum: number, empty = false): void {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    invalid();
}

function effort(value: unknown): asserts value is ClaudeEffort {
  if (!claudeEfforts.includes(value as ClaudeEffort)) invalid();
}

export function assertClaudeSelection(
  value: unknown,
): asserts value is ClaudeSelection {
  const selection = exact(value, ["model", "effort"]);
  if (
    typeof selection.model !== "string" ||
    !modelPattern.test(selection.model)
  )
    invalid();
  if (selection.effort !== null) effort(selection.effort);
}

export function assertClaudeView(value: unknown): asserts value is ClaudeView {
  const view = exact(value, [
    "status",
    "version",
    "account",
    "models",
    "selection",
    "message",
  ]);
  if (
    ![
      "checking",
      "unavailable",
      "signed_out",
      "signing_in",
      "signed_in",
      "error",
    ].includes(view.status as string) ||
    !Array.isArray(view.models) ||
    view.models.length > 32
  )
    invalid();
  if (
    view.version !== null &&
    (typeof view.version !== "string" || !versionPattern.test(view.version))
  )
    invalid();
  if (view.account !== null) {
    const account = exact(view.account, ["billing", "plan"]);
    if (!["subscription", "api", "other"].includes(account.billing as string))
      invalid();
    if (
      account.plan !== null &&
      (typeof account.plan !== "string" || !planPattern.test(account.plan))
    )
      invalid();
  }
  const values = new Set<string>();
  for (const raw of view.models) {
    const model = exact(raw, ["value", "label", "detail", "efforts"]);
    if (
      typeof model.value !== "string" ||
      !modelPattern.test(model.value) ||
      values.has(model.value) ||
      !Array.isArray(model.efforts) ||
      model.efforts.length > claudeEfforts.length
    )
      invalid();
    values.add(model.value);
    prose(model.label, 64);
    prose(model.detail, 160, true);
    for (const level of model.efforts) effort(level);
  }
  if (view.selection !== null) {
    assertClaudeSelection(view.selection);
    if (view.status !== "signed_in") invalid();
  }
  if (view.message !== null && !issueSet.has(view.message as string)) invalid();
  if (
    (view.status === "signed_in") !== (view.account !== null) ||
    (view.models.length !== 0 && view.status !== "signed_in") ||
    (view.version === null &&
      !["checking", "unavailable", "error"].includes(view.status as string))
  )
    invalid();
}

function projectId(value: unknown): void {
  if (typeof value !== "string" || !idPattern.test(value)) invalid();
}

export function assertClaudeThreadProjectRequest(
  value: unknown,
): asserts value is ClaudeThreadProjectRequest {
  const request = exact(value, ["schema_version", "project_id"]);
  if (request.schema_version !== "1.0") invalid();
  projectId(request.project_id);
}

export function assertClaudeThreadSendRequest(
  value: unknown,
): asserts value is ClaudeThreadSendRequest {
  const request = exact(value, ["schema_version", "project_id", "text"]);
  if (request.schema_version !== "1.0") invalid();
  projectId(request.project_id);
  prose(request.text, 16 * 1024);
}

export const maxClaudeThreadMessages = 48;

export function assertClaudeThreadView(
  value: unknown,
): asserts value is ClaudeThreadView {
  const view = exact(value, [
    "status",
    "projectId",
    "messages",
    "activities",
    "streaming",
    "billing",
    "message",
  ]);
  if (
    !["closed", "ready", "running", "interrupting", "failed"].includes(
      view.status as string,
    ) ||
    !Array.isArray(view.messages) ||
    view.messages.length > maxClaudeThreadMessages ||
    !Array.isArray(view.activities) ||
    view.activities.length > 32
  )
    invalid();
  if (view.projectId !== null) projectId(view.projectId);
  if (
    view.billing !== null &&
    !["subscription", "api", "other"].includes(view.billing as string)
  )
    invalid();
  if (view.streaming !== null) prose(view.streaming, 32 * 1024, true);
  if (view.message !== null && !threadIssueSet.has(view.message as string))
    invalid();
  if (
    (view.status === "closed" &&
      (view.projectId !== null ||
        view.messages.length !== 0 ||
        view.activities.length !== 0 ||
        view.streaming !== null ||
        view.billing !== null ||
        view.message !== null)) ||
    (view.status !== "closed" && view.projectId === null) ||
    (view.streaming !== null &&
      view.status !== "running" &&
      view.status !== "interrupting")
  )
    invalid();
  const ids = new Set<string>();
  for (const raw of view.messages) {
    const message = exact(raw, ["id", "role", "text"]);
    projectId(message.id);
    if (
      ids.has(message.id as string) ||
      !["user", "assistant"].includes(message.role as string)
    )
      invalid();
    prose(message.text, message.role === "assistant" ? 32 * 1024 : 16 * 1024);
    ids.add(message.id as string);
  }
  const activityIds = new Set<string>();
  for (const raw of view.activities) {
    const activity = exact(raw, ["id", "label", "complete"]);
    projectId(activity.id);
    if (
      activityIds.has(activity.id as string) ||
      typeof activity.complete !== "boolean"
    )
      invalid();
    prose(activity.label, 80);
    activityIds.add(activity.id as string);
  }
}

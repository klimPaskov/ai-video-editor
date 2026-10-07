import type { DynamicToolCallParams } from "./generated/v2/DynamicToolCallParams.ts";
import type { DynamicToolCallResponse } from "./generated/v2/DynamicToolCallResponse.ts";
import type { DynamicToolSpec } from "./generated/v2/DynamicToolSpec.ts";
import type { JsonValue } from "./generated/serde_json/JsonValue.ts";
import { CodexThreadProtocolError } from "./thread-protocol.ts";
import { codexVideoEditMcpTools } from "../../codex-tools/src/mcp-tools.ts";
import {
  CodexVideoEditToolError,
  type CodexVideoEditToolName,
} from "../../codex-tools/src/service.ts";

export const CODEX_EDITOR_NAMESPACE = "codex_video_edit";
export type DynamicToolAccess = "project_editor" | "native_child_read_only";
export const nativeChildReadOnlyToolNames: ReadonlySet<CodexVideoEditToolName> =
  new Set(["project.get_summary", "timeline.get_summary"]);
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

/** Stable wire names, independent of the internal dotted service API. */
const dynamicNames: Record<CodexVideoEditToolName, string> = {
  "project.get_summary": "project_get_summary",
  "timeline.get_summary": "timeline_get_summary",
  "cut.trim_edge": "cut_trim_edge",
  "cut.split": "cut_split",
  "cut.delete_range": "cut_delete_range",
  "cut.delete_ranges": "cut_delete_ranges",
  "timeline.undo": "timeline_undo",
  "cut.restore_range": "cut_restore_range",
  "transcript.get_range": "transcript_get_range",
};
const internalNames = new Map(
  Object.entries(dynamicNames).map(([internal, wire]) => [
    wire,
    internal as CodexVideoEditToolName,
  ]),
);

export function ownedDynamicToolWireNames(): Set<string> {
  return new Set(internalNames.keys());
}

/** Bind model-visible identity to the main-owned project selected for this thread. */
export function buildCodexVideoEditDynamicTools(
  activeProjectId: string,
): DynamicToolSpec[] {
  if (!validIdentifier(activeProjectId))
    throw new CodexThreadProtocolError("configuration");
  return [
    {
      type: "namespace",
      name: CODEX_EDITOR_NAMESPACE,
      description: "Application-owned reversible video editor tools.",
      tools: codexVideoEditMcpTools.map((tool) => ({
        type: "function" as const,
        name: dynamicNames[tool.name],
        description: tool.description,
        inputSchema: bindProjectIdSchema(tool.inputSchema, activeProjectId),
      })),
    },
  ];
}

function bindProjectIdSchema(
  inputSchema: unknown,
  projectId: string,
): JsonValue {
  const schema: unknown = structuredClone(inputSchema);
  if (
    !record(schema) ||
    !record(schema.properties) ||
    !record(schema.properties.project_id)
  )
    throw new CodexThreadProtocolError("configuration");
  schema.properties.project_id = {
    ...schema.properties.project_id,
    const: projectId,
  };
  return schema as unknown as JsonValue;
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

export interface OwnedDynamicToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  name: CodexVideoEditToolName;
  arguments: Record<string, unknown>;
}

/** Reject anything outside the pinned request shape before invoking main-owned work. */
export function decodeOwnedDynamicToolCall(
  value: unknown,
): OwnedDynamicToolCall {
  const keys = [
    "threadId",
    "turnId",
    "callId",
    "namespace",
    "tool",
    "arguments",
  ] as const;
  if (
    !record(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    !validIdentifier(value.threadId) ||
    !validIdentifier(value.turnId) ||
    !validIdentifier(value.callId) ||
    value.namespace !== CODEX_EDITOR_NAMESPACE ||
    typeof value.tool !== "string" ||
    !internalNames.has(value.tool) ||
    !record(value.arguments)
  )
    throw new CodexThreadProtocolError("forbidden");
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(value.arguments));
  } catch {
    throw new CodexThreadProtocolError("protocol");
  }
  if (size > MAX_INPUT_BYTES) throw new CodexThreadProtocolError("forbidden");
  const params = value as DynamicToolCallParams;
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    callId: params.callId,
    name: internalNames.get(params.tool)!,
    arguments: value.arguments,
  };
}

function response(text: string, success: boolean): DynamicToolCallResponse {
  return { contentItems: [{ type: "inputText", text }], success };
}

function safeError(
  value: CodexVideoEditToolError["code"] | CodexVideoEditToolError,
): DynamicToolCallResponse {
  // Only the service's own fixed messages (plus a validated project ID) reach
  // the model; any other failure was already mapped to a fixed code.
  const error =
    value instanceof CodexVideoEditToolError
      ? value
      : new CodexVideoEditToolError(value);
  return response(
    JSON.stringify({ error: { code: error.code, message: error.message } }),
    false,
  );
}

/** A rejected edit is a safe model-visible result; a malformed call is never dispatched. */
export async function invokeOwnedDynamicTool(
  call: OwnedDynamicToolCall,
  invoke: (
    name: CodexVideoEditToolName,
    input: unknown,
    access: DynamicToolAccess,
  ) => Promise<unknown>,
  access: DynamicToolAccess = "project_editor",
): Promise<DynamicToolCallResponse> {
  try {
    const value = await invoke(call.name, call.arguments, access);
    const text = JSON.stringify(value);
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_OUTPUT_BYTES)
      return safeError("outcome_unknown");
    return response(text, true);
  } catch (cause) {
    return safeError(
      cause instanceof CodexVideoEditToolError ? cause : "service_unavailable",
    );
  }
}

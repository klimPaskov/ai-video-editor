import assert from "node:assert/strict";
import { test } from "node:test";
import { codexVideoEditMcpTools } from "../../packages/codex-tools/src/mcp-tools.ts";
import { CodexVideoEditToolError } from "../../packages/codex-tools/src/service.ts";
import {
  buildCodexVideoEditDynamicTools,
  decodeOwnedDynamicToolCall,
  invokeOwnedDynamicTool,
} from "../../packages/codex-bridge/src/dynamic-tools.ts";
import { CodexThreadProtocolError } from "../../packages/codex-bridge/src/thread-protocol.ts";
import type { DynamicToolCallResponse } from "../../packages/codex-bridge/src/generated/v2/DynamicToolCallResponse.ts";

const request = () => ({
  threadId: "thread-1",
  turnId: "turn-1",
  callId: "call-1",
  namespace: "codex_video_edit",
  tool: "cut_trim_edge",
  arguments: { schema_version: "1.0", project_id: "project-1" },
});

function outputText(response: DynamicToolCallResponse): string {
  const item = response.contentItems[0];
  assert.equal(item?.type, "inputText");
  if (item?.type !== "inputText") throw new Error("Expected text result");
  return item.text;
}

test("host-defined namespace exposes exactly the reviewed nine guarded schemas", () => {
  const projectId = "project-1";
  const specs = buildCodexVideoEditDynamicTools(projectId);
  assert.equal(specs.length, 1);
  const namespace = specs[0]!;
  assert.equal(namespace.type, "namespace");
  if (namespace.type !== "namespace") throw new Error("Expected namespace");
  assert.equal(namespace.name, "codex_video_edit");
  assert.deepEqual(
    namespace.tools.map((tool) => tool.name),
    [
      "project_get_summary",
      "timeline_get_summary",
      "cut_trim_edge",
      "cut_split",
      "cut_delete_range",
      "timeline_undo",
      "cut_delete_ranges",
      "cut_restore_range",
      "transcript_get_range",
    ],
  );
  for (const [index, tool] of namespace.tools.entries()) {
    const normalized = structuredClone(tool.inputSchema) as {
      properties: Record<string, Record<string, unknown>>;
    };
    assert.equal(normalized.properties.project_id?.const, projectId);
    delete normalized.properties.project_id.const;
    assert.deepEqual(normalized, codexVideoEditMcpTools[index]!.inputSchema);
    assert.equal(tool.description, codexVideoEditMcpTools[index]!.description);
  }
  assert.throws(
    () => buildCodexVideoEditDynamicTools("../other-project"),
    (error: unknown) =>
      error instanceof CodexThreadProtocolError &&
      error.code === "configuration",
  );
  namespace.tools[0]!.name = "tampered";
  assert.equal(
    (buildCodexVideoEditDynamicTools(projectId)[0] as typeof namespace)
      .tools[0]!.name,
    "project_get_summary",
  );
});

test("foreign, malformed and oversized host calls never reach the editor", () => {
  const valid = request();
  assert.equal(decodeOwnedDynamicToolCall(valid).name, "cut.trim_edge");
  const invalid = [
    { ...valid, namespace: "foreign" },
    { ...valid, tool: "exec_command" },
    { ...valid, threadId: "" },
    { ...valid, turnId: "turn\n2" },
    { ...valid, callId: "" },
    { ...valid, extra: "outside contract" },
    { ...valid, arguments: ["unexpected"] },
    { ...valid, arguments: { body: "x".repeat(17 * 1024) } },
  ];
  for (const value of invalid)
    assert.throws(
      () => decodeOwnedDynamicToolCall(value),
      CodexThreadProtocolError,
    );
  assert.throws(
    () => decodeOwnedDynamicToolCall(Object.create(null)),
    CodexThreadProtocolError,
  );
});

test("owned responses are bounded and only safe application errors reach the model", async () => {
  const call = decodeOwnedDynamicToolCall(request());
  let invoked = 0;
  const committed = await invokeOwnedDynamicTool(call, async (name, input) => {
    invoked++;
    assert.equal(name, "cut.trim_edge");
    assert.deepEqual(input, request().arguments);
    return { status: "committed", draft_sequence: 2 };
  });
  assert.equal(invoked, 1);
  assert.deepEqual(committed, {
    contentItems: [
      {
        type: "inputText",
        text: '{"status":"committed","draft_sequence":2}',
      },
    ],
    success: true,
  });
  const stale = await invokeOwnedDynamicTool(call, async () => {
    throw new CodexVideoEditToolError("stale_draft");
  });
  assert.equal(stale.success, false);
  assert.match(outputText(stale), /stale_draft/u);
  const secret = "private-internal-exception-marker";
  const unknown = await invokeOwnedDynamicTool(call, async () => {
    throw new Error(secret);
  });
  assert.equal(unknown.success, false);
  assert.doesNotMatch(outputText(unknown), /private-internal/u);
  assert.match(outputText(unknown), /service_unavailable/u);
  const oversized = await invokeOwnedDynamicTool(call, async () => ({
    data: "x".repeat(257 * 1024),
  }));
  assert.equal(oversized.success, false);
  assert.match(outputText(oversized), /outcome_unknown/u);
  const mistyped = await invokeOwnedDynamicTool(call, async () => {
    throw new CodexVideoEditToolError("inactive_project", "project-1");
  });
  assert.equal(mistyped.success, false);
  assert.deepEqual(JSON.parse(outputText(mistyped)), {
    error: {
      code: "inactive_project",
      message:
        'That project is not the active project. The active project_id is "project-1".',
    },
  });
});

test("only a valid active project ID is added to the refusal", () => {
  for (const unsafe of ["", "../x", 'a"b', "x".repeat(200)])
    assert.equal(
      new CodexVideoEditToolError("inactive_project", unsafe).message,
      "That project is not the active project.",
    );
  assert.equal(
    new CodexVideoEditToolError("stale_draft", "project-1").message,
    "The draft changed before this edit could be applied. Refresh and try again.",
  );
});

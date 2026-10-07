import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { CodexProjectThreadClient } from "../../packages/codex-bridge/src/thread-client.ts";
import { CodexThreadProtocolError } from "../../packages/codex-bridge/src/thread-protocol.ts";
import { ProjectThreadRegistry } from "../../packages/codex-bridge/src/thread-registry.ts";
import type { DynamicToolAccess } from "../../packages/codex-bridge/src/dynamic-tools.ts";
import type {
  ThreadHistorySnapshot,
  ThreadStreamEvent,
} from "../../packages/codex-bridge/src/thread-stream.ts";
import { CodexTransportError } from "../../packages/codex-bridge/src/transport.ts";
import type { CodexVideoEditToolName } from "../../packages/codex-tools/src/service.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";

const policy = {
  cwd: resolve("test-results", "codex-thread-context"),
  model: "runtime-model",
  effort: "high",
};

async function fixture(
  onEvent?: (event: ThreadStreamEvent) => void,
  dynamicToolInvoker?: (
    name: CodexVideoEditToolName,
    input: unknown,
    access: DynamicToolAccess,
  ) => Promise<unknown>,
) {
  const parent = resolve("test-results", "codex-thread-client");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-"));
  const registry = await ProjectThreadRegistry.open(root);
  const events: ThreadStreamEvent[] = [];
  const calls: Array<{ method: string; params: unknown }> = [];
  let handler: (method: string, params: unknown) => Promise<unknown> = async (
    method,
    params,
  ) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "thread/start") return threadResponse("thread-1");
    throw new Error("Unexpected RPC");
  };
  const rpc = {
    request: (method: string, params: unknown) => handler(method, params),
  };
  let nextId = 0;
  const client = new CodexProjectThreadClient({
    rpc,
    generation: 1,
    projectId: "project-1",
    policy,
    registry,
    allowedMcpServer: appIdentity.stableMcpServerId,
    allowedMcpTools: new Set(["cut.trim_edge", "timeline.undo"]),
    ...(dynamicToolInvoker ? { dynamicToolInvoker } : {}),
    onEvent: (event) => {
      events.push(event);
      onEvent?.(event);
    },
    clientMessageId: () => `message-${++nextId}`,
  });
  return {
    root,
    registry,
    client,
    calls,
    events,
    setHandler: (
      next: (method: string, params: unknown) => Promise<unknown>,
    ) => {
      handler = async (method, params) => {
        calls.push({ method, params: structuredClone(params) });
        return next(method, params);
      };
    },
  };
}

function threadResponse(threadId: string) {
  return {
    thread: { id: threadId, ephemeral: false, status: { type: "idle" } },
    model: policy.model,
    modelProvider: "openai",
    cwd: policy.cwd,
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
  };
}

function turnResponse(turnId: string, status = "inProgress") {
  return { turn: { id: turnId, status, items: [] } };
}

test("typed client creates then resumes the one registry-owned project thread", async () => {
  const first = await fixture();
  try {
    await first.client.open();
    assert.equal(first.calls[0]?.method, "thread/start");
    assert.deepEqual(
      (first.calls[0]?.params as { environments: unknown }).environments,
      [],
    );
    const resumedCalls: Array<{ method: string; params: unknown }> = [];
    const resumed = new CodexProjectThreadClient({
      rpc: {
        request: async (method, params) => {
          resumedCalls.push({ method, params });
          return {
            ...threadResponse("thread-1"),
            initialTurnsPage: {
              data: [],
              nextCursor: null,
              backwardsCursor: null,
            },
          };
        },
      },
      generation: 2,
      projectId: "project-1",
      policy,
      registry: first.registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["cut.trim_edge"]),
    });
    await resumed.open();
    assert.equal(resumedCalls[0]?.method, "thread/resume");
    assert.equal(resumedCalls.length, 1);
    assert.equal("environments" in (resumedCalls[0]?.params as object), false);
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("legacy MCP bindings cannot be silently routed through host tools", async () => {
  const first = await fixture();
  try {
    await first.client.open();
    assert.equal(
      (await first.registry.bindingForProject("project-1"))?.toolRoute,
      "mcp",
    );
    let invoked = 0;
    const resumed = new CodexProjectThreadClient({
      rpc: {
        request: async (method) => {
          if (method === "thread/resume")
            return {
              ...threadResponse("thread-1"),
              initialTurnsPage: { data: [], nextCursor: null },
            };
          if (method === "turn/start") return turnResponse("legacy-turn");
          throw new Error("Unexpected RPC");
        },
      },
      generation: 2,
      projectId: "project-1",
      policy,
      registry: first.registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["project.get_summary"]),
      dynamicToolInvoker: async () => {
        invoked++;
        return { status: "unexpected" };
      },
    });
    await resumed.open();
    await resumed.startTurn({ text: "Read the legacy project" });
    assert.throws(
      () =>
        resumed.serverRequest({
          id: "legacy-host-call",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "legacy-turn",
            callId: "legacy-call",
            namespace: "codex_video_edit",
            tool: "project_get_summary",
            arguments: { schema_version: "1.0", project_id: "project-1" },
          },
          signal: new AbortController().signal,
        }),
      CodexThreadProtocolError,
    );
    assert.equal(invoked, 0);
    assert.equal(
      (await first.registry.bindingForProject("project-1"))?.toolRoute,
      "mcp",
    );
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("a dynamic binding resumes only with its host-tool boundary", async () => {
  const first = await fixture(undefined, async () => ({ status: "read" }));
  try {
    await first.client.open();
    const calls: string[] = [];
    let invoked = 0;
    const rpc = {
      request: async (method: string) => {
        calls.push(method);
        if (method === "thread/resume")
          return {
            ...threadResponse("thread-1"),
            initialTurnsPage: { data: [], nextCursor: null },
          };
        if (method === "turn/start") return turnResponse("dynamic-resumed");
        throw new Error("Unexpected RPC");
      },
    };
    const resumed = new CodexProjectThreadClient({
      rpc,
      generation: 2,
      projectId: "project-1",
      policy,
      registry: first.registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["project.get_summary"]),
      dynamicToolInvoker: async () => {
        invoked++;
        return { status: "read" };
      },
    });
    await resumed.open();
    assert.deepEqual(calls, ["thread/resume"]);
    await resumed.startTurn({ text: "Read the draft" });
    const result = (await resumed.serverRequest({
      id: "resumed-host-call",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "dynamic-resumed",
        callId: "resumed-call",
        namespace: "codex_video_edit",
        tool: "project_get_summary",
        arguments: { schema_version: "1.0", project_id: "project-1" },
      },
      signal: new AbortController().signal,
    })) as { success: boolean };
    assert.equal(result.success, true);
    assert.equal(invoked, 1);
    const incompatible = new CodexProjectThreadClient({
      rpc,
      generation: 3,
      projectId: "project-1",
      policy,
      registry: first.registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["project.get_summary"]),
    });
    await assert.rejects(incompatible.open(), CodexThreadProtocolError);
    assert.deepEqual(calls, ["thread/resume", "turn/start"]);
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("native child dynamic calls require correlated lineage and are read-only", async () => {
  const accessModes: DynamicToolAccess[] = [];
  const value = await fixture(undefined, async (_name, _input, access) => {
    accessModes.push(access);
    return { status: "read" };
  });
  try {
    await value.client.open();
    value.setHandler(async (method) => {
      assert.equal(method, "turn/start");
      return turnResponse("parent-turn");
    });
    await value.client.startTurn({ text: "Inspect the active project" });
    value.client.notification("item/started", {
      threadId: "thread-1",
      turnId: "parent-turn",
      startedAtMs: 1,
      item: {
        type: "collabAgentToolCall",
        id: "spawn-call",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: "thread-1",
        receiverThreadIds: ["child-1"],
        prompt: null,
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      },
    });
    value.client.notification("thread/started", {
      thread: {
        id: "child-1",
      },
    });
    value.client.notification("turn/started", {
      threadId: "child-1",
      turn: { id: "child-turn", status: "inProgress", items: [] },
    });

    const read = (threadId: string, turnId: string, tool: string) =>
      value.client.serverRequest({
        id: `tool-${threadId}-${tool}`,
        method: "item/tool/call",
        params: {
          threadId,
          turnId,
          callId: `call-${threadId}-${tool}`,
          namespace: "codex_video_edit",
          tool,
          arguments: { schema_version: "1.0", project_id: "project-1" },
        },
        signal: new AbortController().signal,
      });
    const result = (await read(
      "child-1",
      "child-turn",
      "project_get_summary",
    )) as { success: boolean };
    assert.equal(result.success, true);
    assert.deepEqual(accessModes, ["native_child_read_only"]);
    assert.equal(
      value.calls.some(({ method }) => method === "thread/read"),
      false,
    );

    const denied = (await read("child-1", "child-turn", "cut_trim_edge")) as {
      success: boolean;
      contentItems: Array<{ text: string }>;
    };
    assert.equal(denied.success, false);
    assert.match(denied.contentItems[0]!.text, /tool_not_available/u);
    assert.deepEqual(accessModes, ["native_child_read_only"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("V2 native child reads require parent-owned subagent activity", async () => {
  const accessModes: DynamicToolAccess[] = [];
  const value = await fixture(undefined, async (_name, _input, access) => {
    accessModes.push(access);
    return { status: "read" };
  });
  try {
    await value.client.open();
    value.setHandler(async (method) => {
      assert.equal(method, "turn/start");
      return turnResponse("parent-turn");
    });
    await value.client.startTurn({ text: "Inspect the active project" });
    value.client.notification("item/started", {
      threadId: "thread-1",
      turnId: "parent-turn",
      startedAtMs: 1,
      item: {
        type: "subAgentActivity",
        id: "v2-spawn-call",
        kind: "started",
        agentThreadId: "child-1",
        agentPath: "/private/child",
      },
    });
    value.client.notification("turn/started", {
      threadId: "child-1",
      turn: { id: "child-turn", status: "inProgress", items: [] },
    });
    const request = (threadId: string, turnId: string) =>
      value.client.serverRequest({
        id: `v2-child-read-${threadId}`,
        method: "item/tool/call",
        params: {
          threadId,
          turnId,
          callId: `v2-call-${threadId}`,
          namespace: "codex_video_edit",
          tool: "project_get_summary",
          arguments: { schema_version: "1.0", project_id: "project-1" },
        },
        signal: new AbortController().signal,
      });
    const read = (await request("child-1", "child-turn")) as {
      success: boolean;
    };
    assert.equal(read.success, true);
    assert.deepEqual(accessModes, ["native_child_read_only"]);

    value.client.notification("item/started", {
      threadId: "child-1",
      turnId: "child-turn",
      startedAtMs: 2,
      item: {
        type: "subAgentActivity",
        id: "nested-spawn-call",
        kind: "started",
        agentThreadId: "grandchild-1",
        agentPath: "/private/grandchild",
      },
    });
    assert.throws(
      () => request("grandchild-1", "grandchild-turn"),
      CodexThreadProtocolError,
    );
    assert.deepEqual(accessModes, ["native_child_read_only"]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("completed native spawn results correlate the returned child thread", async () => {
  const accessModes: DynamicToolAccess[] = [];
  const value = await fixture(undefined, async (_name, _input, access) => {
    accessModes.push(access);
    return { status: "read" };
  });
  try {
    await value.client.open();
    let resolveStart!: (response: unknown) => void;
    let startSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => {
      startSubmitted = resolve;
    });
    value.setHandler(async (method) => {
      assert.equal(method, "turn/start");
      startSubmitted();
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    });
    const start = value.client.startTurn({
      text: "Inspect the active project",
    });
    await submitted;
    value.client.notification("thread/started", {
      thread: {
        id: "child-1",
        parentThreadId: "thread-1",
        ephemeral: false,
      },
    });
    value.client.notification("turn/started", {
      threadId: "thread-1",
      turn: { id: "parent-turn", status: "inProgress", items: [] },
    });
    const spawn = (status: "inProgress" | "completed", receivers: string[]) =>
      value.client.notification(
        status === "inProgress" ? "item/started" : "item/completed",
        {
          threadId: "thread-1",
          turnId: "parent-turn",
          ...(status === "inProgress"
            ? { startedAtMs: 1 }
            : { completedAtMs: 2 }),
          item: {
            type: "collabAgentToolCall",
            id: "spawn-call",
            tool: "spawnAgent",
            status,
            senderThreadId: "thread-1",
            receiverThreadIds: receivers,
            prompt: null,
            model: null,
            reasoningEffort: null,
            agentsStates: {},
          },
        },
      );
    spawn("inProgress", []);
    value.client.notification("turn/started", {
      threadId: "child-1",
      turn: { id: "child-turn", status: "inProgress", items: [] },
    });
    spawn("completed", ["child-1"]);
    const parentEventCount = value.events.length;
    value.client.notification("item/started", {
      threadId: "child-1",
      turnId: "child-turn",
      startedAtMs: 1,
      item: { id: "child-message", type: "agentMessage" },
    });
    value.client.notification("item/agentMessage/delta", {
      threadId: "child-1",
      turnId: "child-turn",
      itemId: "child-message",
      delta: "Read-only result",
    });
    value.client.notification("item/completed", {
      threadId: "child-1",
      turnId: "child-turn",
      completedAtMs: 2,
      item: { id: "child-message", type: "agentMessage" },
    });
    assert.equal(value.events.length, parentEventCount);
    const result = (await value.client.serverRequest({
      id: "completed-spawn-child-read",
      method: "item/tool/call",
      params: {
        threadId: "child-1",
        turnId: "child-turn",
        callId: "completed-spawn-child-read-call",
        namespace: "codex_video_edit",
        tool: "project_get_summary",
        arguments: { schema_version: "1.0", project_id: "project-1" },
      },
      signal: new AbortController().signal,
    })) as { success: boolean };
    assert.equal(result.success, true);
    assert.deepEqual(accessModes, ["native_child_read_only"]);
    resolveStart(turnResponse("parent-turn"));
    await start;
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("native child reads remain correlated before the parent turn/start response", async () => {
  const accessModes: DynamicToolAccess[] = [];
  const value = await fixture(undefined, async (_name, _input, access) => {
    accessModes.push(access);
    return { status: "read" };
  });
  try {
    await value.client.open();
    let resolveStart!: (response: unknown) => void;
    let startSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => {
      startSubmitted = resolve;
    });
    value.setHandler(async (method) => {
      assert.equal(method, "turn/start");
      startSubmitted();
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    });
    const start = value.client.startTurn({ text: "Inspect this project" });
    await submitted;
    value.client.notification("item/started", {
      threadId: "thread-1",
      turnId: "parent-turn",
      startedAtMs: 1,
      item: {
        type: "subAgentActivity",
        id: "spawn-call",
        kind: "started",
        agentThreadId: "child-1",
        agentPath: "/private/child",
      },
    });
    value.client.notification("thread/started", {
      thread: {
        id: "child-1",
        parentThreadId: "thread-1",
        ephemeral: false,
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: "thread-1",
              depth: 1,
              agent_path: null,
              agent_nickname: null,
              agent_role: null,
            },
          },
        },
      },
    });
    value.client.notification("turn/started", {
      threadId: "child-1",
      turn: { id: "child-turn", status: "inProgress", items: [] },
    });
    const read = await value.client.serverRequest({
      id: "early-child-read",
      method: "item/tool/call",
      params: {
        threadId: "child-1",
        turnId: "child-turn",
        callId: "early-child-read-call",
        namespace: "codex_video_edit",
        tool: "project_get_summary",
        arguments: { schema_version: "1.0", project_id: "project-1" },
      },
      signal: new AbortController().signal,
    });
    assert.deepEqual(read, {
      contentItems: [
        { type: "inputText", text: JSON.stringify({ status: "read" }) },
      ],
      success: true,
    });
    assert.deepEqual(accessModes, ["native_child_read_only"]);
    resolveStart(turnResponse("parent-turn"));
    await start;
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("resume uses one bounded history fallback and emits only a safe projection", async () => {
  const first = await fixture();
  try {
    await first.client.open();
    const histories: ThreadHistorySnapshot[] = [];
    const calls: Array<{ method: string; params: unknown }> = [];
    const resumed = new CodexProjectThreadClient({
      rpc: {
        request: async (method, params) => {
          calls.push({ method, params: structuredClone(params) });
          if (method === "thread/resume")
            return { ...threadResponse("thread-1"), initialTurnsPage: null };
          assert.equal(method, "thread/turns/list");
          return {
            data: [
              {
                id: "turn-1",
                items: [
                  {
                    type: "userMessage",
                    id: "user-1",
                    clientId: "client-1",
                    content: [
                      {
                        type: "text",
                        text: "Trim C:\\Users\\person\\private.mov",
                        text_elements: [],
                      },
                    ],
                  },
                  {
                    type: "agentMessage",
                    id: "agent-1",
                    text: "The edit is committed for private@example.test",
                    phase: null,
                    memoryCitation: null,
                  },
                ],
                status: "completed",
              },
            ],
            nextCursor: "ignored-older-cursor",
            backwardsCursor: "ignored-newer-cursor",
          };
        },
      },
      generation: 2,
      projectId: "project-1",
      policy,
      registry: first.registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["cut.trim_edge"]),
      onHistory: (history) => histories.push(history),
    });
    await resumed.open();
    assert.deepEqual(
      calls.map((call) => call.method),
      ["thread/resume", "thread/turns/list"],
    );
    assert.deepEqual(calls[1]?.params, {
      threadId: "thread-1",
      limit: 100,
      sortDirection: "desc",
      itemsView: "full",
    });
    assert.equal(histories.length, 1);
    assert.deepEqual(
      histories[0]?.messages.map(({ role, complete }) => ({ role, complete })),
      [
        { role: "user", complete: true },
        { role: "codex", complete: true },
      ],
    );
    assert.ok(!JSON.stringify(histories).includes("Users"));
    assert.ok(!JSON.stringify(histories).includes("example.test"));
    assert.ok(!JSON.stringify(histories).includes("cursor"));
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("resumed active history remains interruptible before buffered events flush", async () => {
  const first = await fixture();
  try {
    await first.client.open();
    const calls: string[] = [];
    let notifyDuringResume: () => void = () => {
      throw new Error("Resume notification hook was not initialized");
    };
    const resumed = new CodexProjectThreadClient({
      rpc: {
        request: async (method) => {
          calls.push(method);
          if (method === "thread/resume") {
            notifyDuringResume();
            const response = threadResponse("thread-1");
            return {
              ...response,
              thread: {
                ...response.thread,
                status: { type: "active", activeFlags: [] },
              },
              initialTurnsPage: {
                data: [
                  {
                    id: "turn-active",
                    items: [
                      {
                        type: "agentMessage",
                        id: "agent-active",
                        text: "Work",
                        phase: null,
                        memoryCitation: null,
                      },
                    ],
                    itemsView: "full",
                    status: "inProgress",
                    error: null,
                    startedAt: 1,
                    completedAt: null,
                    durationMs: null,
                  },
                ],
                nextCursor: null,
                backwardsCursor: "active",
              },
            };
          }
          if (method === "turn/interrupt") return {};
          throw new Error("Unexpected RPC");
        },
      },
      generation: 2,
      projectId: "project-1",
      policy,
      registry: first.registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["cut.trim_edge"]),
    });
    notifyDuringResume = () =>
      resumed.notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-active",
        itemId: "agent-active",
        delta: " continued",
      });
    await resumed.open();
    await assert.rejects(
      resumed.startTurn({ text: "Do not overlap the restored turn" }),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError &&
        error.code === "configuration",
    );
    await resumed.interrupt();
    assert.deepEqual(calls, ["thread/resume", "turn/interrupt"]);
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("resume rejects contradictory thread and history activity", async () => {
  const first = await fixture();
  try {
    await first.client.open();
    let quarantines = 0;
    const resumed = new CodexProjectThreadClient({
      rpc: {
        request: async (method) => {
          assert.equal(method, "thread/resume");
          const response = threadResponse("thread-1");
          return {
            ...response,
            thread: {
              ...response.thread,
              status: { type: "idle" },
            },
            initialTurnsPage: {
              data: [
                {
                  id: "turn-active",
                  items: [],
                  status: "inProgress",
                },
              ],
              nextCursor: null,
              backwardsCursor: null,
            },
          };
        },
      },
      generation: 2,
      projectId: "project-1",
      policy,
      registry: first.registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["cut.trim_edge"]),
      onPolicyViolation: () => quarantines++,
    });
    await assert.rejects(
      resumed.open(),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "protocol",
    );
    assert.equal(quarantines, 1);
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("fallback history is authoritative when an active turn finishes between requests", async () => {
  const first = await fixture();
  try {
    await first.client.open();
    const calls: string[] = [];
    let completeDuringFallback: () => void = () => {
      throw new Error("Fallback completion hook was not initialized");
    };
    const resumed = new CodexProjectThreadClient({
      rpc: {
        request: async (method) => {
          calls.push(method);
          if (method === "thread/resume") {
            const response = threadResponse("thread-1");
            return {
              ...response,
              thread: {
                ...response.thread,
                status: { type: "active", activeFlags: [] },
              },
              initialTurnsPage: null,
            };
          }
          if (method === "thread/turns/list") {
            completeDuringFallback();
            return {
              data: [
                {
                  id: "turn-finished",
                  items: [],
                  status: "completed",
                },
              ],
            };
          }
          if (method === "turn/start") return turnResponse("turn-new");
          throw new Error("Unexpected RPC");
        },
      },
      generation: 2,
      projectId: "project-1",
      policy,
      registry: first.registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["cut.trim_edge"]),
    });
    completeDuringFallback = () =>
      resumed.notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-finished", status: "completed", items: [] },
      });
    await resumed.open();
    await resumed.startTurn({ text: "Continue after the completed turn" });
    assert.deepEqual(calls, [
      "thread/resume",
      "thread/turns/list",
      "turn/start",
    ]);
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("failed history fallback cannot leave a partially opened conversation", async () => {
  const first = await fixture();
  try {
    await first.client.open();
    let quarantines = 0;
    const resumed = new CodexProjectThreadClient({
      rpc: {
        request: async (method) => {
          if (method === "thread/resume") {
            return { ...threadResponse("thread-1"), initialTurnsPage: null };
          }
          assert.equal(method, "thread/turns/list");
          throw new CodexTransportError("remote_error", -32000);
        },
      },
      generation: 2,
      projectId: "project-1",
      policy,
      registry: first.registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["cut.trim_edge"]),
      onPolicyViolation: () => quarantines++,
    });
    await assert.rejects(
      resumed.open(),
      (error: unknown) =>
        error instanceof CodexTransportError && error.code === "remote_error",
    );
    assert.equal(quarantines, 0);
    assert.throws(
      () => resumed.notification("warning", {}),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError &&
        error.code === "configuration",
    );
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("invalid resumed history quarantines the unopened client", async () => {
  const first = await fixture();
  try {
    await first.client.open();
    let quarantines = 0;
    const resumed = new CodexProjectThreadClient({
      rpc: {
        request: async (method) => {
          assert.equal(method, "thread/resume");
          return {
            ...threadResponse("thread-1"),
            initialTurnsPage: {
              data: [
                {
                  id: "turn-forbidden",
                  items: [
                    {
                      type: "commandExecution",
                      id: "command-1",
                      command: "read private files",
                    },
                  ],
                  status: "completed",
                },
              ],
              nextCursor: null,
              backwardsCursor: null,
            },
          };
        },
      },
      generation: 2,
      projectId: "project-1",
      policy,
      registry: first.registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["cut.trim_edge"]),
      onPolicyViolation: () => quarantines++,
    });
    await assert.rejects(
      resumed.open(),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "forbidden",
    );
    assert.equal(quarantines, 1);
    assert.throws(
      () => resumed.notification("turn/completed", {}),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "forbidden",
    );
  } finally {
    await rm(first.root, { recursive: true, force: true });
  }
});

test("unsubscribe closes an idle project conversation and keeps the registry binding", async () => {
  const fixtureState = await fixture();
  try {
    await fixtureState.client.open();
    fixtureState.setHandler(async (method, params) => {
      assert.equal(method, "thread/unsubscribe");
      assert.deepEqual(params, { threadId: "thread-1" });
      return { status: "unsubscribed" };
    });
    await fixtureState.client.close();
    assert.equal(
      await fixtureState.registry.threadForProject("project-1"),
      "thread-1",
    );
    assert.throws(
      () => fixtureState.client.notification("warning", {}),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError &&
        error.code === "configuration",
    );
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("an active turn must reach authoritative completion before unsubscribe", async () => {
  const fixtureState = await fixture();
  try {
    await fixtureState.client.open();
    fixtureState.setHandler(async (method) => {
      if (method === "turn/start") return turnResponse("turn-running");
      assert.equal(method, "thread/unsubscribe");
      return { status: "notSubscribed" };
    });
    await fixtureState.client.startTurn({ text: "Keep editing" });
    await assert.rejects(
      fixtureState.client.close(),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError &&
        error.code === "configuration",
    );
    assert.equal(
      fixtureState.calls.filter((call) => call.method === "thread/unsubscribe")
        .length,
      0,
    );
    fixtureState.client.notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-running", status: "completed", items: [] },
    });
    await fixtureState.client.close();
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("notifications racing turn response are reduced in order from authoritative completion", async () => {
  const fixtureState = await fixture();
  const { client, events } = fixtureState;
  try {
    await client.open();
    fixtureState.setHandler(async (method, params) => {
      assert.equal(method, "turn/start");
      const request = params as {
        threadId: string;
        clientUserMessageId: string;
        environments: unknown[];
      };
      assert.equal(request.threadId, "thread-1");
      assert.equal(request.clientUserMessageId, "message-1");
      assert.deepEqual(request.environments, []);
      client.notification("turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "inProgress", items: [] },
      });
      client.notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1,
        item: { type: "agentMessage", id: "item-1", text: "" },
      });
      client.notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Draft saved to C:\\Users\\person\\private.mov",
      });
      client.notification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 2,
        item: {
          type: "agentMessage",
          id: "item-1",
          text: "The trim is committed. private@example.test",
        },
      });
      client.notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed", items: [] },
      });
      return turnResponse("turn-1");
    });
    await client.startTurn({ text: "Trim the false start." });
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "turn_started",
        "item_started",
        "message_delta",
        "item_completed",
        "turn_terminal",
      ],
    );
    assert.ok(!JSON.stringify(events).includes("Users"));
    assert.ok(!JSON.stringify(events).includes("example.test"));
    assert.match(JSON.stringify(events), /\[private path\]/u);
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("native child notifications cannot enter or poison the parent projection", async () => {
  const fixtureState = await fixture();
  try {
    await fixtureState.client.open();
    fixtureState.setHandler(async (method) => {
      assert.equal(method, "turn/start");
      fixtureState.client.notification("turn/started", {
        threadId: "child-thread",
        turn: { id: "child-turn", status: "inProgress", items: [] },
      });
      fixtureState.client.notification("item/started", {
        threadId: "child-thread",
        turnId: "child-turn",
        startedAtMs: 1,
        item: { type: "agentMessage", id: "child-item", text: "PRIVATE" },
      });
      return turnResponse("parent-turn");
    });
    await fixtureState.client.startTurn({ text: "Read this project" });
    fixtureState.client.notification("item/completed", {
      threadId: "child-thread",
      turnId: "child-turn",
      completedAtMs: 2,
      item: { type: "agentMessage", id: "child-item", text: "PRIVATE" },
    });
    fixtureState.client.notification("turn/completed", {
      threadId: "child-thread",
      turn: { id: "child-turn", status: "completed", items: [] },
    });
    fixtureState.client.notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "parent-turn", status: "completed", items: [] },
    });
    assert.deepEqual(
      fixtureState.events.map((event) => event.type),
      ["turn_terminal"],
    );
    assert.ok(!JSON.stringify(fixtureState.events).includes("PRIVATE"));
    assert.throws(
      () =>
        fixtureState.client.notification("turn/started", {
          threadId: 1,
          turn: { id: "invalid", status: "inProgress", items: [] },
        }),
      CodexThreadProtocolError,
    );
    assert.throws(
      () =>
        fixtureState.client.notification("turn/diff/updated", {
          threadId: "child-thread",
        }),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "forbidden",
    );
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("known rejected turn can retry with a fresh main-owned message id", async () => {
  const fixtureState = await fixture();
  try {
    await fixtureState.client.open();
    let attempts = 0;
    fixtureState.setHandler(async (method) => {
      assert.equal(method, "turn/start");
      if (++attempts === 1)
        throw new CodexTransportError("remote_error", -32602);
      return turnResponse("turn-retry");
    });
    await assert.rejects(
      fixtureState.client.startTurn({ text: "First attempt" }),
      (error: unknown) =>
        error instanceof CodexTransportError && error.code === "remote_error",
    );
    await fixtureState.client.startTurn({ text: "Explicit retry" });
    const turnCalls = fixtureState.calls.filter(
      (entry) => entry.method === "turn/start",
    );
    assert.equal(turnCalls.length, 2);
    assert.notEqual(
      (turnCalls[0]?.params as { clientUserMessageId: string })
        .clientUserMessageId,
      (turnCalls[1]?.params as { clientUserMessageId: string })
        .clientUserMessageId,
    );
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("interrupt waits for raced turn completion and does not fabricate status", async () => {
  const fixtureState = await fixture();
  try {
    await fixtureState.client.open();
    fixtureState.setHandler(async (method) => {
      if (method === "turn/start") return turnResponse("turn-running");
      assert.equal(method, "turn/interrupt");
      fixtureState.client.notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-running", status: "interrupted", items: [] },
      });
      return {};
    });
    await fixtureState.client.startTurn({ text: "Long operation" });
    assert.equal(fixtureState.events.length, 0);
    await fixtureState.client.interrupt();
    const terminal = fixtureState.events.at(-1);
    assert.equal(terminal?.type, "turn_terminal");
    assert.equal(
      terminal?.type === "turn_terminal" ? terminal.status : null,
      "interrupted",
    );
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("approval and elicitation requests always decline or cancel then quarantine", async () => {
  for (const [method, expected] of [
    ["item/commandExecution/requestApproval", { decision: "decline" }],
    ["item/fileChange/requestApproval", { decision: "decline" }],
    [
      "mcpServer/elicitation/request",
      { action: "cancel", content: null, _meta: null },
    ],
  ] as const) {
    const fixtureState = await fixture();
    try {
      await fixtureState.client.open();
      fixtureState.setHandler(async () => turnResponse("turn-policy"));
      await fixtureState.client.startTurn({ text: "Inspect the draft" });
      const abort = new AbortController();
      const params =
        method === "mcpServer/elicitation/request"
          ? {
              threadId: "thread-1",
              turnId: "turn-policy",
              serverName: appIdentity.stableMcpServerId,
            }
          : {
              threadId: "thread-1",
              turnId: "turn-policy",
              itemId: "item-policy",
            };
      assert.deepEqual(
        fixtureState.client.serverRequest({
          id: 1,
          method,
          params,
          signal: abort.signal,
        }),
        expected,
      );
      assert.throws(
        () =>
          fixtureState.client.notification("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-policy", status: "completed", items: [] },
          }),
        (error: unknown) =>
          error instanceof CodexThreadProtocolError &&
          error.code === "forbidden",
      );
    } finally {
      await rm(fixtureState.root, { recursive: true, force: true });
    }
  }
});

test("unsupported or uncorrelated server requests fail closed", async () => {
  const fixtureState = await fixture();
  try {
    await fixtureState.client.open();
    fixtureState.setHandler(async () => turnResponse("turn-policy"));
    await fixtureState.client.startTurn({ text: "Inspect the draft" });
    const signal = new AbortController().signal;
    assert.throws(
      () =>
        fixtureState.client.serverRequest({
          id: "request-1",
          method: "item/permissions/requestApproval",
          params: {},
          signal,
        }),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "forbidden",
    );
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("async user-input server requests are rejected without projecting questions", async () => {
  const fixtureState = await fixture();
  try {
    await fixtureState.client.open();
    fixtureState.setHandler(async () => turnResponse("turn-user-input"));
    await fixtureState.client.startTurn({ text: "Inspect the draft" });
    assert.throws(
      () =>
        fixtureState.client.serverRequest({
          id: "request-user-input",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-user-input",
            itemId: "user-input-call",
            questions: [
              {
                id: "question-1",
                header: "Confirm",
                question: "private-test-user-question",
                isOther: false,
                isSecret: false,
                options: [{ label: "Continue", description: "Fixture" }],
              },
            ],
          },
          signal: new AbortController().signal,
        }),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "forbidden",
    );
    assert.throws(
      () =>
        fixtureState.client.notification("item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "turn-user-input",
          delta: "private-test-after-quarantine",
        }),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "forbidden",
    );
    assert.ok(
      !JSON.stringify(fixtureState.events).includes(
        "private-test-user-question",
      ),
    );
    assert.ok(
      !JSON.stringify(fixtureState.events).includes(
        "private-test-after-quarantine",
      ),
    );
  } finally {
    await rm(fixtureState.root, { recursive: true, force: true });
  }
});

test("correlated owned host call uses the guarded invoker without closing the thread", async () => {
  const invoked: string[] = [];
  const value = await fixture(undefined, async (name, input) => {
    invoked.push(name);
    assert.deepEqual(input, { schema_version: "1.0", project_id: "project-1" });
    return { status: "committed", draft_sequence: 1 };
  });
  try {
    await value.client.open();
    assert.equal(
      (await value.registry.bindingForProject("project-1"))?.toolRoute,
      "dynamic",
    );
    const creation = value.calls[0]?.params as { dynamicTools?: unknown[] };
    assert.equal(creation.dynamicTools?.length, 1);
    value.setHandler(async () => turnResponse("turn-owned"));
    await value.client.startTurn({ text: "Trim the active draft" });
    const result = await value.client.serverRequest({
      id: "host-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-owned",
        callId: "call-owned",
        namespace: "codex_video_edit",
        tool: "cut_trim_edge",
        arguments: { schema_version: "1.0", project_id: "project-1" },
      },
      signal: new AbortController().signal,
    });
    assert.deepEqual(result, {
      contentItems: [
        {
          type: "inputText",
          text: '{"status":"committed","draft_sequence":1}',
        },
      ],
      success: true,
    });
    assert.deepEqual(invoked, ["cut.trim_edge"]);
    value.client.notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-owned", status: "completed", items: [] },
    });
    assert.equal(value.events.at(-1)?.type, "turn_terminal");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("foreign tool and stale turn requests quarantine before draft dispatch", async () => {
  for (const change of [
    { tool: "exec_command" },
    { turnId: "old-turn" },
    { namespace: "foreign" },
  ]) {
    let invoked = 0;
    const value = await fixture(undefined, async () => {
      invoked++;
      return { status: "committed" };
    });
    try {
      await value.client.open();
      value.setHandler(async () => turnResponse("turn-current"));
      await value.client.startTurn({ text: "Inspect the draft" });
      assert.throws(
        () =>
          value.client.serverRequest({
            id: "host-foreign",
            method: "item/tool/call",
            params: {
              threadId: "thread-1",
              turnId: "turn-current",
              callId: "call-foreign",
              namespace: "codex_video_edit",
              tool: "project_get_summary",
              arguments: { schema_version: "1.0", project_id: "project-1" },
              ...change,
            },
            signal: new AbortController().signal,
          }),
        CodexThreadProtocolError,
      );
      assert.equal(invoked, 0);
      await assert.rejects(
        value.client.startTurn({ text: "Do not reuse this thread" }),
        CodexThreadProtocolError,
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test("host edit requests before the turn ID is known fail closed", async () => {
  let invoked = 0;
  const value = await fixture(undefined, async () => {
    invoked++;
    return { status: "committed" };
  });
  try {
    await value.client.open();
    let entered!: () => void;
    const rpcEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    value.setHandler(async () => {
      entered();
      await held;
      return turnResponse("turn-later");
    });
    const starting = value.client.startTurn({ text: "Inspect the draft" });
    await rpcEntered;
    assert.throws(
      () =>
        value.client.serverRequest({
          id: "host-early",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-later",
            callId: "call-early",
            namespace: "codex_video_edit",
            tool: "project_get_summary",
            arguments: { schema_version: "1.0", project_id: "project-1" },
          },
          signal: new AbortController().signal,
        }),
      CodexThreadProtocolError,
    );
    assert.equal(invoked, 0);
    release();
    await starting;
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a start notification before RPC submission cannot authorize a host call", async () => {
  let invoked = 0;
  const value = await fixture(undefined, async () => {
    invoked++;
    return { status: "unexpected" };
  });
  try {
    await value.client.open();
    const original = value.registry.threadForProject.bind(value.registry);
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    value.registry.threadForProject = async (projectId) => {
      entered();
      await held;
      return original(projectId);
    };
    value.setHandler(async () => turnResponse("later-turn"));
    const starting = value.client.startTurn({ text: "Read the project" });
    await waiting;
    value.client.notification("turn/started", {
      threadId: "thread-1",
      turn: { id: "unsent-turn", status: "inProgress", items: [] },
    });
    assert.throws(
      () =>
        value.client.serverRequest({
          id: "unsent-host-call",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "unsent-turn",
            callId: "unsent-call",
            namespace: "codex_video_edit",
            tool: "project_get_summary",
            arguments: { schema_version: "1.0", project_id: "project-1" },
          },
          signal: new AbortController().signal,
        }),
      CodexThreadProtocolError,
    );
    assert.equal(invoked, 0);
    release();
    await assert.rejects(starting, CodexThreadProtocolError);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("an owned start notification correlates a host call before the start response", async () => {
  let invoked = 0;
  const value = await fixture(undefined, async () => {
    invoked++;
    return { status: "read" };
  });
  try {
    await value.client.open();
    value.setHandler(async () => {
      value.client.notification("turn/started", {
        threadId: "thread-1",
        turn: { id: "notified-turn", status: "inProgress", items: [] },
      });
      const result = await value.client.serverRequest({
        id: "notified-call",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "notified-turn",
          callId: "notified-call",
          namespace: "codex_video_edit",
          tool: "project_get_summary",
          arguments: { schema_version: "1.0", project_id: "project-1" },
        },
        signal: new AbortController().signal,
      });
      assert.deepEqual(result, {
        contentItems: [{ type: "inputText", text: '{"status":"read"}' }],
        success: true,
      });
      return turnResponse("notified-turn");
    });
    await value.client.startTurn({ text: "Read the project" });
    assert.equal(invoked, 1);
    assert.deepEqual(
      value.events.map((event) => event.type),
      ["turn_started"],
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a notified host call rejects a conflicting turn/start response", async () => {
  let invoked = 0;
  const value = await fixture(undefined, async () => {
    invoked++;
    return { status: "read" };
  });
  try {
    await value.client.open();
    value.setHandler(async () => {
      value.client.notification("turn/started", {
        threadId: "thread-1",
        turn: { id: "notified-turn", status: "inProgress", items: [] },
      });
      await value.client.serverRequest({
        id: "notified-call",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "notified-turn",
          callId: "notified-call",
          namespace: "codex_video_edit",
          tool: "project_get_summary",
          arguments: { schema_version: "1.0", project_id: "project-1" },
        },
        signal: new AbortController().signal,
      });
      return turnResponse("different-turn");
    });
    await assert.rejects(
      value.client.startTurn({ text: "Read the project" }),
      CodexThreadProtocolError,
    );
    assert.equal(invoked, 1);
    await assert.rejects(
      value.client.startTurn({ text: "Do not reuse this thread" }),
      CodexThreadProtocolError,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a buffered terminal turn cannot authorize a late host call", async () => {
  let invoked = 0;
  const value = await fixture(undefined, async () => {
    invoked++;
    return { status: "unexpected" };
  });
  try {
    await value.client.open();
    value.setHandler(async () => {
      value.client.notification("turn/started", {
        threadId: "thread-1",
        turn: { id: "finished-turn", status: "inProgress", items: [] },
      });
      value.client.notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "finished-turn", status: "completed", items: [] },
      });
      assert.throws(
        () =>
          value.client.serverRequest({
            id: "late-host-call",
            method: "item/tool/call",
            params: {
              threadId: "thread-1",
              turnId: "finished-turn",
              callId: "late-call",
              namespace: "codex_video_edit",
              tool: "project_get_summary",
              arguments: { schema_version: "1.0", project_id: "project-1" },
            },
            signal: new AbortController().signal,
          }),
        CodexThreadProtocolError,
      );
      return turnResponse("finished-turn");
    });
    await value.client.startTurn({ text: "Read the project" });
    assert.equal(invoked, 0);
    await assert.rejects(
      value.client.startTurn({ text: "Do not reuse this thread" }),
      CodexThreadProtocolError,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a child start notification cannot authorize a project host call", async () => {
  let invoked = 0;
  const value = await fixture(undefined, async () => {
    invoked++;
    return { status: "unexpected" };
  });
  try {
    await value.client.open();
    value.setHandler(async () => {
      value.client.notification("turn/started", {
        threadId: "child-thread",
        turn: { id: "child-turn", status: "inProgress", items: [] },
      });
      assert.throws(
        () =>
          value.client.serverRequest({
            id: "child-host-call",
            method: "item/tool/call",
            params: {
              threadId: "child-thread",
              turnId: "child-turn",
              callId: "child-call",
              namespace: "codex_video_edit",
              tool: "project_get_summary",
              arguments: { schema_version: "1.0", project_id: "project-1" },
            },
            signal: new AbortController().signal,
          }),
        CodexThreadProtocolError,
      );
      return turnResponse("parent-turn");
    });
    await value.client.startTurn({ text: "Read the project" });
    assert.equal(invoked, 0);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a previous turn ID cannot authorize a new in-flight host call", async () => {
  let invoked = 0;
  const value = await fixture(undefined, async () => {
    invoked++;
    return { status: "unexpected" };
  });
  try {
    await value.client.open();
    value.setHandler(async () => turnResponse("previous-turn"));
    await value.client.startTurn({ text: "First read" });
    value.client.notification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "previous-turn", status: "completed", items: [] },
    });
    value.setHandler(async () => {
      assert.throws(
        () =>
          value.client.notification("turn/started", {
            threadId: "thread-1",
            turn: { id: "previous-turn", status: "inProgress", items: [] },
          }),
        CodexThreadProtocolError,
      );
      return turnResponse("new-turn");
    });
    await value.client.startTurn({ text: "Second read" });
    assert.equal(invoked, 0);
    await assert.rejects(
      value.client.startTurn({ text: "Do not reuse this thread" }),
      CodexThreadProtocolError,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("a start rejection after a validated notification is a protocol conflict", async () => {
  const value = await fixture(undefined, async () => ({ status: "read" }));
  try {
    await value.client.open();
    value.setHandler(async () => {
      value.client.notification("turn/started", {
        threadId: "thread-1",
        turn: { id: "accepted-turn", status: "inProgress", items: [] },
      });
      throw new CodexTransportError("remote_error");
    });
    await assert.rejects(
      value.client.startTurn({ text: "Read the project" }),
      CodexThreadProtocolError,
    );
    await assert.rejects(
      value.client.startTurn({ text: "Do not reuse this thread" }),
      CodexThreadProtocolError,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("poisoned project conversation disconnect and repeated close finish without RPC", async () => {
  const value = await fixture();
  try {
    await value.client.open();
    value.setHandler(async (method) => {
      if (method === "turn/start") return turnResponse("turn-poisoned");
      throw new Error("Unexpected cleanup RPC");
    });
    await value.client.startTurn({ text: "Inspect the fixture." });
    assert.throws(
      () =>
        value.client.notification("item/started", {
          threadId: "thread-1",
          turnId: "turn-poisoned",
          item: { id: "forbidden-item", type: "commandExecution" },
        }),
      CodexThreadProtocolError,
    );
    const count = value.calls.length;
    assert.doesNotThrow(() => value.client.disconnect());
    assert.doesNotThrow(() => value.client.disconnect());
    await value.client.close();
    await value.client.close();
    assert.equal(value.calls.length, count);
    assert.equal(
      value.events.filter((event) => event.type === "connection_uncertain")
        .length,
      1,
    );
    await assert.rejects(
      value.client.startTurn({ text: "Do not reuse." }),
      CodexThreadProtocolError,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("disconnect observer failure cannot leave an opened conversation or permit reuse", async () => {
  const value = await fixture((event) => {
    if (event.type === "connection_uncertain")
      throw new Error("Observer failed");
  });
  try {
    await value.client.open();
    value.setHandler(async () => turnResponse("turn-observer"));
    await value.client.startTurn({ text: "Inspect the fixture." });
    assert.doesNotThrow(() => value.client.disconnect());
    assert.doesNotThrow(() => value.client.disconnect());
    await value.client.close();
    await assert.rejects(
      value.client.startTurn({ text: "Do not reuse." }),
      CodexThreadProtocolError,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

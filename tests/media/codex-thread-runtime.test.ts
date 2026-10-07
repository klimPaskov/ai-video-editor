import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";
import { CodexThreadProtocolError } from "../../packages/codex-bridge/src/thread-protocol.ts";
import { ownedDynamicToolWireNames } from "../../packages/codex-bridge/src/dynamic-tools.ts";
import { ProjectThreadRegistry } from "../../packages/codex-bridge/src/thread-registry.ts";
import { ProjectThreadRuntime } from "../../packages/codex-bridge/src/thread-runtime.ts";

const policy = {
  cwd: resolve("test-results", "codex-thread-context"),
  model: "runtime-model",
  effort: "high",
};

test("project runtime requires experimental negotiation and owns server IDs", async () => {
  const fixtures = resolve("test-results", "codex-thread-runtime");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, "fixture-"));
  try {
    const registry = await ProjectThreadRegistry.open(root);
    assert.throws(
      () =>
        new ProjectThreadRuntime({
          experimentalApiNegotiated: false,
          generation: 1,
          projectId: "project-1",
          policy,
          registry,
          allowedMcpServer: appIdentity.stableMcpServerId,
          allowedMcpTools: new Set(["draft.trim"]),
          clientMessageId: () => "message-1",
        }),
      CodexThreadProtocolError,
    );

    const runtime = new ProjectThreadRuntime({
      experimentalApiNegotiated: true,
      generation: 1,
      projectId: "project-1",
      policy,
      registry,
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["draft.trim"]),
      clientMessageId: () => "message-1",
    });
    const opening = await runtime.openThreadRequest();
    assert.equal(opening.method, "thread/start");
    assert.deepEqual(opening.params.environments, []);
    assert.equal(opening.params.config.features.code_mode_only, false);

    await runtime.acceptThreadResponse({
      thread: { id: "server-thread-1", ephemeral: false },
      model: policy.model,
      modelProvider: "openai",
      cwd: policy.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: false },
    });
    const turnRequest = runtime.turnStartRequest({ text: "Trim the pause." });
    await assert.rejects(
      runtime.turnStartRequest({ text: "Start a racing turn." }),
      CodexThreadProtocolError,
    );
    assert.deepEqual(await turnRequest, {
      threadId: "server-thread-1",
      clientUserMessageId: "message-1",
      input: [{ type: "text", text: "Trim the pause.", text_elements: [] }],
      environments: [],
      cwd: policy.cwd,
      runtimeWorkspaceRoots: [],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: policy.model,
      effort: policy.effort,
    });
    runtime.acceptTurnStartResponse({
      turn: { id: "server-turn-1", status: "inProgress", items: [] },
    });
    assert.deepEqual(await runtime.interruptRequest(), {
      threadId: "server-thread-1",
      turnId: "server-turn-1",
    });
    runtime.acceptInterruptResponse({});
    assert.deepEqual(
      runtime.notification("turn/completed", {
        threadId: "server-thread-1",
        turn: { id: "server-turn-1", status: "interrupted", items: [] },
      }),
      {
        type: "turn_terminal",
        generation: 1,
        threadId: "server-thread-1",
        turnId: "server-turn-1",
        status: "interrupted",
      },
    );

    await runtime.turnStartRequest({ text: "Run a second edit." });
    runtime.notification("turn/started", {
      threadId: "server-thread-1",
      turn: { id: "server-turn-2", status: "inProgress", items: [] },
    });
    runtime.notification("turn/completed", {
      threadId: "server-thread-1",
      turn: { id: "server-turn-2", status: "completed", items: [] },
    });
    assert.equal(
      runtime.acceptTurnStartResponse({
        turn: { id: "server-turn-2", status: "inProgress", items: [] },
      }),
      null,
    );
    await runtime.turnStartRequest({ text: "The terminal race was settled." });

    const reopened = new ProjectThreadRuntime({
      experimentalApiNegotiated: true,
      generation: 2,
      projectId: "project-1",
      policy,
      registry: await ProjectThreadRegistry.open(root),
      allowedMcpServer: appIdentity.stableMcpServerId,
      allowedMcpTools: new Set(["draft.trim"]),
      clientMessageId: () => "message-2",
    });
    const resume = await reopened.openThreadRequest();
    assert.equal(resume.method, "thread/resume");
    assert.equal("environments" in resume.params, false);
    assert.equal(resume.params.config.features.code_mode_only, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic thread creation requires the exact reviewed host inventory", async () => {
  const fixtures = resolve("test-results", "codex-thread-runtime");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, "fixture-"));
  try {
    const registry = await ProjectThreadRegistry.open(root);
    assert.throws(
      () =>
        new ProjectThreadRuntime({
          experimentalApiNegotiated: true,
          generation: 1,
          projectId: "project-1",
          policy,
          registry,
          allowedMcpServer: appIdentity.stableMcpServerId,
          allowedMcpTools: new Set(),
          newThreadToolRoute: "dynamic",
          allowedDynamicNamespace: "codex_video_edit",
          allowedDynamicTools: new Set(["project_get_summary"]),
        }),
      CodexThreadProtocolError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic thread start and resume retain the route-specific code-mode policy", async () => {
  const fixtures = resolve("test-results", "codex-thread-runtime");
  await mkdir(fixtures, { recursive: true });
  const root = await mkdtemp(join(fixtures, "dynamic-fixture-"));
  const options = {
    experimentalApiNegotiated: true,
    generation: 1,
    projectId: "dynamic-project",
    policy,
    registry: await ProjectThreadRegistry.open(root),
    allowedMcpServer: appIdentity.stableMcpServerId,
    allowedMcpTools: new Set<string>(),
    newThreadToolRoute: "dynamic" as const,
    nativeSubagentProtocol: "v1" as const,
    nativeSubagentModel: policy.model,
    nativeSubagentReasoning: policy.effort,
    allowedDynamicNamespace: "codex_video_edit",
    allowedDynamicTools: ownedDynamicToolWireNames(),
  };
  try {
    const runtime = new ProjectThreadRuntime(options);
    const opening = await runtime.openThreadRequest();
    assert.equal(opening.method, "thread/start");
    assert.equal(opening.params.config.features.code_mode_only, true);
    assert.equal(opening.params.config.features.multi_agent, true);
    assert.deepEqual(opening.params.config.agents, {
      enabled: true,
      max_depth: 1,
      default_subagent_model: policy.model,
      default_subagent_reasoning_effort: policy.effort,
    });
    assert.deepEqual(
      opening.params.dynamicTools?.[0]?.name,
      "codex_video_edit",
    );
    const dynamicNamespace = opening.params.dynamicTools?.[0];
    assert.ok(dynamicNamespace?.type === "namespace");
    if (dynamicNamespace?.type !== "namespace")
      throw new Error("Expected the owned dynamic namespace");
    assert.equal(dynamicNamespace.tools.length, 12);
    for (const tool of dynamicNamespace.tools) {
      const inputSchema = tool.inputSchema as {
        properties?: { project_id?: { const?: unknown } };
      };
      assert.equal(
        inputSchema.properties?.project_id?.const,
        "dynamic-project",
      );
    }
    await runtime.acceptThreadResponse({
      thread: { id: "dynamic-thread", ephemeral: false },
      model: policy.model,
      modelProvider: "openai",
      cwd: policy.cwd,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "readOnly", networkAccess: false },
    });

    const resumed = await new ProjectThreadRuntime({
      ...options,
      generation: 2,
      registry: await ProjectThreadRegistry.open(root),
    }).openThreadRequest();
    assert.equal(resumed.method, "thread/resume");
    assert.equal(resumed.params.config.features.code_mode_only, true);
    assert.equal(resumed.params.config.features.multi_agent, true);
    assert.deepEqual(resumed.params.config.agents, {
      enabled: true,
      max_depth: 1,
      default_subagent_model: policy.model,
      default_subagent_reasoning_effort: policy.effort,
    });
    assert.equal("dynamicTools" in resumed.params, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

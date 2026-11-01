import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { join, resolve } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { connect } from "node:net";

import {
  CodexMcpBroker,
  resolveCodexMcpScript,
} from "../../packages/codex-tools/src/broker.ts";
import { CodexVideoEditToolError } from "../../packages/codex-tools/src/service.ts";
import {
  claudeEditorMcpTools,
  codexVideoEditMcpTools,
} from "../../packages/codex-tools/src/mcp-tools.ts";
import {
  buildCodexAppServerArguments,
  codexClientInternals,
} from "../../packages/codex-bridge/src/client.ts";
import { CodexTransportError } from "../../packages/codex-bridge/src/transport.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";

type RpcHarness = {
  child: ChildProcessWithoutNullStreams;
  lines: Interface;
  iterator: AsyncIterator<string>;
  request(value: unknown): Promise<Record<string, unknown>>;
  close(): Promise<void>;
};

async function childFor(
  runtime: ReturnType<CodexMcpBroker["runtime"]>,
  token = runtime.token,
  extraEnv: Record<string, string> = {},
): Promise<RpcHarness> {
  const child = spawn(runtime.command, [runtime.script], {
    env: {
      AI_VIDEO_EDITOR_MCP_ENDPOINT: runtime.endpoint,
      AI_VIDEO_EDITOR_MCP_TOKEN: token,
      NODE_NO_WARNINGS: "1",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    child,
    lines,
    iterator,
    async request(value) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
      const result = await iterator.next();
      assert.equal(result.done, false);
      const parsed: unknown = JSON.parse(result.value!);
      assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
      return parsed as Record<string, unknown>;
    },
    async close() {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null) await once(child, "exit");
    },
  };
}

async function fixture(
  invoke: (name: unknown, input: unknown) => Promise<unknown>,
) {
  const parent = resolve("test-results", "codex-mcp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-"));
  const broker = await CodexMcpBroker.open(root, invoke);
  const runtime = broker.runtime(
    process.execPath,
    resolve("packages/codex-tools/src/mcp-server.ts"),
  );
  return { root, broker, runtime };
}

test("packaged MCP protocol lists only reviewed tools and forwards a bounded call", async () => {
  const calls: Array<{ name: unknown; input: unknown }> = [];
  const state = await fixture(async (name, input) => {
    calls.push({ name, input });
    return { schema_version: "1.0", project_id: "project-1" };
  });
  const rpc = await childFor(state.runtime);
  try {
    const initialized = await rpc.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    assert.equal(
      (initialized.result as { protocolVersion: string }).protocolVersion,
      "2025-06-18",
    );
    const listed = await rpc.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const tools = (
      listed.result as {
        tools: Array<{
          name: string;
          inputSchema: {
            additionalProperties: boolean;
            required: string[];
            properties: Record<string, unknown>;
          };
        }>;
      }
    ).tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "project.get_summary",
        "timeline.get_summary",
        "cut.trim_edge",
        "cut.split",
        "cut.delete_range",
        "timeline.undo",
        "cut.delete_ranges",
        "cut.restore_range",
        "transcript.get_range",
        "zoom.set",
        "zoom.remove",
        "speed.set",
        "graphics.set",
        "graphics.remove",
        "captions.configure",
        "audio.configure",
        "media.get_frames",
        "transition.set",
        "transition.remove",
        "app.start_magic_edit",
        "app.stop_edit",
        "app.go_to_step",
      ],
    );
    const graphic = tools.find((tool) => tool.name === "graphics.set");
    assert.ok(graphic);
    for (const field of ["start_us", "duration_us", "name", "layer"])
      assert.ok(graphic.inputSchema.required.includes(field));
    // Either an HTML/CSS fragment or a HyperFrames composition file.
    for (const field of ["graphic_id", "html", "css", "composition_path"]) {
      assert.ok(!graphic.inputSchema.required.includes(field), field);
      assert.ok(field in graphic.inputSchema.properties, field);
    }
    const ungraphic = tools.find((tool) => tool.name === "graphics.remove");
    assert.ok(ungraphic?.inputSchema.required.includes("graphic_id"));
    const zoom = tools.find((tool) => tool.name === "zoom.set");
    assert.ok(zoom);
    assert.equal(zoom.inputSchema.additionalProperties, false);
    for (const field of ["start_us", "end_us", "center_x", "center_y", "scale"])
      assert.ok(zoom.inputSchema.required.includes(field));
    assert.ok(!zoom.inputSchema.required.includes("zoom_id"));
    assert.ok(Object.hasOwn(zoom.inputSchema.properties, "zoom_id"));
    const speed = tools.find((tool) => tool.name === "speed.set");
    assert.ok(speed);
    for (const field of ["start_us", "end_us", "speed"])
      assert.ok(speed.inputSchema.required.includes(field));
    const unzoom = tools.find((tool) => tool.name === "zoom.remove");
    assert.ok(unzoom?.inputSchema.required.includes("zoom_id"));
    for (const tool of [zoom, speed, unzoom!, graphic, ungraphic!])
      assert.ok(!Object.hasOwn(tool.inputSchema.properties, "origin"));
    const transcript = tools.find(
      (tool) => tool.name === "transcript.get_range",
    );
    assert.ok(transcript);
    assert.equal(transcript.inputSchema.additionalProperties, false);
    assert.equal(transcript.inputSchema.properties.source_path, undefined);
    assert.equal(
      transcript.inputSchema.required.includes("source_start_us"),
      true,
    );
    assert.equal(
      transcript.inputSchema.required.includes("source_end_us"),
      true,
    );
    assert.ok(!JSON.stringify(tools).includes(state.runtime.endpoint));
    const range = tools.find((tool) => tool.name === "cut.delete_range");
    assert.ok(range);
    assert.equal(range.inputSchema.additionalProperties, false);
    assert.ok(range.inputSchema.required.includes("start_us"));
    assert.ok(range.inputSchema.required.includes("end_us"));
    assert.ok(range.inputSchema.required.includes("expected_timeline_sha256"));
    assert.ok(!Object.hasOwn(range.inputSchema.properties, "origin"));
    const batch = tools.find((tool) => tool.name === "cut.delete_ranges");
    assert.ok(batch);
    assert.ok(batch.inputSchema.required.includes("ranges"));
    assert.ok(!Object.hasOwn(batch.inputSchema.properties, "origin"));
    const restore = tools.find((tool) => tool.name === "cut.restore_range");
    assert.ok(restore);
    assert.equal(restore.inputSchema.additionalProperties, false);
    for (const field of ["source_id", "source_start_us", "source_end_us"])
      assert.ok(restore.inputSchema.required.includes(field));
    assert.ok(restore.inputSchema.required.includes("expected_sequence"));
    assert.ok(
      restore.inputSchema.required.includes("expected_timeline_sha256"),
    );
    assert.ok(!Object.hasOwn(restore.inputSchema.properties, "source_path"));
    assert.ok(!Object.hasOwn(restore.inputSchema.properties, "origin"));
    const split = tools.find((tool) => tool.name === "cut.split");
    assert.ok(split);
    assert.equal(split.inputSchema.additionalProperties, false);
    assert.ok(split.inputSchema.required.includes("clip_id"));
    assert.ok(split.inputSchema.required.includes("timeline_position_us"));
    assert.ok(split.inputSchema.required.includes("pass_group_id"));
    assert.ok(split.inputSchema.required.includes("expected_sequence"));
    assert.ok(split.inputSchema.required.includes("expected_timeline_sha256"));
    assert.ok(!Object.hasOwn(split.inputSchema.properties, "origin"));
    const called = await rpc.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "project.get_summary",
        arguments: { schema_version: "1.0", project_id: "project-1" },
      },
    });
    assert.equal((called.result as { isError: boolean }).isError, false);
    assert.deepEqual(calls, [
      {
        name: "project.get_summary",
        input: { schema_version: "1.0", project_id: "project-1" },
      },
    ]);
  } finally {
    await rpc.close();
    await state.broker.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("MCP boundary rejects unknown tools and returns only fixed service errors", async () => {
  const state = await fixture(async () => {
    throw new CodexVideoEditToolError("stale_draft");
  });
  const rpc = await childFor(state.runtime);
  try {
    const unknown = await rpc.request({
      jsonrpc: "2.0",
      id: "unknown",
      method: "tools/call",
      params: { name: "filesystem.read", arguments: {} },
    });
    assert.equal((unknown.error as { code: number }).code, -32602);
    const failed = await rpc.request({
      jsonrpc: "2.0",
      id: "stale",
      method: "tools/call",
      params: {
        name: "timeline.get_summary",
        arguments: { schema_version: "1.0", project_id: "project-1" },
      },
    });
    const result = failed.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /draft changed/u);
    assert.ok(!JSON.stringify(failed).includes(state.runtime.endpoint));
    assert.ok(!JSON.stringify(failed).includes(state.runtime.token));
  } finally {
    await rpc.close();
    await state.broker.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("MCP child cannot reach Electron main with the wrong launch secret", async () => {
  let invoked = false;
  const state = await fixture(async () => {
    invoked = true;
    return {};
  });
  const rpc = await childFor(state.runtime, "0".repeat(64));
  try {
    const failed = await rpc.request({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "project.get_summary",
        arguments: { schema_version: "1.0", project_id: "project-1" },
      },
    });
    assert.equal((failed.result as { isError: boolean }).isError, true);
    assert.equal(invoked, false);
    assert.ok(!JSON.stringify(failed).includes(state.runtime.endpoint));
  } finally {
    await rpc.close();
    await state.broker.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("MCP broker supports deep application-data roots within the POSIX socket limit", async () => {
  const parent = resolve(
    "test-results",
    "codex-mcp-deep-root",
    "a".repeat(48),
    "b".repeat(48),
  );
  const broker = await CodexMcpBroker.open(parent, async () => ({}));
  try {
    const runtime = broker.runtime(
      process.execPath,
      resolve("packages/codex-tools/src/mcp-server.ts"),
    );
    if (process.platform !== "win32") {
      assert.ok(Buffer.byteLength(runtime.endpoint) < 100);
      assert.ok(
        runtime.endpoint.startsWith(resolve("test-results")) ||
          runtime.endpoint.startsWith("/tmp/"),
      );
    }
  } finally {
    await broker.close();
    await rm(resolve("test-results", "codex-mcp-deep-root"), {
      recursive: true,
      force: true,
    });
  }
});

test("packaged MCP resolver rejects a changed child script", async () => {
  const parent = resolve("test-results", "codex-mcp-package");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fixture-"));
  const directory = join(root, "mcp");
  await mkdir(directory);
  const script = join(directory, "ai-video-editor-mcp.cjs");
  const bytes = Buffer.from("process.exit(0);\n");
  await writeFile(script, bytes);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      executable: "ai-video-editor-mcp.cjs",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }),
  );
  try {
    assert.equal(await resolveCodexMcpScript(root), script);
    await writeFile(script, "changed\n");
    await assert.rejects(resolveCodexMcpScript(root), /missing or damaged/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("App Server receives the owned MCP allowlist without command-line secrets", () => {
  const runtime = {
    command: resolve("runtime", "electron"),
    script: resolve("runtime", "ai-video-editor-mcp.cjs"),
    endpoint: "private-endpoint",
    token: "b".repeat(64),
  };
  const args = buildCodexAppServerArguments(runtime, ["untrusted_test"]);
  const serialized = JSON.stringify(args);
  assert.equal(
    args.filter((argument) => argument === "mcp_servers={}").length,
    1,
  );
  const resetIndex = args.indexOf("mcp_servers={}"),
    disabledServerIndex = args.indexOf(
      "mcp_servers.untrusted_test.enabled=false",
    ),
    ownedServerIndex = args.findIndex((argument) =>
      argument.startsWith(
        `mcp_servers.${appIdentity.stableMcpServerId}.command=`,
      ),
    );
  assert.ok(resetIndex >= 0 && resetIndex < disabledServerIndex);
  assert.ok(disabledServerIndex < ownedServerIndex);
  assert.ok(args.includes("--strict-config"));
  for (const [index, value] of args.entries())
    if (value === "-c")
      assert.notEqual(
        args[index + 1],
        undefined,
        "A config flag must have a following expression.",
      );
    else if (index > 0 && args[index - 1] === "-c")
      assert.match(value, /^[A-Za-z0-9_.-]+=/u);
  assert.ok(
    serialized.includes(`mcp_servers.${appIdentity.stableMcpServerId}.command`),
  );
  assert.match(serialized, /enabled_tools/u);
  assert.match(serialized, /default_tools_approval_mode/u);
  assert.ok(args.includes("features.multi_agent=false"));
  assert.ok(args.includes("features.code_mode.enabled=false"));
  assert.ok(args.includes("features.code_mode_host.enabled=false"));
  for (const feature of [
    "api_key_model_discovery",
    "auth_elicitation",
    "chronicle",
    "default_mode_request_user_input",
    "deferred_executor",
    "exec_permission_approvals",
    "external_agent_memory_import",
    "goals",
    "request_permissions_tool",
    "request_rule",
    "skill_mcp_dependency_install",
    "tool_call_mcp_elicitation",
    "mcp_oauth_refresh_coordination",
    "standalone_web_search",
    "web_search_cached",
    "web_search_request",
    "sleep_tool",
    "token_budget",
    "view_image",
    "plugin_sharing",
    "recommended_plugins",
    "tool_suggest",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "computer_use",
    "compaction_image_budget",
    "fast_mode",
    "guardian_approval",
    "in_app_browser",
    "in_app_chat",
    "in_app_dictation",
    "in_app_local_automation",
    "in_app_updates",
    "mentions_v2",
    "personality",
    "shell_snapshot",
    "unified_exec_tty",
    "workspace_dependencies",
    "hooks",
    "skill_search",
    "unbounded_connection_retries",
  ]) {
    const index = args.indexOf(`features.${feature}=false`);
    assert.ok(index > 0, `Missing feature override: ${feature}`);
    assert.equal(
      args[index - 1],
      "-c",
      `Unpaired feature override: ${feature}`,
    );
  }
  assert.ok(args.includes("apps._default.enabled=false"));
  assert.ok(args.includes("apps._default.destructive_enabled=false"));
  assert.ok(args.includes("apps._default.open_world_enabled=false"));
  assert.ok(args.includes("tools.update_plan.enabled=false"));
  assert.ok(
    args.includes("tools.experimental_request_user_input.enabled=false"),
  );
  assert.ok(args.includes("agents.enabled=false"));
  assert.ok(
    args.includes(
      'features.code_mode.excluded_tool_namespaces=["mcp__codex_apps","multi_agent_v1","skills","functions","image_gen"]',
    ),
  );
  assert.ok(
    args.includes("features.code_mode_host.disable_in_process_fallback=true"),
  );
  assert.ok(args.includes("features.multi_agent_v2=false"));
  assert.ok(!serialized.includes(runtime.endpoint));
  assert.ok(!serialized.includes(runtime.token));
  assert.ok(!serialized.includes("filesystem.read"));

  const dynamicArgs = buildCodexAppServerArguments();
  assert.ok(dynamicArgs.includes("--strict-config"));
  for (const [index, value] of dynamicArgs.entries())
    if (value === "-c")
      assert.notEqual(
        dynamicArgs[index + 1],
        undefined,
        "A dynamic config flag must have a following expression.",
      );
    else if (index > 0 && dynamicArgs[index - 1] === "-c")
      assert.match(value, /^[A-Za-z0-9_.-]+=/u);
  assert.ok(dynamicArgs.includes("mcp_servers={}"));
  assert.equal(
    dynamicArgs.filter((argument) => argument === "mcp_servers={}").length,
    1,
  );
  assert.ok(
    !dynamicArgs.some((arg) =>
      arg.startsWith(`mcp_servers.${appIdentity.stableMcpServerId}.`),
    ),
  );
  assert.ok(dynamicArgs.includes("features.multi_agent=true"));
  assert.ok(dynamicArgs.includes("features.multi_agent_v2=true"));
  assert.ok(dynamicArgs.includes("features.code_mode.enabled=false"));
  assert.ok(dynamicArgs.includes("features.code_mode_host.enabled=false"));
  for (const feature of [
    "api_key_model_discovery",
    "auth_elicitation",
    "chronicle",
    "default_mode_request_user_input",
    "deferred_executor",
    "exec_permission_approvals",
    "external_agent_memory_import",
    "goals",
    "request_permissions_tool",
    "request_rule",
    "skill_mcp_dependency_install",
    "tool_call_mcp_elicitation",
    "mcp_oauth_refresh_coordination",
    "standalone_web_search",
    "web_search_cached",
    "web_search_request",
    "sleep_tool",
    "token_budget",
    "view_image",
    "plugin_sharing",
    "recommended_plugins",
    "tool_suggest",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "computer_use",
    "compaction_image_budget",
    "fast_mode",
    "guardian_approval",
    "in_app_browser",
    "in_app_chat",
    "in_app_dictation",
    "in_app_local_automation",
    "in_app_updates",
    "mentions_v2",
    "personality",
    "shell_snapshot",
    "unified_exec_tty",
    "workspace_dependencies",
    "hooks",
    "skill_search",
    "unbounded_connection_retries",
  ]) {
    const index = dynamicArgs.indexOf(`features.${feature}=false`);
    assert.ok(index > 0, `Missing dynamic feature override: ${feature}`);
    assert.equal(
      dynamicArgs[index - 1],
      "-c",
      `Unpaired dynamic feature override: ${feature}`,
    );
  }
  assert.ok(dynamicArgs.includes("agents.enabled=true"));
  assert.ok(!dynamicArgs.includes("features.multi_agent=false"));
  assert.ok(!dynamicArgs.includes("agents.enabled=false"));
  assert.ok(
    dynamicArgs.includes(
      'features.code_mode.excluded_tool_namespaces=["mcp__codex_apps","skills","functions","image_gen"]',
    ),
  );
  assert.ok(dynamicArgs.includes("agents.max_depth=1"));

  const isolatedArgs = buildCodexAppServerArguments(undefined, [
    "untrusted_test",
  ]);
  assert.ok(isolatedArgs.includes("mcp_servers.untrusted_test.enabled=false"));
});

test("Codex MCP inventory accepts only explicitly disabled configured servers", () => {
  codexClientInternals.validateDisabledMcpStatus(
    { data: [], nextCursor: null },
    [],
  );
  const disabled = {
    name: "external-server",
    runtimeStatus: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
  };
  codexClientInternals.validateAppServerMcpStatus(
    { data: [disabled], nextCursor: null },
    ["external-server"],
    false,
  );
  codexClientInternals.validateAppServerMcpStatus(
    { data: [{ ...disabled, runtimeStatus: "disabled" }], nextCursor: null },
    ["external-server"],
    false,
    true,
  );
  assert.throws(
    () =>
      codexClientInternals.validateAppServerMcpStatus(
        {
          data: [{ ...disabled, runtimeStatus: "connected" }],
          nextCursor: null,
        },
        ["external-server"],
        false,
      ),
    CodexTransportError,
  );
  assert.throws(
    () =>
      codexClientInternals.validateAppServerMcpStatus(
        {
          data: [{ ...disabled, tools: { filesystem: {} } }],
          nextCursor: null,
        },
        ["external-server"],
        false,
      ),
    CodexTransportError,
  );
  assert.throws(
    () =>
      codexClientInternals.validateAppServerMcpStatus(
        { data: [disabled], nextCursor: null },
        [],
        false,
      ),
    CodexTransportError,
  );
  assert.deepEqual(
    codexClientInternals.decodeConfiguredMcpServers([
      { name: "external-server", enabled: true },
    ]),
    [{ name: "external-server", enabled: true }],
  );
  assert.throws(
    () =>
      codexClientInternals.decodeConfiguredMcpServers([
        { name: "external-server", enabled: "yes" },
      ]),
    CodexTransportError,
  );
  assert.throws(
    () =>
      codexClientInternals.decodeConfiguredMcpServers([
        { name: "server.name", enabled: true },
      ]),
    CodexTransportError,
  );
});

test("configured MCP discovery disables every listed server and verifies the inventory", async () => {
  const calls: string[][] = [];
  const replies: unknown[] = [
    [
      { name: "untrusted_test", enabled: true },
      { name: "already_disabled", enabled: false },
    ],
    [
      { name: "untrusted_test", enabled: false },
      { name: "already_disabled", enabled: false },
    ],
  ];
  const runCodex: Parameters<
    typeof codexClientInternals.disableConfiguredMcpServers
  >[4] = async (_executable, args) => {
    calls.push(args);
    const reply = replies.shift();
    assert.notEqual(reply, undefined);
    return reply;
  };

  const names = await codexClientInternals.disableConfiguredMcpServers(
    "codex",
    "/isolated/context",
    {},
    new AbortController().signal,
    runCodex,
  );

  assert.deepEqual(names, ["untrusted_test", "already_disabled"]);
  assert.deepEqual(calls, [
    ["mcp", "list", "--json"],
    [
      "mcp",
      "list",
      "--json",
      "-c",
      "mcp_servers.untrusted_test.enabled=false",
      "-c",
      "mcp_servers.already_disabled.enabled=false",
    ],
  ]);
});

test("configured MCP verification rejects a retained enabled server or changed inventory", async () => {
  for (const verification of [
    [{ name: "untrusted_test", enabled: true }],
    [
      { name: "untrusted_test", enabled: false },
      { name: "new_server", enabled: false },
    ],
    [],
  ]) {
    const replies: unknown[] = [
      [{ name: "untrusted_test", enabled: true }],
      verification,
    ];
    await assert.rejects(
      codexClientInternals.disableConfiguredMcpServers(
        "codex",
        "/isolated/context",
        {},
        new AbortController().signal,
        async () => {
          const reply = replies.shift();
          assert.notEqual(reply, undefined);
          return reply;
        },
      ),
      (error: unknown) =>
        error instanceof CodexTransportError && error.code === "configuration",
    );
  }
});

test("App Server argument builder rejects malformed, duplicate, and excess MCP names", () => {
  assert.throws(
    () => buildCodexAppServerArguments(undefined, ["untrusted.server"]),
    CodexTransportError,
  );
  assert.throws(
    () => buildCodexAppServerArguments(undefined, ["same", "same"]),
    CodexTransportError,
  );
  assert.throws(
    () =>
      buildCodexAppServerArguments(
        undefined,
        Array.from({ length: 65 }, (_, index) => `server_${index}`),
      ),
    CodexTransportError,
  );
});

test("App Server startup accepts only the reviewed owned MCP schemas", () => {
  const status = {
    data: [
      {
        name: appIdentity.stableMcpServerId,
        serverInfo: {
          name: appIdentity.stableMcpServerId,
          version: "0.0.1",
        },
        tools: Object.fromEntries(
          codexVideoEditMcpTools.map((tool) => [tool.name, tool]),
        ),
        resources: [],
        resourceTemplates: [],
        authStatus: "unsupported",
      },
    ],
    nextCursor: null,
  };
  codexClientInternals.validateOwnedMcpStatus(structuredClone(status));
  const configuredServer = {
    name: "untrusted_test",
    runtimeStatus: null,
    serverInfo: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
  };
  codexClientInternals.validateAppServerMcpStatus(
    {
      data: [...structuredClone(status.data), configuredServer],
      nextCursor: null,
    },
    ["untrusted_test"],
    true,
  );
  assert.throws(
    () =>
      codexClientInternals.validateAppServerMcpStatus(
        {
          data: [
            ...structuredClone(status.data),
            { ...configuredServer, runtimeStatus: "connected" },
          ],
          nextCursor: null,
        },
        ["untrusted_test"],
        true,
        true,
      ),
    CodexTransportError,
  );
  const changed = structuredClone(status) as unknown as {
    data: Array<{
      tools: Record<string, { inputSchema: unknown }>;
    }>;
    nextCursor: null;
  };
  changed.data[0]!.tools["cut.trim_edge"]!.inputSchema = {
    type: "object",
  };
  assert.throws(
    () => codexClientInternals.validateOwnedMcpStatus(changed),
    CodexTransportError,
  );
});

test("rendered pictures reach Claude and Codex MCP clients as image content", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  const state = await fixture(async (name) => {
    assert.equal(name, "media.get_frames");
    return {
      schema_version: "1.0",
      project_id: "project-1",
      draft_sequence: 3,
      timeline_sha256: "a".repeat(64),
      frames: [
        {
          time_us: 500_000,
          width: 960,
          height: 540,
          mime_type: "image/jpeg",
          data_base64: jpeg,
        },
      ],
    };
  });
  const rpc = await childFor(state.runtime);
  try {
    await rpc.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const called = await rpc.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "media.get_frames",
        arguments: {
          schema_version: "1.0",
          project_id: "project-1",
          times_us: [500_000],
        },
      },
    });
    const result = called.result as {
      isError: boolean;
      content: Array<Record<string, unknown>>;
      structuredContent?: unknown;
    };
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent, undefined);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[0]!.type, "text");
    const metadata = JSON.parse(result.content[0]!.text as string) as {
      frames: Array<Record<string, unknown>>;
    };
    assert.deepEqual(metadata.frames, [
      {
        time_us: 500_000,
        width: 960,
        height: 540,
        mime_type: "image/jpeg",
        image_index: 0,
      },
    ]);
    assert.doesNotMatch(result.content[0]!.text as string, /data_base64/u);
    assert.deepEqual(result.content[1], {
      type: "image",
      data: jpeg,
      mimeType: "image/jpeg",
    });
  } finally {
    await rpc.close();
    await state.broker.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("every constant and choice in the editor tool schemas declares its type", () => {
  // Claude Code passes an untyped numeric-looking constant such as "1.0" as
  // the number 1, which the tools then reject.
  const untyped: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (("const" in record || "enum" in record) && !("type" in record))
      untyped.push(path);
    for (const [key, value] of Object.entries(record))
      walk(value, `${path}.${key}`);
  };
  for (const tool of claudeEditorMcpTools) walk(tool.inputSchema, tool.name);
  assert.deepEqual(untyped, []);
});

test("only Claude's server lists composition.check, with its picture as an image", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
  const state = await fixture(async (name) => {
    assert.equal(name, "composition.check");
    return {
      schema_version: "1.0",
      project_id: "project-1",
      composition_path: "compositions/intro/index.html",
      ok: true,
      findings: [],
      frames: [
        {
          width: 1300,
          height: 380,
          mime_type: "image/jpeg",
          data_base64: jpeg,
        },
      ],
    };
  });
  const codex = await childFor(state.runtime);
  const claude = await childFor(state.runtime, state.runtime.token, {
    AI_VIDEO_EDITOR_MCP_TOOLS: "claude",
  });
  const call = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "composition.check",
      arguments: {
        schema_version: "1.0",
        project_id: "project-1",
        composition_path: "compositions/intro/index.html",
      },
    },
  };
  try {
    for (const rpc of [codex, claude])
      await rpc.request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
    const list = async (rpc: RpcHarness) =>
      (
        (await rpc.request({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
          .result as { tools: { name: string }[] }
      ).tools.map((tool) => tool.name);
    assert.deepEqual(
      await list(codex),
      codexVideoEditMcpTools.map((tool) => tool.name),
    );
    assert.equal((await list(codex)).length, 22);
    assert.deepEqual(
      await list(claude),
      claudeEditorMcpTools.map((tool) => tool.name),
    );
    for (const name of [
      "composition.check",
      "sound.list",
      "sound.set",
      "sound.remove",
      "shorts.propose",
    ])
      assert.ok((await list(claude)).includes(name), name);
    assert.equal((await list(codex)).includes("sound.set"), false);
    assert.equal((await list(codex)).includes("shorts.propose"), false);
    assert.equal(
      ((await codex.request(call)).error as { code: number }).code,
      -32602,
    );
    const result = (await claude.request(call)).result as {
      isError: boolean;
      content: Array<Record<string, unknown>>;
    };
    assert.equal(result.isError, false);
    assert.equal(result.content.length, 2);
    assert.match(result.content[0]!.text as string, /"ok":true/u);
    assert.deepEqual(result.content[1], {
      type: "image",
      data: jpeg,
      mimeType: "image/jpeg",
    });
  } finally {
    await codex.close();
    await claude.close();
    await state.broker.close();
    await rm(state.root, { recursive: true, force: true });
  }
});

test("a tool call may outlast the idle limit once its request has arrived", async () => {
  const parent = resolve("test-results", "codex-mcp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "timeouts-"));
  // Pictures of a long recording take longer than an idle connection may wait.
  const broker = await CodexMcpBroker.open(
    root,
    async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
      return { schema_version: "1.0", project_id: "project-1" };
    },
    { idleMs: 150, callMs: 5_000 },
  );
  const runtime = broker.runtime(
    process.execPath,
    resolve("packages/codex-tools/src/mcp-server.ts"),
  );
  const exchange = (request: string | null) =>
    new Promise<string>((resolveReply, reject) => {
      const socket = connect(runtime.endpoint);
      let reply = "";
      socket.on("data", (chunk) => (reply += chunk.toString("utf8")));
      socket.once("close", () => resolveReply(reply));
      socket.once("error", reject);
      if (request !== null)
        socket.once("connect", () =>
          socket.write(`${request}
`),
        );
    });
  try {
    const reply = JSON.parse(
      await exchange(
        JSON.stringify({
          schema_version: "1.0",
          token: runtime.token,
          request_id: "slow-call",
          tool_name: "project.get_summary",
          input: { schema_version: "1.0", project_id: "project-1" },
        }),
      ),
    ) as { ok: boolean };
    assert.equal(reply.ok, true);
    // A connection that never sends its request is still closed quickly.
    const started = Date.now();
    assert.equal(await exchange(null), "");
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await broker.close();
    await rm(root, { recursive: true, force: true });
  }
});

import { claudeAccountText } from "../../apps/desktop/renderer/claude-settings.ts";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  DesktopClaude,
  claudeEditorTools,
  claudeEditorServer,
} from "../../apps/desktop/src/claude.ts";
import {
  billingForMethod,
  claudeEnvironment,
  claudeExecutableCandidates,
  compareVersions,
  parseAuthStatus,
  parseCatalogResponse,
  parseClaudeVersion,
  restrictedSessionArguments,
  type ClaudeRuntime,
} from "../../packages/claude-bridge/src/cli.ts";
import {
  ClaudeTurnProjection,
  claudeTurnArguments,
} from "../../packages/claude-bridge/src/turn.ts";
import {
  assertClaudeThreadView,
  assertClaudeView,
  claudeIssues,
  claudeThreadIssues,
  type ClaudeThreadView,
  type ClaudeView,
} from "../../packages/domain/src/claude-view.ts";

const fake = resolve("tests/media/support/fake-claude-code.ts");
const fakeRuntime: ClaudeRuntime = {
  executable: process.execPath,
  prefix: [fake],
  version: "2.1.285",
};

test("auth status parsing follows the documented JSON and exit code", () => {
  // Shape captured from Claude Code 2.1.285 signed out in the isolated guest.
  const signedOut = JSON.stringify({
    loggedIn: false,
    authMethod: "none",
    apiProvider: "firstParty",
    analyticsDisabled: false,
    projectsDirectory: "/cfg/projects",
    configDirectory: "/cfg",
  });
  assert.deepEqual(parseAuthStatus(signedOut, 1), {
    loggedIn: false,
    method: "none",
  });
  assert.deepEqual(
    parseAuthStatus(
      JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      0,
    ),
    { loggedIn: true, method: "claude.ai" },
  );
  for (const [output, code] of [
    [signedOut, 0],
    [JSON.stringify({ loggedIn: true, authMethod: "none" }), 0],
    [JSON.stringify({ loggedIn: true, authMethod: "secret" }), 0],
    ["Not logged in.", 1],
  ] as const)
    assert.throws(() => parseAuthStatus(output, code));
  assert.equal(billingForMethod("claude.ai"), "subscription");
  assert.equal(billingForMethod("api_key"), "api");
  assert.equal(billingForMethod("third_party"), "other");
});

test("version parsing and comparison gate the supported CLI", () => {
  assert.equal(parseClaudeVersion("2.1.285 (Claude Code)\n"), "2.1.285");
  assert.equal(parseClaudeVersion("2.1.285"), null);
  assert.equal(parseClaudeVersion("codex 2.1.285 (Claude Code)"), null);
  assert.equal(compareVersions("2.1.285", "2.1.268"), 1);
  assert.equal(compareVersions("2.1.99", "2.1.268"), -1);
  assert.equal(compareVersions("2.1.268", "2.1.268"), 0);
});

test("the child environment drops inherited Anthropic credentials", () => {
  const env = claudeEnvironment({
    platform: "linux",
    configDirectory: "/private/claude",
    env: {
      PATH: "/usr/bin",
      HOME: "/home/user",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      ANTHROPIC_AUTH_TOKEN: "token",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--inspect",
    },
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/private/claude");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
  ])
    assert.equal(env[key], undefined, key);
  assert.throws(() =>
    claudeEnvironment({ platform: "linux", configDirectory: "rel", env: {} }),
  );
});

test("install discovery covers PATH, native installer and npm locations", () => {
  const linux = claudeExecutableCandidates("linux", {
    PATH: "/opt/bin:relative",
    HOME: "/home/user",
  });
  assert.deepEqual(linux, [
    "/opt/bin/claude",
    "/home/user/.local/bin/claude",
    "/home/user/.claude/local/claude",
  ]);
  if (process.platform === "win32") {
    const windows = claudeExecutableCandidates("win32", {
      PATH: "C:\\Tools",
      USERPROFILE: "C:\\Users\\u",
      APPDATA: "C:\\Users\\u\\AppData\\Roaming",
    });
    assert.ok(windows.includes("C:\\Tools\\claude.exe"));
    assert.ok(windows.includes("C:\\Users\\u\\.local\\bin\\claude.exe"));
    assert.ok(
      windows.some((path) => path.endsWith("claude-code\\bin\\claude.exe")),
    );
  }
});

test("catalog parsing keeps model names and drops API list prices", () => {
  const catalog = parseCatalogResponse({
    models: [
      {
        value: "default",
        resolvedModel: "claude-opus-5-5",
        displayName: "Default (recommended)",
        description:
          "Use the default model (currently Opus 5.5) · $4/$20 per Mtok",
        supportedEffortLevels: [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "huge",
        ],
      },
      { value: "default", displayName: "Duplicate" },
      { value: "../bad", displayName: "Bad" },
      {
        value: "haiku",
        displayName: "Haiku",
        description: "Haiku 4.5 · $1/$5",
      },
    ],
    account: { tokenSource: "claude.ai", subscriptionType: "max" },
  });
  assert.deepEqual(catalog.models, [
    {
      value: "default",
      label: "Default (recommended)",
      detail: "Use the default model (currently Opus 5.5)",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    { value: "haiku", label: "Haiku", detail: "Haiku 4.5", efforts: [] },
  ]);
  assert.equal(catalog.plan, "max");
  assert.doesNotMatch(JSON.stringify(catalog), /\$/u);
  assert.throws(() => parseCatalogResponse({ models: [] }));
  assert.throws(() => parseCatalogResponse(null));
});

test("turn arguments disable built-in tools, settings and prompts", () => {
  const args = claudeTurnArguments({
    mcpConfigPath: "/private/mcp.json",
    serverName: claudeEditorServer,
    allowedTools: claudeEditorTools,
    model: "default",
    effort: "high",
    systemPrompt: "prompt",
    sessionId: "11111111-2222-4333-8444-555555555555",
    resume: false,
    maxTurns: 24,
  });
  assert.deepEqual(args.slice(0, restrictedSessionArguments.length), [
    ...restrictedSessionArguments,
  ]);
  const value = (name: string) => args[args.indexOf(name) + 1];
  assert.equal(value("--tools"), "");
  assert.equal(value("--setting-sources"), "");
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(value("--permission-prompts"), "none");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.equal(value("--allowedTools"), claudeEditorTools.join(","));
  assert.equal(value("--session-id"), "11111111-2222-4333-8444-555555555555");
  assert.equal(value("--effort"), "high");
  assert.ok(!args.includes("--resume"));
  assert.equal(claudeEditorTools.length, 12);
  for (const name of ["zoom_set", "zoom_remove", "speed_set"])
    assert.ok(claudeEditorTools.includes(`mcp__ai_video_editor__${name}`));
  for (const name of claudeEditorTools)
    assert.match(name, /^mcp__ai_video_editor__[a-z_]+$/u);
});

const session = "11111111-2222-4333-8444-555555555555";
const projection = () =>
  new ClaudeTurnProjection({
    allowedTools: claudeEditorTools,
    serverName: claudeEditorServer,
    sessionId: session,
  });
const init = (tools: readonly string[] = claudeEditorTools) => ({
  type: "system",
  subtype: "init",
  session_id: session,
  tools: [...tools],
  mcp_servers: [{ name: claudeEditorServer, status: "connected" }],
  permissionMode: "dontAsk",
  skills: [],
  slash_commands: [],
});

test("projection enforces the authoritative init tool inventory", () => {
  for (const message of [
    init([...claudeEditorTools, "Bash"]),
    init(claudeEditorTools.slice(1)),
    { ...init(), permissionMode: "default" },
    { ...init(), mcp_servers: [] },
    { ...init(), skills: ["canary"] },
    { ...init(), session_id: "other" },
  ]) {
    const turn = projection();
    assert.equal(turn.handle(message), false);
    assert.equal(turn.violation, true);
    assert.deepEqual(turn.outcome, {
      kind: "failed",
      issue: "tools",
      text: null,
    });
  }
  const turn = projection();
  assert.equal(turn.handle(init()), true);
  assert.equal(
    turn.handle({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }] },
    }),
    false,
  );
  assert.equal(turn.outcome?.kind, "failed");
});

test("projection streams text, tracks activity and completes", () => {
  const turn = projection();
  turn.handle(init());
  for (const text of ["Rea", "ding"])
    turn.handle({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      },
    });
  assert.equal(turn.streaming, "Reading");
  turn.handle({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "text", text: "Reading" },
        { type: "tool_use", id: "toolu_1", name: claudeEditorTools[4] },
      ],
    },
  });
  assert.equal(turn.activities.length, 1);
  assert.equal(turn.pendingMutation, true);
  // Subagent traffic is ignored; the app exposes no Agent tool.
  turn.handle({
    type: "assistant",
    parent_tool_use_id: "toolu_x",
    message: { content: [{ type: "tool_use", id: "t", name: "Bash" }] },
  });
  assert.equal(turn.violation, false);
  turn.handle({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
  });
  assert.equal(turn.pendingMutation, false);
  turn.handle({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "Done." }] },
  });
  turn.handle({ type: "result", subtype: "success", is_error: false });
  assert.deepEqual(turn.outcome, {
    kind: "completed",
    text: "Reading\n\nDone.",
  });
});

test("zoom and speed tools pass the inventory and count as pending edits", () => {
  const turn = projection();
  assert.equal(turn.handle(init()), true);
  assert.equal(
    turn.handle({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: ["zoom_set", "zoom_remove", "speed_set"].map((name, i) => ({
          type: "tool_use",
          id: `toolu_${i + 1}`,
          name: `mcp__${claudeEditorServer}__${name}`,
        })),
      },
    }),
    true,
  );
  assert.equal(turn.violation, false);
  assert.deepEqual(
    turn.activities.map((item) => [item.label, item.mutating]),
    [
      ["Setting a zoom", true],
      ["Removing a zoom", true],
      ["Changing playback speed", true],
    ],
  );
  assert.equal(turn.pendingMutation, true);
});

test("projection maps documented failures to fixed issues", () => {
  const cases: Array<[string | undefined, Record<string, unknown>, string]> = [
    ["authentication_failed", {}, "signIn"],
    ["rate_limit", {}, "limit"],
    ["billing_error", {}, "account"],
    ["model_not_found", {}, "modelUnavailable"],
    [undefined, { subtype: "error_max_turns" }, "turns"],
    ["server_error", {}, "failed"],
  ];
  for (const [error, result, issue] of cases) {
    const turn = projection();
    turn.handle(init());
    turn.handle({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "raw provider detail" }] },
      ...(error ? { error } : {}),
    });
    turn.handle({
      type: "result",
      subtype: "success",
      is_error: true,
      ...result,
    });
    assert.equal(turn.outcome?.kind, "failed");
    assert.equal(
      (turn.outcome as { issue: string }).issue,
      issue,
      String(error ?? result.subtype),
    );
  }
  const interrupted = projection();
  interrupted.handle(init());
  interrupted.markInterrupted();
  interrupted.handle({ type: "result", is_error: true });
  assert.equal((interrupted.outcome as { issue: string }).issue, "stopped");
  const uncertain = projection();
  uncertain.handle(init());
  uncertain.handle({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: [
        { type: "tool_use", id: "toolu_2", name: claudeEditorTools[5] },
      ],
    },
  });
  assert.equal(
    (uncertain.closed(false) as { issue: string }).issue,
    "uncertain",
  );
  assert.equal(
    (projection().closed(true) as { issue: string }).issue,
    "resume",
  );
});

async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function harness(root: string, missing = false) {
  return new DesktopClaude(root, {
    platform: process.platform,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "sk-ant-should-not-pass",
      CLAUDE_CODE_OAUTH_TOKEN: "should-not-pass",
    },
    openExternal: async () => undefined,
    mcpRuntime: () => ({
      command: process.execPath,
      script: resolve("missing-mcp.cjs"),
      endpoint: "fixture-endpoint",
      token: "f".repeat(64),
    }),
    resolveRuntime: async () => {
      if (missing)
        throw new (
          await import("../../packages/claude-bridge/src/cli.ts")
        ).ClaudeCliError("missing");
      return fakeRuntime;
    },
  });
}

test("desktop Claude reports a missing installation without a fake connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-missing-"));
  try {
    const claude = await harness(root, true);
    const view = await claude.check();
    assertClaudeView(view);
    assert.equal(view.status, "unavailable");
    assert.equal(view.message, claudeIssues.missing);
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

test("desktop Claude signs in through the CLI flow and runs guarded turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-flow-"));
  const config = join(root, "claude", "claude-code");
  const scenario = (kind: string) =>
    writeFile(join(config, "fake-scenario.json"), JSON.stringify({ kind }));
  const log = async () =>
    (await readFile(join(config, "fake-log.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            inheritedSecret: boolean;
            disabledMemory: boolean;
          },
      );
  try {
    let claude = await harness(root);
    let view: ClaudeView = await claude.check();
    assert.equal(view.status, "signed_out");
    assert.equal(view.version, "2.1.285");
    assert.deepEqual(view.models, []);
    view = await claude.signIn();
    assert.equal(view.status, "signing_in");
    view = await waitFor(
      () => claude.get(),
      (value) => value.status === "signed_in",
      "sign-in",
    );
    assertClaudeView(view);
    assert.deepEqual(view.account, { billing: "subscription", plan: "max" });
    assert.deepEqual(view.selection, { model: "default", effort: null });
    assert.deepEqual(
      view.models.map((model) => model.value),
      ["default", "sonnet", "haiku"],
    );
    assert.doesNotMatch(JSON.stringify(view), /\$|claude-code|fake/u);
    view = await claude.select({ model: "sonnet", effort: "xhigh" });
    assert.equal(view.message, claudeIssues.selection);
    view = await claude.select({ model: "sonnet", effort: "high" });
    assert.deepEqual(view.selection, { model: "sonnet", effort: "high" });

    // A new main process restores the remembered model choice.
    claude = await harness(root);
    view = await claude.check();
    assert.deepEqual(view.selection, { model: "sonnet", effort: "high" });

    const project = "project-001";
    let thread: ClaudeThreadView = await claude.openThread(project);
    assert.equal(thread.status, "ready");
    await scenario("reply");
    thread = await claude.sendThread(project, "Say hello");
    assert.equal(thread.status, "running");
    thread = await waitFor(
      async () => claude.getThread(project),
      (value) => value.status === "ready",
      "reply",
    );
    assertClaudeThreadView(thread);
    assert.deepEqual(
      thread.messages.map((item) => [item.role, item.text]),
      [
        ["user", "Say hello"],
        ["assistant", "Hello"],
      ],
    );
    await scenario("edit");
    await claude.sendThread(project, "Split it");
    thread = await waitFor(
      async () => claude.getThread(project),
      (value) => value.status === "ready",
      "edit",
    );
    assert.equal(thread.messages.at(-1)?.text, "Split the clip.");
    const turns = (await log()).filter(
      (entry) => entry.args[0] === "-p" && entry.args.includes("--model"),
    );
    assert.ok(turns[0]!.args.includes("--session-id"));
    assert.ok(turns[1]!.args.includes("--resume"));
    assert.equal(
      turns[0]!.args[turns[0]!.args.indexOf("--session-id") + 1],
      turns[1]!.args[turns[1]!.args.indexOf("--resume") + 1],
    );
    for (const entry of await log()) {
      assert.equal(entry.inheritedSecret, false);
      assert.equal(entry.disabledMemory, true);
    }
    // The per-turn MCP config holding the broker token is removed after use.
    assert.deepEqual(
      (await readdir(join(root, "claude", "runtime"))).filter((name) =>
        name.endsWith(".json"),
      ),
      [],
    );

    await scenario("hang");
    await claude.sendThread(project, "Read slowly");
    await waitFor(
      async () => claude.getThread(project),
      (value) => value.activities.length === 1,
      "activity",
    );
    thread = await claude.interruptThread(project);
    assert.equal(thread.status, "interrupting");
    thread = await waitFor(
      async () => claude.getThread(project),
      (value) => value.status === "failed",
      "interrupt",
    );
    assert.equal(thread.message, claudeThreadIssues.stopped);

    for (const [kind, issue] of [
      ["extra_tool", claudeThreadIssues.tools],
      ["bad_tool_use", claudeThreadIssues.tools],
      ["rate", claudeThreadIssues.limit],
    ] as const) {
      await scenario(kind);
      await claude.sendThread(project, `Try ${kind}`);
      thread = await waitFor(
        async () => claude.getThread(project),
        (value) => value.status === "failed",
        kind,
      );
      assert.equal(thread.message, issue, kind);
    }

    // Persisted history reopens without the provider; stored file is private.
    await claude.closeThread(project);
    const reopened = await (await harness(root)).openThread(project);
    assert.equal(reopened.messages.length, thread.messages.length);
    await claude.openThread(project);
    const stored = await readFile(
      join(root, "claude", "threads", `${project}.json`),
      "utf8",
    );
    assert.doesNotMatch(
      stored,
      /sk-ant|should-not-pass|fixture-endpoint|f{64}/u,
    );
    if (process.platform !== "win32")
      assert.equal(
        (await stat(join(root, "claude", "threads", `${project}.json`))).mode &
          0o777,
        0o600,
      );

    await scenario("resume_missing");
    await claude.sendThread(project, "Continue");
    thread = await waitFor(
      async () => claude.getThread(project),
      (value) => value.status === "failed",
      "resume",
    );
    assert.equal(thread.message, claudeThreadIssues.resume);
    await scenario("reply");
    await claude.sendThread(project, "Start over");
    thread = await waitFor(
      async () => claude.getThread(project),
      (value) => value.status === "ready",
      "fresh session",
    );
    const fresh = (await log())
      .filter(
        (entry) => entry.args[0] === "-p" && entry.args.includes("--model"),
      )
      .at(-1)!;
    assert.ok(fresh.args.includes("--session-id"));

    view = await claude.signOut();
    assert.equal(view.status, "signed_out");
    await claude.close();
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

test("cancelled sign-in returns to signed out without an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-cancel-"));
  try {
    const claude = await harness(root);
    await claude.check();
    await writeFile(
      join(root, "claude", "claude-code", "fake-scenario.json"),
      JSON.stringify({ kind: "login_never" }),
    );
    await claude.signIn();
    await waitFor(
      () => claude.get(),
      (value) => value.status === "signing_in",
      "signing in",
    );
    const view = await claude.cancelSignIn();
    assert.equal(view.status, "signed_out");
    assert.equal(view.message, null);
    const thread = await claude.openThread("project-002");
    await claude.sendThread("project-002", "Hello");
    const failed = claude.getThread(thread.projectId!);
    assert.equal(failed.message, claudeThreadIssues.signIn);
    await claude.close();
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

test("IPC schema enumerations match the Claude domain constants", async () => {
  const schema = JSON.parse(
    await readFile("docs/schemas/desktop_ipc.schema.json", "utf8"),
  ) as {
    $defs: Record<string, { properties: Record<string, { enum: unknown[] }> }>;
  };
  assert.deepEqual(schema.$defs.claudeView!.properties.message!.enum, [
    null,
    ...Object.values(claudeIssues),
  ]);
  assert.deepEqual(schema.$defs.claudeThreadView!.properties.message!.enum, [
    null,
    ...Object.values(claudeThreadIssues),
  ]);
});

test("account text names the plan once", () => {
  const view = (plan: string | null): ClaudeView => ({
    status: "signed_in",
    version: "2.1.292",
    account: { billing: "subscription", plan },
    models: [{ value: "default", label: "Default", detail: "", efforts: [] }],
    selection: { model: "default", effort: null },
    message: null,
  });
  assert.equal(claudeAccountText(view("max")), "Claude · Max");
  assert.equal(claudeAccountText(view("Claude Max")), "Claude Max");
  assert.equal(claudeAccountText(view(null)), "Claude · Signed in");
});

test("domain assertions reject leaked or inconsistent Claude state", () => {
  const signedOut: ClaudeView = {
    status: "signed_out",
    version: "2.1.285",
    account: null,
    models: [],
    selection: null,
    message: null,
  };
  assertClaudeView(signedOut);
  for (const bad of [
    { ...signedOut, token: "secret" },
    // The removed fallback page must not reappear as an unchecked field.
    { ...signedOut, signInPageAvailable: false },
    { ...signedOut, selection: { model: "default", effort: null } },
    { ...signedOut, message: "Not logged in · Please run /login" },
    { ...signedOut, status: "signed_in" },
    { ...signedOut, version: null },
  ])
    assert.throws(() => assertClaudeView(bad), JSON.stringify(bad));
  const closed: ClaudeThreadView = {
    status: "closed",
    projectId: null,
    messages: [],
    activities: [],
    streaming: null,
    billing: null,
    message: null,
  };
  assertClaudeThreadView(closed);
  for (const bad of [
    { ...closed, projectId: "project-001" },
    { ...closed, status: "ready" },
    { ...closed, status: "ready", projectId: "project-001", streaming: "x" },
    { ...closed, sessionId: "11111111-2222-4333-8444-555555555555" },
  ])
    assert.throws(() => assertClaudeThreadView(bad), JSON.stringify(bad));
});

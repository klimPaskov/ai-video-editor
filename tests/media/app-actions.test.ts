import assert from "node:assert/strict";
import test from "node:test";

import {
  appActionSteps,
  appActionToolNames,
  claudeEditorToolNames,
  claudeOnlyToolNames,
  CodexVideoEditToolError,
  CodexVideoEditToolService,
  codexVideoEditToolNames,
  type AppActionResult,
  type AppActions,
} from "../../packages/codex-tools/src/service.ts";
import {
  claudeEditorMcpTools,
  claudeOnlyMcpTools,
  codexVideoEditMcpTools,
} from "../../packages/codex-tools/src/mcp-tools.ts";
import { projectStages } from "../../packages/domain/src/project-view.ts";
import {
  claudeIssues,
  claudeThreadIssues,
} from "../../packages/domain/src/claude-view.ts";
import { apiTurnProblems } from "../../apps/desktop/src/api-thread.ts";
import {
  createAppActions,
  DeferredActions,
  StoryPassEditor,
  apiRoughCutTools,
  claudeOutcome,
  type ApiStory,
  type ClaudeStory,
  type CodexStory,
} from "../../apps/desktop/src/story-pass.ts";
import { roughCutTools } from "../../apps/desktop/src/rough-cut-playbook.ts";
import { idleMagicWandView } from "../../packages/domain/src/magic-wand-view.ts";

const project = "project-actions-1";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 400; index++) {
    if (check()) return;
    await wait(5);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// The guarded app-action tools

function actionsRecorder() {
  const calls: unknown[][] = [];
  const answer = (status: AppActionResult["status"]): AppActionResult => ({
    status,
    message: "Plain words for the user.",
  });
  const actions: AppActions = {
    startMagicEdit: async (id, preset) => {
      calls.push(["magic", id, preset]);
      return answer("queued");
    },
    startEditMyVideo: async (id, level) => {
      calls.push(["edit", id, level]);
      return answer("queued");
    },
    stopEdit: async (id) => {
      calls.push(["stop", id]);
      return answer("stopped");
    },
    goToStep: async (id, step) => {
      calls.push(["step", id, step]);
      return answer("moved");
    },
  };
  return { calls, actions };
}

function service(
  origin: "codex" | "claude" | "api_provider",
  actions?: AppActions,
) {
  return new CodexVideoEditToolService(
    project,
    {} as never,
    origin,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
}

function code(expected: CodexVideoEditToolError["code"]) {
  return (error: unknown) =>
    error instanceof CodexVideoEditToolError && error.code === expected;
}

const head = { schema_version: "1.0", project_id: project };

test("app actions reach the same code as the buttons and answer in plain words", async () => {
  const { calls, actions } = actionsRecorder();
  const tools = service("codex", actions);
  const started = (await tools.invoke("app.start_magic_edit", {
    ...head,
    preset: "tight",
  })) as Record<string, unknown>;
  assert.deepEqual(started, {
    schema_version: "1.0",
    project_id: project,
    status: "queued",
    message: "Plain words for the user.",
  });
  await tools.invoke("app.stop_edit", head);
  await tools.invoke("app.go_to_step", { ...head, step: "clips" });
  assert.deepEqual(calls, [
    ["magic", project, "tight"],
    ["stop", project],
    ["step", project, "clips"],
  ]);
});

test("app action input is validated and scoped to the active project", async () => {
  const { calls, actions } = actionsRecorder();
  const tools = service("api_provider", actions);
  for (const [name, input] of [
    ["app.start_magic_edit", { ...head, preset: "extreme" }],
    ["app.start_magic_edit", { ...head }],
    ["app.start_magic_edit", { ...head, preset: "tight", provider: "claude" }],
    ["app.go_to_step", { ...head, step: "cleanup" }],
    ["app.go_to_step", { ...head, step: "delete" }],
    // The Review step is gone, and Done is reached only by exporting.
    ["app.go_to_step", { ...head, step: "review" }],
    ["app.go_to_step", { ...head, step: "done" }],
    ["app.stop_edit", { ...head, extra: true }],
    ["app.stop_edit", { schema_version: "2.0", project_id: project }],
  ] as const)
    await assert.rejects(
      () => tools.invoke(name, input),
      code("invalid_request"),
      JSON.stringify(input),
    );
  await assert.rejects(
    () =>
      tools.invoke("app.stop_edit", {
        schema_version: "1.0",
        project_id: "project-other",
      }),
    code("inactive_project"),
  );
  assert.deepEqual(calls, [], "nothing ran for a refused request");
  await assert.rejects(
    () => service("codex").invoke("app.stop_edit", head),
    code("service_unavailable"),
  );
  // There is no export or cleanup action to ask for.
  for (const name of [
    "app.export",
    "app.start_export",
    "app.cleanup",
    "app.delete_project",
    "app.delete_source",
  ])
    await assert.rejects(
      () => tools.invoke(name, head),
      code("tool_not_available"),
      name,
    );
});

test("the full Edit my video action is Claude's alone", async () => {
  const { calls, actions } = actionsRecorder();
  const input = { ...head, level: "bold" };
  await service("claude", actions).invoke("app.start_edit_my_video", input);
  assert.deepEqual(calls, [["edit", project, "bold"]]);
  for (const origin of ["codex", "api_provider"] as const)
    await assert.rejects(
      () => service(origin, actions).invoke("app.start_edit_my_video", input),
      code("tool_not_available"),
      origin,
    );
  await assert.rejects(
    () =>
      service("claude", actions).invoke("app.start_edit_my_video", {
        ...head,
        level: "wild",
      }),
    code("invalid_request"),
  );
});

test("tool inventories: three shared actions, one Claude-only, no export or cleanup", () => {
  const shared = [
    "app.start_magic_edit",
    "app.stop_edit",
    "app.go_to_step",
  ] as const;
  for (const name of shared) {
    assert.ok(
      (codexVideoEditToolNames as readonly string[]).includes(name),
      name,
    );
    assert.ok((claudeEditorToolNames as readonly string[]).includes(name));
  }
  assert.deepEqual([...claudeOnlyToolNames].slice(-1), [
    "app.start_edit_my_video",
  ]);
  assert.equal(
    (codexVideoEditToolNames as readonly string[]).includes(
      "app.start_edit_my_video",
    ),
    false,
  );
  assert.equal(codexVideoEditToolNames.length, 22);
  assert.equal(claudeEditorToolNames.length, 33);
  // The API providers get the shared list without the picture tool.
  assert.equal(
    codexVideoEditToolNames.filter((name) => name !== "media.get_frames")
      .length,
    21,
  );
  assert.deepEqual(
    codexVideoEditMcpTools.map((tool) => tool.name),
    [...codexVideoEditToolNames],
  );
  assert.deepEqual(
    claudeEditorMcpTools.map((tool) => tool.name),
    [...claudeEditorToolNames],
  );
  assert.deepEqual(
    claudeOnlyMcpTools.map((tool) => tool.name),
    [...claudeOnlyToolNames],
  );
  assert.deepEqual(
    [...appActionToolNames].sort(),
    [...claudeEditorToolNames].filter((name) => name.startsWith("app.")).sort(),
  );
  for (const name of appActionToolNames)
    assert.doesNotMatch(name, /export|delete|clean|remove/u, name);
  // The steps are the project's stages without the Done screen (only an export reaches it), in order.
  assert.deepEqual([...appActionSteps], projectStages.slice(0, 5));
  // The story edit can never start other actions.
  for (const name of roughCutTools)
    assert.equal(appActionToolNames.has(name), false, name);
  for (const name of apiRoughCutTools)
    assert.equal(name.startsWith("app_"), false, name);
  assert.equal(apiRoughCutTools.has("media_get_frames"), false);
  assert.ok(apiRoughCutTools.has("cut_delete_ranges"));
});

// ---------------------------------------------------------------------------
// The story edit with each connection

const thread = (status: string, message: string | null = null) =>
  ({
    status,
    message,
    projectId: project,
    messages: [],
    activities: [],
  }) as never;

function claudeFake(view: Record<string, unknown>) {
  const log = { started: [] as string[], interrupted: 0 };
  let current = thread("running");
  const claude: ClaudeStory = {
    settled: async () => view as never,
    startRoughCut: async (_id, preset, request) => {
      log.started.push(`${preset}:${request}`);
      return current;
    },
    getThread: () => current,
    interruptThread: async () => {
      log.interrupted++;
      return current;
    },
    runKind: () => "rough_cut",
  };
  return {
    claude,
    log,
    set: (status: string, message: string | null = null) =>
      (current = thread(status, message)),
  };
}

test("Claude's readiness says how to fix what is wrong, including an old Claude Code", async () => {
  const cases: Array<[Record<string, unknown>, string | null]> = [
    [{ status: "signed_in", selection: { model: "m" } }, null],
    [
      { status: "signed_in", selection: null, roughCutSelection: null },
      "setup",
    ],
    [{ status: "signed_out" }, "signIn"],
    [{ status: "signing_in" }, "signIn"],
    [{ status: "unavailable", message: claudeIssues.outdated }, "outdated"],
    [{ status: "unavailable", message: claudeIssues.missing }, "missing"],
    [{ status: "error", message: claudeIssues.status }, "setup"],
  ];
  for (const [view, expected] of cases) {
    const editor = new StoryPassEditor({
      claude: () => claudeFake(view).claude,
      codex: () => undefined,
      api: () => undefined,
    });
    assert.equal(
      await editor.blocked("claude"),
      expected,
      JSON.stringify(view),
    );
  }
  const none = new StoryPassEditor({
    claude: () => undefined,
    codex: () => undefined,
    api: () => undefined,
  });
  assert.equal(await none.blocked("claude"), "missing");
});

test("Claude's story edit starts, finishes and stops as before", async () => {
  const fake = claudeFake({ status: "signed_in", selection: { model: "m" } });
  const editor = new StoryPassEditor({
    claude: () => fake.claude,
    codex: () => undefined,
    api: () => undefined,
  });
  assert.equal(
    await editor.start(project, "balanced", "REQUEST", "claude"),
    null,
  );
  assert.deepEqual(fake.log.started, ["balanced:REQUEST"]);
  assert.equal(editor.outcome(project), null);
  await editor.stop(project);
  assert.equal(fake.log.interrupted, 1);
  fake.set("ready");
  assert.equal(editor.outcome(project), "completed");
  fake.set("failed", claudeThreadIssues.stopped);
  assert.equal(editor.outcome(project), "stopped");
  assert.equal(
    claudeOutcome(thread("failed", claudeThreadIssues.limit)),
    "limit",
  );
  assert.equal(
    claudeOutcome(thread("failed", claudeThreadIssues.signIn)),
    "signIn",
  );
  const signedOut = claudeFake({ status: "signed_out" });
  const refusing = new StoryPassEditor({
    claude: () => signedOut.claude,
    codex: () => undefined,
    api: () => undefined,
  });
  assert.equal(await refusing.start(project, "tight", "x", "claude"), "signIn");
  assert.deepEqual(signedOut.log.started, []);
});

function codexFake(view?: Record<string, unknown>) {
  const log = { opened: 0, sent: [] as string[], interrupted: 0 };
  let current = thread("closed");
  const codex: CodexStory = {
    get: async () =>
      (view ?? {
        connection: "connected",
        account: "signed_in",
        selection: { modelId: "m", reasoning: "high" },
      }) as never,
    getThread: () => current,
    openThread: async () => {
      log.opened++;
      return (current = thread("ready"));
    },
    sendThread: async (_id, text) => {
      log.sent.push(text);
      return (current = thread("running"));
    },
    interruptThread: async () => {
      log.interrupted++;
      return (current = thread("interrupting"));
    },
  };
  return { codex, log, set: (status: string) => (current = thread(status)) };
}

test("Codex makes the story edit in its thread, with the playbook in the turn and the tools restricted", async () => {
  const fake = codexFake();
  const editor = new StoryPassEditor({
    claude: () => undefined,
    codex: () => fake.codex,
    api: () => undefined,
  });
  assert.equal(await editor.blocked("codex"), null);
  assert.equal(editor.restricted(project, "codex"), false);
  assert.equal(
    await editor.start(project, "balanced", "REQUEST", "codex"),
    null,
  );
  assert.equal(fake.log.opened, 1);
  assert.match(fake.log.sent[0]!, /# Rough cut playbook/u);
  assert.match(fake.log.sent[0]!, /REQUEST$/u);
  assert.equal(editor.restricted(project, "codex"), true);
  assert.equal(editor.restricted(project, "api"), false);
  assert.equal(editor.outcome(project), null);
  await editor.stop(project);
  assert.equal(fake.log.interrupted, 1);
  fake.set("ready");
  assert.equal(editor.outcome(project), "stopped");
  editor.release(project);
  assert.equal(editor.restricted(project, "codex"), false);
  // A normal finish and a failure.
  await editor.start(project, "tight", "R2", "codex");
  fake.set("ready");
  assert.equal(editor.outcome(project), "completed");
  fake.set("uncertain");
  assert.equal(editor.outcome(project), "failed");
});

test("Codex that is signed out or not connected is reported, not started", async () => {
  const out = codexFake({
    connection: "connected",
    account: "signed_out",
    selection: null,
  });
  const editor = new StoryPassEditor({
    claude: () => undefined,
    codex: () => out.codex,
    api: () => undefined,
  });
  assert.equal(await editor.blocked("codex"), "signIn");
  assert.equal(await editor.start(project, "tight", "x", "codex"), "signIn");
  assert.deepEqual(out.log.sent, []);
  const down = codexFake({
    connection: "disconnected",
    account: "unknown",
    selection: null,
  });
  const other = new StoryPassEditor({
    claude: () => undefined,
    codex: () => down.codex,
    api: () => undefined,
  });
  assert.equal(await other.blocked("codex"), "setup");
});

function apiFake(options: { connected?: boolean; model?: string | null } = {}) {
  const connected = options.connected ?? true;
  const model = options.model === undefined ? "model-1" : options.model;
  const log = {
    sends: [] as Array<{
      provider: string;
      text: string;
      turn: Record<string, unknown>;
    }>,
    interrupted: [] as string[],
  };
  let finish: ((view: unknown) => void) | undefined;
  const api: ApiStory = {
    providers: {
      get: async () =>
        ({
          providers: ["deepseek", "openai", "gemini"].map((id) => ({
            id,
            connected: connected,
            selectedModel: model,
          })),
        }) as never,
      selected: async () => (connected && model ? { key: "k", model } : null),
    },
    threads: {
      get: async () => thread("ready") as never,
      open: async () => thread("ready") as never,
      send: (_id, provider, text, turn) => {
        log.sends.push({
          provider,
          text,
          turn: turn as unknown as Record<string, unknown>,
        });
        return new Promise((resolve) => (finish = resolve as never));
      },
      interrupt: async (_id, provider) => {
        log.interrupted.push(provider);
        return thread("interrupting") as never;
      },
    },
  };
  return { api, log, finish: (view: unknown) => finish?.(view) };
}

test("an API provider makes the story edit with the cutting tools only, within a larger budget", async () => {
  const fake = apiFake();
  const editor = new StoryPassEditor({
    claude: () => undefined,
    codex: () => undefined,
    api: () => fake.api,
  });
  assert.equal(await editor.blocked("openai"), null);
  assert.equal(
    await editor.start(
      project,
      "balanced",
      "Use transcript_get_range",
      "openai",
    ),
    null,
  );
  const sent = fake.log.sends[0]!;
  assert.equal(sent.provider, "openai");
  assert.equal(sent.text, "Rough cut with OpenAI API · Balanced");
  const turn = sent.turn as {
    request: string;
    playbook: string;
    tools: ReadonlySet<string>;
    maxCompletions: number;
    maxToolCalls: number;
  };
  assert.equal(turn.request, "Use transcript_get_range");
  assert.doesNotMatch(turn.playbook, /rendered picture/u);
  assert.ok(turn.tools.has("cut_delete_ranges"));
  assert.ok(!turn.tools.has("graphics_set"));
  assert.ok(!turn.tools.has("timeline_undo"));
  assert.ok(!turn.tools.has("app_start_magic_edit"));
  assert.ok(turn.maxCompletions > 4 && turn.maxToolCalls > 8);
  assert.equal(editor.restricted(project, "api"), true);
  assert.equal(editor.outcome(project), null);
  fake.finish(thread("ready"));
  await until(() => editor.outcome(project) !== null, "the API turn to end");
  assert.equal(editor.outcome(project), "completed");
  assert.equal(editor.restricted(project, "api"), false);
});

test("API turn endings map to what Magic Edit reports, and Stop interrupts the turn", async () => {
  const cases: Array<[string | null, string]> = [
    [apiTurnProblems.rate, "limit"],
    [apiTurnProblems.authentication, "signIn"],
    [apiTurnProblems.response, "failed"],
    [apiTurnProblems.stopped, "stopped"],
  ];
  for (const [message, expected] of cases) {
    const fake = apiFake();
    const editor = new StoryPassEditor({
      claude: () => undefined,
      codex: () => undefined,
      api: () => fake.api,
    });
    await editor.start(project, "tight", "x", "gemini");
    fake.finish(thread("failed", message));
    await until(() => editor.outcome(project) !== null, "the turn to end");
    assert.equal(editor.outcome(project), expected, String(message));
  }
  const fake = apiFake();
  const editor = new StoryPassEditor({
    claude: () => undefined,
    codex: () => undefined,
    api: () => fake.api,
  });
  await editor.start(project, "tight", "x", "deepseek");
  await editor.stop(project);
  assert.deepEqual(fake.log.interrupted, ["deepseek"]);
  fake.finish(thread("failed", apiTurnProblems.stopped));
  await until(() => editor.outcome(project) !== null, "the stopped turn");
  assert.equal(editor.outcome(project), "stopped");
});

test("an API provider without a key or model says which", async () => {
  const noKey = new StoryPassEditor({
    claude: () => undefined,
    codex: () => undefined,
    api: () => apiFake({ connected: false }).api,
  });
  assert.equal(await noKey.blocked("deepseek"), "signIn");
  const noModel = new StoryPassEditor({
    claude: () => undefined,
    codex: () => undefined,
    api: () => apiFake({ model: null }).api,
  });
  assert.equal(await noModel.blocked("gemini"), "setup");
  assert.equal(await noModel.start(project, "tight", "x", "gemini"), "failed");
});

// ---------------------------------------------------------------------------
// Actions that wait for the reply, and the chat's own actions

test("deferred work waits for the reply to finish and Stop cancels it", async () => {
  const deferred = new DeferredActions(2);
  let idle = false;
  let ran = 0;
  const done = deferred.defer(
    project,
    () => idle,
    async () => {
      ran++;
    },
  );
  assert.ok(done);
  assert.equal(deferred.has(project), true);
  assert.equal(
    deferred.defer(
      project,
      () => true,
      async () => undefined,
    ),
    null,
    "one pending job per project",
  );
  await wait(30);
  assert.equal(ran, 0, "still waiting for the reply");
  idle = true;
  await done;
  assert.equal(ran, 1);
  assert.equal(deferred.has(project), false);
  let neverRan = true;
  const cancelled = deferred.defer(
    project,
    () => false,
    async () => {
      neverRan = false;
    },
  )!;
  assert.equal(deferred.cancel(project), true);
  await cancelled;
  assert.equal(neverRan, true);
  assert.equal(deferred.cancel(project), false);
});

function appFixture(
  options: {
    provider?: "claude" | "codex" | "openai";
    step?: (typeof projectStages)[number];
    busy?: boolean;
    withFullEdit?: boolean;
  } = {},
) {
  const log: string[] = [];
  let idle = false;
  let busy = options.busy ?? false;
  let step = options.step ?? "clips";
  let view = { ...idleMagicWandView() };
  const deferred = new DeferredActions(2);
  const provider = options.provider ?? "codex";
  const actions = createAppActions({
    provider,
    deferred,
    magic: {
      busy: () => busy,
      start: (_id, preset, who) => {
        log.push(`magic:${preset}:${who}`);
        busy = true;
        view = {
          ...view,
          status: "transcribing",
          projectId: project,
          preset,
          progress: 0,
        };
        return view;
      },
      stop: () => {
        log.push("magic-stop");
        busy = false;
        return view;
      },
      get: () => view,
    },
    chatIdle: () => idle,
    currentStep: async () => step,
    navigate: async (_id, next) => {
      if (next === "export" && step === "edit")
        throw new Error("Stop local transcription before leaving Magic Edit.");
      log.push(`navigate:${next}`);
      step = next;
    },
    ...(options.withFullEdit
      ? {
          startFullEdit: async (_id: string, level: string) => {
            log.push(`full-edit:${level}`);
          },
          stopFullEdit: async () => {
            log.push("full-edit-stop");
            return true;
          },
        }
      : {}),
  });
  return {
    actions,
    deferred,
    log,
    reply: () => (idle = true),
    finishMagic: (status: "completed" | "failed") => {
      busy = false;
      view = { ...view, status, progress: null };
    },
  };
}

test("Magic Edit from a chat starts only after the reply, in Magic Edit, with that chat's connection", async () => {
  const fixture = appFixture({ provider: "openai", step: "clips" });
  const answer = await fixture.actions.startMagicEdit(project, "gentle");
  assert.equal(answer.status, "queued");
  assert.match(answer.message, /as soon as this reply is finished/u);
  await wait(30);
  assert.deepEqual(fixture.log, [], "nothing runs while the reply is written");
  fixture.reply();
  await until(() => fixture.log.includes("magic:gentle:openai"), "Magic Edit");
  // The transcript needs Magic Edit or Edit, so the app moves there first.
  assert.deepEqual(fixture.log, ["navigate:auto_edit", "magic:gentle:openai"]);
});

test("a second start while one is running or waiting says so; Stop ends either", async () => {
  const waiting = appFixture();
  await waiting.actions.startMagicEdit(project, "tight");
  const busy = await waiting.actions.startMagicEdit(project, "tight");
  assert.equal(busy.status, "busy");
  const stopped = await waiting.actions.stopEdit(project);
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.message, /cancelled/u);
  waiting.reply();
  await wait(30);
  assert.deepEqual(waiting.log, [], "a cancelled start never runs");

  const running = appFixture({ busy: true });
  assert.equal(
    (await running.actions.startMagicEdit(project, "tight")).status,
    "busy",
  );
  const result = await running.actions.stopEdit(project);
  assert.equal(result.status, "stopped");
  assert.deepEqual(running.log, ["magic-stop"]);

  const idle = appFixture();
  const nothing = await idle.actions.stopEdit(project);
  assert.equal(nothing.status, "nothing_running");
});

test("moving to a step reports what happened, including a refusal in plain words", async () => {
  const fixture = appFixture({ step: "auto_edit" });
  const moved = await fixture.actions.goToStep(project, "clips");
  assert.equal(moved.status, "moved");
  assert.match(moved.message, /Clips/u);
  const exportStep = await fixture.actions.goToStep(project, "export");
  assert.equal(exportStep.status, "moved");
  assert.match(exportStep.message, /Nothing is exported until/u);
  const edit = appFixture({ step: "edit" });
  const refused = await edit.actions.goToStep(project, "export");
  assert.equal(refused.status, "not_available");
  assert.match(refused.message, /Stop local transcription/u);
});

test("Edit my video runs the rough cut, then the production edit only if it finished", async () => {
  const good = appFixture({ provider: "claude", withFullEdit: true });
  assert.ok(good.actions.startEditMyVideo);
  const answer = await good.actions.startEditMyVideo!(project, "polished");
  assert.equal(answer.status, "queued");
  good.reply();
  await until(() => good.log.includes("magic:balanced:claude"), "rough cut");
  assert.ok(!good.log.includes("full-edit:polished"), "after the rough cut");
  good.finishMagic("completed");
  await until(() => good.log.includes("full-edit:polished"), "the full edit");

  const bad = appFixture({ provider: "claude", withFullEdit: true });
  await bad.actions.startEditMyVideo!(project, "bold");
  bad.reply();
  await until(() => bad.log.includes("magic:balanced:claude"), "rough cut");
  bad.finishMagic("failed");
  await wait(60);
  assert.ok(!bad.log.some((entry) => entry.startsWith("full-edit")));

  const other = appFixture({ provider: "codex" });
  assert.equal(other.actions.startEditMyVideo, undefined);
  assert.deepEqual(Object.keys(other.actions).sort(), [
    "goToStep",
    "startMagicEdit",
    "stopEdit",
  ]);
});

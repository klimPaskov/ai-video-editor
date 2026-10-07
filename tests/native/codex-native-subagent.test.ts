/** Authenticated native-child test. It never reads credentials or prints raw turns. */
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "playwright/test";
import { assertInitialProjectSnapshot } from "../../packages/domain/src/project.ts";
import {
  encodeVerifiedMaster,
  sha256,
} from "../../packages/media-engine/src/lossless.ts";
import {
  CodexStdioTransport,
  CodexTransportError,
} from "../../packages/codex-bridge/src/transport.ts";
import { buildCodexAppServerArguments } from "../../packages/codex-bridge/src/client.ts";
import { buildExperimentalInitialize } from "../../packages/codex-bridge/src/thread-protocol.ts";

assert.equal(process.platform, "linux", "Requires isolated Linux guest");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await access("/.dockerenv");
const executablePath = process.argv[2];
const configArgument = process.argv[3];
assert.ok(executablePath && isAbsolute(executablePath));
assert.ok(configArgument && isAbsolute(configArgument));
const selectedModelId =
  process.argv.find((argument) => argument.startsWith("--model="))?.slice(8) ??
  "gpt-6-luna";
assert.ok(
  selectedModelId === "gpt-5.6-luna" || selectedModelId === "gpt-6-luna",
  "Select a supported Luna model for native child verification",
);
const expectedMultiAgentVersion =
  selectedModelId === "gpt-6-luna" ? "v2" : "v1";
const configRoot = await realpath(configArgument);
assert.equal(
  configRoot,
  resolve(configArgument),
  "Config root must not redirect",
);
assert.notEqual(configRoot, "/");
const hostileMcpConfig = join(
  configRoot,
  "codex-video-edit",
  "codex",
  "account",
  "config.toml",
);
await mkdir(dirname(hostileMcpConfig), { recursive: true, mode: 0o700 });
await assert.rejects(access(hostileMcpConfig));
await writeFile(
  hostileMcpConfig,
  '[mcp_servers.untrusted_test]\ncommand = "/bin/false"\nargs = []\nenabled = true\n',
  { mode: 0o600, flag: "wx" },
);
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "native-codex-child-"));
await chmod(evidence, 0o700);
let step = "fixture";
const mark = (value: string): void => {
  step = value;
  console.log(`STEP ${value}`);
};
async function inspectionHold(): Promise<{
  display: ":99";
  width: 1440;
  height: 900;
  screenshotSha256: string;
} | null> {
  if (!process.argv.includes("--inspect")) return null;
  console.log(JSON.stringify({ inspectionReady: true, evidence }));
  const deadline = Date.now() + 600000;
  while (true) {
    try {
      const inspection: unknown = JSON.parse(
        await readFile(join(evidence, "inspection.done"), "utf8"),
      );
      assert.ok(record(inspection));
      assert.equal(inspection.action, "capture");
      assert.equal(inspection.hostInput, false);
      assert.equal(inspection.display, ":99");
      assert.equal(inspection.width, 1440);
      assert.equal(inspection.height, 900);
      assert.ok(
        typeof inspection.screenshot === "string" &&
          inspection.screenshot.startsWith("/home/node/evidence/visual/"),
      );
      assert.ok(
        typeof inspection.sha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(inspection.sha256),
      );
      return {
        display: ":99",
        width: 1440,
        height: 900,
        screenshotSha256: inspection.sha256,
      };
    } catch {
      /* Guest-only input marker. */
    }
    if (Date.now() > deadline) throw new Error("Inspection timeout");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
const resourceRoot = join(dirname(executablePath), "resources");
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify(
    {
      asarHash: sha256(await readFile(join(resourceRoot, "app.asar"))),
      runtimeManifestHash: sha256(
        await readFile(join(resourceRoot, "codex/manifest.json")),
      ),
      mcpManifestHash: sha256(
        await readFile(join(resourceRoot, "mcp/manifest.json")),
      ),
      testHash: sha256(await readFile(fileURLToPath(import.meta.url))),
    },
    null,
    2,
  ),
);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function turns(value: unknown): Record<string, unknown>[] {
  assert.ok(record(value) && Array.isArray(value.data));
  assert.ok(value.data.length > 0 && value.data.length <= 100);
  return value.data.map((turn: unknown) => {
    assert.ok(record(turn) && Array.isArray(turn.items));
    return turn;
  });
}

function items(turn: Record<string, unknown>): Record<string, unknown>[] {
  assert.ok(Array.isArray(turn.items));
  return turn.items.map((item: unknown) => {
    assert.ok(record(item));
    return item;
  });
}

function dynamicToolResult(
  item: Record<string, unknown>,
): Record<string, unknown> {
  assert.ok(Array.isArray(item.contentItems));
  const content = item.contentItems.find(
    (entry: unknown) =>
      record(entry) &&
      entry.type === "inputText" &&
      typeof entry.text === "string",
  );
  assert.ok(record(content));
  const result: unknown = JSON.parse(content.text as string);
  assert.ok(record(result));
  return result;
}

async function rolloutRecords(
  thread: Record<string, unknown>,
  codexHome: string,
): Promise<Record<string, unknown>[]> {
  // Thread.path is an unstable App Server field; use it only in this private,
  // pinned-runtime test, and confine the read to the isolated account.
  assert.ok(typeof thread.path === "string" && isAbsolute(thread.path));
  const root = await realpath(codexHome);
  const path = await realpath(thread.path);
  const inside = relative(root, path);
  assert.ok(
    inside.length > 0 &&
      !isAbsolute(inside) &&
      !inside.split(sep).includes(".."),
    "Rollout must remain inside the isolated Codex account",
  );
  assert.ok((await stat(path)).size <= 8_000_000, "Rollout exceeds test bound");
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  assert.ok(lines.length > 0 && lines.length <= 2_000);
  return lines.map((line) => {
    const item: unknown = JSON.parse(line);
    assert.ok(record(item));
    return item;
  });
}

function rolloutContext(
  records: Record<string, unknown>[],
  turnId: unknown,
): Record<string, unknown> {
  assert.ok(typeof turnId === "string" && turnId.length > 0);
  const contexts = records
    .filter((item) => item.type === "turn_context" && record(item.payload))
    .map((item) => item.payload as Record<string, unknown>)
    .filter((payload) => payload.turn_id === turnId);
  assert.equal(
    contexts.length,
    1,
    "Expected one persisted context for this turn",
  );
  return contexts[0]!;
}

const video = Buffer.alloc(96 * 64 * 4 * 3);
const colors = [
  [20, 40, 180, 255],
  [30, 170, 50, 255],
  [190, 60, 30, 255],
];
for (let frame = 0; frame < 3; frame++)
  for (let pixel = 0; pixel < 96 * 64; pixel++)
    for (let channel = 0; channel < 4; channel++)
      video[(frame * 96 * 64 + pixel) * 4 + channel] =
        channel === 3
          ? 255
          : (colors[frame]![channel]! +
              (pixel % 96) +
              Math.floor(pixel / 96) * (channel + 1)) %
            256;
const audio = Buffer.alloc(72_000 * 2);
for (let sample = 0; sample < 72_000; sample++)
  audio.writeInt16LE(Math.round(Math.sin(sample / 20) * 6000), sample * 2);
const videoPath = join(evidence, "canonical.raw");
const audioPath = join(evidence, "canonical.pcm");
const source = join(evidence, "Child fixture.mkv");
await writeFile(videoPath, video);
await writeFile(audioPath, audio);
await encodeVerifiedMaster(
  {
    videoPath,
    audioPath,
    role: "canonical",
    format: {
      width: 96,
      height: 64,
      frameRate: { numerator: 2, denominator: 1 },
      pixelFormat: "bgra",
      color: {
        range: "pc",
        space: "gbr",
        primaries: "bt709",
        transfer: "bt709",
      },
      audio: { format: "s16le", sampleRate: 48000, channelLayout: "mono" },
    },
  },
  source,
);
const sourceHash = sha256(await readFile(source));
const env = { ...process.env, XDG_CONFIG_HOME: configRoot };
const electron = await _electron.launch({
  executablePath,
  chromiumSandbox: true,
  env,
  timeout: 30000,
});
let transport: CodexStdioTransport | undefined;
let failureSnapshot: () => Promise<unknown> = async () => ({
  status: "before-thread",
});
try {
  const page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "codex-video-edit://app/index.html");
  assert.ok(
    !electron
      .process()
      .spawnargs.some((arg) =>
        /--(?:no-sandbox|disable-setuid-sandbox)/u.test(arg),
      ),
  );
  await electron.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("External launch disabled in isolated test");
    };
  });
  failureSnapshot = async () => {
    try {
      const result = await page.evaluate(() => window.desktop.getCodex());
      if (!result.ok) return { status: "account-unavailable" };
      return {
        status: "before-thread",
        connection: result.value.connection,
        account: result.value.account,
        busy: result.value.busy,
        modelCount: result.value.models.length,
        skillCount: result.value.skills.length,
      };
    } catch {
      return { status: "account-unavailable" };
    }
  };
  mark("authenticated-account");
  await expect
    .poll(
      async () => {
        const result = await page.evaluate(() => window.desktop.getCodex());
        return (
          result.ok &&
          !result.value.busy &&
          result.value.connection === "connected" &&
          result.value.account === "signed_in" &&
          result.value.models.length > 0 &&
          result.value.skills.length > 0
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
  const catalog = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(catalog.ok);
  const model = catalog.value.models.find(
    (item) => item.id === selectedModelId,
  );
  assert.ok(
    model,
    "The authenticated catalog must provide the selected Luna model",
  );
  assert.ok(model.reasoning.includes("high"), "Luna/high is not available");
  mark("select-selected-luna-high-through-settings");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.locator("#codex-model")).toBeEnabled();
  await page.locator("#codex-model").selectOption(model.id);
  await expect
    .poll(
      async () => {
        const result = await page.evaluate(() => window.desktop.getCodex());
        return result.ok && !result.value.busy
          ? result.value.selection?.modelId
          : null;
      },
      { timeout: 30_000 },
    )
    .toBe(model.id);
  await expect(page.locator("#codex-reasoning")).toBeEnabled({
    timeout: 30_000,
  });
  await page.locator("#codex-reasoning").selectOption("high");
  await expect
    .poll(
      async () => {
        const result = await page.evaluate(() => window.desktop.getCodex());
        return result.ok && !result.value.busy ? result.value.selection : null;
      },
      { timeout: 30_000 },
    )
    .toEqual({ modelId: model.id, reasoning: "high" });
  await page.keyboard.press("Escape");
  mark("import-fixture");
  const before = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(before.ok);
  mark("fixture-dialog-stubbed");
  await electron.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, source);
  mark("fixture-import-clicked");
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  mark("fixture-preview-wait");
  await expect(page.locator("#frame")).toBeVisible({ timeout: 30000 });
  mark("fixture-preview-visible");
  const list = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(list.ok);
  mark("fixture-project-list-read");
  const added = list.value.filter(
    (project) => !before.value.some((prior) => prior.id === project.id),
  );
  mark("fixture-project-created-check");
  assert.equal(added.length, 1);
  const project = added[0]!;
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  assert.equal(await realpath(userData), join(configRoot, "codex-video-edit"));
  const projectFolder = join(userData, "project-store", project.id);
  const baselinePath = join(projectFolder, "baseline.json");
  const baselineBytes = await readFile(baselinePath);
  const baseline: unknown = JSON.parse(baselineBytes.toString("utf8"));
  assertInitialProjectSnapshot(baseline);
  assert.equal(baseline.timeline.duration_us, 1500000);
  const projectSourceHash = sha256(
    await readFile(baseline.source.managed_path),
  );
  assert.equal(projectSourceHash, sourceHash);

  mark("open-project-thread");
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  const threadRequest = {
    schema_version: "1.0" as const,
    project_id: project.id,
  };
  const threadState = async () => {
    const result = await page.evaluate(
      (request) => window.desktop.getCodexThread(request),
      threadRequest,
    );
    assert.ok(result.ok);
    return result.value;
  };
  failureSnapshot = async () => {
    try {
      const state = await threadState();
      const knownMessages = new Set([
        "Codex is retrying this turn.",
        "Codex reported a problem with this turn.",
        "This Codex turn failed. Review the committed draft before retrying.",
        "The Codex turn was interrupted.",
        "The connection ended during this turn. Reopen the project to reconcile its thread and committed draft.",
      ]);
      return {
        status: state.status,
        message:
          state.message === null
            ? null
            : knownMessages.has(state.message)
              ? state.message
              : "Application issue; details omitted",
        userCount: state.messages.filter((message) => message.role === "user")
          .length,
        completedReplyCount: state.messages.filter(
          (message) => message.role === "codex" && message.complete,
        ).length,
        activityKinds: state.activities.map(({ kind, complete }) => ({
          kind,
          complete,
        })),
      };
    } catch {
      return { status: "unavailable" };
    }
  };
  await expect
    .poll(async () => (await threadState()).status, { timeout: 90000 })
    .toBe("ready");
  const registry: unknown = JSON.parse(
    await readFile(
      join(userData, "codex/context/threads/project-threads.json"),
      "utf8",
    ),
  );
  assert.ok(record(registry) && Array.isArray(registry.entries));
  const entries = registry.entries.filter(
    (entry: unknown) =>
      record(entry) &&
      entry.projectId === project.id &&
      typeof entry.threadId === "string" &&
      entry.toolRoute === "dynamic",
  ) as Array<{ threadId: string; toolRoute: string }>;
  assert.equal(entries.length, 1);
  const parentThreadId = entries[0]!.threadId;

  mark("real-native-child-turn");
  const prompt =
    expectedMultiAgentVersion === "v2"
      ? "First use codex_video_edit__project_get_summary and codex_video_edit__timeline_get_summary in the parent thread to read the active project. Then call the direct top-level native codex_video_edit_agents__spawn_agent tool exactly once with fork_turns=none and no model or reasoning override. Give the child only the active project_id and the exact path-free JSON results from those two summary calls; ask it to confirm the fixture has one clip and is 1.5 seconds long using only that snapshot. Do not call spawn through a code-mode JavaScript cell. Then wait with the direct top-level codex_video_edit_agents__wait_agent tool and summarize the child's answer. Do not use send_message or followup_task, spawn another child, or mutate the draft. If the functions are unavailable or the child does not complete, say so without claiming it ran."
      : "First use the supported tool search to discover the native spawn_agent collaboration tool. Do not use MCP resource listing for discovery. If tool search does not make spawn_agent available, say it is unavailable without claiming a child started. If available, invoke it exactly once with fork_context=true for a small read-only child task: give the child the active project_id from your fixed developer instructions and ask it to use only the codex_video_edit project and timeline summary tools to verify this fixture has one clip and is 1.5 seconds long. Wait for that child to finish, then summarize its finding. Neither you nor the child may mutate the draft. Do not claim a child was used unless the native tool actually succeeds.";
  await page.locator("#codex-thread-input").fill(prompt);
  await page.locator("#send-codex-thread").click();
  await expect
    .poll(
      async () => {
        const state = await threadState();
        if (state.status === "failed" || state.status === "uncertain")
          throw new Error("Native Codex child turn failed; details omitted");
        return (
          state.status === "ready" &&
          state.message === null &&
          state.messages.some(
            (message) =>
              message.role === "codex" &&
              message.complete &&
              message.text.trim().length > 0,
          )
        );
      },
      { timeout: 240000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  const projected = await threadState();
  const projectedChild = projected.activities.some(
    (activity) => activity.kind === "subagent" && activity.complete,
  );
  assert.equal(projectedChild, true, "Project the completed native child");
  await expect(page.locator("#codex-thread-status")).toBeHidden();
  await expect(page.locator("#codex-thread-input")).toBeEnabled();
  await page.screenshot({ path: join(evidence, "native-window.png") });
  const guestInspection = await inspectionHold();
  await electron.close();

  mark("authoritative-server-history");
  const codexHome = join(userData, "codex/account");
  const cwd = join(userData, "codex/context");
  const runtime = join(resourceRoot, "codex/codex");
  await access(runtime);
  const auditEnv: NodeJS.ProcessEnv = {
    HOME: dirname(codexHome),
    USERPROFILE: dirname(codexHome),
    CODEX_HOME: codexHome,
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
  };
  transport = new CodexStdioTransport({
    executable: runtime,
    args: buildCodexAppServerArguments(undefined, ["untrusted_test"]),
    cwd,
    env: auditEnv,
    requestTimeoutMs: 120000,
  });
  const initialized = await transport.start(
    buildExperimentalInitialize("0.0.0"),
  );
  assert.ok(record(initialized) && initialized.codexHome === codexHome);
  const pageParams = (threadId: string) => ({
    threadId,
    limit: 100,
    sortDirection: "desc",
    itemsView: "full",
  });
  const listedTurns = async (threadId: string) => {
    try {
      return turns(
        await transport!.request("thread/turns/list", pageParams(threadId)),
      );
    } catch (error) {
      if (!(
        error instanceof CodexTransportError && error.code === "remote_error"
      ))
        throw error;
      // Some pinned runtimes require the persisted thread to be loaded first.
      await transport!.request("thread/resume", {
        threadId,
        excludeTurns: true,
      });
      return turns(
        await transport!.request("thread/turns/list", pageParams(threadId)),
      );
    }
  };
  const parentTurns = await listedTurns(parentThreadId);
  const parentTurn = parentTurns.find((turn) =>
    items(turn).some(
      (item) =>
        item.type === "userMessage" &&
        Array.isArray(item.content) &&
        item.content.some(
          (content: unknown) => record(content) && content.text === prompt,
        ),
    ),
  );
  assert.ok(parentTurn && parentTurn.status === "completed");
  assert.equal(
    parentTurns.filter((turn) =>
      items(turn).some((item) => item.type === "userMessage"),
    ).length,
    1,
    "Expected one fresh user turn in the native child test",
  );
  const parentRead: unknown = await transport.request("thread/read", {
    threadId: parentThreadId,
    includeTurns: false,
  });
  assert.ok(record(parentRead) && record(parentRead.thread));
  assert.equal(parentRead.thread.id, parentThreadId);
  const parentRollout = await rolloutRecords(parentRead.thread, codexHome);
  const parentItems = items(parentTurn!);
  let childThreadId: string;
  let parentSummarySnapshotVerified = false;
  if (expectedMultiAgentVersion === "v1") {
    const parentCollaborationCalls = parentItems.filter(
      (item) =>
        item.type === "collabAgentToolCall" &&
        item.senderThreadId === parentThreadId,
    );
    const spawnCalls = parentCollaborationCalls.filter(
      (item) => item.tool === "spawnAgent",
    );
    assert.equal(
      spawnCalls.length,
      1,
      "Require one server-owned V1 native spawn event",
    );
    const spawnCall = spawnCalls[0]!;
    assert.equal(spawnCall.status, "completed");
    assert.ok(
      Array.isArray(spawnCall.receiverThreadIds) &&
        spawnCall.receiverThreadIds.length === 1 &&
        spawnCall.receiverThreadIds.every((id) => typeof id === "string"),
    );
    childThreadId = spawnCall.receiverThreadIds[0] as string;
    const waitCalls = parentCollaborationCalls.filter(
      (item) => item.tool === "wait",
    );
    assert.equal(waitCalls.length, 1, "Require one server-owned child wait");
    assert.equal(waitCalls[0]!.status, "completed");
    assert.deepEqual(waitCalls[0]!.receiverThreadIds, [childThreadId]);
  } else {
    const responseItems = parentRollout
      .filter(
        (entry) => entry.type === "response_item" && record(entry.payload),
      )
      .map((entry) => entry.payload as Record<string, unknown>);
    const functionCalls = responseItems.filter(
      (item) => item.type === "function_call",
    );
    const spawnCalls = functionCalls.filter(
      (item) => item.name === "spawn_agent",
    );
    const waitCalls = functionCalls.filter(
      (item) => item.name === "wait_agent",
    );
    assert.equal(spawnCalls.length, 1, "Require one V2 spawn function call");
    assert.ok(
      waitCalls.length > 0 && waitCalls.length <= 4,
      "Require a bounded server-owned V2 wait",
    );
    const spawnCall = spawnCalls[0]!;
    assert.ok(typeof spawnCall.call_id === "string");
    for (const call of [spawnCall, ...waitCalls]) {
      assert.ok(typeof call.call_id === "string");
      assert.equal(
        responseItems.filter(
          (item) =>
            item.type === "function_call_output" &&
            item.call_id === call.call_id,
        ).length,
        1,
        "Require a correlated native V2 call result",
      );
    }
    assert.ok(typeof spawnCall.arguments === "string");
    const spawnArguments: unknown = JSON.parse(spawnCall.arguments);
    assert.ok(record(spawnArguments));
    assert.deepEqual(Object.keys(spawnArguments).sort(), [
      "fork_turns",
      "message",
      "task_name",
    ]);
    assert.equal(spawnArguments.fork_turns, "none");
    assert.ok(typeof spawnArguments.message === "string");
    assert.ok(spawnArguments.message.length > 0);
    const startActivities = parentItems.filter(
      (item) => item.type === "subAgentActivity" && item.kind === "started",
    );
    assert.equal(startActivities.length, 1);
    assert.equal(startActivities[0]!.id, spawnCall.call_id);
    assert.ok(
      typeof startActivities[0]!.agentThreadId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(
          startActivities[0]!.agentThreadId,
        ),
    );
    childThreadId = startActivities[0]!.agentThreadId as string;
    assert.equal(
      parentItems.filter(
        (item) =>
          item.type === "subAgentActivity" &&
          item.kind === "completed" &&
          item.agentThreadId === childThreadId,
      ).length,
      1,
      "Require the same server-owned child to complete",
    );
  }
  assert.notEqual(childThreadId, parentThreadId);
  const childRead: unknown = await transport.request("thread/read", {
    threadId: childThreadId,
    includeTurns: false,
  });
  assert.ok(record(childRead) && record(childRead.thread));
  assert.equal(childRead.thread.id, childThreadId);
  assert.equal(childRead.thread.parentThreadId, parentThreadId);
  assert.equal(childRead.thread.ephemeral, false);
  assert.ok(record(childRead.thread.source));
  assert.ok(record(childRead.thread.source.subAgent));
  assert.ok(record(childRead.thread.source.subAgent.thread_spawn));
  assert.equal(
    childRead.thread.source.subAgent.thread_spawn.parent_thread_id,
    parentThreadId,
  );
  const childTurns = await listedTurns(childThreadId);
  const childReadTurns = childTurns.filter((turn) =>
    items(turn).some(
      (item) =>
        item.type === "dynamicToolCall" &&
        item.namespace === "codex_video_edit" &&
        (item.tool === "project_get_summary" ||
          item.tool === "timeline_get_summary") &&
        item.status === "completed" &&
        item.success === true &&
        Array.isArray(item.contentItems),
    ),
  );
  if (expectedMultiAgentVersion === "v1") {
    assert.ok(
      childReadTurns.length > 0,
      "V1 child must own a completed read tool",
    );
    assert.ok(childReadTurns.some((turn) => turn.status === "completed"));
  } else {
    const parentSummaryCalls = parentItems.filter(
      (item) =>
        item.type === "dynamicToolCall" &&
        item.namespace === "codex_video_edit" &&
        (item.tool === "project_get_summary" ||
          item.tool === "timeline_get_summary") &&
        item.status === "completed" &&
        item.success === true,
    );
    const parentSummaryTools = new Set(
      parentSummaryCalls.map((item) => item.tool),
    );
    assert.deepEqual([...parentSummaryTools].sort(), [
      "project_get_summary",
      "timeline_get_summary",
    ]);
    const spawnActivityIndex = parentItems.findIndex(
      (item) => item.type === "subAgentActivity" && item.kind === "started",
    );
    assert.ok(spawnActivityIndex > 0);
    assert.ok(
      parentSummaryCalls.every(
        (item) => parentItems.indexOf(item) < spawnActivityIndex,
      ),
      "The parent must read both summaries before the V2 spawn",
    );
    const projectSummary = dynamicToolResult(
      parentSummaryCalls.find((item) => item.tool === "project_get_summary")!,
    );
    const timelineSummary = dynamicToolResult(
      parentSummaryCalls.find((item) => item.tool === "timeline_get_summary")!,
    );
    assert.equal(projectSummary.project_id, project.id);
    assert.equal(timelineSummary.project_id, project.id);
    assert.equal(timelineSummary.duration_us, 1_500_000);
    assert.ok(Array.isArray(timelineSummary.clips));
    assert.equal(timelineSummary.clips.length, 1);
    assert.equal(childReadTurns.length, 0);
    const childAnswer = childTurns
      .flatMap(items)
      .filter(
        (item) => item.type === "agentMessage" && typeof item.text === "string",
      )
      .at(-1)?.text;
    assert.ok(typeof childAnswer === "string" && childAnswer.length > 0);
    assert.match(childAnswer, /clip/i);
    assert.match(childAnswer, /1\.5\s*(?:seconds|s)/iu);
    parentSummarySnapshotVerified = true;
  }
  const childItems = childTurns.flatMap(items);
  const childSummaryTools = new Set(
    childItems
      .filter(
        (item) =>
          item.type === "dynamicToolCall" &&
          item.namespace === "codex_video_edit" &&
          item.status === "completed" &&
          item.success === true,
      )
      .map((item) => item.tool),
  );
  assert.deepEqual(
    [...childSummaryTools].sort(),
    expectedMultiAgentVersion === "v1"
      ? ["project_get_summary", "timeline_get_summary"]
      : [],
  );
  assert.ok(
    childItems.every(
      (item) =>
        item.type !== "dynamicToolCall" ||
        (item.namespace === "codex_video_edit" &&
          (item.tool === "project_get_summary" ||
            item.tool === "timeline_get_summary")),
    ),
    "Child used an unapproved host tool",
  );
  const harmlessItems = new Set([
    "userMessage",
    "agentMessage",
    "reasoning",
    "plan",
    "contextCompaction",
    "sleep",
    ...(expectedMultiAgentVersion === "v2" ? ["subAgentActivity"] : []),
  ]);
  assert.ok(
    childItems.every(
      (item) =>
        item.type === "dynamicToolCall" || harmlessItems.has(String(item.type)),
    ),
    "Child used a non-read capability or an unknown item type",
  );

  mark("child-policy-metadata");
  const childRollout = await rolloutRecords(childRead.thread, codexHome);
  const parentContext = rolloutContext(parentRollout, parentTurn.id);
  const childPolicyTurn =
    expectedMultiAgentVersion === "v1"
      ? childReadTurns[0]
      : childTurns.find((turn) => turn.status === "completed");
  assert.ok(childPolicyTurn);
  const childContext = rolloutContext(childRollout, childPolicyTurn.id);
  assert.equal(parentContext.cwd, cwd);
  assert.equal(parentContext.approval_policy, "never");
  assert.deepEqual(parentContext.sandbox_policy, { type: "read-only" });
  assert.ok(record(parentContext.permission_profile));
  assert.equal(parentContext.model, model.id);
  assert.equal(parentContext.effort, "high");
  assert.equal(parentContext.multi_agent_version, expectedMultiAgentVersion);
  for (const field of [
    "cwd",
    "workspace_roots",
    "approval_policy",
    "sandbox_policy",
    "permission_profile",
    "network",
    "file_system_sandbox_policy",
    "model",
    "collaboration_mode",
    "multi_agent_version",
    "multi_agent_mode",
    "effort",
  ])
    assert.deepEqual(
      childContext[field],
      parentContext[field],
      `Child turn did not inherit ${field}`,
    );
  const childParentVerified = true;
  const childPolicyVerified = true;
  await transport.close();
  transport = undefined;

  mark("immutable-project-state");
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.equal(
    sha256(await readFile(baseline.source.managed_path)),
    sourceHash,
  );
  assert.equal(sha256(await readFile(source)), sourceHash);
  const journal = join(projectFolder, "draft/journal");
  const journalEntries = await readdir(journal);
  assert.equal(
    journalEntries.filter((name) => /^\d{12}\..+\.json$/u.test(name)).length,
    0,
  );
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        status: "pass",
        scope:
          expectedMultiAgentVersion === "v1"
            ? "P2-real-native-child-read-only-v1"
            : "P2-real-native-child-summary-snapshot-v2",
        authenticated: true,
        selectedModelId: model.id,
        selectedReasoning: "high",
        packagedNativeWindow: true,
        projectedChildActivity: projectedChild,
        serverOwnedSpawnCompleted: true,
        receiverThreadCorrelated: true,
        childOwnedReadToolCompleted:
          expectedMultiAgentVersion === "v1" && childReadTurns.length > 0,
        parentSummarySnapshotPassed: parentSummarySnapshotVerified,
        childParentVerified,
        childPolicyVerified,
        childEnvironmentListExposed: false,
        noForbiddenChildItemObserved: true,
        journalUnchanged: true,
        sourceUnchanged: true,
        baselineUnchanged: true,
        guestInspection,
        audioListening: false,
        windowsAcceptance: false,
        sourceHash,
        baselineHash: sha256(baselineBytes),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "pass", evidence }));
} catch (error) {
  const failure = error && typeof error === "object" ? error : {};
  const stack = "stack" in failure ? failure.stack : undefined;
  const sourceLine =
    typeof stack === "string"
      ? stack.match(/codex-native-subagent\.test\.ts:(\d+):\d+/u)?.[1]
      : undefined;
  try {
    await (
      await electron.firstWindow()
    ).screenshot({
      path: join(evidence, "failure-window.png"),
      timeout: 5000,
    });
  } catch {
    /* The original assertion category remains authoritative. */
  }
  const category = (value: unknown): string | null =>
    typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(value)
      ? value
      : null;
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({
      status: "fail",
      step,
      detailsOmitted: true,
      errorName: category("name" in failure ? failure.name : null),
      errorCode: category("code" in failure ? failure.code : null),
      ...(sourceLine ? { sourceLine: Number(sourceLine) } : {}),
      snapshot: await failureSnapshot(),
    }),
  );
  console.error(
    `Native child test failed at ${step}; private details omitted.`,
  );
  await inspectionHold();
  process.exitCode = 1;
} finally {
  await transport?.close().catch(() => {});
  await electron.close().catch(() => {});
}

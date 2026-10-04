/** Real managed-account test. Credentials are provisioned externally and never read here. */
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertInitialProjectSnapshot } from "../../packages/domain/src/project.ts";
import type { DraftTransactionRecord } from "../../packages/domain/src/draft-transaction.ts";
import {
  encodeVerifiedMaster,
  sha256,
} from "../../packages/media-engine/src/lossless.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";
import { DraftTransactionStore } from "../../packages/project-store/src/transactions.ts";

assert.equal(process.platform, "linux", "Requires isolated Linux guest");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await access("/.dockerenv");

async function appServerChildren(parentPid: number, appExecutable: string) {
  const runtimeExecutable = await realpath(
    join(dirname(appExecutable), "resources/codex/codex"),
  );
  const children: number[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const pid = Number(entry);
    const proc = join("/proc", entry);
    let statLine: string;
    try {
      statLine = await readFile(join(proc, "stat"), "utf8");
    } catch {
      continue;
    }
    const close = statLine.lastIndexOf(")");
    const fields = statLine
      .slice(close + 1)
      .trim()
      .split(/\s+/u);
    if (Number(fields[1]) !== parentPid) continue;
    let args: string[];
    try {
      args = (await readFile(join(proc, "cmdline")))
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
    } catch {
      continue;
    }
    if (
      !args.includes("app-server") ||
      !args.includes("--listen") ||
      !args.includes("stdio://")
    )
      continue;
    const executable = await realpath(join(proc, "exe")).catch(() => "");
    if (executable === runtimeExecutable) children.push(pid);
  }
  return children.sort((left, right) => left - right);
}

const executablePath = process.argv[2],
  configArgument = process.argv[3];
assert.ok(executablePath && isAbsolute(executablePath));
assert.ok(configArgument && isAbsolute(configArgument));
const configRoot = await realpath(configArgument);
assert.equal(
  configRoot,
  resolve(configArgument),
  "Explicit config root must not redirect",
);
assert.notEqual(configRoot, "/");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(
  join(evidenceRoot, "native-codex-authenticated-"),
);
await chmod(evidence, 0o700);
let step = "fixture";
const mark = (value: string): void => {
  step = value;
  console.log(`STEP ${value}`);
};
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify(
    {
      asarHash: sha256(
        await readFile(join(dirname(executablePath), "resources/app.asar")),
      ),
      runtimeManifestHash: sha256(
        await readFile(
          join(dirname(executablePath), "resources/codex/manifest.json"),
        ),
      ),
      mcpManifestHash: sha256(
        await readFile(
          join(dirname(executablePath), "resources/mcp/manifest.json"),
        ),
      ),
      testHash: sha256(await readFile(fileURLToPath(import.meta.url))),
    },
    null,
    2,
  ),
);
const video = Buffer.alloc(96 * 64 * 4 * 3);
const colors = [
  [20, 40, 180, 255],
  [30, 170, 50, 255],
  [190, 60, 30, 255],
];
for (let frame = 0; frame < 3; frame++)
  for (let i = 0; i < 96 * 64; i++) {
    for (let channel = 0; channel < 4; channel++)
      video[(frame * 96 * 64 + i) * 4 + channel] =
        channel === 3
          ? 255
          : (colors[frame]![channel]! +
              (i % 96) +
              Math.floor(i / 96) * (channel + 1)) %
            256;
  }
async function assertCanvasFrame(page: Page, frame: number): Promise<void> {
  const actual = await page.locator("canvas").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: Array.from(
        canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height)
          .data,
      ),
    };
  });
  assert.equal(actual.width, 96);
  assert.equal(actual.height, 64);
  const expected = Buffer.from(
    video.subarray(frame * 96 * 64 * 4, (frame + 1) * 96 * 64 * 4),
  );
  for (let i = 0; i < expected.length; i += 4) {
    const blue = expected[i]!;
    expected[i] = expected[i + 2]!;
    expected[i + 2] = blue;
  }
  assert.deepEqual(Buffer.from(actual.pixels), expected);
}
const audio = Buffer.alloc(72_000 * 2);
for (let i = 0; i < 72_000; i++)
  audio.writeInt16LE(Math.round(Math.sin(i / 20) * 6000), i * 2);
const videoPath = join(evidence, "canonical.raw"),
  audioPath = join(evidence, "canonical.pcm"),
  source = join(evidence, "Color sequence.mkv");
await writeFile(videoPath, video);
await writeFile(audioPath, audio);
const mediaEvidence = await encodeVerifiedMaster(
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
await writeFile(
  join(evidence, "master-roundtrip.json"),
  JSON.stringify(mediaEvidence, null, 2),
);
const sourceHash = sha256(await readFile(source));

const env = { ...process.env, XDG_CONFIG_HOME: configRoot };
const launch = () =>
  _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30000,
  });
let electron = await launch();
let failureSnapshot: () => Promise<unknown> = async () => ({
  status: "unavailable",
  message: "Test failed before project context",
  journalCount: null,
});
try {
  let page = await electron.firstWindow();
  failureSnapshot = async () => {
    try {
      const result = await page.evaluate(() => window.desktop.getCodex());
      if (!result.ok)
        return { status: "unavailable", message: "Account request failed" };
      const state = result.value;
      return {
        connection: state.connection,
        account: state.account,
        busy: state.busy,
        modelCount: state.models.length,
        skillCount: state.skills.length,
        usageWindowCount: state.limits.length,
        hasSelection: state.selection !== null,
        message:
          state.message === null
            ? null
            : "Application account issue; details omitted",
      };
    } catch {
      return {
        status: "unavailable",
        message: "Could not read safe account state",
      };
    }
  };
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  assert.ok(
    !electron
      .process()
      .spawnargs.some((arg) =>
        /--(?:no-sandbox|disable-setuid-sandbox)/u.test(arg),
      ),
  );
  // Never initiate login or allow an unexpected external browser launch in this test.
  await electron.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("External launch disabled in isolated test");
    };
  });
  mark("authenticated-settings");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.locator("#codex-model")).toBeVisible({ timeout: 60000 });
  mark("authenticated-settings-metadata-settle");
  await expect(page.locator("#codex-model")).toBeEnabled({ timeout: 60000 });
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
  const account = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(account.ok);
  assert.equal(account.value.account, "signed_in");
  assert.equal(account.value.connection, "connected");
  assert.ok(account.value.models.length > 0);
  assert.ok(
    account.value.skills.length > 0,
    "Real skill discovery must return entries",
  );
  const requireLunaHigh = process.argv.includes("--require-luna-high");
  const requestedModelId = process.argv
    .find((argument) => argument.startsWith("--model-id="))
    ?.slice("--model-id=".length);
  const requestedReasoning = process.argv
    .find((argument) => argument.startsWith("--reasoning="))
    ?.slice("--reasoning=".length);
  if (requestedModelId !== undefined) {
    assert.ok(
      requestedModelId === "gpt-5.6-luna" || requestedModelId === "gpt-6-luna",
      "The authenticated policy fixture may select only a Luna model",
    );
    assert.ok(!requireLunaHigh);
  }
  const model = requestedModelId
    ? account.value.models.find((item) => item.id === requestedModelId)
    : requireLunaHigh
      ? account.value.models.find(
          (item) => item.id === "gpt-6-luna" && item.reasoning.includes("high"),
        )
      : account.value.models.find(
          (item) => item.id === account.value.selection?.modelId,
        );
  assert.ok(model, "The required Codex model is unavailable");
  const reasoning = requireLunaHigh
    ? "high"
    : (requestedReasoning ??
      (account.value.selection?.modelId === model.id
        ? account.value.selection.reasoning
        : model.defaultReasoning));
  assert.ok(
    model.reasoning.includes(reasoning),
    "The required Codex reasoning effort is unavailable",
  );
  const selection = {
    modelId: model.id,
    reasoning,
  };
  mark("authenticated-settings-select-model");
  await page.locator("#codex-model").selectOption(model.id);
  mark("authenticated-settings-model-settle");
  await expect
    .poll(
      async () => {
        const result = await page.evaluate(() => window.desktop.getCodex());
        return (
          result.ok &&
          !result.value.busy &&
          result.value.selection?.modelId === model.id
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
  await expect(page.locator("#codex-reasoning")).toBeEnabled();
  mark("authenticated-settings-select-reasoning");
  await page.locator("#codex-reasoning").selectOption(selection.reasoning);
  mark("authenticated-settings-selection-settle");
  await expect
    .poll(async () => {
      const view = await page.evaluate(() => window.desktop.getCodex());
      return view.ok && !view.value.busy ? view.value.selection : null;
    })
    .toEqual(selection);
  await page.keyboard.press("Escape");
  mark("import-fixture");
  const before = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(before.ok);
  await electron.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, source);
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 30000 });
  await assertCanvasFrame(page, 0);
  const list = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(list.ok);
  const added = list.value.filter(
    (item) => !before.value.some((prior) => prior.id === item.id),
  );
  assert.equal(added.length, 1);
  const project = added[0]!;
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  assert.equal(await realpath(userData), join(configRoot, "ai-video-editor"));
  const projectFolder = join(userData, "project-store", project.id);
  const baselinePath = join(projectFolder, "baseline.json");
  const baselineBytes = await readFile(baselinePath);
  const baseline: unknown = JSON.parse(baselineBytes.toString("utf8"));
  assertInitialProjectSnapshot(baseline);
  assert.equal(baseline.timeline.duration_us, 1500000);
  const request = { schema_version: "1.0" as const, project_id: project.id };
  async function thread() {
    const result = await page.evaluate(
      (value) => window.desktop.getCodexThread(value),
      request,
    );
    assert.ok(result.ok);
    return result.value;
  }
  async function openDrawer(): Promise<void> {
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await page
      .getByRole("button", { name: "Open conversation", exact: true })
      .click();
    await expect
      .poll(async () => (await thread()).status, { timeout: 90000 })
      .toBe("ready");
  }
  async function turn(
    text: string,
    observeRunning?: () => Promise<void>,
  ): Promise<void> {
    const turnStep = step;
    const prior = (await thread()).messages.filter(
      (message) => message.role === "user",
    );
    const priorIds = new Set(prior.map((message) => message.id));
    mark(`${turnStep}-send`);
    await page.locator("#codex-thread-input").fill(text);
    await page.locator("#send-codex-thread").click();
    mark(`${turnStep}-wait-current-reply`);
    let userId: string | undefined;
    await expect
      .poll(
        async () => {
          const state = await thread();
          if (["failed", "uncertain"].includes(state.status))
            throw new Error("Real turn failed; details omitted");
          if (state.status === "running") await observeRunning?.();
          const users = state.messages.filter(
            (message) => message.role === "user",
          );
          const current = users.filter((message) => !priorIds.has(message.id));
          if (current.length !== 1 || users.length !== prior.length + 1)
            return false;
          assert.equal(current[0]!.text, text);
          userId ??= current[0]!.id;
          assert.equal(
            current[0]!.id,
            userId,
            "Current user surrogate must remain stable during the turn",
          );
          const index = state.messages.findIndex(
            (message) => message.id === userId,
          );
          return (
            state.status === "ready" &&
            state.message === null &&
            state.messages
              .slice(index + 1)
              .some(
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
    mark(`${turnStep}-completed`);
  }
  async function records(): Promise<DraftTransactionRecord[]> {
    const root = join(projectFolder, "draft/journal");
    const entries = (await readdir(root))
      .filter((name) =>
        /^\d{12}\.[A-Za-z0-9][A-Za-z0-9._-]{1,127}\.json$/u.test(name),
      )
      .sort();
    assert.ok(entries.length <= 4, "Unexpected extra transactions");
    return Promise.all(
      entries.map(
        async (name) =>
          JSON.parse(
            await readFile(join(root, name), "utf8"),
          ) as DraftTransactionRecord,
      ),
    );
  }
  failureSnapshot = async () => {
    let journalCount: number | null = null;
    try {
      journalCount = (
        await readdir(join(projectFolder, "draft/journal"))
      ).filter((name) => /^\d{12}\..+\.json$/u.test(name)).length;
    } catch {
      /* Missing/unreadable is not zero. */
    }
    try {
      const state = await thread();
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
        replyCount: state.messages.filter((message) => message.role === "codex")
          .length,
        completedReplyCount: state.messages.filter(
          (message) => message.role === "codex" && message.complete,
        ).length,
        activities: state.activities.map(({ kind, complete }) => ({
          kind,
          complete,
        })),
        journalCount,
      };
    } catch {
      return {
        status: "unavailable",
        message: "Could not read safe thread state",
        journalCount,
      };
    }
  };
  async function threadIdentity(): Promise<string> {
    const registry: unknown = JSON.parse(
      await readFile(
        join(userData, "codex/context/threads/project-threads.json"),
        "utf8",
      ),
    );
    assert.ok(
      registry &&
        typeof registry === "object" &&
        "entries" in registry &&
        Array.isArray(registry.entries),
    );
    if (process.argv.includes("--require-dynamic")) {
      assert.ok("schemaVersion" in registry);
      assert.equal(registry.schemaVersion, 2);
    }
    const entries = registry.entries.filter(
      (entry: unknown) =>
        entry &&
        typeof entry === "object" &&
        "projectId" in entry &&
        entry.projectId === project.id,
    );
    assert.equal(entries.length, 1);
    const entry: unknown = entries[0];
    assert.ok(
      entry &&
        typeof entry === "object" &&
        "threadId" in entry &&
        typeof entry.threadId === "string" &&
        entry.threadId.length > 0,
    );
    if (process.argv.includes("--require-dynamic")) {
      assert.ok("toolRoute" in entry);
      assert.equal(entry.toolRoute, "dynamic");
    }
    return entry.threadId;
  }
  mark("real-trim-open-conversation");
  await openDrawer();
  const originalThreadId = await threadIdentity();
  mark("real-trim-turn");
  const trimPrompt =
    "Use the guarded editor tools to read the active draft and trim exactly 0.5 seconds (500000 microseconds) from the START of its sole clip. Apply exactly one trim transaction. The fixture is 1.5 seconds long; the committed result must be 1.0 second. Do not change the end, undo, or make any other edits. Read the draft again to verify, then reply briefly.";
  let liveTrimObserved = false;
  await turn(trimPrompt, async () => {
    if (liveTrimObserved) return;
    const committed = (await records()).find(
      (record) =>
        record.origin === "codex" &&
        record.status === "committed" &&
        record.after.draft_sequence === 1 &&
        record.after.timeline.duration_us === 1000000,
    );
    if (
      !committed ||
      (await page.locator("#seek").getAttribute("max")) !== "500000" ||
      (await page.locator("#time").textContent()) !== "0:00.000"
    )
      return;
    try {
      await assertCanvasFrame(page, 1);
    } catch (error) {
      if (error instanceof assert.AssertionError) return;
      throw error;
    }
    // Both observations bracket actual committed controls/pixels in this same running turn.
    liveTrimObserved = (await thread()).status === "running";
  });
  assert.equal(
    liveTrimObserved,
    true,
    "Committed trim pixels must be observed before the turn completes",
  );
  await expect(page.locator("#seek")).toHaveAttribute("max", "500000");
  await expect(page.locator("#time")).toHaveText("0:00.000");
  await assertCanvasFrame(page, 1);
  const trimmed = await records();
  assert.equal(trimmed.length, 1);
  const edit = trimmed[0]!;
  assert.equal(edit.origin, "codex");
  assert.equal(edit.kind, "apply");
  assert.equal(edit.status, "committed");
  assert.equal(edit.operations.length, 1);
  if (edit.operations[0]!.operation_type !== "trim")
    throw new Error("Expected a trim operation");
  assert.equal(edit.operations[0]!.edge, "start");
  assert.equal(edit.operations[0]!.timeline_position_us, 500000);
  assert.equal(edit.after.timeline.duration_us, 1000000);
  assert.equal(edit.after.draft_sequence, 1);
  const history = (await thread()).messages.map(({ role, text, complete }) => ({
    role,
    text,
    complete,
  }));
  assert.ok(
    history.some(
      (message) => message.role === "user" && message.text === trimPrompt,
    ),
  );
  const historySignatures = (messages: typeof history) =>
    messages.map(({ role, text, complete }) => ({
      role,
      length: text.length,
      sha256: sha256(Buffer.from(text)),
      complete,
    }));
  await writeFile(
    join(evidence, "history-before-reopen.json"),
    JSON.stringify(historySignatures(history), null, 2),
  );
  await electron.close();
  mark("reopen-project-and-thread");
  const offline = new DraftTransactionStore(
    join(userData, "project-store"),
    new ProjectStore(
      join(userData, "project-store"),
      new MediaLibrary(join(userData, "media-library")),
    ),
  );
  assert.deepEqual((await offline.snapshot(project.id)).draft, edit.after);
  electron = await launch();
  page = await electron.firstWindow();
  await electron.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("External launch disabled in isolated test");
    };
  });
  await page.locator(`#projects [data-project-id="${project.id}"]`).click();
  await expect(page.locator("#frame")).toBeVisible();
  await assertCanvasFrame(page, 1);
  await expect(page.locator("#seek")).toHaveAttribute("max", "500000");
  mark("reopen-conversation");
  await openDrawer();
  mark("reopen-thread-identity");
  assert.equal(await threadIdentity(), originalThreadId);
  mark("reopen-history-equality");
  await writeFile(
    join(evidence, "history-after-reopen.json"),
    JSON.stringify(historySignatures((await thread()).messages), null, 2),
  );
  assert.deepEqual(
    (await thread()).messages.map(({ role, text, complete }) => ({
      role,
      text,
      complete,
    })),
    history,
  );
  mark("reopen-selection-equality");
  const reopenedAccount = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(reopenedAccount.ok);
  assert.deepEqual(reopenedAccount.value.selection, selection);
  mark("real-undo-turn");
  await turn(
    "Use the guarded editor tools to read the active draft and undo exactly the previous start-trim transaction, once. Restore the original 1.5-second duration. Do not apply a new trim or any other edit. Read the draft again to verify, then reply briefly.",
  );
  await expect(page.locator("#seek")).toHaveAttribute("max", "1000000");
  await assertCanvasFrame(page, 0);
  const undone = await records();
  assert.equal(undone.length, 2);
  const undo = undone[1]!;
  assert.equal(undo.origin, "codex");
  assert.equal(undo.kind, "undo");
  assert.equal(undo.status, "committed");
  assert.equal(undo.target_transaction_id, edit.transaction_id);
  assert.equal(undo.after.draft_sequence, 2);
  assert.equal(undo.after.timeline.duration_us, 1500000);
  assert.deepEqual(undo.after.timeline, baseline.timeline);
  let expectedFinalDraft = undo.after;
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.equal(
    sha256(await readFile(baseline.source.managed_path)),
    sourceHash,
  );
  assert.equal(sha256(await readFile(source)), sourceHash);
  mark("read-only-turn-send");
  const journalBeforeStop = await records();
  const readOnlyPrompt =
    "Read-only cancellation test: use only the guarded project/draft read tools. Read the current draft exactly ten times sequentially, checking the duration each time, then summarize briefly. Do not call trim, undo, or any mutation tool. Stop immediately if interrupted.";
  await page.locator("#codex-thread-input").fill(readOnlyPrompt);
  await page.locator("#send-codex-thread").click();
  mark("read-only-turn-running");
  await expect
    .poll(async () => (await thread()).status, {
      timeout: 60000,
      intervals: [100],
    })
    .toBe("running");
  mark("read-only-turn-stop");
  await page.locator("#interrupt-codex-thread").click();
  await expect
    .poll(
      async () => {
        const state = await thread();
        return (
          state.status === "ready" &&
          state.message === "The Codex turn was interrupted."
        );
      },
      { timeout: 60000, intervals: [100, 250, 500] },
    )
    .toBe(true);
  assert.deepEqual(await records(), journalBeforeStop);
  await expect(page.locator("#seek")).toHaveAttribute("max", "1000000");
  await assertCanvasFrame(page, 0);
  mark("interrupted-turn-reopen");
  await electron.close();
  assert.deepEqual((await offline.snapshot(project.id)).draft, undo.after);
  electron = await launch();
  page = await electron.firstWindow();
  await electron.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("External launch disabled in isolated test");
    };
  });
  await page.locator(`#projects [data-project-id="${project.id}"]`).click();
  await expect(page.locator("#frame")).toBeVisible();
  await openDrawer();
  assert.equal(await threadIdentity(), originalThreadId);
  const resumedAfterStop = await thread();
  assert.equal(resumedAfterStop.status, "ready");
  assert.ok(
    resumedAfterStop.messages.some(
      (message) => message.role === "user" && message.text === readOnlyPrompt,
    ),
  );
  assert.ok(resumedAfterStop.messages.every((message) => message.complete));
  assert.deepEqual(await records(), journalBeforeStop);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.equal(
    sha256(await readFile(baseline.source.managed_path)),
    sourceHash,
  );
  await expect(page.locator("#seek")).toHaveAttribute("max", "1000000");
  await assertCanvasFrame(page, 0);
  mark("app-server-process-recovery");
  const historyBeforeServerRestart = (await thread()).messages.map(
    ({ role, text, complete }) => ({ role, text, complete }),
  );
  const journalBeforeServerRestart = await records();
  assert.equal(await threadIdentity(), originalThreadId);
  const mainPid = electron.process().pid;
  if (typeof mainPid !== "number" || !Number.isSafeInteger(mainPid))
    throw new Error("The Electron main process could not be identified");
  const appServerBefore = await appServerChildren(mainPid, executablePath);
  assert.equal(appServerBefore.length, 1);
  process.kill(appServerBefore[0]!, "SIGKILL");
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.desktop.getCodex());
        return state.ok ? state.value.connection : "unavailable";
      },
      { timeout: 60000, intervals: [100, 250, 500] },
    )
    .toBe("unavailable");
  await expect
    .poll(
      async () => (await appServerChildren(mainPid, executablePath)).length,
      { timeout: 30000, intervals: [100, 250, 500] },
    )
    .toBe(0);
  assert.deepEqual(await records(), journalBeforeServerRestart);
  mark("settings-reconnect-after-app-server-exit");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-codex").click();
  await expect(page.locator("#codex-reconnect")).toBeVisible();
  await page.locator("#codex-reconnect").click();
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.desktop.getCodex());
        return (
          state.ok &&
          !state.value.busy &&
          state.value.connection === "connected" &&
          state.value.account === "signed_in" &&
          state.value.selection?.modelId === selection.modelId &&
          state.value.selection?.reasoning === selection.reasoning
        );
      },
      { timeout: 60000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  mark("resume-project-thread-after-app-server-restart");
  const reopenedAfterServerRestart = await page.evaluate(
    (value) => window.desktop.openCodexThread(value),
    request,
  );
  assert.ok(reopenedAfterServerRestart.ok);
  await expect
    .poll(async () => (await thread()).status, {
      timeout: 90000,
      intervals: [250, 500, 1000],
    })
    .toBe("ready");
  assert.equal(await threadIdentity(), originalThreadId);
  assert.deepEqual(
    (await thread()).messages.map(({ role, text, complete }) => ({
      role,
      text,
      complete,
    })),
    historyBeforeServerRestart,
  );
  assert.deepEqual(await records(), journalBeforeServerRestart);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.equal(
    sha256(await readFile(baseline.source.managed_path)),
    sourceHash,
  );
  assert.equal(sha256(await readFile(source)), sourceHash);
  const appServerAfter = await appServerChildren(mainPid, executablePath);
  assert.equal(appServerAfter.length, 1);
  assert.notEqual(appServerAfter[0], appServerBefore[0]);
  await expect(page.locator("#seek")).toHaveAttribute("max", "1000000");
  await assertCanvasFrame(page, 0);
  mark("inflight-committed-mutation-send");
  if (await page.locator("#codex-drawer").isHidden())
    await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.locator("#codex-thread-input")).toBeVisible();
  const inFlightMutationPrompt =
    "Use the guarded editor tools to read the active draft and trim exactly 250000 microseconds from the END of its sole clip. Apply exactly one end-trim transaction. The current draft is 1.5 seconds and must become 1.25 seconds. After the trim, read the current draft twelve times sequentially without changing it, then reply briefly. Do not make any other edits.";
  await page.locator("#codex-thread-input").fill(inFlightMutationPrompt);
  await page.locator("#send-codex-thread").click();
  mark("inflight-committed-mutation-wait");
  await expect
    .poll(
      async () => {
        const state = await thread();
        if (state.status !== "running") return false;
        const journal = await records();
        const candidate = journal[2];
        return (
          journal.length === 3 &&
          state.messages.filter(
            (message) =>
              message.role === "user" &&
              message.text === inFlightMutationPrompt,
          ).length === 1 &&
          candidate?.origin === "codex" &&
          candidate.status === "committed" &&
          candidate.kind === "apply" &&
          candidate.after.draft_sequence === 3 &&
          candidate.after.timeline.duration_us === 1250000 &&
          candidate.operations.length === 1 &&
          candidate.operations[0]?.operation_type === "trim" &&
          candidate.operations[0]?.edge === "end" &&
          candidate.operations[0]?.timeline_position_us === 1250000
        );
      },
      { timeout: 240000, intervals: [50, 100, 250] },
    )
    .toBe(true);
  const inFlightJournalBeforeLoss = await records();
  assert.equal(inFlightJournalBeforeLoss.length, 3);
  const inFlightTrim = inFlightJournalBeforeLoss[2]!;
  assert.equal(inFlightTrim.origin, "codex");
  assert.equal(inFlightTrim.after.timeline.duration_us, 1250000);
  const appServerDuringMutation = await appServerChildren(
    mainPid,
    executablePath,
  );
  assert.equal(appServerDuringMutation.length, 1);
  mark("kill-app-server-after-committed-mutation");
  process.kill(appServerDuringMutation[0]!, "SIGKILL");
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.desktop.getCodex());
        return state.ok ? state.value.connection : "unavailable";
      },
      { timeout: 60000, intervals: [100, 250, 500] },
    )
    .toBe("unavailable");
  await expect
    .poll(
      async () => (await appServerChildren(mainPid, executablePath)).length,
      { timeout: 30000, intervals: [100, 250, 500] },
    )
    .toBe(0);
  assert.deepEqual(await records(), inFlightJournalBeforeLoss);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.equal(
    sha256(await readFile(baseline.source.managed_path)),
    sourceHash,
  );
  mark("settings-reconnect-after-inflight-mutation-loss");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#settings-codex").click();
  await expect(page.locator("#codex-reconnect")).toBeVisible();
  await page.locator("#codex-reconnect").click();
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.desktop.getCodex());
        return (
          state.ok &&
          !state.value.busy &&
          state.value.connection === "connected" &&
          state.value.account === "signed_in" &&
          state.value.selection?.modelId === selection.modelId &&
          state.value.selection?.reasoning === selection.reasoning
        );
      },
      { timeout: 60000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  mark("resume-inflight-project-thread");
  const reopenedAfterInFlightLoss = await page.evaluate(
    (value) => window.desktop.openCodexThread(value),
    request,
  );
  assert.ok(reopenedAfterInFlightLoss.ok);
  await expect
    .poll(async () => (await thread()).status !== "opening", {
      timeout: 90000,
      intervals: [250, 500, 1000],
    })
    .toBe(true);
  if ((await thread()).status === "running") {
    mark("interrupt-resumed-inflight-turn");
    const interrupted = await page.evaluate((value) => {
      return window.desktop.interruptCodexThread(value);
    }, request);
    assert.ok(interrupted.ok);
    await expect
      .poll(
        async () =>
          !["running", "interrupting"].includes((await thread()).status),
        { timeout: 90000, intervals: [250, 500, 1000] },
      )
      .toBe(true);
  }
  const threadAfterInFlightRecovery = await thread();
  assert.ok(
    ["ready", "uncertain", "failed"].includes(
      threadAfterInFlightRecovery.status,
    ),
  );
  assert.equal(
    threadAfterInFlightRecovery.messages.filter(
      (message) =>
        message.role === "user" && message.text === inFlightMutationPrompt,
    ).length,
    1,
  );
  assert.deepEqual(await records(), inFlightJournalBeforeLoss);
  const projectsAfterRecovery = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(projectsAfterRecovery.ok);
  const recoveredProject = projectsAfterRecovery.value.find(
    (candidate) => candidate.id === project.id,
  );
  assert.ok(recoveredProject);
  assert.equal(recoveredProject.draft.sequence, 3);
  assert.equal(
    recoveredProject.draft.undoTransactionId,
    inFlightTrim.transaction_id,
  );
  mark("manual-undo-recovered-inflight-transaction");
  const undoAfterInFlightLoss = await page.evaluate(
    (value) => window.desktop.undoManualEdit(value),
    {
      schema_version: "1.0" as const,
      projectId: recoveredProject.id,
      draftId: recoveredProject.draft.id,
      baseRevisionId: recoveredProject.draft.baseRevisionId,
      expectedSequence: recoveredProject.draft.sequence,
      expectedTimelineSha256: recoveredProject.draft.timelineSha256,
      targetTransactionId: inFlightTrim.transaction_id,
    },
  );
  assert.ok(undoAfterInFlightLoss.ok);
  assert.equal(undoAfterInFlightLoss.value.draft.sequence, 4);
  assert.equal(undoAfterInFlightLoss.value.timeline.durationUs, 1500000);
  const inFlightUndoJournal = await records();
  assert.equal(inFlightUndoJournal.length, 4);
  const inFlightUndo = inFlightUndoJournal[3]!;
  assert.equal(inFlightUndo.origin, "manual");
  assert.equal(inFlightUndo.kind, "undo");
  assert.equal(inFlightUndo.target_transaction_id, inFlightTrim.transaction_id);
  assert.deepEqual(inFlightUndo.after.timeline, baseline.timeline);
  expectedFinalDraft = inFlightUndo.after;
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  assert.equal(sha256(await readFile(source)), sourceHash);
  assert.equal(
    sha256(await readFile(baseline.source.managed_path)),
    sourceHash,
  );
  await expect(page.locator("#seek")).toHaveAttribute("max", "1000000");
  await assertCanvasFrame(page, 0);
  mark("guest-inspection");
  if (process.argv.includes("--inspect")) {
    console.log(JSON.stringify({ inspectionReady: true, evidence }));
    const deadline = Date.now() + 600000;
    while (true) {
      try {
        await access(join(evidence, "inspection.done"));
        break;
      } catch {
        /* Guest input marker only. */
      }
      if (Date.now() > deadline) throw new Error("Inspection timeout");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await electron.close();
  assert.deepEqual(
    (await offline.snapshot(project.id)).draft,
    expectedFinalDraft,
  );
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        status: "pass",
        scope: "P2-real-authenticated-trim-undo",
        modelCount: account.value.models.length,
        skillCount: account.value.skills.length,
        authenticated: true,
        lunaHighTurn: requireLunaHigh,
        dynamicToolRoute: process.argv.includes("--require-dynamic"),
        discoveredSelectionPersisted: true,
        trimSequence: 1,
        undoSequence: 2,
        restoredDurationUs: 1500000,
        sourceUnchanged: true,
        baselineUnchanged: true,
        journalVerified: true,
        historyRestored: true,
        threadIdentityPreserved: true,
        exactFixturePixels: true,
        committedTrimObservedDuringTurn: liveTrimObserved,
        realReadOnlyTurnInterrupted: true,
        interruptionPreservedJournal: true,
        interruptedThreadReopened: true,
        appServerProcessRestartedInPlace: true,
        settingsReconnectActionUsed: true,
        projectThreadHistoryRestoredAfterAppServerRestart: true,
        committedJournalUnchangedDuringRecovery: true,
        appServerProcessLostDuringCommittedMutation: true,
        committedMutationNotDuplicatedAfterRecovery: true,
        manualUndoRestoredCommittedMutationAfterRecovery: true,
        inFlightTrimSequence: 3,
        inFlightUndoSequence: 4,
        computerUse: false,
        audioListening: false,
        windowsAcceptance: false,
        sourceHash,
        baselineHash: sha256(baselineBytes),
        trimJournalHash: edit.transaction_sha256,
        undoJournalHash: undo.transaction_sha256,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "pass", evidence }));
} catch (error) {
  const category = (value: unknown): string | null =>
    typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/u.test(value)
      ? value
      : null;
  const failure = error && typeof error === "object" ? error : {};
  try {
    await (
      await electron.firstWindow()
    ).screenshot({ path: join(evidence, "failure-window.png"), timeout: 5000 });
  } catch {
    /* Screenshot failure must not replace the original assertion category. */
  }
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({
      status: "fail",
      step,
      detailsOmitted: true,
      errorName: category("name" in failure ? failure.name : null),
      errorCode: category("code" in failure ? failure.code : null),
      snapshot: await failureSnapshot(),
    }),
  );
  console.error(
    `Authenticated native test failed at ${step}; private details omitted.`,
  );
  process.exitCode = 1;
} finally {
  await electron.close().catch(() => {
    /* Already closed or failed; no private diagnostics. */
  });
}

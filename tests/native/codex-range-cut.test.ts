/** Real Codex range-cut test. The private app-owned account is supplied by the guest. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
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
import type { Page } from "playwright/test";
import { assertTwoSourceInitialProjectSnapshot } from "../../packages/domain/src/project.ts";
import type { DraftTransactionRecord } from "../../packages/domain/src/draft-transaction.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { sha256 } from "../../packages/media-engine/src/lossless.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";
import { DraftTransactionStore } from "../../packages/project-store/src/transactions.ts";
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
const configRoot = await realpath(configArgument);
assert.equal(
  configRoot,
  resolve(configArgument),
  "Config root must not redirect",
);
assert.notEqual(configRoot, "/");
const providedPaths = process.argv
  .slice(4)
  .filter(
    (argument) =>
      argument !== "--inspect" &&
      argument !== "--batch" &&
      argument !== "--restore",
  );
const batch = process.argv.includes("--batch");
const restore = process.argv.includes("--restore");
assert.ok(!(batch && restore), "Batch cut and restore modes are exclusive");
assert.ok(
  providedPaths.length === 0 || providedPaths.length === 2,
  "Supply exactly two optional guest media paths",
);
for (const sourcePath of providedPaths)
  assert.ok(isAbsolute(sourcePath), "Guest media paths must be absolute");
async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ReadBeforeEditEvidence {
  route: "dynamic";
  completedTurn: true;
  projectSummaryCalls: number;
  timelineSummaryCalls: number;
  rangeEditCalls: 1;
  summaryBeforeEdit: true;
  editHeadMatchedBothSummaries: true;
  callOutputCorrelated: true;
}

interface DraftHeadEvidence {
  project_id: string;
  draft_id: string;
  base_revision_id: string;
  draft_sequence: number;
  timeline_sha256: string;
}

function readDraftHead(value: Record<string, unknown>): DraftHeadEvidence {
  assert.equal(typeof value.project_id, "string");
  assert.equal(typeof value.draft_id, "string");
  assert.equal(typeof value.base_revision_id, "string");
  assert.ok(Number.isSafeInteger(value.draft_sequence));
  assert.equal(typeof value.timeline_sha256, "string");
  assert.match(value.timeline_sha256 as string, /^[a-f0-9]{64}$/u);
  return {
    project_id: value.project_id as string,
    draft_id: value.draft_id as string,
    base_revision_id: value.base_revision_id as string,
    draft_sequence: value.draft_sequence as number,
    timeline_sha256: value.timeline_sha256 as string,
  };
}

async function verifyAuthenticatedReadBeforeEdit(options: {
  executablePath: string;
  userData: string;
  projectId: string;
  threadId: string;
  prompt: string;
}): Promise<ReadBeforeEditEvidence> {
  const codexHome = join(options.userData, "codex/account");
  const cwd = join(options.userData, "codex/context");
  const runtime = join(
    dirname(options.executablePath),
    "resources/codex/codex",
  );
  const transport = new CodexStdioTransport({
    executable: runtime,
    args: buildCodexAppServerArguments(undefined, []),
    cwd,
    env: {
      HOME: dirname(codexHome),
      USERPROFILE: dirname(codexHome),
      CODEX_HOME: codexHome,
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    },
    requestTimeoutMs: 120_000,
  });
  try {
    await transport.start(buildExperimentalInitialize("0.0.0"));
    const threadRead: unknown = await transport.request("thread/read", {
      threadId: options.threadId,
      includeTurns: false,
    });
    assert.ok(record(threadRead) && record(threadRead.thread));
    assert.equal(threadRead.thread.id, options.threadId);
    assert.ok(typeof threadRead.thread.path === "string");

    let page: unknown;
    try {
      page = await transport.request("thread/turns/list", {
        threadId: options.threadId,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      });
    } catch (error) {
      if (
        !(error instanceof CodexTransportError) ||
        error.code !== "remote_error"
      )
        throw error;
      await transport.request("thread/resume", {
        threadId: options.threadId,
        excludeTurns: true,
      });
      page = await transport.request("thread/turns/list", {
        threadId: options.threadId,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      });
    }
    assert.ok(record(page) && Array.isArray(page.data));
    assert.ok(page.data.length > 0 && page.data.length <= 100);
    const matches = page.data.filter(
      (turn) =>
        record(turn) &&
        Array.isArray(turn.items) &&
        turn.items.some(
          (item) =>
            record(item) &&
            item.type === "userMessage" &&
            Array.isArray(item.content) &&
            item.content.some(
              (content) => record(content) && content.text === options.prompt,
            ),
        ),
    );
    assert.equal(matches.length, 1);
    const turn = matches[0]!;
    assert.equal(turn.status, "completed");
    assert.ok(typeof turn.id === "string");

    const accountRoot = await realpath(codexHome);
    const rolloutPath = await realpath(threadRead.thread.path);
    const relativePath = relative(accountRoot, rolloutPath);
    assert.ok(
      relativePath.length > 0 &&
        !isAbsolute(relativePath) &&
        !relativePath.split(sep).includes(".."),
      "Read-before-edit rollout must remain inside the isolated account",
    );
    assert.ok((await stat(rolloutPath)).size <= 8_000_000);
    const turnItems = turn.items;
    assert.ok(Array.isArray(turnItems) && turnItems.length <= 128);
    const toolCalls = turnItems.filter(
      (item) => record(item) && item.type === "dynamicToolCall",
    );
    assert.ok(toolCalls.length > 0 && toolCalls.length <= 16);
    const projectReads: Array<{ position: number; head: DraftHeadEvidence }> =
      [];
    const timelineReads: Array<{ position: number; head: DraftHeadEvidence }> =
      [];
    const editPositions: number[] = [];
    let editHead: DraftHeadEvidence | undefined;
    for (const [index, rawCall] of toolCalls.entries()) {
      assert.ok(record(rawCall));
      const call = rawCall;
      assert.equal(call.namespace, "codex_video_edit");
      assert.equal(call.status, "completed");
      assert.equal(call.success, true);
      assert.ok(typeof call.id === "string");
      assert.ok(record(call.arguments));
      assert.equal(call.arguments.project_id, options.projectId);
      assert.equal(call.arguments.schema_version, "1.0");
      assert.ok(
        Array.isArray(call.contentItems) && call.contentItems.length === 1,
      );
      const output = call.contentItems[0];
      assert.ok(record(output) && output.type === "inputText");
      assert.ok(
        typeof output.text === "string" && output.text.length <= 64_000,
      );
      if (call.tool === "project_get_summary") {
        const summary: unknown = JSON.parse(output.text as string);
        assert.ok(record(summary));
        assert.equal(summary.schema_version, "1.0");
        assert.equal(summary.project_id, options.projectId);
        assert.ok(record(summary.active_draft));
        const head = readDraftHead({
          ...summary.active_draft,
          project_id: summary.project_id,
        });
        assert.equal(summary.current_revision_id, head.base_revision_id);
        projectReads.push({ position: index, head });
      } else if (call.tool === "timeline_get_summary") {
        const summary: unknown = JSON.parse(output.text as string);
        assert.ok(record(summary));
        assert.equal(summary.schema_version, "1.0");
        const head = readDraftHead(summary);
        assert.equal(head.project_id, options.projectId);
        timelineReads.push({ position: index, head });
      } else if (call.tool === "cut_delete_ranges") {
        editPositions.push(index);
        assert.ok(Number.isSafeInteger(call.arguments.expected_sequence));
        assert.ok(
          typeof call.arguments.expected_timeline_sha256 === "string" &&
            /^[a-f0-9]{64}$/u.test(call.arguments.expected_timeline_sha256),
        );
        editHead = {
          project_id: call.arguments.project_id as string,
          draft_id: call.arguments.draft_id as string,
          base_revision_id: call.arguments.base_revision_id as string,
          draft_sequence: call.arguments.expected_sequence as number,
          timeline_sha256: call.arguments.expected_timeline_sha256 as string,
        };
      } else {
        assert.fail("Unexpected guarded tool in range-cut turn");
      }
    }
    assert.ok(projectReads.length > 0);
    assert.ok(timelineReads.length > 0);
    assert.equal(editPositions.length, 1);
    const firstEdit = editPositions[0]!;
    const projectRead = projectReads
      .filter((read) => read.position < firstEdit)
      .at(-1);
    const timelineRead = timelineReads
      .filter((read) => read.position < firstEdit)
      .at(-1);
    assert.ok(projectRead, "Project summary must precede the range mutation");
    assert.ok(timelineRead, "Timeline summary must precede the range mutation");
    assert.ok(
      editHead,
      "One guarded mutation must provide its exact draft head",
    );
    assert.deepEqual(projectRead.head, timelineRead.head);
    assert.deepEqual(editHead, projectRead.head);
    return {
      route: "dynamic",
      completedTurn: true,
      projectSummaryCalls: projectReads.length,
      timelineSummaryCalls: timelineReads.length,
      rangeEditCalls: 1,
      summaryBeforeEdit: true,
      editHeadMatchedBothSummaries: true,
      callOutputCorrelated: true,
    };
  } finally {
    await transport.close();
  }
}
const resultRoot = resolve("test-results");
await mkdir(resultRoot, { recursive: true });
const evidence = await mkdtemp(join(resultRoot, "native-codex-range-cut-"));
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

const sources: string[] = [];
if (providedPaths.length === 2) {
  for (const sourcePath of providedPaths)
    sources.push(await realpath(sourcePath));
} else {
  for (const [index, pattern] of ["testsrc", "testsrc2"].entries()) {
    const source = join(evidence, `part-${index + 1}.mp4`);
    await runProcess({
      executable: "ffmpeg",
      args: [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        `${pattern}=size=96x64:rate=2:duration=1`,
        "-vf",
        "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
        "-c:v",
        "libx264",
        "-qp",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-color_range",
        "tv",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        source,
      ],
    });
    sources.push(source);
  }
}
const originalHashes = await Promise.all(sources.map(fileHash));

const env = { ...process.env, XDG_CONFIG_HOME: configRoot };
const launch = () =>
  _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30_000,
  });
let electron = await launch();
let page: Page | undefined;
let readBeforeEditEvidence: ReadBeforeEditEvidence | undefined;
async function canvasHash(active: Page): Promise<string | null> {
  return active.locator("canvas").evaluate(async (node) => {
    const canvas = node as HTMLCanvasElement;
    if (!canvas.width || !canvas.height) return null;
    const pixels = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", pixels),
    );
    return Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  });
}
function clock(timeUs: number): string {
  const seconds = timeUs / 1_000_000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
}
async function seek(active: Page, timeUs: number): Promise<void> {
  await active.locator("#seek").evaluate((node, value) => {
    const input = node as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, timeUs);
  await expect(active.locator("#time")).toHaveText(clock(timeUs), {
    timeout: 60_000,
  });
}
try {
  page = await electron.firstWindow();
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
  mark("authenticated-account");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.locator("#codex-model")).toBeEnabled({ timeout: 60_000 });
  await expect
    .poll(
      async () => {
        const state = await page!.evaluate(() => window.desktop.getCodex());
        return (
          state.ok &&
          !state.value.busy &&
          state.value.connection === "connected" &&
          state.value.account === "signed_in" &&
          state.value.models.length > 0 &&
          state.value.skills.length > 0
        );
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  const account = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(account.ok);
  assert.equal(account.value.selection?.modelId, "gpt-6-luna");
  assert.equal(account.value.selection?.reasoning, "high");
  await page.keyboard.press("Escape");

  mark("import-two-sources");
  const before = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(before.ok);
  await electron.evaluate(({ dialog }, paths) => {
    let index = 0;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [paths[index++]!],
    });
  }, sources);
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add footage" })).toBeVisible({
    timeout: 120_000,
  });
  await page.getByRole("button", { name: "Add footage" }).click();
  await expect
    .poll(
      async () => {
        const result = await page!.evaluate(() =>
          window.desktop.listProjects(),
        );
        return result.ok
          ? result.value
              .filter(
                (item) => !before.value.some((prior) => prior.id === item.id),
              )
              .some((item) => item.sources?.length === 2)
          : false;
      },
      { timeout: 300_000 },
    )
    .toBe(true);
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const added = listed.value.filter(
    (item) => !before.value.some((prior) => prior.id === item.id),
  );
  assert.equal(added.length, 2);
  const combined = added.find((item) => item.sources?.length === 2);
  assert.ok(combined);
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  assert.equal(await realpath(userData), join(configRoot, "codex-video-edit"));
  const projectFolder = join(userData, "project-store", combined.id);
  const baselinePath = join(projectFolder, "baseline.json");
  const baselineBytes = await readFile(baselinePath);
  const baseline: unknown = JSON.parse(baselineBytes.toString("utf8"));
  assertTwoSourceInitialProjectSnapshot(baseline);
  const totalUs = baseline.timeline.duration_us;
  const joinUs = baseline.timeline.clips[0]!.timeline_end_us;
  const restoreSourceId = baseline.timeline.clips[0]!.source_id;
  const restoreStartUs = 250_000;
  const restoreEndUs = 750_000;
  if (restore) {
    assert.ok(restoreEndUs < joinUs, "Restore range must fit the first source");
    await electron.close();
    const seedLibrary = new MediaLibrary(join(userData, "media-library"));
    const seedProjects = new ProjectStore(
      join(userData, "project-store"),
      seedLibrary,
    );
    const seedDrafts = new DraftTransactionStore(
      join(userData, "project-store"),
      seedProjects,
    );
    const seededHead = (await seedDrafts.snapshot(combined.id)).draft;
    const seedCut = await seedDrafts.applyManual({
      schema_version: "1.0",
      request_id: "native-restore-seed-cut-001",
      project_id: seededHead.project_id,
      draft_id: seededHead.draft_id,
      base_revision_id: seededHead.base_revision_id,
      expected_sequence: seededHead.draft_sequence,
      expected_timeline_sha256: seededHead.timeline_sha256,
      pass_group: { pass_group_id: "native-restore-seed-001", kind: "manual" },
      reason:
        "Create a known source-time gap for guarded restore verification.",
      operations: [
        {
          type: "ripple_delete",
          start_us: restoreStartUs,
          end_us: restoreEndUs,
        },
      ],
    });
    assert.equal(seedCut.draft.timeline.duration_us, totalUs - 500_000);
    electron = await launch();
    page = await electron.firstWindow();
    assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(page.url(), "codex-video-edit://app/index.html");
  }
  const beforeCodexDurationUs = restore ? totalUs - 500_000 : totalUs;
  const cutStartUs = restore
    ? restoreStartUs
    : providedPaths.length === 2
      ? joinUs - 1_000_000
      : 250_000;
  const cutEndUs = restore
    ? restoreEndUs
    : providedPaths.length === 2
      ? joinUs + 1_000_000
      : 1_500_000;
  const earlyStartUs = 50_000;
  const earlyEndUs = 150_000;
  if (!restore)
    assert.ok(
      cutStartUs > 0 && cutEndUs < totalUs,
      "Both sources must extend beyond the requested cut",
    );
  if (batch) assert.ok(earlyEndUs < cutStartUs);
  const secondSourceStartUs = cutEndUs - joinUs;
  const cutDurationUs = restore
    ? totalUs
    : totalUs -
      (cutEndUs - cutStartUs) -
      (batch ? earlyEndUs - earlyStartUs : 0);
  const editedDurationUs = cutDurationUs;
  const editedJoinUs = restore
    ? (restoreStartUs + restoreEndUs) / 2
    : cutStartUs - (batch ? earlyEndUs - earlyStartUs : 0);
  const reopenJoinUs = restore ? joinUs - 500_000 : joinUs;
  mark("select-combined-project");
  const combinedProject = page.locator(
    `#projects [data-project-id="${combined.id}"]`,
  );
  const homeButton = page.getByRole("button", { name: "Home", exact: true });
  await expect
    .poll(
      async () =>
        (await combinedProject.isVisible()) || (await homeButton.isVisible()),
      { timeout: 120_000 },
    )
    .toBe(true);
  if (!(await combinedProject.isVisible())) await homeButton.click();
  mark("returned-home");
  await expect(combinedProject).toBeVisible({ timeout: 120_000 });
  await combinedProject.click();
  mark("opened-combined-project");
  await expect(page.locator("#duration")).toHaveText(
    ` / ${clock(beforeCodexDurationUs)}`,
    { timeout: 120_000 },
  );
  mark("combined-project-duration-visible");
  const library = new MediaLibrary(join(userData, "media-library"));
  const firstFrame = Buffer.from(
    (
      await library.frame(
        baseline.sources[0].source_id,
        restore ? restoreEndUs : cutStartUs,
      )
    ).rgbaBase64,
    "base64",
  );
  const cutJoinFrame = Buffer.from(
    (
      await library.frame(
        restore ? restoreSourceId : baseline.sources[1].source_id,
        restore ? editedJoinUs : secondSourceStartUs,
      )
    ).rgbaBase64,
    "base64",
  );
  mark("open-edit-stage");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  const threadRequest = {
    schema_version: "1.0" as const,
    project_id: combined.id,
  };
  async function thread() {
    const result = await page!.evaluate(
      (request) => window.desktop.getCodexThread(request),
      threadRequest,
    );
    assert.ok(result.ok);
    return result.value;
  }
  await expect
    .poll(async () => (await thread()).status, { timeout: 90_000 })
    .toBe("ready");
  let threadBinding: { threadId: string; toolRoute?: string } | undefined;
  if (batch || restore) {
    const registry = JSON.parse(
      await readFile(
        join(userData, "codex/context/threads/project-threads.json"),
        "utf8",
      ),
    ) as {
      entries: Array<{
        projectId: string;
        threadId: string;
        toolRoute?: string;
      }>;
    };
    threadBinding = registry.entries.find(
      (entry) => entry.projectId === combined.id,
    );
    assert.equal(threadBinding?.toolRoute, "dynamic");
    assert.ok(threadBinding?.threadId);
  }
  async function records(): Promise<DraftTransactionRecord[]> {
    const folder = join(projectFolder, "draft/journal");
    const names = (await readdir(folder).catch(() => []))
      .filter((name) =>
        /^\d{12}\.[A-Za-z0-9][A-Za-z0-9._-]{1,127}\.json$/u.test(name),
      )
      .sort();
    assert.ok(
      names.length <= (restore ? 3 : 2),
      "Unexpected extra transactions",
    );
    return Promise.all(
      names.map(
        async (name) =>
          JSON.parse(
            await readFile(join(folder, name), "utf8"),
          ) as DraftTransactionRecord,
      ),
    );
  }

  mark(restore ? "authenticated-range-restore" : "authenticated-range-cut");
  const prompt = restore
    ? `The active project_id is ${combined.id}. Use the guarded editor tools with that exact project_id to read the active two-source draft. A prior transaction removed source_id ${restoreSourceId} from source time [${restoreStartUs}, ${restoreEndUs}) microseconds. Restore exactly that confirmed missing source interval once using codex_video_edit__cut_restore_range, with source_id ${restoreSourceId} and those exact half-open source times. The committed draft must be ${editedDurationUs} microseconds long and place the restored clip between its original neighboring source intervals. Do not cut, trim, split, undo, or make another edit. Read the draft again to verify, then reply briefly.`
    : batch
      ? `The active project_id is ${combined.id}. Use the guarded editor tools with that exact project_id to read the active two-source draft. Call codex_video_edit__cut_delete_ranges exactly once with these two confirmed disjoint half-open output-time ranges in descending order: [${cutStartUs}, ${cutEndUs}) across the source join, then [${earlyStartUs}, ${earlyEndUs}) in the first source. The batch must be one transaction with two ripple_delete operations and final duration ${cutDurationUs} microseconds. Do not use cut_delete_range, split, trim, undo, or make another edit. After the batch, call codex_video_edit__timeline_get_summary eight times sequentially and confirm every result has duration_us ${cutDurationUs}. Then reply briefly.`
      : `The active project_id is ${combined.id}. Use the guarded editor tools with that exact project_id to read the active two-source draft. Delete exactly the half-open output range [${cutStartUs}, ${cutEndUs}) microseconds using cut.delete_range, spanning the join between its two source clips. Apply exactly one range-cut transaction. The committed draft must be ${cutDurationUs} microseconds long. Do not trim, undo, or make another edit. Read the draft again to verify, then reply briefly.`;
  await seek(page, editedJoinUs);
  const activePage = page;
  assert.ok(activePage);
  await page.locator("#codex-thread-input").fill(prompt);
  mark("range-turn-send");
  await page.locator("#send-codex-thread").click();
  let committedDuringTurn = false;
  let committedPreviewVisibleDuringTurn = false;
  await expect
    .poll(
      async () => {
        const state = await thread();
        if (state.status === "failed" || state.status === "uncertain")
          throw new Error("Real Codex turn failed; details omitted");
        const journal = await records();
        const editCommitted = journal.some(
          (record) =>
            record.origin === "codex" &&
            record.status === "committed" &&
            record.after.timeline.duration_us === editedDurationUs,
        );
        if (state.status === "running" && editCommitted) {
          committedDuringTurn = true;
          const visibleDuration = await activePage
            .locator("#duration")
            .textContent();
          committedPreviewVisibleDuringTurn =
            visibleDuration?.includes(clock(editedDurationUs)) === true &&
            (await canvasHash(activePage)) === sha256(cutJoinFrame);
        }
        return (
          state.status === "ready" &&
          state.message === null &&
          state.messages.some(
            (message) => message.role === "user" && message.text === prompt,
          ) &&
          state.messages.some(
            (message) =>
              message.role === "codex" &&
              message.complete &&
              message.text.trim().length > 0,
          )
        );
      },
      { timeout: 240_000, intervals: [100, 250, 500, 1000] },
    )
    .toBe(true);
  mark("range-turn-completed");
  assert.equal(
    committedDuringTurn,
    true,
    "Committed edit must exist during the real turn",
  );
  mark("range-commit-observed-during-turn");
  assert.equal(
    committedPreviewVisibleDuringTurn,
    true,
    "Committed duration and preview must update during the real turn",
  );
  mark("committed-preview-verified");
  const journal = await records();
  assert.equal(journal.length, restore ? 2 : 1);
  if (restore) {
    assert.equal(journal[0]!.origin, "manual");
    assert.equal(journal[0]!.operations[0]!.operation_type, "ripple_delete");
  }
  const cut = journal[restore ? 1 : 0]!;
  assert.equal(cut.origin, "codex");
  assert.equal(cut.kind, "apply");
  assert.equal(cut.status, "committed");
  assert.equal(cut.operations.length, batch ? 2 : 1);
  const operation = cut.operations[0]!;
  if (restore) {
    assert.equal(operation.operation_type, "restore");
    if (operation.operation_type !== "restore")
      throw new Error("Expected source-range restore");
    assert.equal(operation.source_id, restoreSourceId);
    assert.equal(operation.source_start_us, restoreStartUs);
    assert.equal(operation.source_end_us, restoreEndUs);
  } else {
    assert.equal(operation.operation_type, "ripple_delete");
    if (operation.operation_type !== "ripple_delete")
      throw new Error("Expected range cut");
    assert.equal(operation.start_us, cutStartUs);
    assert.equal(operation.end_us, cutEndUs);
  }
  if (batch) {
    const second = cut.operations[1]!;
    assert.equal(second.operation_type, "ripple_delete");
    if (second.operation_type !== "ripple_delete")
      throw new Error("Expected second range cut");
    assert.equal(second.start_us, earlyStartUs);
    assert.equal(second.end_us, earlyEndUs);
  }
  mark("range-journal-verified");
  assert.equal(cut.after.timeline.duration_us, editedDurationUs);
  assert.equal(cut.after.draft_sequence, restore ? 2 : 1);
  await expect(page.locator("#duration")).toHaveText(
    ` / ${clock(editedDurationUs)}`,
  );
  await seek(page, editedJoinUs);
  await expect
    .poll(async () => (await canvasHash(page!)) === sha256(cutJoinFrame), {
      timeout: 30_000,
    })
    .toBe(true);
  const edited = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(edited.ok);
  const clips = edited.value.find((item) => item.id === combined.id)?.clips;
  if (restore) {
    assert.equal(clips?.length, 4);
    assert.equal(clips?.[1]?.sourceId, restoreSourceId);
    assert.equal(clips?.[1]?.sourceStartUs, restoreStartUs);
    assert.equal(clips?.[1]?.sourceEndUs, restoreEndUs);
    assert.equal(clips?.[1]?.timelineStartUs, restoreStartUs);
    assert.equal(clips?.[1]?.timelineEndUs, restoreEndUs);
  } else {
    assert.equal(clips?.length, batch ? 3 : 2);
    assert.equal(clips?.[batch ? 1 : 0]?.timelineEndUs, editedJoinUs);
    assert.equal(clips?.[batch ? 2 : 1]?.timelineStartUs, editedJoinUs);
    assert.equal(clips?.[batch ? 2 : 1]?.sourceStartUs, secondSourceStartUs);
  }
  mark("committed-map-verified");
  await page.screenshot({
    path: join(evidence, "committed-native-window.png"),
  });

  mark("shared-undo-and-reopen");
  await page.locator("#close-codex").click();
  await page.locator("#undo-edit").click();
  mark("undo-restored-state");
  await expect(page.locator("#duration")).toHaveText(
    ` / ${clock(beforeCodexDurationUs)}`,
  );
  const undone = await records();
  assert.equal(undone.length, restore ? 3 : 2);
  const undo = undone.at(-1)!;
  assert.equal(undo.origin, "manual");
  assert.equal(undo.kind, "undo");
  assert.equal(undo.target_transaction_id, cut.transaction_id);
  assert.deepEqual(
    undo.after.timeline,
    restore ? journal[0]!.after.timeline : baseline.timeline,
  );
  await seek(page, cutStartUs);
  await expect
    .poll(async () => (await canvasHash(page!)) === sha256(firstFrame), {
      timeout: 30_000,
    })
    .toBe(true);
  mark("reopen-project");
  await electron.close();
  if (batch) {
    assert.ok(threadBinding);
    mark("authoritative-read-before-edit");
    readBeforeEditEvidence = await verifyAuthenticatedReadBeforeEdit({
      executablePath,
      userData,
      projectId: combined.id,
      threadId: threadBinding.threadId,
      prompt,
    });
  }
  const offline = new DraftTransactionStore(
    join(userData, "project-store"),
    new ProjectStore(join(userData, "project-store"), library),
  );
  assert.deepEqual((await offline.snapshot(combined.id)).draft, undo.after);
  electron = await launch();
  page = await electron.firstWindow();
  await page.locator(`#projects [data-project-id="${combined.id}"]`).click();
  mark("reopen-frame");
  await expect(page.locator("#duration")).toHaveText(
    ` / ${clock(beforeCodexDurationUs)}`,
    { timeout: 30_000 },
  );
  mark("reopen-duration");
  await seek(page, reopenJoinUs);
  mark("reopen-seek");
  const restoredSecond = Buffer.from(
    (await library.frame(baseline.sources[1].source_id, 0)).rgbaBase64,
    "base64",
  );
  await expect
    .poll(async () => (await canvasHash(page!)) === sha256(restoredSecond), {
      timeout: 30_000,
    })
    .toBe(true);
  mark("reopen-exact-frame");
  mark("verify-immutable-inputs");
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  for (let index = 0; index < sources.length; index++) {
    assert.equal(await fileHash(sources[index]!), originalHashes[index]);
    assert.equal(
      await fileHash(baseline.sources[index]!.managed_path),
      originalHashes[index],
    );
  }
  if (process.argv.includes("--inspect")) {
    await writeFile(join(evidence, "inspection.ready"), "ready\n");
    const deadline = Date.now() + 120_000;
    while (
      Date.now() < deadline &&
      !(await access(join(evidence, "inspection.done")).then(
        () => true,
        () => false,
      ))
    )
      await new Promise((done) => setTimeout(done, 500));
    assert.ok(
      await access(join(evidence, "inspection.done")).then(
        () => true,
        () => false,
      ),
      "Guest visual inspection timed out",
    );
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        status: "pass",
        scope: restore
          ? "real-authenticated-codex-range-restore"
          : batch
            ? "real-authenticated-codex-range-batch"
            : "real-authenticated-codex-range-cut",
        packaged: true,
        nativeWindow: true,
        sourceCount: 2,
        privateInputs: providedPaths.length === 2,
        committedDuringTurn,
        committedPreviewVisibleDuringTurn,
        exactJoinFrame: true,
        sharedUndo: true,
        reopen: true,
        immutableSourcesAndBaseline: true,
        authenticatedReadBeforeEdit: readBeforeEditEvidence ?? null,
        audioListening: false,
        windowsAcceptance: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "pass", evidence }));
} catch (error) {
  try {
    await page?.screenshot({
      path: join(evidence, "failure-window.png"),
      timeout: 5000,
    });
  } catch {
    /* Preserve the original failure. */
  }
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({
      status: "fail",
      step,
      detailsOmitted: true,
      errorName: error instanceof Error ? error.name : "unknown",
    }),
  );
  console.error(
    `Authenticated native range-edit test failed at ${step}; private details omitted.`,
  );
  process.exitCode = 1;
} finally {
  await electron.close().catch(() => {
    /* Already closed. */
  });
}

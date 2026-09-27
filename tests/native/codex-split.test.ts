/** Real Codex split with synthetic or two ordered private guest sources. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
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
import { isDeepStrictEqual } from "node:util";
import { _electron, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { maxFramePixels } from "../../packages/domain/src/library.ts";
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
let configRoot = await realpath(configArgument);
assert.equal(
  configRoot,
  resolve(configArgument),
  "Config root must not redirect",
);
assert.notEqual(configRoot, "/");
if (process.argv.includes("--hostile-app-config")) {
  const explicitModelId = process.argv
    .find((argument) => argument.startsWith("--model-id="))
    ?.slice("--model-id=".length);
  const explicitReasoning = process.argv
    .find((argument) => argument.startsWith("--reasoning="))
    ?.slice("--reasoning=".length);
  assert.ok(
    process.argv.includes("--require-luna") ||
      (explicitModelId === "gpt-5.6-luna" && explicitReasoning === "high"),
    "Hostile-app probes require GPT-6-Luna/high or the explicit GPT-5.6-Luna/high test choice",
  );
  assert.ok(process.argv.includes("--require-dynamic"));
  assert.ok(process.argv.includes("--probe-surface"));
}
const providedPaths = process.argv
  .slice(4)
  .filter(
    (argument) =>
      argument !== "--inspect" &&
      argument !== "--require-luna" &&
      argument !== "--require-dynamic" &&
      argument !== "--probe-surface" &&
      argument !== "--hostile-app-config" &&
      !argument.startsWith("--model-id=") &&
      !argument.startsWith("--reasoning="),
  );
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

function multiAgentVersionForModel(
  modelId: string | undefined,
): "v1" | "v2" | null {
  if (modelId === "gpt-6-luna") return "v2";
  if (modelId === "gpt-5.6-luna") return "v1";
  return null;
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === "string") {
    try {
      return [value, ...collectStrings(JSON.parse(value), depth + 1)];
    } catch {
      return [value];
    }
  }
  if (Array.isArray(value))
    return value.flatMap((item) => collectStrings(item, depth + 1));
  if (record(value))
    return Object.values(value).flatMap((item) =>
      collectStrings(item, depth + 1),
    );
  return [];
}

interface ToolSurfaceEvidence {
  route: "mcp" | "dynamic";
  ownedToolCount: 8;
  nativeAgentToolCount: number;
  nestedV2ToolCount: number;
  clockToolCount: number;
  applicationToolCount: 0;
  otherToolCount: number;
  multiAgentVersion: "disabled" | "v1" | "v2" | null;
  readOnlyUtilityNames: string[];
  completedCodeModeCall: true;
  callOutputCorrelated: true;
}

async function verifyToolSurfaceRollout(options: {
  executablePath: string;
  userData: string;
  projectThreadId: string;
  diagnostic: string;
  toolRoute: "mcp" | "dynamic";
  multiAgentVersion: "disabled" | "v1" | "v2" | null;
}): Promise<ToolSurfaceEvidence> {
  mark("surface-audit-start");
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
    mark("surface-audit-thread-read");
    const threadRead: unknown = await transport.request("thread/read", {
      threadId: options.projectThreadId,
      includeTurns: false,
    });
    assert.ok(record(threadRead) && record(threadRead.thread));
    assert.equal(threadRead.thread.id, options.projectThreadId);
    assert.ok(typeof threadRead.thread.path === "string");

    mark("surface-audit-turn-list");
    let page: unknown;
    try {
      page = await transport.request("thread/turns/list", {
        threadId: options.projectThreadId,
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
        threadId: options.projectThreadId,
        excludeTurns: true,
      });
      page = await transport.request("thread/turns/list", {
        threadId: options.projectThreadId,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      });
    }
    assert.ok(record(page) && Array.isArray(page.data));
    assert.ok(page.data.length > 0 && page.data.length <= 100);
    const turns = page.data.filter(record);
    mark("surface-audit-diagnostic-turn");
    const matchingTurns = turns.filter(
      (turn) =>
        Array.isArray(turn.items) &&
        turn.items.some(
          (item) =>
            record(item) &&
            item.type === "userMessage" &&
            Array.isArray(item.content) &&
            item.content.some(
              (content) =>
                record(content) && content.text === options.diagnostic,
            ),
        ),
    );
    assert.equal(matchingTurns.length, 1);
    const turn = matchingTurns[0]!;
    assert.equal(turn.status, "completed");
    assert.ok(typeof turn.id === "string");

    mark("surface-audit-rollout-boundary");
    const accountRoot = await realpath(codexHome);
    const rolloutPath = await realpath(threadRead.thread.path);
    const relativePath = relative(accountRoot, rolloutPath);
    assert.ok(
      relativePath.length > 0 &&
        !isAbsolute(relativePath) &&
        !relativePath.split(sep).includes(".."),
      "Native tool-surface rollout must remain inside the isolated account",
    );
    assert.ok((await stat(rolloutPath)).size <= 8_000_000);
    const lines = (await readFile(rolloutPath, "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0);
    assert.ok(lines.length > 0 && lines.length <= 2_000);
    const records = lines.map((line: string) => {
      const item: unknown = JSON.parse(line);
      assert.ok(record(item));
      return item;
    });
    mark("surface-audit-turn-context");
    const turnContextIndexes = records.flatMap((item, index) =>
      item.type === "turn_context" &&
      record(item.payload) &&
      item.payload.turn_id === turn.id
        ? [index]
        : [],
    );
    assert.equal(turnContextIndexes.length, 1);
    const turnStart = turnContextIndexes[0]!;
    const nextTurn = records.findIndex(
      (item, index) => index > turnStart && item.type === "turn_context",
    );
    const responseItems = records
      .slice(turnStart, nextTurn < 0 ? undefined : nextTurn)
      .filter((item) => item.type === "response_item" && record(item.payload))
      .map((item) => item.payload as Record<string, unknown>);
    mark("surface-audit-inventory-call");
    const codeCalls = responseItems.filter(
      (item) =>
        item.type === "custom_tool_call" &&
        item.name === "exec" &&
        typeof item.input === "string" &&
        item.input.includes("ALL_TOOLS.filter") &&
        item.input.includes("agentCount") &&
        item.input.includes("appCount"),
    );
    const inventoryCalls = codeCalls.filter((candidate) => {
      if (typeof candidate.call_id !== "string") return false;
      const outputs = responseItems.filter(
        (item) =>
          item.type === "custom_tool_call_output" &&
          item.call_id === candidate.call_id,
      );
      return (
        outputs.length === 1 &&
        collectStrings(outputs[0]).some(
          (output) =>
            output.includes('"ownedCount"') && output.includes('"otherCount"'),
        )
      );
    });
    mark("surface-audit-call-correlation");
    assert.equal(
      responseItems.filter(
        (item) => item.type === "custom_tool_call" && item.name !== "exec",
      ).length,
      0,
      "The tool-surface probe must not invoke an unrelated tool",
    );
    assert.equal(
      inventoryCalls.length,
      1,
      "Require one correlated code-mode inventory result",
    );
    const call = inventoryCalls[0]!;
    assert.ok(typeof call.call_id === "string");
    const codeOutputs = responseItems.filter(
      (item) =>
        item.type === "custom_tool_call_output" &&
        item.call_id === call.call_id,
    );
    assert.equal(codeOutputs.length, 1, "Require its correlated tool output");
    assert.ok(JSON.stringify(codeOutputs[0]).length <= 64_000);
    mark("surface-audit-capability-counts");
    const outputText = collectStrings(codeOutputs[0]).join("\n");
    const expectedAgentCount =
      options.toolRoute === "dynamic" && options.multiAgentVersion === "v1"
        ? 5
        : 0;
    const v2ToolNames =
      options.toolRoute === "dynamic" && options.multiAgentVersion === "v2"
        ? [
            "codex_video_edit_agents__spawn_agent",
            "codex_video_edit_agents__send_message",
            "codex_video_edit_agents__followup_task",
            "codex_video_edit_agents__interrupt_agent",
            "codex_video_edit_agents__list_agents",
            "codex_video_edit_agents__wait_agent",
          ]
        : [];
    const expectedV2Count = 0;
    const expectedClockCount =
      options.toolRoute === "dynamic" && options.multiAgentVersion === "v2"
        ? 1
        : 0;
    const expectedUnownedCount =
      expectedAgentCount + expectedV2Count + expectedClockCount;
    const expectedOtherCount = 0;
    for (const [key, value] of [
      ["ownedCount", 8],
      ["agentCount", expectedAgentCount],
      ["v2AgentCount", expectedV2Count],
      ["clockCount", expectedClockCount],
      ["appCount", 0],
      ["unownedCount", expectedUnownedCount],
      ["otherCount", expectedOtherCount],
    ] as const)
      assert.match(
        outputText,
        new RegExp(`"${key}"\\s*:\\s*${value}\\b`, "u"),
        `Code-mode output did not report the expected ${key}`,
      );
    mark("surface-audit-capability-denials");
    for (const key of [
      "apps",
      "goals",
      "plan",
      "input",
      "skills",
      "images",
      "web",
      "shell",
    ])
      assert.match(
        outputText,
        new RegExp(`"${key}"\\s*:\\s*"undefined"`, "u"),
        `Code-mode output did not suppress ${key}`,
      );
    assert.match(
      outputText,
      expectedAgentCount > 0
        ? /"spawn"\s*:\s*"function"/u
        : /"spawn"\s*:\s*"undefined"/u,
    );
    if (options.toolRoute === "dynamic" && options.multiAgentVersion === "v2") {
      for (const name of v2ToolNames)
        assert.ok(
          !outputText.includes(name),
          `Direct-only V2 tool ${name} leaked into the nested code-mode surface`,
        );
      assert.ok(outputText.includes("clock__curr_time"));
    }
    mark("surface-audit-complete");
    return {
      route: options.toolRoute,
      ownedToolCount: 8,
      nativeAgentToolCount: expectedAgentCount,
      nestedV2ToolCount: expectedV2Count,
      clockToolCount: expectedClockCount,
      applicationToolCount: 0,
      otherToolCount: expectedOtherCount,
      multiAgentVersion: options.multiAgentVersion,
      readOnlyUtilityNames: expectedClockCount > 0 ? ["clock__curr_time"] : [],
      completedCodeModeCall: true,
      callOutputCorrelated: true,
    };
  } finally {
    await transport.close();
  }
}
const resultRoot = resolve("test-results");
await mkdir(resultRoot, { recursive: true });
const evidence = await mkdtemp(join(resultRoot, "native-codex-split-"));
if (process.argv.includes("--require-luna")) {
  const source = join(configRoot, "codex-video-edit/codex/account/auth.json");
  const info = await stat(source);
  assert.ok(info.isFile());
  assert.equal(info.mode & 0o077, 0);
  const fresh = await mkdtemp("/tmp/codex-video-edit-luna-edit-");
  await chmod(fresh, 0o700);
  const target = join(fresh, "codex-video-edit/codex/account");
  await mkdir(target, { recursive: true, mode: 0o700 });
  await copyFile(source, join(target, "auth.json"));
  await chmod(join(target, "auth.json"), 0o600);
  if (process.argv.includes("--hostile-app-config"))
    await writeFile(
      join(target, "config.toml"),
      "[apps._default]\nenabled = true\n\n[apps.adobe]\nenabled = true\n",
      { mode: 0o600 },
    );
  if (process.argv.includes("--hostile-app-config"))
    assert.equal((await stat(join(target, "config.toml"))).mode & 0o077, 0);
  configRoot = fresh;
}
let step = "fixture";
let surfaceEvidence: ToolSurfaceEvidence | undefined;
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
    sources.push(
      await realpath(sourcePath).catch(() => {
        throw new Error("Private guest source could not be resolved");
      }),
    );
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
const originalHashes = await Promise.all(sources.map(fileHash)).catch(() => {
  throw new Error("Guest source integrity could not be read");
});

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
async function canvasHash(active: Page): Promise<string | null> {
  return active.locator("canvas").evaluate(async (node, pixelLimit) => {
    const canvas = node as HTMLCanvasElement;
    if (!canvas.width || !canvas.height) return null;
    if (canvas.width * canvas.height > pixelLimit)
      throw new Error("Canvas exceeds supported preview bounds");
    const pixels = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", pixels),
    );
    return Array.from(digest, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }, maxFramePixels);
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
  let account = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(account.ok);
  const requestedModelId = process.argv
    .find((argument) => argument.startsWith("--model-id="))
    ?.slice("--model-id=".length);
  const requestedReasoning =
    process.argv
      .find((argument) => argument.startsWith("--reasoning="))
      ?.slice("--reasoning=".length) ?? "high";
  if (requestedModelId !== undefined) {
    assert.ok(
      requestedModelId === "gpt-5.6-luna" || requestedModelId === "gpt-6-luna",
      "The policy fixture may select only a Luna model",
    );
    assert.ok(!process.argv.includes("--require-luna"));
    const model = account.value.models.find(
      (item) => item.id === requestedModelId,
    );
    assert.ok(model, "The explicitly requested Luna model is unavailable");
    assert.ok(
      model.reasoning.includes(requestedReasoning),
      "The explicitly requested reasoning effort is unavailable",
    );
    await page.locator("#codex-model").selectOption(model.id);
    await expect
      .poll(
        async () => {
          const state = await page!.evaluate(() => window.desktop.getCodex());
          return (
            state.ok &&
            !state.value.busy &&
            state.value.selection?.modelId === model.id
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await page.locator("#codex-reasoning").selectOption(requestedReasoning);
    await expect
      .poll(
        async () => {
          const state = await page!.evaluate(() => window.desktop.getCodex());
          return state.ok && !state.value.busy ? state.value.selection : null;
        },
        { timeout: 60_000 },
      )
      .toEqual({ modelId: model.id, reasoning: requestedReasoning });
    account = await page.evaluate(() => window.desktop.getCodex());
    assert.ok(account.ok);
  } else {
    assert.ok(
      account.value.selection,
      "Do not silently choose from a missing default model selection; supply --model-id for an explicit fixture choice",
    );
  }
  if (process.argv.includes("--require-luna")) {
    assert.deepEqual(account.value.selection, {
      modelId: "gpt-6-luna",
      reasoning: "high",
    });
  }
  if (!account.value.selection) {
    const model = account.value.models[0]!;
    await page.locator("#codex-model").selectOption(model.id);
    await expect
      .poll(
        async () => {
          const state = await page!.evaluate(() => window.desktop.getCodex());
          return (
            state.ok &&
            !state.value.busy &&
            state.value.selection?.modelId === model.id
          );
        },
        { timeout: 60_000 },
      )
      .toBe(true);
  }
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
  const splitUs = Math.min(500_000, Math.floor(joinUs / 2));
  if (providedPaths.length === 0) {
    assert.equal(totalUs, 2_000_000);
    assert.equal(joinUs, 1_000_000);
  }
  const target = baseline.timeline.clips[0]!;
  assert.ok(
    target.timeline_start_us < splitUs && splitUs < target.timeline_end_us,
  );
  await expect(page.locator("#duration")).toHaveText(` / ${clock(totalUs)}`);
  const library = new MediaLibrary(join(userData, "media-library"));
  const firstFrameHash = sha256(
    Buffer.from(
      (await library.frame(baseline.sources[0].source_id, 0)).rgbaBase64,
      "base64",
    ),
  );
  const splitRightFrameHash = sha256(
    Buffer.from(
      (await library.frame(baseline.sources[0].source_id, splitUs)).rgbaBase64,
      "base64",
    ),
  );
  const secondSourceFrameHash = sha256(
    Buffer.from(
      (await library.frame(baseline.sources[1].source_id, 0)).rgbaBase64,
      "base64",
    ),
  );
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible();
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
  const registry = JSON.parse(
    await readFile(
      join(userData, "codex/context/threads/project-threads.json"),
      "utf8",
    ),
  ) as {
    schemaVersion: number;
    entries: Array<{
      projectId: string;
      threadId: string;
      toolRoute?: string;
    }>;
  };
  const bindings = registry.entries.filter(
    (entry) => entry.projectId === combined.id,
  );
  assert.equal(bindings.length, 1);
  assert.ok(bindings[0]!.threadId.length > 0);
  const toolRoute = bindings[0]!.toolRoute ?? "mcp";
  assert.ok(toolRoute === "mcp" || toolRoute === "dynamic");
  if (process.argv.includes("--require-dynamic")) {
    assert.equal(registry.schemaVersion, 2);
    assert.equal(toolRoute, "dynamic");
  }
  if (process.argv.includes("--probe-surface")) {
    mark("safe-tool-surface-probe");
    const ownedPrefix =
      toolRoute === "dynamic"
        ? "codex_video_edit__"
        : "mcp__codex_video_edit__";
    const diagnostic = `In a code-mode JavaScript cell, evaluate only JSON.stringify({owned: typeof tools.${ownedPrefix}project_get_summary, apps: typeof tools.mcp__codex_apps__adobe_adobe_mandatory_init, goals: typeof tools.update_goal, plan: typeof tools.update_plan, input: typeof tools.request_user_input_async, skills: typeof tools.skills__list, spawn: typeof tools.multi_agent_v1__spawn_agent, images: typeof tools.image_gen__imagegen, web: typeof tools.web__run, shell: typeof tools.exec_command, spawnV2: typeof tools.codex_video_edit_agents__spawn_agent, waitV2: typeof tools.codex_video_edit_agents__wait_agent, ownedCount: ALL_TOOLS.filter(x => x.name.startsWith('${ownedPrefix}')).length, agentCount: ALL_TOOLS.filter(x => x.name.startsWith('multi_agent_v1__')).length, v2AgentCount: ALL_TOOLS.filter(x => x.name.startsWith('codex_video_edit_agents__')).length, clockCount: ALL_TOOLS.filter(x => x.name === 'clock__curr_time').length, appCount: ALL_TOOLS.filter(x => x.name.startsWith('mcp__codex_apps__')).length, unownedCount: ALL_TOOLS.filter(x => !x.name.startsWith('${ownedPrefix}')).length, otherCount: ALL_TOOLS.filter(x => !x.name.startsWith('${ownedPrefix}') && !x.name.startsWith('multi_agent_v1__') && !x.name.startsWith('codex_video_edit_agents__') && x.name !== 'clock__curr_time').length, unownedNames: ALL_TOOLS.filter(x => !x.name.startsWith('${ownedPrefix}')).map(x => x.name)}). Print that exact JSON with text(). Do not invoke any nested tool, access any file or contact any service. Report the observed JSON only.`;
    await page.locator("#codex-thread-input").fill(diagnostic);
    await page.locator("#send-codex-thread").click();
    await expect
      .poll(async () => (await thread()).status, { timeout: 120_000 })
      .toBe("ready");
    step = "surface-turn-completed";
    assert.equal((await thread()).status, "ready");
    await electron.close();
    mark("authoritative-surface-rollout");
    surfaceEvidence = await verifyToolSurfaceRollout({
      executablePath,
      userData,
      projectThreadId: bindings[0]!.threadId,
      diagnostic,
      toolRoute,
      multiAgentVersion: multiAgentVersionForModel(
        account.value.selection?.modelId,
      ),
    });
    await writeFile(
      join(evidence, "tool-surface-probe.json"),
      JSON.stringify(surfaceEvidence),
    );
    electron = await launch();
    page = await electron.firstWindow();
    await page.locator(`#projects [data-project-id="${combined.id}"]`).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.locator("#edit-actions")).toBeVisible();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await page
      .getByRole("button", { name: "Open conversation", exact: true })
      .click();
    await expect
      .poll(async () => (await thread()).status, { timeout: 90_000 })
      .toBe("ready");
  }
  async function records(): Promise<DraftTransactionRecord[]> {
    const folder = join(projectFolder, "draft/journal");
    const names = (await readdir(folder).catch(() => []))
      .filter((name) =>
        /^\d{12}\.[A-Za-z0-9][A-Za-z0-9._-]{1,127}\.json$/u.test(name),
      )
      .sort();
    assert.ok(names.length <= 2, "Unexpected extra transactions");
    return Promise.all(
      names.map(
        async (name) =>
          JSON.parse(
            await readFile(join(folder, name), "utf8"),
          ) as DraftTransactionRecord,
      ),
    );
  }

  mark("authenticated-split");
  const splitTool =
    toolRoute === "dynamic" ? "codex_video_edit__cut_split" : "cut.split";
  const prompt = `Use the guarded editor tools to read the active two-source draft. Split its first clip, ID ${target.clip_id}, at exactly ${splitUs} microseconds on the output timeline using ${splitTool}. Apply exactly one split transaction. The committed draft must have three clips and remain ${totalUs} microseconds long. Do not trim, delete, undo, or make another edit. Read the draft again to verify, then reply briefly.`;
  await page.locator("#codex-thread-input").fill(prompt);
  await page.locator("#send-codex-thread").click();
  let committedDuringTurn = false;
  await expect
    .poll(
      async () => {
        const state = await thread();
        if (state.status === "failed" || state.status === "uncertain")
          throw new Error("Real Codex turn failed; details omitted");
        const journal = await records();
        const committedSplit = journal.find(
          (record) =>
            record.origin === "codex" &&
            record.status === "committed" &&
            record.after.timeline.clips.length === 3,
        );
        if (state.status === "running" && committedSplit) {
          const projected = await page!.evaluate(() =>
            window.desktop.listProjects(),
          );
          if (
            projected.ok &&
            isDeepStrictEqual(
              projected.value.find((item) => item.id === combined.id)?.clips,
              committedSplit.after.timeline.clips.map((clip) => ({
                id: clip.clip_id,
                sourceId: clip.source_id,
                timelineStartUs: clip.timeline_start_us,
                timelineEndUs: clip.timeline_end_us,
                sourceStartUs: clip.source_start_us,
                sourceEndUs: clip.source_end_us,
              })),
            )
          )
            committedDuringTurn = true;
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
  assert.equal(
    committedDuringTurn,
    true,
    "Committed split and projected fragments must be visible during the real turn",
  );
  const journal = await records();
  assert.equal(journal.length, 1);
  const split = journal[0]!;
  assert.equal(split.origin, "codex");
  assert.equal(split.kind, "apply");
  assert.equal(split.status, "committed");
  assert.equal(split.operations.length, 1);
  const operation = split.operations[0]!;
  assert.equal(operation.operation_type, "split");
  if (operation.operation_type !== "split")
    throw new Error("Expected clip split");
  assert.equal(operation.clip_id, target.clip_id);
  assert.equal(operation.timeline_position_us, splitUs);
  assert.equal(split.after.timeline.duration_us, totalUs);
  assert.equal(split.after.timeline.clips.length, 3);
  assert.equal(split.after.draft_sequence, 1);
  assert.deepEqual(split.after.timeline.clips.slice(0, 2), operation.after);
  await expect(page.locator("#duration")).toHaveText(` / ${clock(totalUs)}`);
  await seek(page, 0);
  await expect
    .poll(async () => (await canvasHash(page!)) === firstFrameHash, {
      timeout: 30_000,
    })
    .toBe(true);
  await seek(page, splitUs);
  await expect
    .poll(async () => (await canvasHash(page!)) === splitRightFrameHash, {
      timeout: 30_000,
    })
    .toBe(true);
  await seek(page, joinUs);
  await expect
    .poll(async () => (await canvasHash(page!)) === secondSourceFrameHash, {
      timeout: 30_000,
    })
    .toBe(true);
  const edited = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(edited.ok);
  const clips = edited.value.find((item) => item.id === combined.id)?.clips;
  assert.equal(clips?.length, 3);
  assert.equal(clips?.[0]?.timelineStartUs, 0);
  assert.equal(clips?.[0]?.timelineEndUs, splitUs);
  assert.equal(clips?.[1]?.timelineStartUs, splitUs);
  assert.equal(clips?.[1]?.timelineEndUs, joinUs);
  assert.equal(clips?.[1]?.sourceStartUs, splitUs);
  assert.equal(clips?.[2]?.timelineStartUs, joinUs);
  await page.screenshot({
    path: join(evidence, "committed-native-window.png"),
  });

  mark("shared-undo-and-reopen");
  await page.locator("#close-codex").click();
  await page.locator("#undo-edit").click();
  mark("undo-restored-state");
  await expect
    .poll(async () => (await records()).length, { timeout: 60_000 })
    .toBe(2);
  await expect(page.locator("#duration")).toHaveText(` / ${clock(totalUs)}`);
  const undone = await records();
  assert.equal(undone.length, 2);
  assert.equal(undone[1]!.origin, "manual");
  assert.equal(undone[1]!.kind, "undo");
  assert.equal(undone[1]!.target_transaction_id, split.transaction_id);
  assert.deepEqual(undone[1]!.after.timeline, baseline.timeline);
  await expect
    .poll(
      async () => {
        const restored = await page!.evaluate(() =>
          window.desktop.listProjects(),
        );
        return restored.ok
          ? restored.value.find((item) => item.id === combined.id)?.clips
              ?.length
          : null;
      },
      { timeout: 60_000 },
    )
    .toBe(2);
  await seek(page, 0);
  await expect
    .poll(async () => (await canvasHash(page!)) === firstFrameHash, {
      timeout: 30_000,
    })
    .toBe(true);
  mark("reopen-project");
  await electron.close();
  const offline = new DraftTransactionStore(
    join(userData, "project-store"),
    new ProjectStore(join(userData, "project-store"), library),
  );
  assert.deepEqual(
    (await offline.snapshot(combined.id)).draft,
    undone[1]!.after,
  );
  electron = await launch();
  page = await electron.firstWindow();
  await page.locator(`#projects [data-project-id="${combined.id}"]`).click();
  mark("reopen-frame");
  await expect(page.locator("#duration")).toHaveText(` / ${clock(totalUs)}`, {
    timeout: 30_000,
  });
  mark("reopen-duration");
  await seek(page, joinUs);
  mark("reopen-seek");
  await expect
    .poll(async () => (await canvasHash(page!)) === secondSourceFrameHash, {
      timeout: 30_000,
    })
    .toBe(true);
  mark("reopen-exact-frame");
  mark("verify-baseline-file-bytes");
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  for (let index = 0; index < sources.length; index++) {
    mark(`verify-original-source-${index + 1}`);
    assert.equal(await fileHash(sources[index]!), originalHashes[index]);
    mark(`verify-managed-source-${index + 1}`);
    assert.equal(
      await fileHash(baseline.sources[index]!.managed_path),
      originalHashes[index],
    );
  }
  if (process.argv.includes("--inspect")) {
    mark("native-visual-inspection");
    await page?.bringToFront();
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
        scope: "real-authenticated-codex-split",
        toolRoute,
        packaged: true,
        nativeWindow: true,
        sourceCount: 2,
        privateInputs: providedPaths.length === 2,
        committedDuringTurn,
        exactSplitAndJoinFrames: true,
        sharedUndo: true,
        reopen: true,
        immutableSourcesAndBaseline: true,
        toolSurface: surfaceEvidence ?? null,
        hostilePerAppConfig: process.argv.includes("--hostile-app-config"),
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
    `Authenticated native split test failed at ${step}; private details omitted.`,
  );
  process.exitCode = 1;
} finally {
  await electron.close().catch(() => {
    /* Already closed. */
  });
}

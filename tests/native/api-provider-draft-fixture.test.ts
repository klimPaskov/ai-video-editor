/** Packaged native API-provider draft flow with a main-only synthetic transport. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect, type Page } from "playwright/test";
import {
  encodeVerifiedMaster,
  sha256,
} from "../../packages/media-engine/src/lossless.ts";
import { assertInitialProjectSnapshot } from "../../packages/domain/src/project.ts";
import type { DraftTransactionRecord } from "../../packages/domain/src/draft-transaction.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await access("/.dockerenv");
const executablePath = process.argv[2];
if (!executablePath?.startsWith("/home/node/"))
  throw new Error("Packaged executable must stay inside the guest");
const evidence = await mkdtemp(
  join(resolve("test-results"), "native-api-draft-"),
);
await chmod(evidence, 0o700);
const configRoot = await mkdtemp(join(evidence, "account-"));
await chmod(configRoot, 0o700);
const canonicalVideo = Buffer.alloc(96 * 64 * 4 * 3);
const colors = [
  [20, 40, 180],
  [30, 170, 50],
  [190, 60, 30],
];
for (let frame = 0; frame < 3; frame++)
  for (let pixel = 0; pixel < 96 * 64; pixel++)
    for (let channel = 0; channel < 4; channel++)
      canonicalVideo[(frame * 96 * 64 + pixel) * 4 + channel] =
        channel === 3
          ? 255
          : (colors[frame]![channel]! +
              (pixel % 96) +
              Math.floor(pixel / 96) * (channel + 1)) %
            256;
const canonicalAudio = Buffer.alloc(72_000 * 2);
for (let sample = 0; sample < 72_000; sample++)
  canonicalAudio.writeInt16LE(
    Math.round(Math.sin(sample / 20) * 6000),
    sample * 2,
  );
const videoPath = join(evidence, "canonical.raw");
const audioPath = join(evidence, "canonical.pcm");
const source = join(evidence, "fixture.mkv");
await writeFile(videoPath, canonicalVideo);
await writeFile(audioPath, canonicalAudio);
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
const testKey = "TEST-ONLY-LOCAL-API-KEY";
assert.ok(
  !(process.argv.includes("--deepseek") && process.argv.includes("--gemini")),
  "Select only one synthetic API provider",
);
const provider = process.argv.includes("--gemini")
  ? "gemini"
  : process.argv.includes("--deepseek")
    ? "deepseek"
    : "openai";
const model =
  provider === "gemini"
    ? "gemini-3.1-flash-lite"
    : provider === "deepseek"
      ? "deepseek-chat"
      : "gpt-4.1-mini";
const modelUrl =
  provider === "gemini"
    ? "https://generativelanguage.googleapis.com/v1beta/openai/models"
    : provider === "deepseek"
      ? "https://api.deepseek.com/models"
      : "https://api.openai.com/v1/models";
const chatUrl =
  provider === "gemini"
    ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    : provider === "deepseek"
      ? "https://api.deepseek.com/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
let lastFrameMismatch: {
  frame: number;
  index: number;
  actual: number;
  expected: number;
} | null = null;
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify({
    asarHash: sha256(
      await readFile(join(dirname(executablePath), "resources/app.asar")),
    ),
    testHash: sha256(await readFile(fileURLToPath(import.meta.url))),
  }),
);

async function assertFrame(page: Page, frame: number): Promise<void> {
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
    canonicalVideo.subarray(frame * 96 * 64 * 4, (frame + 1) * 96 * 64 * 4),
  );
  for (let index = 0; index < expected.length; index += 4) {
    const blue = expected[index]!;
    expected[index] = expected[index + 2]!;
    expected[index + 2] = blue;
  }
  const pixels = Buffer.from(actual.pixels);
  for (let index = 0; index < pixels.length; index++) {
    if (pixels[index] === expected[index]) continue;
    lastFrameMismatch = {
      frame,
      index,
      actual: pixels[index]!,
      expected: expected[index]!,
    };
    throw new assert.AssertionError({ message: "Frame pixels differ" });
  }
  lastFrameMismatch = null;
}

async function expectFrame(page: Page, frame: number): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          await assertFrame(page, frame);
          return true;
        } catch (error) {
          if (error instanceof assert.AssertionError) return false;
          throw error;
        }
      },
      { timeout: 30000 },
    )
    .toBe(true);
}

let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let step = "launch";
let passed = false;
try {
  const launch = () =>
    _electron.launch({
      executablePath,
      chromiumSandbox: true,
      env: { ...process.env, DISPLAY: ":99", XDG_CONFIG_HOME: configRoot },
      timeout: 30000,
    });
  const installTransport = async (projectId: string | null) => {
    assert.ok(electron);
    await electron.evaluate(
      (_electron, args) => {
        const scope = globalThis as typeof globalThis & {
          nativeProviderFixture?: {
            requests: string[];
            original: Record<string, unknown> | null;
            thoughtReplayChecks: number;
            releaseFinal?: () => void;
          };
        };
        const state: {
          requests: string[];
          original: Record<string, unknown> | null;
          thoughtReplayChecks: number;
          releaseFinal?: () => void;
        } = { requests: [], original: null, thoughtReplayChecks: 0 };
        scope.nativeProviderFixture = state;
        const respond = (value: unknown, status = 200) =>
          new Response(JSON.stringify(value), {
            status,
            headers: { "content-type": "application/json" },
          });
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          const method = init?.method;
          if (
            init?.headers &&
            new Headers(init.headers).get("Authorization") !==
              `Bearer ${args.key}`
          )
            throw new Error("Unexpected test credential");
          if (
            new Headers(init?.headers).get("x-goog-api-client") !==
            (args.provider === "gemini" ? "ai-video-editor/0.0.0" : null)
          )
            throw new Error("Unexpected Gemini client header");
          if (url === args.modelUrl && method === "GET") {
            state.requests.push("models");
            return respond({ data: [{ id: args.model }] });
          }
          if (url !== args.chatUrl || method !== "POST")
            throw new Error("Unexpected outbound request");
          state.requests.push("completion");
          const request = JSON.parse(String(init?.body)) as {
            model: string;
            max_tokens?: number;
            max_completion_tokens?: number;
            messages: Array<{
              role: string;
              content: string;
              tool_calls?: Array<{
                id: string;
                extra_content?: unknown;
              }>;
              tool_call_id?: string;
              name?: string;
            }>;
          };
          if (request.model !== args.model || !args.projectId)
            throw new Error("Unexpected model or project");
          if (
            args.provider === "gemini"
              ? request.max_completion_tokens !== 2048 ||
                request.max_tokens !== undefined
              : request.max_tokens !== 2048 ||
                request.max_completion_tokens !== undefined
          )
            throw new Error("Unexpected provider completion limit");
          const user =
            request.messages.filter((item) => item.role === "user").at(-1)
              ?.content ?? "";
          const toolReplies = request.messages.filter(
            (item) => item.role === "tool",
          );
          if (args.provider === "gemini") {
            const assistants = request.messages.filter(
              (item) => item.role === "assistant" && item.tool_calls,
            );
            if (assistants.length !== toolReplies.length)
              throw new Error("Incomplete Gemini tool-call replay");
            assistants.forEach((assistant, index) => {
              const id = `call-${index + 1}`;
              // Synthetic sentinel only; no real provider signature enters this fixture.
              const expected = {
                google: { thought_signature: `fixture-thought-${index + 1}` },
              };
              const call = assistant.tool_calls?.[0];
              if (
                assistant.tool_calls?.length !== 1 ||
                call?.id !== id ||
                JSON.stringify(call.extra_content) !==
                  JSON.stringify(expected) ||
                toolReplies[index]?.tool_call_id !== id ||
                !toolReplies[index]?.name
              )
                throw new Error("Gemini thought signature was not replayed");
              state.thoughtReplayChecks++;
            });
          }
          if (user.includes("provider failure"))
            return respond({ error: "private-test-provider-detail" }, 503);
          if (user.includes("quota failure"))
            return respond({ error: "private-test-provider-detail" }, 429);
          if (user.includes("authentication failure"))
            return respond({ error: "private-test-provider-detail" }, 401);
          const tool = (name: string, input: unknown) =>
            respond({
              model: args.model,
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: `call-${toolReplies.length + 1}`,
                        type: "function",
                        function: {
                          name,
                          arguments: JSON.stringify(input),
                        },
                        ...(args.provider === "gemini"
                          ? {
                              extra_content: {
                                google: {
                                  thought_signature: `fixture-thought-${toolReplies.length + 1}`,
                                },
                              },
                            }
                          : {}),
                      },
                    ],
                  },
                },
              ],
            });
          if (toolReplies.length === 0)
            return tool("timeline_get_summary", {
              schema_version: "1.0",
              project_id: args.projectId,
            });
          if (toolReplies.length === 1) {
            const current = JSON.parse(toolReplies[0]!.content) as Record<
              string,
              unknown
            >;
            if (user.includes("trim the start")) state.original = current;
            const draft = user.includes("stale") ? state.original : current;
            if (!draft) throw new Error("Missing prior draft");
            const freshness = {
              schema_version: "1.0",
              request_id: user.includes("stale")
                ? "req-native-stale"
                : user.includes("undo")
                  ? "req-native-undo"
                  : "req-native-trim",
              project_id: args.projectId,
              draft_id: draft.draft_id,
              base_revision_id: draft.base_revision_id,
              expected_sequence: draft.draft_sequence,
              expected_timeline_sha256: draft.timeline_sha256,
              reason: "Native synthetic provider fixture",
            };
            if (user.includes("undo"))
              return tool("timeline_undo", {
                ...freshness,
                target_transaction_id: draft.undo_transaction_id,
              });
            const clip = (draft.clips as Array<{ clip_id: string }>)[0]!;
            return tool("cut_trim_edge", {
              ...freshness,
              pass_group_id: "pass-native-fixture",
              clip_id: clip.clip_id,
              edge: "start",
              timeline_position_us: 500000,
            });
          }
          if (toolReplies.length !== 2)
            throw new Error("Unexpected tool chain");
          if (user.includes("trim the start"))
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 120000);
              state.releaseFinal = () => {
                clearTimeout(timer);
                resolve();
              };
            });
          return respond({
            model: args.model,
            choices: [
              {
                finish_reason: "stop",
                message: { content: "The active draft edit was committed." },
              },
            ],
          });
        };
      },
      { key: testKey, projectId, provider, model, modelUrl, chatUrl },
    );
  };
  const connect = async (page: Page) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    if (process.argv.includes("--scale-200")) {
      await page
        .getByRole("button", { name: "Appearance", exact: true })
        .click();
      await page.locator("#interface-scale").selectOption("2");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    }
    await page
      .getByRole("button", { name: "API providers", exact: true })
      .click();
    await page.locator("#api-provider-id").selectOption(provider);
    await page.locator("#api-provider-remember").uncheck({ force: true });
    await page.locator("#api-provider-key").fill(testKey);
    await page.locator("#api-provider-connect").click();
    await expect(page.locator("#api-provider-status")).toHaveText(
      "Key available for this session",
    );
    await page.locator("#api-provider-model").selectOption(model);
    await expect
      .poll(async () => {
        const reply = await page.evaluate(() =>
          window.desktop.getApiProviders(),
        );
        return reply.ok
          ? reply.value.providers.find((item) => item.id === provider)
              ?.selectedModel
          : null;
      })
      .toBe(model);
    await page.keyboard.press("Escape");
  };
  electron = await launch();
  if (process.argv.includes("--compact")) {
    const windowSize = await electron.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1366, 768);
      return BrowserWindow.getAllWindows()[0]?.getSize();
    });
    assert.deepEqual(windowSize, [1366, 768]);
  }
  let page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  await electron.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("External launch disabled");
    };
  });
  step = "import-fixture";
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
  await assertFrame(page, 0);
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
  const projectFolder = join(userData, "project-store", project.id);
  const baselineBytes = await readFile(join(projectFolder, "baseline.json"));
  const baseline: unknown = JSON.parse(baselineBytes.toString("utf8"));
  assertInitialProjectSnapshot(baseline);
  assert.equal(baseline.timeline.duration_us, 1500000);
  const sourceBytes = await readFile(source);
  assert.equal(
    sha256(await readFile(baseline.source.managed_path)),
    sourceHash,
  );
  step = "connect-synthetic-provider";
  await installTransport(project.id);
  await connect(page);
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await page.locator("#assistant-provider").selectOption(provider);
  await expect(page.locator("#api-turn-notice")).toBeVisible();
  await expect(page.locator("#codex-context-notice")).toBeHidden();
  await page
    .getByRole("button", { name: "Open conversation", exact: true })
    .click();
  const request = {
    schema_version: "1.0",
    project_id: project.id,
    provider,
  } as const;
  const thread = async () => {
    const reply = await page.evaluate(
      (value) => window.desktop.getApiThread(value),
      request,
    );
    assert.ok(reply.ok);
    return reply.value;
  };
  await expect.poll(async () => (await thread()).status).toBe("ready");
  assert.deepEqual(
    await electron.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        nativeProviderFixture?: { requests: string[] };
      };
      return scope.nativeProviderFixture?.requests ?? [];
    }),
    ["models"],
  );
  const journal = async (): Promise<DraftTransactionRecord[]> => {
    const folder = join(projectFolder, "draft/journal");
    const names = (await readdir(folder))
      .filter((name) => /^\d{12}\..+\.json$/u.test(name))
      .sort();
    return Promise.all(
      names.map(
        async (name) =>
          JSON.parse(
            await readFile(join(folder, name), "utf8"),
          ) as DraftTransactionRecord,
      ),
    );
  };
  const send = async (text: string) => {
    const beforeCount = (await thread()).messages.filter(
      (item) => item.role === "user",
    ).length;
    await page.locator("#codex-thread-input").fill(text);
    await page.locator("#send-codex-thread").click();
    await expect
      .poll(
        async () =>
          (await thread()).messages.filter((item) => item.role === "user")
            .length,
        { timeout: 30000 },
      )
      .toBe(beforeCount + 1);
    await expect
      .poll(async () => (await thread()).status, { timeout: 70000 })
      .toMatch(/^(ready|failed)$/u);
    return thread();
  };
  step = "trim-live";
  const pendingTrim = send(
    "Please trim the start of the sole clip by half a second.",
  );
  // Observe while this promise is pending without leaving a rejection unhandled.
  void pendingTrim.catch(() => undefined);
  step = "trim-journal";
  await expect
    .poll(async () => (await journal()).length, { timeout: 35000 })
    .toBe(1);
  step = "trim-controls";
  await expect(page.locator("#seek")).toHaveAttribute("max", "500000");
  step = "trim-running";
  assert.equal((await thread()).status, "running");
  step = "trim-native-preview";
  await page.locator("canvas").scrollIntoViewIfNeeded();
  const previewDeadline = Date.now() + 60000;
  let livePreviewObserved = false;
  do {
    const capture = JSON.parse(
      execFileSync(
        "python3",
        [resolve("tests/desktop/guest-input.py"), "capture"],
        { encoding: "utf8", timeout: 30000 },
      ),
    ) as { screenshot: string; display: string; hostInput: boolean };
    assert.equal(capture.display, ":99");
    assert.equal(capture.hostInput, false);
    assert.ok(capture.screenshot.startsWith("/home/node/evidence/visual/"));
    const previewPixels = execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        capture.screenshot,
        "-vf",
        "crop=800:400:200:250,format=rgb24",
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { timeout: 30000 },
    );
    assert.equal(previewPixels.length, 800 * 400 * 3);
    let greenPixels = 0;
    for (let index = 0; index < previewPixels.length; index += 3)
      if (
        previewPixels[index + 1]! > previewPixels[index]! + 50 &&
        previewPixels[index + 1]! > previewPixels[index + 2]! + 50
      )
        greenPixels++;
    livePreviewObserved = greenPixels > 10_000;
    if (livePreviewObserved)
      await copyFile(
        capture.screenshot,
        join(evidence, "trim-live-native.png"),
      );
    else await new Promise((done) => setTimeout(done, 1000));
  } while (!livePreviewObserved && Date.now() < previewDeadline);
  assert.ok(livePreviewObserved, "Trimmed native preview did not appear");
  assert.equal((await thread()).status, "running");
  step = "trim-settle";
  await electron.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      nativeProviderFixture?: { releaseFinal?: () => void };
    };
    if (!scope.nativeProviderFixture?.releaseFinal)
      throw new Error("No pending synthetic response");
    scope.nativeProviderFixture.releaseFinal();
  });
  assert.equal((await pendingTrim).status, "ready");
  await expectFrame(page, 1);
  const first = (await journal())[0]!;
  assert.equal(first.origin, "api_provider");
  assert.equal(first.after.timeline.duration_us, 1000000);
  await page.screenshot({ path: join(evidence, "trim-private.png") });
  if (process.argv.includes("--inspect")) {
    console.log(JSON.stringify({ inspectionReady: true, evidence }));
    const deadline = Date.now() + 300000;
    while (true) {
      try {
        await access(join(evidence, "inspection.done"));
        break;
      } catch {
        await new Promise((done) => setTimeout(done, 1000));
      }
      if (Date.now() > deadline) throw new Error("Inspection timeout");
    }
  }
  step = "stale-rejection";
  const stale = await send("Attempt a stale trim using the old draft head.");
  assert.equal(stale.status, "failed");
  assert.equal(
    stale.message,
    "The edit may have been saved. Reopen the project before sending again.",
  );
  assert.equal((await journal()).length, 1);
  step = "shared-undo";
  const undone = await send("Please undo the latest draft transaction.");
  assert.equal(undone.status, "ready");
  const records = await journal();
  assert.equal(records.length, 2);
  assert.equal(records[1]!.origin, "api_provider");
  assert.equal(records[1]!.kind, "undo");
  assert.equal(records[1]!.target_transaction_id, first.transaction_id);
  await expect(page.locator("#seek")).toHaveAttribute("max", "1000000");
  await page.screenshot({ path: join(evidence, "undo-private.png") });
  try {
    await expectFrame(page, 0);
  } catch (error) {
    await page.screenshot({
      path: join(evidence, "undo-after-wait-private.png"),
    });
    await writeFile(
      join(evidence, "undo-after-wait.json"),
      JSON.stringify(
        await page.evaluate(() => ({
          message: document.querySelector("#preview-message")?.textContent,
          messageHidden: (
            document.querySelector("#preview-message") as HTMLElement
          )?.hidden,
          canvasHidden: (document.querySelector("#frame") as HTMLElement)
            ?.hidden,
          seek: (document.querySelector("#seek") as HTMLInputElement)?.value,
          error: document.querySelector("#error")?.textContent,
        })),
      ),
    );
    throw error;
  }
  step = "provider-failure";
  const failure = await send("Test provider failure without an edit.");
  assert.equal(failure.status, "failed");
  assert.equal(
    failure.message,
    "The provider request failed. Check the connection and try a new turn.",
  );
  assert.equal((await journal()).length, 2);
  assert.ok(!JSON.stringify(failure).includes(testKey));
  assert.ok(!JSON.stringify(failure).includes("private-test-provider-detail"));
  step = "quota-failure";
  const quota = await send("Test quota failure without an edit.");
  assert.equal(quota.status, "failed");
  assert.equal(
    quota.message,
    "The provider rate or quota limit was reached. Check your API account before sending again.",
  );
  assert.equal((await journal()).length, 2);
  assert.ok(!JSON.stringify(quota).includes(testKey));
  assert.ok(!JSON.stringify(quota).includes("private-test-provider-detail"));
  await expect(page.locator("#codex-thread-error")).toHaveText(quota.message!);
  await expect(page.locator("#codex-thread-error")).toBeInViewport({
    ratio: 1,
  });
  const quotaCapture = JSON.parse(
    execFileSync(
      "python3",
      [resolve("tests/desktop/guest-input.py"), "capture"],
      { encoding: "utf8", timeout: 30000 },
    ),
  ) as { screenshot: string; display: string; hostInput: boolean };
  assert.equal(quotaCapture.display, ":99");
  assert.equal(quotaCapture.hostInput, false);
  await copyFile(quotaCapture.screenshot, join(evidence, "quota-native.png"));
  step = "authentication-failure";
  const authentication = await send(
    "Test authentication failure without an edit.",
  );
  assert.equal(authentication.status, "failed");
  assert.equal(
    authentication.message,
    "The provider rejected this API connection. Check the key and account access in Settings before sending again.",
  );
  assert.equal((await journal()).length, 2);
  assert.ok(!JSON.stringify(authentication).includes(testKey));
  assert.ok(
    !JSON.stringify(authentication).includes("private-test-provider-detail"),
  );
  await expect(page.locator("#codex-thread-error")).toHaveText(
    authentication.message!,
  );
  await expect(page.locator("#codex-thread-error")).toBeInViewport({
    ratio: 1,
  });
  const drawerLayout = await page.evaluate(() => {
    const alert = document.querySelector("#codex-thread-error")!;
    const drawer = document.querySelector("#codex-drawer")!;
    const messages = document.querySelector("#codex-thread-messages")!;
    const issue = alert.getBoundingClientRect();
    const panel = drawer.getBoundingClientRect();
    return {
      alertFits: issue.top >= panel.top && issue.bottom <= panel.bottom,
      messageHeight: messages.getBoundingClientRect().height,
    };
  });
  assert.equal(drawerLayout.alertFits, true);
  assert.ok(drawerLayout.messageHeight >= 80);
  const authenticationCapture = JSON.parse(
    execFileSync(
      "python3",
      [resolve("tests/desktop/guest-input.py"), "capture"],
      { encoding: "utf8", timeout: 30000 },
    ),
  ) as { screenshot: string; display: string; hostInput: boolean };
  assert.equal(authenticationCapture.display, ":99");
  assert.equal(authenticationCapture.hostInput, false);
  await copyFile(
    authenticationCapture.screenshot,
    join(evidence, "authentication-native.png"),
  );
  const conversation = await readFile(
    join(userData, "api-provider-threads", `${project.id}.${provider}.json`),
    "utf8",
  );
  assert.ok(!conversation.includes(testKey));
  assert.ok(!conversation.includes("private-test-provider-detail"));
  assert.ok(!conversation.includes("fixture-thought-"));
  const transport = await electron.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      nativeProviderFixture?: {
        requests: string[];
        thoughtReplayChecks: number;
      };
    };
    return (
      scope.nativeProviderFixture ?? {
        requests: [],
        thoughtReplayChecks: 0,
      }
    );
  });
  const requests = transport.requests;
  assert.equal(requests.filter((entry) => entry === "models").length, 1);
  assert.equal(requests.filter((entry) => entry === "completion").length, 11);
  assert.equal(requests.length, 12);
  assert.equal(transport.thoughtReplayChecks, provider === "gemini" ? 7 : 0);
  step = "reopen-project";
  await electron.close();
  electron = await launch();
  page = await electron.firstWindow();
  await page.locator(`#projects [data-project-id="${project.id}"]`).click();
  await expect(page.locator("#frame")).toBeVisible();
  await assertFrame(page, 0);
  await expect(page.locator("#seek")).toHaveAttribute("max", "1000000");
  assert.equal(sha256(await readFile(source)), sourceHash);
  assert.equal(
    sha256(await readFile(baseline.source.managed_path)),
    sourceHash,
  );
  assert.deepEqual(
    await readFile(join(projectFolder, "baseline.json")),
    baselineBytes,
  );
  assert.deepEqual(await readFile(source), sourceBytes);
  passed = true;
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({
      status: "pass",
      scope: "P2-packaged-synthetic-provider-draft",
      provider,
      packagedNativeWindow: true,
      outboundTransport: "main-only deterministic test shim",
      liveCommittedTrim: true,
      staleRejected: true,
      sharedUndo: true,
      sourceAndBaselineUnchanged: true,
      providerFailureRedacted: true,
      geminiSyntheticThoughtReplay:
        provider === "gemini" ? transport.thoughtReplayChecks : null,
      quotaFailureActionable: true,
      authenticationFailureActionable: true,
      projectReopened: true,
      paidTurnStarted: false,
      hostInput: false,
    }),
  );
} catch (error) {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}`
          .replaceAll(testKey, "[redacted]")
          .slice(0, 1600)
      : "Unknown test error";
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({
      status: "fail",
      step,
      privateDiagnostic: detail,
      lastFrameMismatch,
    }),
  );
  console.error(`Native synthetic provider draft test failed at ${step}.`);
  process.exitCode = 1;
} finally {
  await electron?.close();
}
if (passed) console.log(JSON.stringify({ status: "pass", evidence }));

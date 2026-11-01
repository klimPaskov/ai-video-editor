/**
 * Packaged native camera layouts decided by a real, signed-in Claude: a short
 * public speech clip over a screen recording in which something happens in
 * the middle, with a camera recording linked in Edit. The speech is
 * transcribed locally; Claude is asked in the assistant drawer to plan the
 * camera with layout_plan and apply it with layout_set. The layouts must land
 * in the shared draft with Claude's attribution, follow the rules (the first
 * change is the speaker full screen; no change is within six seconds of
 * another), and shared Undo must remove them.
 *
 * node tests/native/camera-claude.test.ts <packaged-executable>
 *   <claude-bin-dir> <profile-config-root>
 *
 * The profile is a private config root whose Claude Code sign-in the user
 * completed themselves (docs/48); no credential is copied.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect as baseExpect } from "playwright/test";
import { openDisclosures } from "./disclosures.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const expect = baseExpect.configure({ timeout: 30_000 });
const [executablePath, claudeBin, profile] = process.argv.slice(2);
assert.ok(
  executablePath && claudeBin && profile,
  "executable, claude bin and profile are required",
);
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-camera-claude-"));

const sampleRevision = "fbe92bd97d48f3ec17779d8d8f2964e1c6bc7634";
const sampleSha256 =
  "aa81c2552465568567e670f3823117e633900d16bd6202346a72f3c8464c74c8";
const response = await fetch(
  `https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/${sampleRevision}/jfk.wav`,
  { redirect: "follow" },
);
assert.ok(response.ok);
const sample = Buffer.from(await response.arrayBuffer());
assert.equal(createHash("sha256").update(sample).digest("hex"), sampleSha256);
const samplePath = join(evidence, "speech.wav");
await writeFile(samplePath, sample, { mode: 0o600 });

async function ffmpeg(args: string[]): Promise<Buffer> {
  return (
    await runProcess({
      executable: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
      timeoutMs: 600_000,
      maxOutputBytes: 512 * 1024 * 1024,
    })
  ).stdout;
}

// The speech runs about 11 s. The screen is quiet for the first and last
// part; in the middle a panel on the left changes.
const screenPath = join(evidence, "Talk.mp4");
await ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "color=c=0x1d2433:s=640x360:r=30:d=40",
  "-i",
  samplePath,
  "-vf",
  "drawbox=x=40:y=60:w=260:h=180:color=0x4f8cff:t=fill:enable='between(t,4,9)*lt(mod(t,0.6),0.3)'",
  "-c:v",
  "libx264",
  "-g",
  "60",
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
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-shortest",
  screenPath,
]);
const cameraPath = join(evidence, "Camera.mp4");
await ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "color=c=0xe0502a:s=1280x720:r=25:d=40",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  cameraPath,
]);

const started = Date.now();
const elapsed = () => Math.round((Date.now() - started) / 1000);
let step = "launch";
const result: Record<string, unknown> = {
  scope: "camera-layouts-by-claude",
  assistant: "Claude (signed in, real model)",
};
const configRoot = resolve(profile);
const electron = await _electron.launch({
  executablePath,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${resolve(claudeBin)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  },
  chromiumSandbox: true,
  timeout: 60_000,
});
try {
  await electron.evaluate(
    ({ dialog }, files) => {
      const state = globalThis as unknown as { __next?: string };
      state.__next = files.screen;
      void files.camera;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [state.__next!],
      });
    },
    { screen: screenPath, camera: cameraPath },
  );
  const page = await electron.firstWindow();
  await expect
    .poll(
      async () => {
        const reply = await page.evaluate(() => window.desktop.getClaude());
        return reply.ok ? reply.value.status : "error";
      },
      { timeout: 120_000 },
    )
    .toBe("signed_in");

  step = "import";
  const before = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(before.ok);
  const known = new Set(before.value.map((view) => view.id));
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 120_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value.find((view) => !known.has(view.id))!;
  const folder = join(
    configRoot,
    "ai-video-editor",
    "project-store",
    project.id,
  );

  step = "transcribe";
  await page.getByRole("button", { name: "Magic Edit", exact: true }).click();
  await openDisclosures(page);
  await page.locator("#transcribe-local").click();
  await expect(page.locator("#transcript-results")).toBeVisible({
    timeout: 15 * 60_000,
  });

  step = "camera";
  await page.getByRole("button", { name: "Refine", exact: true }).click();
  await openDisclosures(page);
  await electron.evaluate(({ dialog }, file) => {
    const state = globalThis as unknown as { __next?: string };
    state.__next = file;
    void dialog;
  }, cameraPath);
  await page.locator("#camera-add").click();
  await expect(page.locator("#camera-status")).toHaveText("Camera in sync");

  step = "claude-plans-the-camera";
  if (!(await page.locator("#codex-thread-input").isVisible()))
    await page.getByRole("button", { name: "Claude", exact: true }).click();
  // The conversation starts only when the user asks for it.
  const open = page.getByRole("button", { name: "Open conversation" });
  if (await open.isVisible()) await open.click();
  await expect(page.locator("#codex-thread-input")).toBeVisible();
  const request = { schema_version: "1.0" as const, project_id: project.id };
  const thread = async () => {
    const reply = await page.evaluate(
      (value) => window.desktop.getClaudeThread(value),
      request,
    );
    assert.ok(reply.ok);
    return reply.value;
  };
  await expect
    .poll(async () => (await thread()).status, { timeout: 60_000 })
    .toBe("ready");
  await page
    .locator("#codex-thread-input")
    .fill(
      "This video has a camera recording. Call layout_plan, look at what it proposes, and apply the changes you agree with using layout_set (at_us in edit time). Apply no other kind of edit. Then reply in one short sentence.",
    );
  await page.locator("#send-codex-thread").click();
  await expect
    .poll(
      async () => {
        const view = await thread();
        if (view.status === "failed")
          throw new Error(`Claude turn failed: ${view.message ?? "unknown"}`);
        return view.status === "ready" && view.messages.length >= 2;
      },
      { timeout: 10 * 60_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  await page.screenshot({ path: join(evidence, "claude-camera.png") });

  step = "result";
  const journal = join(folder, "draft", "journal");
  const records = await Promise.all(
    (await readdir(journal))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(
        async (name) =>
          JSON.parse(await readFile(join(journal, name), "utf8")) as {
            origin: string;
            kind: string;
            status: string;
            operations: Array<{
              operation_type: string;
              layout?: {
                kind: string;
                corner?: string;
                source_us: number;
              } | null;
            }>;
          },
      ),
  );
  const layouts = records
    .filter((record) => record.origin === "claude" && record.kind === "apply")
    .flatMap((record) => record.operations)
    .filter((operation) => operation.operation_type === "layout")
    .map((operation) => operation.layout!);
  assert.ok(layouts.length >= 1, "Claude applied at least one layout");
  assert.ok(
    layouts.every((layout) =>
      ["screen", "camera", "pip"].includes(layout.kind),
    ),
  );
  result.layouts = layouts.map((layout) => [
    Math.round(layout.source_us / 1000) / 1000,
    layout.kind,
    layout.corner ?? null,
  ]);
  const current = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(current.ok);
  const view = current.value.find((item) => item.id === project.id)!;
  assert.ok((view.layouts ?? []).length >= 1);
  // The speaker opens the video: the first change is the camera full screen
  // (or at least starts within the opening seconds).
  const firstChange = [...(view.layouts ?? [])].sort(
    (a, b) => a.source_us - b.source_us,
  )[0]!;
  result.first = [firstChange.kind, firstChange.source_us];

  step = "undo";
  await page.locator("#close-codex").click();
  const applied = records.filter(
    (record) =>
      record.origin === "claude" &&
      record.kind === "apply" &&
      record.operations.some(
        (operation) => operation.operation_type === "layout",
      ),
  ).length;
  for (let index = 0; index < applied; index++)
    await page.locator("#undo-edit").click();
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(() => window.desktop.listProjects());
        return now.ok
          ? (now.value.find((item) => item.id === project.id)?.layouts ?? [])
              .length
          : -1;
      },
      { timeout: 60_000 },
    )
    .toBe(0);
  result.undoRemovedLayouts = true;
  result.step = "complete";
  result.seconds = elapsed();
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ evidence, result }));
} catch (error) {
  await electron
    .windows()[0]
    ?.screenshot({ path: join(evidence, "failure.png") })
    .catch(() => undefined);
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, result }, null, 2),
  );
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}

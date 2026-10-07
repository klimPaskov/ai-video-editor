import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertInitialProjectSnapshot } from "../../packages/domain/src/project.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";

assert.equal(
  process.platform,
  "linux",
  "Native tests require the isolated guest",
);
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "native-h264-preview-"));
const source = join(evidence, "synthetic-h264.mp4");
await runProcess({
  executable: "ffmpeg",
  args: [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=96x64:rate=2:duration=1.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=1.5",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
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
    "-c:a",
    "aac",
    "-ac",
    "2",
    source,
  ],
});
const sourceBytes = await readFile(source);
const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
const env = { ...process.env, XDG_CONFIG_HOME: join(evidence, "config") };
let electron = await _electron.launch({
  executablePath,
  chromiumSandbox: true,
  env,
  timeout: 30_000,
});
async function canvasBytes(page: Page): Promise<Buffer> {
  const result = await page.locator("canvas").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return {
      width: canvas.width,
      height: canvas.height,
      bytes: Array.from(
        canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height)
          .data,
      ),
    };
  });
  assert.equal(result.width, 96);
  assert.equal(result.height, 64);
  return Buffer.from(result.bytes);
}
try {
  let page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  await electron.evaluate(({ dialog }, sourcePath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [sourcePath],
    });
  }, source);
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 30_000 });
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const projects = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(projects.ok);
  assert.equal(projects.value.length, 1);
  const project = projects.value[0]!;
  const baselineBytes = await readFile(
    join(userData, "project-store", project.id, "baseline.json"),
  );
  const baseline: unknown = JSON.parse(baselineBytes.toString("utf8"));
  assertInitialProjectSnapshot(baseline);
  assert.equal(baseline.timeline.duration_us, 1_500_000);
  assert.equal(baseline.source.sha256, sourceHash);
  assert.deepEqual(await readFile(baseline.source.managed_path), sourceBytes);
  const library = new MediaLibrary(join(userData, "media-library"));
  const expected = async (timeUs: number) =>
    Buffer.from(
      (await library.frame(baseline.source.source_id, timeUs)).rgbaBase64,
      "base64",
    );
  await expect(page.locator("#time")).toHaveText("0:00.000");
  assert.deepEqual(await canvasBytes(page), await expected(0));
  await page.locator("#seek").evaluate((node) => {
    const input = node as HTMLInputElement;
    input.value = "250000";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#time")).toHaveText("0:00.250");
  await expect
    .poll(async () => (await canvasBytes(page)).equals(await expected(0)))
    .toBe(true);
  await page.locator("#seek").evaluate((node) => {
    const input = node as HTMLInputElement;
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#time")).toHaveText("0:00.000");
  await page.getByRole("button", { name: "Next frame", exact: true }).click();
  await expect(page.locator("#time")).toHaveText("0:00.500");
  assert.deepEqual(await canvasBytes(page), await expected(500_000));
  await page.screenshot({ path: join(evidence, "native-h264-frame.png") });
  await electron.close();
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30_000,
  });
  page = await electron.firstWindow();
  await page.locator(`#projects [data-project-id="${project.id}"]`).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 30_000 });
  assert.deepEqual(await canvasBytes(page), await expected(0));
  await page.getByRole("button", { name: "Next frame", exact: true }).click();
  await page.getByRole("button", { name: "Next frame", exact: true }).click();
  await expect(page.locator("#time")).toHaveText("0:01.000");
  assert.deepEqual(await canvasBytes(page), await expected(1_000_000));
  assert.deepEqual(await readFile(source), sourceBytes);
  assert.deepEqual(await readFile(baseline.source.managed_path), sourceBytes);
  assert.deepEqual(
    await readFile(
      join(userData, "project-store", project.id, "baseline.json"),
    ),
    baselineBytes,
  );
  await page.screenshot({ path: join(evidence, "native-h264-reopened.png") });
  if (process.argv.includes("--inspect")) {
    await writeFile(join(evidence, "inspection.ready"), "ready\n");
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (
        await access(join(evidence, "inspection.done")).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        scope: "P2-H264-display-only-preview",
        packaged: true,
        nativeWindow: true,
        sourceSha256: sourceHash,
        dimensions: [96, 64],
        frameTimesUs: [0, 500_000, 1_000_000],
        exactCanvasToDecodedDisplayFrame: true,
        sourceAndBaselineUnchanged: true,
        reopen: true,
        audioPlaybackTested: false,
        masterExportTested: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ evidence, result: "passed" }));
} finally {
  await electron.close();
}

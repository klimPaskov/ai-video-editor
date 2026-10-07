/**
 * Packaged native zoom: mark a range, add a zoom by clicking its target in
 * the preview, change its strength, undo and redo it, export a verified
 * lossless master in which only the zoomed frames differ, then remove it.
 *
 * node tests/native/zoom.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { rawFrameBytes } from "../../packages/media-engine/src/render.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-zoom-"));
const configRoot = join(evidence, "config");
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

async function ffmpeg(args: string[]): Promise<Buffer> {
  return (
    await runProcess({
      executable: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
      timeoutMs: 300_000,
      maxOutputBytes: 1024 * 1024 * 1024,
    })
  ).stdout;
}

const sourcePath = join(evidence, "Walkthrough.mp4");
await ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=30:duration=4",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=330:sample_rate=48000:duration=4",
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
  sourcePath,
]);
const sourceHash = sha(await readFile(sourcePath));
const master = join(evidence, "Walkthrough master.mkv");

let step = "launch";
const result: Record<string, unknown> = { scope: "P7-02-native-zoom" };
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
  chromiumSandbox: true,
  timeout: 30_000,
});

async function seekTo(page: Page, us: number): Promise<void> {
  await page.evaluate((value) => {
    const seek = document.querySelector<HTMLInputElement>("#seek")!;
    seek.value = String(value);
    seek.dispatchEvent(new Event("input"));
  }, us);
  await expect(page.locator(".preview")).not.toHaveClass(/loading/u);
  await page.waitForTimeout(300);
}

async function zooms(page: Page) {
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  return listed.value[0]!.zooms ?? [];
}

try {
  await electron.evaluate(
    ({ dialog }, value) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [value.source],
      });
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: value.master,
      });
    },
    { source: sourcePath, master },
  );
  const page = await electron.firstWindow();
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible();

  step = "mark-range";
  await seekTo(page, 1_000_000);
  await page.locator("#mark-in").click();
  await seekTo(page, 2_500_000);
  await page.locator("#mark-out").click();
  const add = page.getByRole("button", { name: "Zoom the marked range" });
  await expect(add).toBeEnabled();

  step = "pick-cancel";
  await add.click();
  await expect(page.locator("#zoom-hint")).toBeVisible();
  await expect(page.locator(".preview")).toHaveClass(/picking/u);
  await page.keyboard.press("Escape");
  await expect(page.locator("#zoom-hint")).toBeHidden();
  assert.equal((await zooms(page)).length, 0);

  step = "pick-target";
  await add.click();
  await expect(page.locator("#zoom-hint")).toBeVisible();
  // Click three quarters across and a quarter down the displayed picture.
  const target = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#frame")!;
    const box = canvas.getBoundingClientRect();
    const scale = Math.min(
      box.width / canvas.width,
      box.height / canvas.height,
    );
    const width = canvas.width * scale,
      height = canvas.height * scale;
    return {
      x: box.left + (box.width - width) / 2 + width * 0.75,
      y: box.top + (box.height - height) / 2 + height * 0.25,
    };
  });
  await page.mouse.click(target.x, target.y);
  await expect(page.locator("#zoom-hint")).toBeHidden();
  await expect(page.locator(".timeline-zoom")).toHaveCount(1, {
    timeout: 30_000,
  });
  const added = await zooms(page);
  assert.equal(added.length, 1);
  assert.ok(Math.abs(added[0]!.center_x - 0.75) < 0.02, "target x");
  assert.ok(Math.abs(added[0]!.center_y - 0.25) < 0.02, "target y");
  assert.equal(added[0]!.scale, 2);
  assert.equal(added[0]!.source_start_us, 1_000_000);
  assert.equal(added[0]!.source_end_us, 2_500_000);
  // Marks are consumed by the zoom.
  await expect(page.locator("#cut-selection")).toBeHidden();

  step = "preview";
  await seekTo(page, 1_800_000);
  await expect(page.locator("#zoom-controls")).toBeVisible();
  await expect(page.locator("#zoom-scale")).toHaveValue("2");
  const transform = await page
    .locator("#frame")
    .evaluate((canvas) => canvas.style.transform);
  assert.match(transform, /^matrix\(2, 0, 0, 2,/u);
  await page.screenshot({ path: join(evidence, "zoom-preview.png") });

  step = "strength";
  await page.locator("#zoom-scale").selectOption("3");
  await expect
    .poll(async () => (await zooms(page))[0]?.scale, { timeout: 30_000 })
    .toBe(3);
  const changed = (await zooms(page))[0]!;
  assert.equal(changed.zoom_id, added[0]!.zoom_id);
  assert.equal(changed.center_x, added[0]!.center_x);

  step = "undo-redo";
  await page.locator("#undo-edit").click();
  await expect
    .poll(async () => (await zooms(page))[0]?.scale, { timeout: 30_000 })
    .toBe(2);
  await page.locator("#redo-edit").click();
  await expect
    .poll(async () => (await zooms(page))[0]?.scale, { timeout: 30_000 })
    .toBe(3);

  step = "export";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator("#export-actions")).toBeVisible();
  await expect(page.locator("#export-profile")).toHaveValue("lossless_master");
  await page.locator("#export-start").click();
  await expect(page.locator("#export-done")).toBeVisible({ timeout: 300_000 });
  await expect(page.locator("#export-result")).toContainText(
    "verified lossless",
  );
  const decode = (file: string) =>
    ffmpeg([
      "-i",
      file,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "rawvideo",
      "-pix_fmt",
      "yuv420p",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
  const original = await decode(sourcePath);
  const exported = await decode(master);
  assert.equal(exported.length, original.length);
  const frameBytes = rawFrameBytes("yuv420p", 320, 180);
  const differing: number[] = [];
  for (let frame = 0; frame < original.length / frameBytes; frame++) {
    const range = [frame * frameBytes, (frame + 1) * frameBytes] as const;
    if (!exported.subarray(...range).equals(original.subarray(...range)))
      differing.push(frame);
  }
  // Output 1.0–2.5 s is frames 30–74; frame 30 is still at magnification 1.
  assert.deepEqual(
    differing,
    Array.from({ length: 44 }, (_, index) => index + 31),
  );
  result.export = {
    frames: original.length / frameBytes,
    zoomedFrames: differing.length,
    othersBitIdentical: true,
  };

  step = "remove";
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible();
  await seekTo(page, 1_800_000);
  await expect(page.locator("#zoom-controls")).toBeVisible();
  await page.locator("#zoom-remove").click();
  await expect(page.locator(".timeline-zoom")).toHaveCount(0, {
    timeout: 30_000,
  });
  assert.equal((await zooms(page)).length, 0);
  await expect(page.locator("#zoom-controls")).toBeHidden();
  assert.equal(
    await page.locator("#frame").evaluate((canvas) => canvas.style.transform),
    "",
  );

  step = "unchanged-source";
  assert.equal(sha(await readFile(sourcePath)), sourceHash);
  result.step = "complete";
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ evidence, result }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, result }, null, 2),
  );
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}

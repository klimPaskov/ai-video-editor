/**
 * Packaged native speed: speed up a marked range to 3×, play it, return the
 * part under the playhead to normal speed, undo, and export a verified
 * lossless master that keeps every third frame of the sped-up part.
 *
 * node tests/native/speed.test.ts <packaged-executable>
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
const evidence = await mkdtemp(join(evidenceRoot, "native-speed-"));
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

const sourcePath = join(evidence, "Typing.mp4");
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
const master = join(evidence, "Typing master.mkv");

let step = "launch";
const result: Record<string, unknown> = { scope: "P7-05-native-speed" };
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

async function clips(page: Page) {
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  return listed.value[0]!.clips ?? [];
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
  await expect(page.locator("#speed")).toHaveValue("1");

  step = "speed-up";
  await seekTo(page, 1_000_000);
  await page.keyboard.press("i");
  await seekTo(page, 2_500_000);
  await page.keyboard.press("o");
  await page.locator("#speed").selectOption("3");
  await expect(page.locator("#duration")).toHaveText(" / 0:03.000", {
    timeout: 30_000,
  });
  await expect(page.locator(".timeline-speed")).toHaveText("3×");
  await expect(page.locator("#cut-selection")).toBeHidden();
  const sped = await clips(page);
  assert.deepEqual(
    sped.map((clip) => [
      clip.sourceStartUs,
      clip.sourceEndUs,
      clip.timelineStartUs,
      clip.timelineEndUs,
      clip.speed ?? 1,
    ]),
    [
      [0, 1_000_000, 0, 1_000_000, 1],
      [1_000_000, 2_500_000, 1_000_000, 1_500_000, 3],
      [2_500_000, 4_000_000, 1_500_000, 3_000_000, 1],
    ],
  );
  await page.screenshot({ path: join(evidence, "speed.png") });

  step = "playback";
  await seekTo(page, 1_100_000);
  await expect(page.locator("#speed")).toHaveValue("3");
  await page.locator("#play").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document.querySelector<HTMLVideoElement>(
              ".preview video:not([hidden])",
            )?.playbackRate ?? 0,
        ),
      { timeout: 15_000 },
    )
    .toBe(3);
  await page.locator("#play").click();

  step = "normal-speed";
  await seekTo(page, 1_200_000);
  await page.locator("#speed").selectOption("1");
  await expect(page.locator("#duration")).toHaveText(" / 0:04.000", {
    timeout: 30_000,
  });
  await expect(page.locator(".timeline-speed")).toHaveCount(0);
  await page.locator("#seek").focus();
  await page.keyboard.press("Control+z");
  await expect(page.locator("#duration")).toHaveText(" / 0:03.000", {
    timeout: 30_000,
  });

  step = "export";
  await expect(page.locator("#edit-actions")).toHaveAttribute(
    "aria-busy",
    "false",
  );
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
  const frameBytes = rawFrameBytes("yuv420p", 320, 180);
  const frame = (data: Buffer, index: number) =>
    data.subarray(index * frameBytes, (index + 1) * frameBytes);
  assert.equal(exported.length, 90 * frameBytes);
  // Output frame k shows source frame: k (0–29), 30 + 3(k−30) (30–44),
  // then 75 onward.
  for (let index = 0; index < 90; index++) {
    const sourceIndex =
      index < 30 ? index : index < 45 ? 30 + (index - 30) * 3 : index + 30;
    assert.ok(
      frame(exported, index).equals(frame(original, sourceIndex)),
      `frame ${index}`,
    );
  }
  const audio = await ffmpeg([
    "-i",
    master,
    "-map",
    "0:a:0",
    "-c:a",
    "pcm_f32le",
    "-f",
    "f32le",
    "pipe:1",
  ]);
  // 1 s + 0.5 s (1.5 s at 3×) + 1.5 s of stereo 48 kHz float samples.
  assert.equal(audio.length, 144_000 * 2 * 4);
  result.export = { frames: 90, framesMatchSource: true, audioSeconds: 3 };

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

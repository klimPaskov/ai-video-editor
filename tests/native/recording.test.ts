/**
 * Packaged native recording with labelled synthetic devices: a test pattern
 * instead of a screen and a test tone instead of a microphone (no real
 * hardware is claimed). The take is recorded, paused, resumed and stopped,
 * then opens as a project whose preview frame equals an independent decode
 * of the managed lossless file.
 *
 * node tests/native/recording.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-recording-"));
const result: Record<string, unknown> = {
  scope: "P4-native-recording-synthetic-devices",
  realHardware: false,
};
let step = "launch";
const electron = await _electron.launch({
  executablePath,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: join(evidence, "config"),
    AI_VIDEO_EDITOR_TEST_CAPTURE: "1",
  },
  chromiumSandbox: true,
  timeout: 30_000,
});
try {
  const page = await electron.firstWindow();
  step = "setup";
  await page
    .getByRole("button", { name: "New recording", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "New recording" });
  await expect(dialog).toBeVisible();
  const display = dialog.getByRole("radio", { name: /Test pattern/ });
  await expect(display).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#record-microphone option")).toHaveText([
    "Test tone (not a microphone)",
    "No microphone",
  ]);
  await page.screenshot({ path: join(evidence, "record-setup.png") });

  step = "record";
  await page.locator("#record-start").click();
  await expect(page.locator("#record-countdown")).toBeVisible();
  await expect(page.locator("#record-pause")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#record-elapsed")).toHaveText("0:01", {
    timeout: 10_000,
  });
  await expect(page.locator("#record-health")).toHaveText("Recording");
  // A running take cannot be dismissed with Escape.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: join(evidence, "record-live.png") });
  await page.locator("#record-pause").click();
  await expect(page.locator("#record-pause")).toHaveText("Resume");
  await expect(page.locator("#record-health")).toHaveText("Paused");
  const pausedAt = await page.locator("#record-elapsed").textContent();
  await page.waitForTimeout(1200);
  await expect(page.locator("#record-elapsed")).toHaveText(pausedAt!);
  await page.locator("#record-pause").click();
  await expect(page.locator("#record-pause")).toHaveText("Pause");
  await expect(page.locator("#record-elapsed")).toHaveText("0:02", {
    timeout: 10_000,
  });

  step = "stop";
  await page.locator("#record-stop").click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#preview-message")).toBeHidden();
  await page.screenshot({ path: join(evidence, "record-project.png") });

  step = "verify";
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 1);
  const project = listed.value[0]!;
  assert.match(
    project.name,
    /^Recording \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.mkv$/u,
  );
  assert.equal(project.source.width, 320);
  assert.equal(project.source.height, 180);
  assert.equal(project.source.frameRate, 30);
  assert.equal(project.source.previewAvailable, true);
  const durationUs = project.timeline.durationUs;
  assert.ok(
    durationUs >= 2_000_000 && durationUs <= 4_000_000,
    `duration ${durationUs}`,
  );
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const managed = join(
    userData,
    "media-library",
    "assets",
    `${project.source.id}.media`,
  );
  const probe = JSON.parse(
    (
      await runProcess({
        executable: "ffprobe",
        args: ["-v", "error", "-show_streams", "-of", "json", managed],
      })
    ).stdout.toString(),
  ) as { streams: Record<string, unknown>[] };
  const video = probe.streams.find((stream) => stream.codec_type === "video")!;
  const audio = probe.streams.find((stream) => stream.codec_type === "audio")!;
  assert.equal(video.codec_name, "ffv1");
  assert.equal(video.pix_fmt, "bgr0");
  assert.equal(audio.codec_name, "pcm_s16le");
  assert.equal(Number(audio.sample_rate), 48_000);
  const bgr0 = (
    await runProcess({
      executable: "ffmpeg",
      args: [
        "-v",
        "error",
        "-i",
        managed,
        "-frames:v",
        "1",
        "-pix_fmt",
        "bgr0",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      maxOutputBytes: 320 * 180 * 4 + 1024,
    })
  ).stdout;
  // Decoded without colour conversion; the preview must show B, G, R as-is.
  const expected = Buffer.alloc(bgr0.length);
  for (let i = 0; i < bgr0.length; i += 4)
    expected.set([bgr0[i + 2]!, bgr0[i + 1]!, bgr0[i]!, 255], i);
  const actual = await page.locator("#frame").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return Array.from(
      canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height)
        .data,
    );
  });
  assert.ok(Buffer.from(actual).equals(expected), "preview frame differs");
  // Only the session record remains once the library holds the verified copy.
  const takes = await readdir(join(userData, "recordings"));
  assert.equal(takes.length, 1);
  assert.deepEqual(await readdir(join(userData, "recordings", takes[0]!)), [
    "session.json",
  ]);
  result.durationUs = durationUs;
  result.previewEqualsDecode = true;

  step = "playback";
  // FFV1/PCM is not playable in Chromium; Play waits for the playback copy.
  await expect(page.locator("#play")).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator("#playback-status")).toBeHidden();
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Pause");
  const playing = page.locator("video.preview-video:visible");
  await expect(playing).toHaveCount(1, { timeout: 10_000 });
  await expect
    .poll(
      () => playing.evaluate((node) => (node as HTMLVideoElement).currentTime),
      {
        timeout: 10_000,
      },
    )
    .toBeGreaterThan(0.5);
  const served = await playing.evaluate(
    (node) => (node as HTMLVideoElement).src,
  );
  assert.match(served, /\/media\//u);
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play", {
    timeout: 15_000,
  });
  await expect(page.locator("#error")).toBeHidden();
  result.playedThroughCopy = true;
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

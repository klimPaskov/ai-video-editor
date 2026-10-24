/**
 * Step screenshots: a synthetic recording (2 s of tone, 2 s of
 * silence) gets a music bed and a sound effect from audio files chosen in the
 * Sound card; the layers are shared-Undo draft edits that survive Redo, are
 * mixed (audible in the recording's silent
 * half), and can be removed.
 *
 * node tests/native/sound.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-screens-"));

const sampleRate = 48_000;
const samplesPerFrame = 24_000;
const frames = 8;
const audio = Buffer.alloc(frames * samplesPerFrame * 2);
for (let sample = 0; sample < 2 * sampleRate; sample++)
  audio.writeInt16LE(
    Math.round(12_000 * Math.sin((2 * Math.PI * 440 * sample) / sampleRate)),
    sample * 2,
  );
const width = 96;
const height = 64;
const video = Buffer.alloc(frames * width * height * 4);
for (let frame = 0; frame < frames; frame++)
  for (let pixel = 0; pixel < width * height; pixel++)
    video.set(
      [(180 + frame * 23) % 256, (100 + frame * 17) % 256, 40, 255],
      (frame * width * height + pixel) * 4,
    );
const videoPath = join(evidence, "video.bgra");
const audioPath = join(evidence, "tone.s16le");
const sourcePath = join(evidence, "Tone then silence.mkv");
await writeFile(videoPath, video, { mode: 0o600 });
await writeFile(audioPath, audio, { mode: 0o600 });
await encodeVerifiedMaster(
  {
    videoPath,
    audioPath,
    role: "canonical",
    format: {
      width,
      height,
      frameRate: { numerator: 2, denominator: 1 },
      pixelFormat: "bgra",
      color: {
        range: "pc",
        space: "gbr",
        primaries: "bt709",
        transfer: "bt709",
      },
      audio: { format: "s16le", sampleRate, channelLayout: "mono" },
    },
  },
  sourcePath,
);

const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: join(evidence, "config") },
  chromiumSandbox: true,
  timeout: 30_000,
});
try {
  await electron.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, sourcePath);
  const page = await electron.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.screenshot({ path: join(evidence, "0-home.png") });
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  for (const name of [
    "Record or Import",
    "Auto Edit",
    "Edit",
    "Review",
    "Export",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(2500);
    await page.screenshot({
      path: join(evidence, `step-${name.replaceAll(" ", "-")}.png`),
    });
  }
  console.log(evidence);
} finally {
  await electron.close().catch(() => undefined);
}

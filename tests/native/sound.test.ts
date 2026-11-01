/**
 * Packaged native sound layers: a synthetic recording (2 s of tone, 2 s of
 * silence) gets a music bed and a sound effect from audio files chosen in the
 * Sound card; the layers are shared-Undo draft edits that survive Redo, are
 * mixed into a verified lossless master (audible in the recording's silent
 * half), and can be removed.
 *
 * node tests/native/sound.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { openDisclosures } from "./disclosures.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-sound-"));

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
const musicPath = join(evidence, "Bed.wav");
const effectPath = join(evidence, "Hit.wav");
for (const [file, seconds, frequency] of [
  [musicPath, 3, 1000],
  [effectPath, 0.5, 2000],
] as const)
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=44100:duration=${seconds}`,
      "-c:a",
      "pcm_s16le",
      file,
    ],
  });

let step = "launch";
const result: Record<string, unknown> = { scope: "sound-layers-native" };
const outputs = join(evidence, "outputs");
await mkdir(outputs, { recursive: true });
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: join(evidence, "config") },
  chromiumSandbox: true,
  timeout: 30_000,
});
try {
  const master = join(outputs, "Tone master.mkv");
  const choose = (file: string) =>
    electron.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [chosen],
      });
    }, file);
  await choose(sourcePath);
  await electron.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, master);
  const page = await electron.firstWindow();
  await openDisclosures(page);
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const projectId = listed.value[0]!.id;
  const sounds = async () => {
    const reply = await page.evaluate(
      (id) =>
        window.desktop.getSounds({ schema_version: "1.0", project_id: id }),
      projectId,
    );
    assert.ok(reply.ok);
    return reply.value.layers;
  };
  await page.getByRole("button", { name: "Magic Edit", exact: true }).click();
  await expect(page.locator("#sound-card")).toBeVisible();
  assert.deepEqual(await sounds(), []);

  step = "add-music";
  await choose(musicPath);
  await page.locator("#sound-add-music").click();
  await expect(page.locator(".sound-row")).toHaveCount(1);
  let layers = await sounds();
  assert.equal(layers[0]!.kind, "music");
  assert.equal(layers[0]!.name, "Bed");
  assert.equal(layers[0]!.gain_db, -18);
  assert.equal(layers[0]!.duck_db, 12);
  assert.equal(layers[0]!.loop, true);
  assert.deepEqual(layers[0]!.timeline_range, {
    start_us: 0,
    end_us: 4_000_000,
  });
  await page.screenshot({ path: join(evidence, "sound-music.png") });

  step = "volume-undo-redo";
  await page.locator(".sound-row input[type=range]").evaluate((input) => {
    (input as HTMLInputElement).value = "-12";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(async () => (await sounds())[0]!.gain_db).toBe(-12);
  await page.getByRole("button", { name: "Refine", exact: true }).click();
  await page.locator("#undo-edit").click();
  await expect.poll(async () => (await sounds())[0]!.gain_db).toBe(-18);
  await page.locator("#undo-edit").click();
  await expect.poll(async () => (await sounds()).length).toBe(0);
  await expect(page.locator(".sound-row")).toHaveCount(0);
  await page.locator("#redo-edit").click();
  await page.locator("#redo-edit").click();
  await expect.poll(async () => (await sounds())[0]?.gain_db).toBe(-12);
  await page.getByRole("button", { name: "Magic Edit", exact: true }).click();
  // Changing step closes the disclosures again.
  await openDisclosures(page);
  await expect(page.locator(".sound-row")).toHaveCount(1);
  // Back to the default level for the audio check below.
  await page.locator(".sound-row input[type=range]").evaluate((input) => {
    (input as HTMLInputElement).value = "-18";
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect.poll(async () => (await sounds())[0]!.gain_db).toBe(-18);

  step = "add-effect";
  await page.locator("#seek").fill("2000000");
  await expect(page.locator("#preview-message")).toBeHidden({
    timeout: 30_000,
  });
  await choose(effectPath);
  await page.locator("#sound-add-effect").click();
  await expect(page.locator(".sound-row")).toHaveCount(2);
  layers = await sounds();
  const effect = layers.find((layer) => layer.kind === "effect")!;
  assert.equal(effect.gain_db, -6);
  assert.equal(effect.duck_db, 0);
  assert.deepEqual(effect.timeline_range, {
    start_us: 2_000_000,
    end_us: 2_500_000,
  });

  step = "export";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.locator("#export-start").click();
  await expect(page.locator("#export-done")).toBeVisible({ timeout: 300_000 });
  await expect(page.locator("#export-result")).toContainText(
    "verified lossless",
  );
  // The recording is silent after 2 s: the music bed (-18 dB, fading out over
  // the last 2 s) is audible after the effect has finished, where the plain
  // edit has none.
  const level = async (from: number, length: number) => {
    const probe = await runProcess({
      executable: "ffmpeg",
      args: [
        "-hide_banner",
        "-nostdin",
        "-ss",
        String(from),
        "-t",
        String(length),
        "-i",
        master,
        "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      maxOutputBytes: 1024 * 1024,
    });
    const match = /mean_volume: (-?[\d.]+) dB/u.exec(
      `${probe.stderr}${probe.stdout}`,
    );
    assert.ok(match, "no volume measurement");
    return Number(match[1]);
  };
  const tail = await level(2.6, 0.4);
  const middle = await level(2.05, 0.4);
  assert.ok(tail > -60, `music tail ${tail} dB`);
  assert.ok(tail < -25, `music tail ${tail} dB`);
  assert.ok(middle > tail, `effect ${middle} dB over music ${tail} dB`);
  result.musicTailDb = tail;
  result.effectDb = middle;

  step = "remove";
  await page.getByRole("button", { name: "Magic Edit", exact: true }).click();
  await openDisclosures(page);
  await page.getByRole("button", { name: /^Remove Hit$/u }).click();
  await expect(page.locator(".sound-row")).toHaveCount(1);
  await page.getByRole("button", { name: /^Remove Bed$/u }).click();
  await expect(page.locator(".sound-row")).toHaveCount(0);
  assert.deepEqual(await sounds(), []);
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

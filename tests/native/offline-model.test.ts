/**
 * Offline first use: with the speech model's host unreachable (the runner
 * points huggingface.co at this machine through /etc/hosts for the run),
 * Transcribe locally explains in plain words that the model could not be
 * downloaded, leaves the button usable and never hangs or raises a page error.
 *
 * The block is set and removed around the run by whoever launches it (as root
 * in the guest: append "127.0.0.1 huggingface.co" to /etc/hosts, run, then
 * remove that line); the test refuses to run unless the host really is
 * unreachable.
 *
 * node tests/native/offline-model.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect as baseExpect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { openStep } from "./disclosures.ts";

await assertNativeTestEnvironment();
const expect = baseExpect.configure({ timeout: 30_000 });
assert.equal(
  (await lookup("huggingface.co")).address,
  "127.0.0.1",
  "the model host must be blocked for this test",
);
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-offline-"));

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

const configRoot = join(evidence, "config");
const problems: string[] = [];
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
  chromiumSandbox: true,
  timeout: 30_000,
});
let step = "start";
try {
  await electron.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, sourcePath);
  const page = await electron.firstWindow();
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await expect(page.locator("#import")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 120_000 });
  step = "transcribe-offline";
  await openStep(page, "Magic Edit");
  await page.locator("#auto-edit-more > summary").click();
  await page.getByRole("button", { name: "Transcribe locally" }).click();
  await expect(page.locator("#transcription-error")).toBeVisible({
    timeout: 180_000,
  });
  const message = await page.locator("#transcription-error").textContent();
  assert.ok(message && message.trim().length > 8, `a message (${message})`);
  assert.ok(
    !/\sat \S+:\d+|Error:|ENOENT|ECONNREFUSED|undefined|\[object/u.test(
      message,
    ),
    message,
  );
  await expect(
    page.getByRole("button", { name: "Transcribe locally" }),
  ).toBeEnabled();
  await page.screenshot({ path: join(evidence, "offline-model.png") });
  assert.deepEqual(problems, [], "no uncaught page errors");
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({ step: "complete", message }),
  );
  console.log(JSON.stringify({ evidence, message }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, problems }, null, 2),
  );
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}

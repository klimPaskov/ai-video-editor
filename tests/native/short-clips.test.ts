/**
 * Packaged native short clips: a public 60 s talk excerpt is transcribed
 * locally, Export finds self-contained moments in it, one is previewed, one
 * is exported as a vertical MP4 with burned-in captions, and one is
 * discarded.
 *
 * node tests/native/short-clips.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-short-clips-"));
const sampleRevision = "fbe92bd97d48f3ec17779d8d8f2964e1c6bc7634";
const sampleSha256 =
  "c118a98686f286284bf8d69a9049ef48e3031338609d9db970fb00ec7ab04948";
const response = await fetch(
  `https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/${sampleRevision}/ted_60_16k.wav`,
  { redirect: "follow" },
);
assert.ok(response.ok);
const sample = Buffer.from(await response.arrayBuffer());
assert.equal(createHash("sha256").update(sample).digest("hex"), sampleSha256);
const samplePath = join(evidence, "public-speech.wav");
await writeFile(samplePath, sample, { mode: 0o600 });
const speech = (
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-i",
      samplePath,
      "-ar",
      "48000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    ],
    maxOutputBytes: 64 * 1024 * 1024,
  })
).stdout;
// The talk excerpt alone; whole 0.5 s frames.
let audio = Buffer.from(speech);
const samplesPerFrame = 24_000;
const frames = Math.ceil(audio.length / 2 / samplesPerFrame);
audio = Buffer.concat([
  audio,
  Buffer.alloc(frames * samplesPerFrame * 2 - audio.length),
]);
const width = 96;
const height = 64;
const video = Buffer.alloc(frames * width * height * 4);
for (let frame = 0; frame < frames; frame++)
  for (let pixel = 0; pixel < width * height; pixel++)
    video.set(
      [
        (180 + frame * 23) % 256,
        (100 + frame * 17) % 256,
        (40 + frame * 11) % 256,
        255,
      ],
      (frame * width * height + pixel) * 4,
    );
const videoPath = join(evidence, "video.bgra");
const audioPath = join(evidence, "speech.s16le");
const sourcePath = join(evidence, "Talk.mkv");
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
      audio: { format: "s16le", sampleRate: 48_000, channelLayout: "mono" },
    },
  },
  sourcePath,
);

let step = "launch";
const result: Record<string, unknown> = { scope: "P10-native-short-clips" };
const configRoot = join(evidence, "config");
const outputs = join(evidence, "outputs");
await mkdir(outputs, { recursive: true });
const clipPath = join(outputs, "Vertical clip.mp4");
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
  chromiumSandbox: true,
  timeout: 30_000,
});
try {
  await electron.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [files.source],
      });
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: files.clip,
      });
    },
    { source: sourcePath, clip: clipPath },
  );
  const page = await electron.firstWindow();
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });

  step = "transcribe";
  await page.getByRole("button", { name: "Auto Edit", exact: true }).click();
  await page
    .getByRole("button", { name: "Transcribe locally", exact: true })
    .click();
  await expect(page.locator("#transcription-status")).toContainText(
    "Transcript complete",
    { timeout: 20 * 60_000 },
  );

  step = "find";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator("#shorts-find")).toBeEnabled();
  await page.locator("#shorts-find").click();
  const items = page.locator("#shorts-list .short-item");
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  const found = await items.count();
  const titles = await page
    .locator("#shorts-list .short-head strong")
    .allTextContents();
  const times = await page
    .locator("#shorts-list .short-time")
    .allTextContents();
  result.found = found;
  result.titles = titles;
  result.times = times;
  await page.screenshot({ path: join(evidence, "shorts-found.png") });

  step = "preview";
  const first = items.first();
  const firstTime = (await first.locator(".short-time").textContent())!;
  const [startText] = firstTime.split("–");
  const [minutes, seconds] = startText!.split(":").map(Number);
  await first.getByRole("button", { name: /^Preview / }).click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Pause", {
    timeout: 20_000,
  });
  const playingAt = Number(await page.locator("#seek").inputValue());
  assert.ok(
    Math.abs(playingAt - (minutes! * 60 + seconds!) * 1_000_000) < 3_000_000,
    `preview started at ${playingAt}`,
  );
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play");

  step = "export";
  await page.locator("#shorts-format").selectOption("vertical");
  await page.locator("#shorts-framing").selectOption("fit");
  await expect(page.locator("#shorts-captions")).toBeChecked();
  await first.getByRole("button", { name: /^Export / }).click();
  await expect(first.locator(".short-status")).toHaveText(
    "Saved Vertical clip.mp4",
    { timeout: 300_000 },
  );
  const probe = JSON.parse(
    (
      await runProcess({
        executable: "ffprobe",
        args: [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          clipPath,
        ],
      })
    ).stdout.toString(),
  ) as {
    streams: Record<string, unknown>[];
    format: Record<string, unknown>;
  };
  const video = probe.streams.find((stream) => stream.codec_type === "video")!;
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
  assert.ok(probe.streams.some((stream) => stream.codec_type === "audio"));
  const [endText] = firstTime.split("–")[1]!.split(" ");
  const [endMinutes, endSeconds] = endText!.split(":").map(Number);
  const expectedSeconds =
    endMinutes! * 60 + endSeconds! - (minutes! * 60 + seconds!);
  const duration = Number(probe.format.duration);
  assert.ok(
    Math.abs(duration - expectedSeconds) <= 1.5,
    `clip lasts ${duration}s, expected about ${expectedSeconds}s`,
  );
  // "Fit" keeps the whole frame: the band above it is a blurred fill, not
  // black, and the middle shows the source colour.
  const frame = (
    await runProcess({
      executable: "ffmpeg",
      args: [
        "-v",
        "error",
        "-ss",
        "1",
        "-i",
        clipPath,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      maxOutputBytes: 1080 * 1920 * 3 + 1024,
    })
  ).stdout;
  const pixel = (x: number, y: number) => {
    const at = (y * 1080 + x) * 3;
    return [frame[at]!, frame[at + 1]!, frame[at + 2]!];
  };
  const top = pixel(540, 200);
  assert.ok(top[0]! + top[1]! + top[2]! > 40, `top band ${top}`);
  await writeFile(join(evidence, "clip-frame.rgb"), frame);
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-v",
      "error",
      "-ss",
      "1",
      "-i",
      clipPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=360:-2",
      join(evidence, "clip-frame.png"),
    ],
  });
  result.clipSeconds = duration;

  step = "discard";
  if (found > 1) {
    const last = items.last();
    const title = await last.locator(".short-head strong").textContent();
    await last.getByRole("button", { name: /^Discard / }).click();
    await expect(items).toHaveCount(found - 1);
    assert.ok(
      !(
        await page.locator("#shorts-list .short-head strong").allTextContents()
      ).includes(title!),
    );
  }
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

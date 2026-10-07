/**
 * Packaged native captions: a public speech sample is transcribed locally,
 * captions are switched on and shown over the preview, follow a cut made in
 * Edit, highlight the spoken word, and are exported as an .srt file beside
 * a verified master.
 *
 * node tests/native/captions.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
const evidence = await mkdtemp(join(evidenceRoot, "native-captions-"));
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
// Speech, 2.5 s of digital silence, the same speech again; whole 0.5 s frames.
const silence = Buffer.alloc(48_000 * 2 * 2.5);
let audio = Buffer.concat([speech, silence, speech]);
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
const sourcePath = join(evidence, "Talk with retake.mkv");
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
const result: Record<string, unknown> = { scope: "P8-01-native-captions" };
const configRoot = join(evidence, "config");
const outputs = join(evidence, "outputs");
await mkdir(outputs, { recursive: true });
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
  chromiumSandbox: true,
  timeout: 30_000,
});
try {
  const master = join(outputs, "Talk master.mkv");
  await electron.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [files.source],
      });
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: files.master,
      });
    },
    { source: sourcePath, master },
  );
  const page = await electron.firstWindow();
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;

  step = "transcribe";
  await page.getByRole("button", { name: "Auto Edit", exact: true }).click();
  await expect(page.locator("#captions-enabled")).toBeDisabled();
  await expect(page.locator("#captions-note")).toHaveText(
    "Captions use the transcript. Transcribe first.",
  );
  await page
    .getByRole("button", { name: "Transcribe locally", exact: true })
    .click();
  await expect(page.locator("#transcription-status")).toContainText(
    "Transcript complete",
    { timeout: 15 * 60_000 },
  );
  await expect(page.locator("#captions-enabled")).toBeEnabled();

  step = "enable";
  await page.locator("#captions-enabled").check();
  await expect(page.locator("#captions-note")).toContainText("captions");
  const transcription = await page.evaluate(
    (id) =>
      window.desktop.getTranscription({
        schema_version: "1.0",
        project_id: id,
        job_id: null,
      }),
    project.id,
  );
  assert.ok(transcription.ok);
  const words = transcription.value.results[0]!.transcript.segments.flatMap(
    (segment) => segment.words,
  );
  assert.ok(words.length >= 10);
  // Seek into the middle of a word: its caption shows that word.
  const target = words[3]!;
  const middle = Math.floor((target.start_us + target.end_us) / 2);
  const seekTo = async (us: number) => {
    await page.locator("#seek").fill(String(us));
    await expect(page.locator("#preview-message")).toBeHidden({
      timeout: 30_000,
    });
  };
  await seekTo(middle);
  const overlay = page.locator("#caption-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText(target.text.trim().replace(/[,.]$/u, ""));
  await page.screenshot({ path: join(evidence, "captions-plain.png") });
  // The caption sits inside the displayed frame, near its bottom.
  const boxes = await page.evaluate(() => {
    const block = document
      .querySelector(".caption-block")!
      .getBoundingClientRect();
    const frame = document.querySelector("#frame")!.getBoundingClientRect();
    return { block: block.toJSON(), frame: frame.toJSON() };
  });
  assert.ok(boxes.block.bottom <= boxes.frame.bottom);
  assert.ok(boxes.block.top > boxes.frame.top + boxes.frame.height / 2);

  step = "highlight";
  await page.locator("#captions-style").selectOption("highlight");
  await expect(page.locator("#caption-overlay .spoken")).toHaveText(
    target.text.trim(),
  );
  await page.locator("#captions-position").selectOption("top");
  const top = await page.evaluate(() => {
    const block = document
      .querySelector(".caption-block")!
      .getBoundingClientRect();
    const frame = document.querySelector("#frame")!.getBoundingClientRect();
    return block.bottom < frame.top + frame.height / 2;
  });
  assert.ok(top);
  await page.screenshot({ path: join(evidence, "captions-highlight-top.png") });

  step = "cut";
  // Cut the target word's whole span; its caption text must disappear.
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await seekTo(target.start_us);
  await page.locator("#mark-in").click();
  await seekTo(target.end_us);
  await page.locator("#mark-out").click();
  await page.locator("#cut-range").click();
  await expect
    .poll(async () => {
      const reply = await page.evaluate(() => window.desktop.listProjects());
      return reply.ok ? reply.value[0]!.draft.sequence : -1;
    })
    .toBe(1);
  await seekTo(target.start_us);
  await expect(overlay).toBeVisible();
  const afterCut = (await overlay.textContent()) ?? "";
  const before = words[2]!.text.trim();
  assert.ok(afterCut.includes(before.replace(/[,.]$/u, "")), afterCut);

  step = "export";
  await page.getByRole("button", { name: "Auto Edit", exact: true }).click();
  await page.locator("#captions-burn-in").check();
  await page.locator("#audio-normalize").check();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.locator("#export-start").click();
  await expect(page.locator("#export-done")).toBeVisible({ timeout: 300_000 });
  await expect(page.locator("#export-result")).toContainText(
    "captions in Talk master.srt",
  );
  await expect(page.locator("#export-result")).toContainText(
    "captions burned in",
  );
  await expect(page.locator("#export-result")).toContainText("audio cleaned");
  await expect(page.locator("#export-result")).toContainText(
    "verified lossless",
  );
  const srt = await readFile(join(outputs, "Talk master.srt"), "utf8");
  const cues = srt.split("\r\n\r\n").filter(Boolean);
  assert.ok(cues.length >= 2);
  assert.match(cues[0]!, /^1\r\n00:00:\d\d,\d{3} --> 00:00:\d\d,\d{3}\r\n/u);
  const lastEnd = /--> (\d\d):(\d\d):(\d\d),(\d{3})/u.exec(cues.at(-1)!)!;
  const lastEndUs =
    ((Number(lastEnd[1]) * 60 + Number(lastEnd[2])) * 60 + Number(lastEnd[3])) *
      1_000_000 +
    Number(lastEnd[4]) * 1000;
  const edited = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(edited.ok);
  assert.ok(lastEndUs <= edited.value[0]!.timeline.durationUs + 1000);
  result.cues = cues.length;
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

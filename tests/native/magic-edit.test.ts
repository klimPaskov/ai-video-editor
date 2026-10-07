/**
 * Packaged native Magic Edit: a public speech sample, a 2.5 s silent gap and
 * the same sample again. Magic Edit transcribes locally, then applies only
 * safe cuts through the shared journal; no word may be partly removed, and
 * Edit's Undo must restore the original draft.
 *
 * node tests/native/magic-edit.test.ts <packaged-executable> [--inspect]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import type { DraftTransactionRecord } from "../../packages/domain/src/draft-transaction.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-magic-edit-"));
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
const originalDurationUs = frames * 500_000;

let step = "launch";
const result: Record<string, unknown> = { scope: "P5-04-native-magic-edit" };
const configRoot = join(evidence, "config");
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
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
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;
  assert.equal(project.timeline.durationUs, originalDurationUs);
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const journal = join(
    userData,
    "project-store",
    project.id,
    "draft",
    "journal",
  );
  const records = async (): Promise<DraftTransactionRecord[]> =>
    Promise.all(
      (await readdir(journal).catch(() => []))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(async (name) =>
          JSON.parse(await readFile(join(journal, name), "utf8")),
        ),
    );

  step = "magic-edit";
  await page.getByRole("button", { name: "Auto Edit", exact: true }).click();
  await expect(page.locator("#magic-start")).toBeVisible();
  await expect(page.locator("#magic-preset")).toHaveValue("balanced");
  await page.locator("#magic-start").click();
  await expect(page.locator("#magic-stop")).toBeVisible();
  await expect(page.locator("#magic-status")).toContainText("Removed", {
    timeout: 15 * 60_000,
  });
  await expect(page.locator("#magic-error")).toBeHidden();
  const summaryText = await page.locator("#magic-status").textContent();
  await page.screenshot({ path: join(evidence, "magic-edit-summary.png") });

  step = "draft-checks";
  const edited = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(edited.ok);
  const after = edited.value.find((item) => item.id === project.id)!;
  const removedUs = originalDurationUs - after.timeline.durationUs;
  assert.ok(removedUs >= 1_500_000, `removed only ${removedUs} us`);
  const magic = (await records()).filter(
    (record) => record.origin === "magic_wand",
  );
  assert.ok(magic.length >= 1);
  for (const record of magic) {
    assert.equal(record.kind, "apply");
    assert.equal(record.status, "committed");
    assert.ok(
      record.operations.every(
        (operation) => operation.operation_type === "ripple_delete",
      ),
    );
  }
  // No transcript word may be partly removed.
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
  assert.equal(transcription.value.job.status, "completed");
  const words = transcription.value.results[0]!.transcript.segments.flatMap(
    (segment) => segment.words,
  );
  const kept = after.clips!.map(
    (clip) => [clip.sourceStartUs, clip.sourceEndUs] as const,
  );
  let removedWords = 0;
  for (const word of words) {
    const keptUs = kept.reduce(
      (sum, [start, end]) =>
        sum +
        Math.max(
          0,
          Math.min(end, word.end_us) - Math.max(start, word.start_us),
        ),
      0,
    );
    const length = word.end_us - word.start_us;
    assert.ok(
      keptUs === 0 || keptUs === length,
      `word "${word.text}" is partly cut`,
    );
    if (keptUs === 0) removedWords++;
  }
  const speechUs = (speech.length / 2 / 48_000) * 1_000_000;
  const takeEnd = Math.max(
    ...words
      .filter((word) => word.end_us <= speechUs)
      .map((word) => word.end_us),
  );
  const nextStart = Math.min(
    ...words
      .filter((word) => word.start_us >= speechUs)
      .map((word) => word.start_us),
  );
  result.magicEdit = {
    summary: summaryText,
    transactions: magic.length,
    removedUs,
    words: words.length,
    removedWords,
    gapBetweenTakesUs: nextStart - takeEnd,
  };

  step = "undo";
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  for (let index = 0; index < magic.length; index++) {
    await page.locator("#undo-edit").click();
    await expect
      .poll(async () => (await records()).length, { timeout: 30_000 })
      .toBe(magic.length + index + 1);
  }
  const undone = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(undone.ok);
  assert.equal(
    undone.value.find((item) => item.id === project.id)!.timeline.durationUs,
    originalDurationUs,
  );
  result.undoRestoredOriginal = true;
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

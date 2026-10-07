import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { verifySpeechModelCache } from "../../packages/media-engine/src/transcription.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const root = resolve("test-results");
await mkdir(root, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(root, "native-transcription-"));
async function inspectionHold(name: string): Promise<void> {
  if (!process.argv.includes("--inspect")) return;
  const ready = join(evidence, `${name}.ready`);
  const done = join(evidence, `${name}.done`);
  await writeFile(ready, "ready\n", { mode: 0o600 });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try {
      await access(done);
      return;
    } catch {
      await delay(500);
    }
  }
  await access(done);
}
const sampleRevision = "fbe92bd97d48f3ec17779d8d8f2964e1c6bc7634";
const sampleSha256 =
  "aa81c2552465568567e670f3823117e633900d16bd6202346a72f3c8464c74c8";
const sampleUrl = `https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/${sampleRevision}/jfk.wav`;
const sampleResponse = await fetch(sampleUrl, { redirect: "follow" });
const sampleFinalUrl = new URL(sampleResponse.url);
assert.ok(sampleResponse.ok);
assert.equal(sampleFinalUrl.protocol, "https:");
assert.ok(
  sampleFinalUrl.hostname === "huggingface.co" ||
    sampleFinalUrl.hostname.endsWith(".hf.co"),
);
const sample = Buffer.from(await sampleResponse.arrayBuffer());
assert.equal(sample.length, 1_940_478);
assert.equal(createHash("sha256").update(sample).digest("hex"), sampleSha256);
const samplePath = join(evidence, "public-speech.wav");
const audioPath = join(evidence, "speech.s16le");
const videoPath = join(evidence, "video.bgra");
const sourcePath = join(evidence, "speech-fixture.mkv");
await writeFile(samplePath, sample, { mode: 0o600 });
await runProcess({
  executable: "ffmpeg",
  args: [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-i",
    samplePath,
    "-map",
    "0:a:0",
    "-vn",
    "-af",
    "aresample=48000:async=0,asetpts=PTS-STARTPTS",
    "-ar",
    "48000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    audioPath,
  ],
});
const audio = await readFile(audioPath);
const samplesPerFrame = 24_000;
const frameCount = Math.floor(audio.length / 2 / samplesPerFrame);
assert.ok(frameCount >= 10);
const matchingAudio = audio.subarray(0, frameCount * samplesPerFrame * 2);
await writeFile(audioPath, matchingAudio, { mode: 0o600 });
const width = 96,
  height = 64,
  frameBytes = width * height * 4;
const video = Buffer.alloc(frameCount * frameBytes);
for (let frame = 0; frame < frameCount; frame++) {
  const colors = [
    (40 + frame * 11) % 256,
    (100 + frame * 17) % 256,
    (180 + frame * 23) % 256,
  ];
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = frame * frameBytes + pixel * 4;
    video[offset] = colors[2]!;
    video[offset + 1] = colors[1]!;
    video[offset + 2] = colors[0]!;
    video[offset + 3] = 255;
  }
}
await writeFile(videoPath, video, { mode: 0o600 });
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
const sourceBytes = await readFile(sourcePath);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const env = { ...process.env, XDG_CONFIG_HOME: join(evidence, "config") };
const electron = await _electron.launch({
  executablePath,
  chromiumSandbox: true,
  env,
  timeout: 30_000,
});
try {
  const page = await electron.firstWindow();
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.ok(
    !electron
      .process()
      .spawnargs.some((argument) => argument.includes("--no-sandbox")),
  );
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, sourcePath);
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  await expect(
    page.getByRole("navigation", { name: "Project stages" }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Project stages" })
    .getByRole("button", { name: "Auto Edit", exact: true })
    .click();
  const autoEdit = page
    .getByRole("navigation", { name: "Project stages" })
    .getByRole("button", { name: "Auto Edit", exact: true });
  await expect(autoEdit).toHaveAttribute("aria-current", "step");
  await expect(
    page.getByText(/First use downloads about 76 MiB/u),
  ).toBeVisible();
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  if (process.env.P5_MODEL_CACHE_SOURCE) {
    const sourceCache = resolve(process.env.P5_MODEL_CACHE_SOURCE);
    await verifySpeechModelCache(sourceCache);
    await cp(sourceCache, join(userData, "transcription-models"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await verifySpeechModelCache(join(userData, "transcription-models"));
  }
  const beforeTranscription = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(beforeTranscription.ok);
  assert.equal(beforeTranscription.value.length, 1);
  const projectId = beforeTranscription.value[0]!.id;
  const library = new MediaLibrary(join(userData, "media-library"));
  const source = await library.verifiedSource(
    beforeTranscription.value[0]!.source.id,
  );
  assert.equal(source.sha256, sourceSha256);
  await page
    .getByRole("button", { name: "Transcribe locally", exact: true })
    .click();
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const reply = await window.desktop.getTranscription({
            schema_version: "1.0",
            project_id: id,
            job_id: null,
          });
          return reply.ok ? reply.value.job : null;
        }, projectId),
      { timeout: 120_000 },
    )
    .not.toBeNull();
  const initialJob = await page.evaluate(async (id) => {
    const reply = await window.desktop.getTranscription({
      schema_version: "1.0",
      project_id: id,
      job_id: null,
    });
    if (!reply.ok) throw new Error("Transcription job could not be read");
    return reply.value.job;
  }, projectId);
  assert.ok(initialJob.job_id);
  const jobId = initialJob.job_id;
  assert.ok(
    ["preparing", "downloading_model", "transcribing"].includes(
      initialJob.status,
    ),
  );
  const repeatedStart = await page.evaluate(async (id) => {
    const reply = await window.desktop.startTranscription({
      schema_version: "1.0",
      project_id: id,
    });
    if (!reply.ok) throw new Error("Repeated transcription request failed");
    return reply.value.job.job_id;
  }, projectId);
  assert.equal(repeatedStart, jobId, "repeated Start must reuse the live job");
  const sameJobPoll = await page.evaluate(
    async (input) => {
      const reply = await window.desktop.getTranscription({
        schema_version: "1.0",
        project_id: input.projectId,
        job_id: input.jobId,
      });
      if (!reply.ok) throw new Error("Bound transcription poll failed");
      return reply.value.job.job_id;
    },
    { projectId, jobId },
  );
  assert.equal(
    sameJobPoll,
    jobId,
    "polling must preserve the original job identity",
  );
  await expect(page.locator("#transcription-status")).toContainText(
    "Transcript complete",
    { timeout: 900_000 },
  );
  await expect(page.locator("#transcript-results")).toBeVisible();
  const completed = await page.evaluate(
    async (input) => {
      const reply = await window.desktop.getTranscription({
        schema_version: "1.0",
        project_id: input.projectId,
        job_id: input.jobId,
      });
      if (!reply.ok) throw new Error("Completed transcript could not be read");
      return reply.value;
    },
    { projectId, jobId },
  );
  assert.equal(completed.job.status, "completed");
  assert.ok(completed.job.word_count > 0);
  assert.equal(completed.results.length, 1);
  const firstTranscript = completed.results[0]!.transcript;
  assert.equal(firstTranscript.model.provider, "local");
  assert.equal(
    firstTranscript.model.version,
    "64da57285918e20ea79ea5c88eed7197933abaa8",
  );
  assert.equal(firstTranscript.model.device, "cpu");
  assert.ok(firstTranscript.segments.length > 0);
  for (const word of firstTranscript.segments.flatMap(
    (segment) => segment.words,
  )) {
    assert.ok(Number.isSafeInteger(word.start_us));
    assert.ok(Number.isSafeInteger(word.end_us));
    assert.ok(word.start_us >= 0 && word.end_us <= firstTranscript.duration_us);
  }
  assert.equal(completed.results[0]!.analysis.source_sha256, sourceSha256);
  const modelSha256 = await verifySpeechModelCache(
    join(userData, "transcription-models"),
  );
  assert.equal(firstTranscript.model.sha256, modelSha256);
  assert.equal(
    createHash("sha256")
      .update(await readFile(sourcePath))
      .digest("hex"),
    sourceSha256,
  );
  const projects = new ProjectStore(join(userData, "project-store"), library);
  const reopenedBaseline = await projects.open(projectId);
  assert.equal(reopenedBaseline.project.project_id, projectId);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.locator("#home")).toBeVisible();
  await page.locator(`#projects [data-project-id="${projectId}"]`).click();
  await expect(page.locator("#transcription-status")).toContainText(
    "Transcript complete",
    { timeout: 30_000 },
  );
  const afterReopen = await page.evaluate(async (id) => {
    const reply = await window.desktop.getTranscription({
      schema_version: "1.0",
      project_id: id,
      job_id: null,
    });
    if (!reply.ok) throw new Error("Cached transcript could not be reopened");
    return reply.value;
  }, projectId);
  assert.equal(
    afterReopen.results[0]!.transcript.transcript_id,
    firstTranscript.transcript_id,
  );
  const firstWord = firstTranscript.segments[0]!.words[0]!;
  await page
    .getByRole("navigation", { name: "Project stages" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.locator("#transcript-edit-panel")).toBeVisible();
  await page.locator("#transcript-edit-details summary").click();
  await expect
    .poll(() => page.locator("#transcript-edit-word option").count())
    .toBeGreaterThan(0);
  await page.locator("#transcript-edit-word").selectOption(firstWord.word_id);
  await expect(page.locator("#transcript-correction-input")).toHaveValue(
    firstWord.text,
  );
  await page.locator("#transcript-correction-input").fill("Start");
  await page
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await expect(page.locator("#transcript-correction-status")).toContainText(
    /recorded audio is unchanged/iu,
  );
  let correctedProjects = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(correctedProjects.ok);
  let correctedProject = correctedProjects.value.find(
    (item) => item.id === projectId,
  );
  assert.ok(correctedProject);
  assert.equal(correctedProject.draft.sequence, 1);
  assert.equal(
    correctedProject.transcriptEdits?.[0]?.replacement_text,
    "Start",
  );
  const correctedTranscript = await page.evaluate(async (id) => {
    const reply = await window.desktop.getTranscription({
      schema_version: "1.0",
      project_id: id,
      job_id: null,
    });
    if (!reply.ok) throw new Error("Original transcript could not be read");
    return reply.value.results[0]!.transcript;
  }, projectId);
  assert.equal(
    correctedTranscript.segments[0]!.words[0]!.text,
    firstWord.text,
    "a text correction must not rewrite the local ASR result",
  );
  await page.locator("#undo-edit").click();
  await expect(page.locator("#transcript-correction-input")).toHaveValue(
    firstWord.text,
  );
  await page.locator("#redo-edit").click();
  await expect(page.locator("#transcript-correction-input")).toHaveValue(
    "Start",
  );
  correctedProjects = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(correctedProjects.ok);
  correctedProject = correctedProjects.value.find(
    (item) => item.id === projectId,
  );
  assert.equal(correctedProject?.draft.sequence, 3);
  assert.equal(
    correctedProject?.transcriptEdits?.[0]?.replacement_text,
    "Start",
  );
  await inspectionHold("transcript-correction-inspection");
  const secondWord = firstTranscript.segments[0]!.words[1]!;
  const initialDuration = beforeTranscription.value[0]!.timeline.durationUs;
  await page.locator("#transcript-cut-start").selectOption(firstWord.word_id);
  await page.locator("#transcript-cut-end").selectOption(secondWord.word_id);
  await expect(page.locator("#transcript-cut-submit")).toBeEnabled();
  await page.locator("#transcript-cut-submit").click();
  await expect(page.locator("#transcript-cut-status")).toContainText(
    "Check the join",
  );
  const afterTranscriptCut = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(afterTranscriptCut.ok);
  const cutProject = afterTranscriptCut.value.find(
    (item) => item.id === projectId,
  );
  assert.ok(cutProject);
  assert.equal(cutProject.draft.sequence, 4);
  assert.equal(
    cutProject.timeline.durationUs,
    initialDuration - (secondWord.end_us - firstWord.start_us),
  );
  const journal = join(
    userData,
    "project-store",
    projectId,
    "draft",
    "journal",
  );
  const committedEntries = (await readdir(journal))
    .filter((name) => /^\d{12}\..+\.json$/u.test(name))
    .sort();
  const lastTransaction = JSON.parse(
    await readFile(join(journal, committedEntries.at(-1)!), "utf8"),
  ) as { operations: Array<Record<string, unknown>> };
  const transcriptCut = lastTransaction.operations[0]!;
  assert.equal(transcriptCut.operation_type, "transcript_cut");
  assert.equal(transcriptCut.transcript_id, firstTranscript.transcript_id);
  assert.equal(transcriptCut.start_word_id, firstWord.word_id);
  assert.equal(transcriptCut.end_word_id, secondWord.word_id);
  await inspectionHold("transcript-cut-inspection");
  await page.locator("#undo-edit").click();
  await expect(page.locator("#transcript-correction-input")).toHaveValue(
    "Start",
  );
  const afterCutUndo = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(afterCutUndo.ok);
  const restoredCutProject = afterCutUndo.value.find(
    (item) => item.id === projectId,
  );
  assert.ok(restoredCutProject);
  assert.equal(restoredCutProject.draft.sequence, 5);
  assert.equal(restoredCutProject.timeline.durationUs, initialDuration);
  await expect(page.locator("#transcript-cut-status")).toBeHidden();
  assert.equal(
    restoredCutProject.transcriptEdits?.[0]?.replacement_text,
    "Start",
  );
  await page.locator("#redo-edit").click();
  const afterCutRedo = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(afterCutRedo.ok);
  const redoneCutProject = afterCutRedo.value.find(
    (item) => item.id === projectId,
  );
  assert.ok(redoneCutProject);
  assert.equal(redoneCutProject.draft.sequence, 6);
  assert.equal(
    redoneCutProject.timeline.durationUs,
    initialDuration - (secondWord.end_us - firstWord.start_us),
  );
  await expect(page.locator("#transcript-cut-status")).toBeHidden();
  await page.locator("#undo-edit").click();
  const afterCutRedoUndo = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(afterCutRedoUndo.ok);
  const finallyRestoredProject = afterCutRedoUndo.value.find(
    (item) => item.id === projectId,
  );
  assert.ok(finallyRestoredProject);
  assert.equal(finallyRestoredProject.draft.sequence, 7);
  assert.equal(finallyRestoredProject.timeline.durationUs, initialDuration);
  await expect(page.locator("#transcript-cut-status")).toBeHidden();
  assert.equal(
    finallyRestoredProject.transcriptEdits?.[0]?.replacement_text,
    "Start",
  );
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.locator("#home")).toBeVisible();
  await page.locator(`#projects [data-project-id="${projectId}"]`).click();
  await expect(page.locator("#transcript-correction-input")).toHaveValue(
    "Start",
    { timeout: 30_000 },
  );
  const reopenedAfterCut = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(reopenedAfterCut.ok);
  const reopenedCutProject = reopenedAfterCut.value.find(
    (item) => item.id === projectId,
  );
  assert.ok(reopenedCutProject);
  assert.equal(reopenedCutProject.draft.sequence, 7);
  assert.equal(reopenedCutProject.timeline.durationUs, initialDuration);
  await expect(page.locator("#transcript-cut-status")).toBeHidden();
  assert.equal(
    reopenedCutProject.transcriptEdits?.[0]?.replacement_text,
    "Start",
  );
  await page
    .getByRole("navigation", { name: "Project stages" })
    .getByRole("button", { name: "Auto Edit", exact: true })
    .click();
  const repeatedCompletedStart = await page.evaluate(async (id) => {
    const reply = await window.desktop.startTranscription({
      schema_version: "1.0",
      project_id: id,
    });
    if (!reply.ok) throw new Error("Cached transcription start failed");
    return {
      jobId: reply.value.job.job_id,
      transcriptId: reply.value.results[0]?.transcript.transcript_id,
    };
  }, projectId);
  assert.equal(repeatedCompletedStart.jobId, null);
  assert.equal(
    repeatedCompletedStart.transcriptId,
    firstTranscript.transcript_id,
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(sourcePath))
      .digest("hex"),
    sourceSha256,
  );
  if (process.argv.includes("--inspect")) {
    await page.locator("#transcript-summary").click();
    await inspectionHold("transcription-inspection");
  }
  await writeFile(
    join(evidence, "result.json"),
    `${JSON.stringify(
      {
        status: "pass",
        packaged: true,
        nativeWindow: true,
        urlScheme: "ai-video-editor",
        hostInput: false,
        sourceSha256,
        sampleSha256,
        model: firstTranscript.model.name,
        modelRevision: firstTranscript.model.version,
        modelSha256,
        wordCount: completed.job.word_count,
        wordTimestampsBounded: true,
        silenceCount: completed.results[0]!.analysis.silences.length,
        repeatedStartReusedJob: true,
        pollRetainedJobId: true,
        reopenedProjectHasNoLiveJob: true,
        reopenRetainedTranscript: true,
        transcriptCorrectionUndoRedo: true,
        transcriptCorrectionSurvivedReopen: true,
        transcriptCorrectionIsMetadataOnly: true,
        transcriptCutLinkedUndo: true,
        transcriptCutUndoRedoReopen: true,
        sourceUnchanged: true,
        paidProviderUsed: false,
        transcriptTextRecorded: false,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
} finally {
  await electron.close();
}

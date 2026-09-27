import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertTranscriptionJobRequest,
  assertTranscriptionProjectView,
  assertTranscriptionStopRequest,
  assertLocalTranscript,
  assertTranscriptAnalysis,
} from "../../packages/domain/src/transcription.ts";
import {
  buildLocalTranscript,
  buildTranscriptAnalysis,
  downloadSpeechModelWeights,
  extractSpeechAudioProxy,
  localSpeechModel,
  parseSilenceDetection,
  readSpeechAudioProxy,
  speechAudioProfile,
  verifySpeechModelCache,
} from "../../packages/media-engine/src/transcription.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

test("word timing is converted to integer microseconds and bounded to the source", () => {
  const transcript = buildLocalTranscript(
    {
      projectId: "project-0001",
      sourceId: "source-0001",
      durationUs: 2_000_000,
      sourceStartUs: 500_000,
      language: null,
      modelSha256: "a".repeat(64),
      transcriptId: "transcript-0001",
    },
    [
      { text: "Hello", timestamp: [0.12, 0.42] },
      { text: ",", timestamp: [0.42, 0.44] },
      { text: "world", timestamp: [1.3, 1.45] },
    ],
  );
  assert.equal(transcript.language, "und");
  assert.equal(transcript.segments[0]?.text, "Hello, world");
  assert.deepEqual(
    transcript.segments.flatMap((segment) =>
      segment.words.map((word) => [word.start_us, word.end_us]),
    ),
    [
      [620_000, 920_000],
      [920_000, 940_000],
      [1_800_000, 1_950_000],
    ],
  );
  assert.equal(transcript.model.sha256, "a".repeat(64));
  assertLocalTranscript(transcript);
  assert.throws(() =>
    buildLocalTranscript(
      {
        projectId: "project-0001",
        sourceId: "source-0001",
        durationUs: 2_000_000,
        sourceStartUs: 500_000,
      },
      [{ text: "late", timestamp: [2, 3] }],
    ),
  );
});

test("silence analysis retains source times and never creates cuts", () => {
  const silences = parseSilenceDetection(
    "[silencedetect] silence_start: 0.250000\n[silencedetect] silence_end: 0.800000 | silence_duration: 0.550000\n[silencedetect] silence_start: 1.000000\n[silencedetect] silence_end: 1.100000 | silence_duration: 0.100000\n",
    250_000,
    2_000_000,
  );
  assert.deepEqual(silences, [{ start_us: 500_000, end_us: 1_050_000 }]);
  const analysis = buildTranscriptAnalysis({
    projectId: "project-0001",
    sourceId: "source-0001",
    sourceSha256: "b".repeat(64),
    durationUs: 2_000_000,
    silences,
  });
  assertTranscriptAnalysis(analysis);
  assert.deepEqual(Object.keys(analysis), [
    "schema_version",
    "project_id",
    "source_id",
    "source_sha256",
    "duration_us",
    "silence_policy",
    "silences",
  ]);
});

test("project transcription views and polling requests stay path-free and job-bound", () => {
  const transcript = buildLocalTranscript(
    {
      projectId: "project-0001",
      sourceId: "source-0001",
      durationUs: 1_000_000,
      sourceStartUs: 0,
      transcriptId: "transcript-0001",
    },
    [{ text: "Hello", timestamp: [0.1, 0.4] }],
  );
  const analysis = buildTranscriptAnalysis({
    projectId: "project-0001",
    sourceId: "source-0001",
    sourceSha256: "c".repeat(64),
    durationUs: 1_000_000,
    silences: [],
  });
  const view = {
    project_id: "project-0001",
    job: {
      project_id: "project-0001",
      job_id: "transcription-run-0001",
      status: "completed",
      progress_percent: 100,
      source_count: 1,
      completed_source_count: 1,
      word_count: 1,
      message: "Transcript ready.",
    },
    results: [{ source_id: "source-0001", transcript, analysis }],
  } as const;
  assertTranscriptionProjectView(view);
  assertTranscriptionJobRequest({
    schema_version: "1.0",
    project_id: "project-0001",
    job_id: view.job.job_id,
  });
  assertTranscriptionStopRequest({
    schema_version: "1.0",
    project_id: "project-0001",
    job_id: view.job.job_id,
  });
  assert.throws(() =>
    assertTranscriptionJobRequest({
      schema_version: "1.0",
      project_id: "project-0001",
      job_id: "private/path",
    }),
  );
  assert.throws(() =>
    assertTranscriptionStopRequest({
      schema_version: "1.0",
      project_id: "project-0001",
      job_id: null,
    }),
  );
  assert.throws(() =>
    assertTranscriptionProjectView({
      ...view,
      job: { ...view.job, word_count: 2 },
    }),
  );
  assert.throws(() =>
    assertTranscriptionProjectView({
      ...view,
      results: [...view.results, ...view.results],
    }),
  );
});

test("speech proxy is analysis-only, literal-path, mono f32le and source preserving", async () => {
  const root = resolve("test-results/transcription");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "fixture-"));
  try {
    const source = join(directory, "source audio.wav");
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
        "anullsrc=channel_layout=stereo:sample_rate=48000:d=0.75",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=48000:duration=1",
        "-filter_complex",
        "[0:a][1:a]concat=n=2:v=0:a=1,asetpts=PTS-STARTPTS[a]",
        "-map",
        "[a]",
        "-c:a",
        "pcm_s16le",
        source,
      ],
    });
    const before = createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
    const output = join(directory, "private analysis", "speech.f32le");
    const proxy = await extractSpeechAudioProxy({
      ffmpegExecutable: "ffmpeg",
      sourcePath: source,
      outputPath: output,
      audioStreamIndex: 0,
      sourceStartUs: 0,
      sourceDurationUs: 1_750_000,
    });
    assert.equal(proxy.sampleRate, speechAudioProfile.sampleRate);
    assert.equal(proxy.channels, 1);
    assert.equal(proxy.format, "f32le");
    assert.equal(proxy.sampleCount, 28_000);
    assert.equal(proxy.durationUs, 1_750_000);
    assert.ok(
      proxy.silences.some(
        (range) => range.start_us === 0 && range.end_us >= 500_000,
      ),
    );
    const audio = await readSpeechAudioProxy(proxy.path);
    assert.equal(audio.length, proxy.sampleCount);
    assert.ok(audio.some((sample) => Math.abs(sample) > 0.1));
    assert.ok(
      audio.slice(0, 5_000).every((sample) => Math.abs(sample) < 0.0001),
    );
    const after = createHash("sha256")
      .update(await readFile(source))
      .digest("hex");
    assert.equal(after, before);
    assert.equal((await stat(proxy.path)).size, proxy.sampleCount * 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("local model cache rejects unverified bytes and downloader does not follow an untrusted response", async () => {
  const root = await mkdtemp(
    join(resolve("test-results/transcription"), "model-"),
  );
  const originalFetch = globalThis.fetch;
  try {
    const modelFile = localSpeechModel.files[0]!;
    const modelPath = join(
      root,
      localSpeechModel.id,
      localSpeechModel.revision,
      modelFile.name,
    );
    await mkdir(join(modelPath, ".."), { recursive: true });
    await writeFile(modelPath, Buffer.alloc(32));
    await assert.rejects(verifySpeechModelCache(root));
    let requested = "";
    globalThis.fetch = (async (input) => {
      requested = String(input);
      return {
        ok: false,
        url: "https://huggingface.co/Xenova/whisper-base/resolve/pinned/onnx/encoder_model_quantized.onnx",
        body: null,
      } as Response;
    }) as typeof fetch;
    const cleanRoot = await mkdtemp(join(root, "clean-"));
    await assert.rejects(downloadSpeechModelWeights(cleanRoot), {
      code: "PROCESS_FAILED",
    });
    assert.match(
      requested,
      /^https:\/\/huggingface\.co\/Xenova\/whisper-base\/resolve\//u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

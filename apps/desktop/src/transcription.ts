import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  assertTranscriptionJobRequest,
  assertTranscriptionProjectRequest,
  assertTranscriptionStopRequest,
  assertTranscriptionProjectView,
  assertLocalTranscript,
  assertTranscriptAnalysis,
} from "../../../packages/domain/src/transcription.ts";
import type {
  LocalTranscript,
  TranscriptionJobRequest,
  TranscriptionJobView,
  TranscriptionProjectRequest,
  TranscriptionProjectView,
  TranscriptionSourceResult,
  TranscriptionStopRequest,
  TranscriptionMessage,
} from "../../../packages/domain/src/transcription.ts";
import type {
  InitialProjectSnapshot,
  TwoSourceInitialProjectSnapshot,
} from "../../../packages/domain/src/project.ts";
import type { MediaLibrary } from "../../../packages/media-engine/src/library.ts";
import { MediaError } from "../../../packages/media-engine/src/process.ts";
import {
  buildTranscriptAnalysis,
  downloadSpeechModelWeights,
  localSpeechModel,
  type TranscriptBuildFailureReason,
} from "../../../packages/media-engine/src/transcription.ts";
import type { ProjectStore } from "../../../packages/project-store/src/store.ts";

type Baseline = InitialProjectSnapshot | TwoSourceInitialProjectSnapshot;
type Source = InitialProjectSnapshot["source"];
type WorkerFailureReason =
  | "model"
  | "audio_proxy"
  | "model_inference"
  | "model_output"
  | `transcript_${TranscriptBuildFailureReason}`;
type WorkerReply =
  | { type: "model-progress"; progress: number }
  | { type: "ready" }
  | { type: "source-result"; sourceId: string; transcript: unknown }
  | { type: "worker-error"; reason: WorkerFailureReason };
type WorkerResponseType = WorkerReply["type"];

const workerFailureReasons: readonly WorkerFailureReason[] = [
  "model",
  "audio_proxy",
  "model_inference",
  "model_output",
  "transcript_invalid_options",
  "transcript_invalid_chunk",
  "transcript_invalid_timing",
  "transcript_out_of_order",
  "transcript_outside_source",
  "transcript_invalid_transcript",
];

const workerFailureMessages: Record<WorkerFailureReason, TranscriptionMessage> =
  {
    model:
      "The local speech model could not start. Restart the app and try again.",
    audio_proxy:
      "The prepared speech audio could not be read. Try transcribing again.",
    model_inference:
      "The local speech model could not process this source. Check its audio or choose a shorter clip.",
    model_output:
      "The local model returned words without usable timing. Try transcribing again.",
    transcript_invalid_options:
      "The local model could not use the transcription settings. Try again.",
    transcript_invalid_chunk:
      "The local model returned words without usable timing. Try transcribing again.",
    transcript_invalid_timing:
      "The local model returned unusable word timing. Try transcribing again.",
    transcript_out_of_order:
      "The local model returned out-of-order word times. Try another source or transcribe again.",
    transcript_outside_source:
      "The local model returned word times outside this source. Check its audio or try another source.",
    transcript_invalid_transcript:
      "The local model returned transcript data this editor cannot validate. Try transcribing again.",
  };

interface WorkerWaiter {
  types: readonly WorkerResponseType[];
  resolve: (value: WorkerReply) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

interface StoredTranscriptResult {
  schema_version: "1.0";
  project_id: string;
  source_id: string;
  source_sha256: string;
  model_revision: string;
  transcript: LocalTranscript;
  analysis: TranscriptionSourceResult["analysis"];
}

function invalid(): never {
  throw new Error("Local transcription data is invalid.");
}

class TranscriptionTaskError extends Error {
  readonly userMessage: TranscriptionMessage;

  constructor(message: TranscriptionMessage) {
    super(message ?? "Local transcription failed. Try again.");
    this.userMessage = message;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function noEntry(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function sourceList(baseline: Baseline): Source[] {
  return baseline.schema_version === "1.1"
    ? [...baseline.sources]
    : [baseline.source];
}

function countWords(transcript: LocalTranscript): number {
  return transcript.segments.reduce(
    (total, segment) => total + segment.words.length,
    0,
  );
}

function safeWorkerEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
  };
  for (const key of ["SystemRoot", "WINDIR", "TMP", "TEMP"])
    if (process.env[key]) result[key] = process.env[key];
  return result;
}

function parseWorkerReply(value: unknown): WorkerReply {
  if (!record(value) || typeof value.type !== "string") invalid();
  switch (value.type) {
    case "model-progress":
      if (
        Object.keys(value).sort().join() !== "progress,type" ||
        typeof value.progress !== "number" ||
        !Number.isFinite(value.progress) ||
        value.progress < 0 ||
        value.progress > 100
      )
        invalid();
      return { type: value.type, progress: value.progress };
    case "ready":
      if (Object.keys(value).join() !== "type") invalid();
      return { type: value.type };
    case "source-result":
      if (
        Object.keys(value).sort().join() !== "sourceId,transcript,type" ||
        typeof value.sourceId !== "string"
      )
        invalid();
      return {
        type: value.type,
        sourceId: value.sourceId,
        transcript: value.transcript,
      };
    case "worker-error":
      if (
        Object.keys(value).sort().join() !== "reason,type" ||
        !workerFailureReasons.includes(value.reason as WorkerFailureReason)
      )
        invalid();
      return {
        type: value.type,
        reason: value.reason as WorkerFailureReason,
      };
    default:
      invalid();
  }
}

class SpeechWorkerClient {
  private readonly worker: Worker;
  private readonly queue: WorkerReply[] = [];
  private readonly waiters: WorkerWaiter[] = [];
  private failure: Error | undefined;
  private closing = false;

  constructor(
    workerPath: string,
    cacheRoot: string,
    onModelProgress: (progress: number) => void,
  ) {
    this.worker = new Worker(workerPath, {
      workerData: { cacheRoot, allowModelNetwork: true },
      env: safeWorkerEnvironment(),
      execArgv: [],
    });
    this.worker.on("message", (value: unknown) => {
      try {
        const message = parseWorkerReply(value);
        if (message.type === "model-progress") {
          onModelProgress(message.progress);
          return;
        }
        const index = this.waiters.findIndex((waiter) =>
          waiter.types.includes(message.type),
        );
        if (index < 0) this.queue.push(message);
        else {
          const [waiter] = this.waiters.splice(index, 1);
          waiter!.cleanup();
          waiter!.resolve(message);
        }
      } catch {
        this.fail(new Error("The local speech worker returned invalid data."));
      }
    });
    this.worker.on("error", () =>
      this.fail(new Error("The local speech worker stopped unexpectedly.")),
    );
    this.worker.on("exit", (code) => {
      if (!this.closing && code !== 0)
        this.fail(new Error("The local speech worker stopped unexpectedly."));
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(this.failure);
    }
  }

  waitFor(
    types: readonly WorkerResponseType[],
    signal: AbortSignal,
  ): Promise<WorkerReply> {
    if (signal.aborted)
      return Promise.reject(new Error("Local transcription cancelled."));
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.queue.findIndex((message) =>
      types.includes(message.type),
    );
    if (queued >= 0) return Promise.resolve(this.queue.splice(queued, 1)[0]!);
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.fail(
          new Error("The local speech worker exceeded its time limit."),
        );
      }, 1_800_000);
      const onAbort = () => {
        const waiter = this.waiters.find(
          (item) => item.resolve === resolvePromise,
        );
        if (!waiter) return;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.cleanup();
        rejectPromise(new Error("Local transcription cancelled."));
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      this.waiters.push({
        types,
        resolve: resolvePromise,
        reject: rejectPromise,
        cleanup,
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  async transcribe(request: {
    projectId: string;
    sourceId: string;
    audioPath: string;
    durationUs: number;
    sourceStartUs: number;
    transcriptId: string;
    modelSha256: string;
    signal: AbortSignal;
  }): Promise<LocalTranscript> {
    const pending = this.waitFor(
      ["source-result", "worker-error"],
      request.signal,
    );
    this.worker.postMessage({
      type: "transcribe",
      projectId: request.projectId,
      sourceId: request.sourceId,
      audioPath: request.audioPath,
      durationUs: request.durationUs,
      sourceStartUs: request.sourceStartUs,
      transcriptId: request.transcriptId,
      modelSha256: request.modelSha256,
    });
    const result = await pending;
    if (result.type === "worker-error")
      throw new TranscriptionTaskError(workerFailureMessages[result.reason]);
    if (result.type !== "source-result") invalid();
    if (result.sourceId !== request.sourceId) invalid();
    assertLocalTranscript(result.transcript);
    return result.transcript;
  }

  async ready(signal: AbortSignal): Promise<void> {
    const result = await this.waitFor(["ready", "worker-error"], signal);
    if (result.type === "worker-error")
      throw new TranscriptionTaskError(
        "The local speech model could not start. Restart the app and try again.",
      );
    if (result.type !== "ready") invalid();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.fail(new Error("Local transcription stopped."));
    await this.worker.terminate().catch(() => undefined);
  }
}

class TranscriptResultStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    const actual = resolve(await realpath(path));
    const same =
      process.platform === "win32"
        ? actual.toLowerCase() === resolve(path).toLowerCase()
        : actual === resolve(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same) invalid();
  }

  private resultPath(
    projectId: string,
    sourceId: string,
    sourceSha256: string,
  ): string {
    const cacheKey = createHash("sha256")
      .update(`${sourceSha256}\0${localSpeechModel.revision}`)
      .digest("hex");
    return join(this.root, projectId, sourceId, `${cacheKey}.json`);
  }

  async read(
    projectId: string,
    source: Source,
  ): Promise<TranscriptionSourceResult | undefined> {
    const path = this.resultPath(projectId, source.source_id, source.sha256);
    const stat = await lstat(path).catch((error: unknown) => {
      if (noEntry(error)) return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 16 * 1024 * 1024
    )
      invalid();
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    );
    let value: unknown;
    try {
      const actual = await handle.stat();
      if (
        !actual.isFile() ||
        actual.nlink !== 1 ||
        actual.size !== stat.size ||
        actual.dev !== stat.dev ||
        actual.ino !== stat.ino
      )
        invalid();
      value = JSON.parse(await handle.readFile("utf8")) as unknown;
    } finally {
      await handle.close();
    }
    if (
      !record(value) ||
      Object.keys(value).sort().join() !==
        "analysis,model_revision,project_id,schema_version,source_id,source_sha256,transcript" ||
      value.schema_version !== "1.0" ||
      value.project_id !== projectId ||
      value.source_id !== source.source_id ||
      value.source_sha256 !== source.sha256 ||
      value.model_revision !== localSpeechModel.revision
    )
      invalid();
    assertLocalTranscript(value.transcript);
    assertTranscriptAnalysis(value.analysis);
    if (
      value.transcript.project_id !== projectId ||
      value.transcript.source_id !== source.source_id ||
      value.transcript.model.version !== localSpeechModel.revision ||
      value.analysis.project_id !== projectId ||
      value.analysis.source_id !== source.source_id ||
      value.analysis.source_sha256 !== source.sha256
    )
      invalid();
    return {
      source_id: source.source_id,
      transcript: value.transcript,
      analysis: value.analysis,
    };
  }

  async write(result: StoredTranscriptResult): Promise<void> {
    assertLocalTranscript(result.transcript);
    assertTranscriptAnalysis(result.analysis);
    if (
      result.schema_version !== "1.0" ||
      result.model_revision !== localSpeechModel.revision ||
      result.project_id !== result.transcript.project_id ||
      result.project_id !== result.analysis.project_id ||
      result.source_id !== result.transcript.source_id ||
      result.source_id !== result.analysis.source_id ||
      result.source_sha256 !== result.analysis.source_sha256
    )
      invalid();
    const target = this.resultPath(
      result.project_id,
      result.source_id,
      result.source_sha256,
    );
    const folder = join(this.root, result.project_id, result.source_id);
    await this.directory(this.root);
    await this.directory(join(this.root, result.project_id));
    await this.directory(folder);
    const temp = join(folder, `.${randomUUID()}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(result)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    let published = false;
    try {
      await lstat(target).then(
        () => invalid(),
        (error: unknown) => {
          if (!noEntry(error)) throw error;
        },
      );
      await rename(temp, target);
      published = true;
    } finally {
      if (!published) await unlink(temp).catch(() => undefined);
    }
  }
}

interface RunningTranscription {
  view: TranscriptionJobView;
  controller: AbortController;
  worker?: SpeechWorkerClient;
  done: Promise<void>;
  results: TranscriptionSourceResult[];
}

export class DesktopTranscriptionManager {
  private readonly projects: ProjectStore;
  private readonly library: MediaLibrary;
  private readonly store: TranscriptResultStore;
  private readonly tempRoot: string;
  private readonly modelRoot: string;
  private readonly workerPath: string;
  private readonly baselines = new Map<string, Baseline>();
  private readonly results = new Map<string, TranscriptionSourceResult[]>();
  private readonly jobs = new Map<string, RunningTranscription>();

  constructor(options: {
    projects: ProjectStore;
    library: MediaLibrary;
    userData: string;
    workerPath: string;
  }) {
    this.projects = options.projects;
    this.library = options.library;
    this.store = new TranscriptResultStore(
      join(options.userData, "transcripts"),
    );
    this.tempRoot = join(options.userData, "transcription-temp");
    this.modelRoot = join(options.userData, "transcription-models");
    this.workerPath = resolve(options.workerPath);
  }

  isRunning(projectId: string): boolean {
    const status = this.jobs.get(projectId)?.view.status;
    return (
      status === "preparing" ||
      status === "downloading_model" ||
      status === "transcribing"
    );
  }

  private async baseline(projectId: string): Promise<Baseline> {
    const existing = this.baselines.get(projectId);
    if (existing) return existing;
    const baseline = await this.projects.open(projectId);
    this.baselines.set(projectId, baseline);
    return baseline;
  }

  private async sourceResults(
    projectId: string,
    sources: Source[],
  ): Promise<TranscriptionSourceResult[]> {
    const cached = this.results.get(projectId);
    if (cached) return cached;
    const result: TranscriptionSourceResult[] = [];
    for (const source of sources) {
      const transcript = await this.store.read(projectId, source);
      if (transcript) result.push(transcript);
    }
    result.sort(
      (left, right) =>
        sources.findIndex((source) => source.source_id === left.source_id) -
        sources.findIndex((source) => source.source_id === right.source_id),
    );
    this.results.set(projectId, result);
    return result;
  }

  private view(
    projectId: string,
    job: TranscriptionJobView,
    results: TranscriptionSourceResult[],
  ): TranscriptionProjectView {
    const value: TranscriptionProjectView = {
      project_id: projectId,
      job: { ...job },
      results: structuredClone(results),
    };
    assertTranscriptionProjectView(value);
    return value;
  }

  async get(
    request: TranscriptionJobRequest,
  ): Promise<TranscriptionProjectView> {
    assertTranscriptionJobRequest(request);
    const baseline = await this.baseline(request.project_id);
    const sources = sourceList(baseline);
    const results = await this.sourceResults(request.project_id, sources);
    const job = this.jobs.get(request.project_id);
    if (request.job_id && (!job || job.view.job_id !== request.job_id)) {
      return this.view(
        request.project_id,
        {
          project_id: request.project_id,
          job_id: request.job_id,
          status: "cancelled",
          progress_percent: null,
          source_count: sources.filter((source) =>
            source.streams.some((stream) => stream.media_type === "audio"),
          ).length,
          completed_source_count: results.length,
          word_count: results.reduce(
            (sum, item) => sum + countWords(item.transcript),
            0,
          ),
          message: "Transcription was interrupted. Start it again.",
        },
        results,
      );
    }
    if (job) return this.view(request.project_id, job.view, results);
    const sourceCount = sources.filter((source) =>
      source.streams.some((stream) => stream.media_type === "audio"),
    ).length;
    const complete = sourceCount > 0 && results.length === sourceCount;
    return this.view(
      request.project_id,
      {
        project_id: request.project_id,
        job_id: null,
        status: complete ? "completed" : "idle",
        progress_percent: complete ? 100 : null,
        source_count: sourceCount,
        completed_source_count: results.length,
        word_count: results.reduce(
          (sum, item) => sum + countWords(item.transcript),
          0,
        ),
        message: complete ? "Transcript ready." : null,
      },
      results,
    );
  }

  async start(
    request: TranscriptionProjectRequest,
  ): Promise<TranscriptionProjectView> {
    assertTranscriptionProjectRequest(request);
    const baseline = await this.baseline(request.project_id);
    const sources = sourceList(baseline);
    const results = await this.sourceResults(request.project_id, sources);
    const prior = this.jobs.get(request.project_id);
    if (prior && this.isRunning(request.project_id))
      return this.view(request.project_id, prior.view, results);
    const audioSources = sources.filter((source) =>
      source.streams.some((stream) => stream.media_type === "audio"),
    );
    if (audioSources.length > 0 && results.length === audioSources.length) {
      return this.view(
        request.project_id,
        {
          project_id: request.project_id,
          job_id: prior?.view.job_id ?? null,
          status: "completed",
          progress_percent: 100,
          source_count: audioSources.length,
          completed_source_count: results.length,
          word_count: results.reduce(
            (sum, item) => sum + countWords(item.transcript),
            0,
          ),
          message: "Transcript ready.",
        },
        results,
      );
    }
    const state: RunningTranscription = {
      view: {
        project_id: request.project_id,
        job_id: `transcription-${randomUUID()}`,
        status: "preparing",
        progress_percent: 0,
        source_count: audioSources.length,
        completed_source_count: results.length,
        word_count: results.reduce(
          (sum, item) => sum + countWords(item.transcript),
          0,
        ),
        message: "Preparing audio for transcription.",
      },
      controller: new AbortController(),
      done: Promise.resolve(),
      results,
    };
    this.jobs.set(request.project_id, state);
    state.done = this.run(state, sources, audioSources);
    return this.view(request.project_id, state.view, state.results);
  }

  async stop(
    request: TranscriptionStopRequest,
  ): Promise<TranscriptionProjectView> {
    assertTranscriptionStopRequest(request);
    const state = this.jobs.get(request.project_id);
    if (
      state?.view.job_id === request.job_id &&
      this.isRunning(request.project_id)
    ) {
      state.controller.abort();
      await state.worker?.close();
      await state.done;
    }
    return this.get(request);
  }

  async closeProject(projectId: string): Promise<void> {
    const job = this.jobs.get(projectId);
    if (job && this.isRunning(projectId)) {
      job.controller.abort();
      await job.worker?.close();
      await job.done;
    }
    this.jobs.delete(projectId);
    this.baselines.delete(projectId);
    this.results.delete(projectId);
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.jobs.keys()].map((projectId) => this.closeProject(projectId)),
    );
  }

  private async run(
    state: RunningTranscription,
    allSources: Source[],
    audioSources: Source[],
  ): Promise<void> {
    let tempDirectory: string | undefined;
    try {
      if (audioSources.length === 0) {
        state.view.status = "failed";
        state.view.progress_percent = null;
        state.view.message = "This project has no audio tracks to transcribe.";
        return;
      }
      await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
      const modelSha256 = await downloadSpeechModelWeights(
        this.modelRoot,
        state.controller.signal,
        ({ completedBytes, totalBytes }) => {
          state.view.status = "downloading_model";
          state.view.message = "Downloading the local speech model.";
          state.view.progress_percent = Math.round(
            (completedBytes / totalBytes) * 25,
          );
        },
      ).catch(() => {
        if (state.controller.signal.aborted) throw new Error("cancelled");
        throw new TranscriptionTaskError(
          "The local speech model could not be downloaded. Try again.",
        );
      });
      if (state.controller.signal.aborted) throw new Error("cancelled");
      state.view.status = "transcribing";
      state.view.progress_percent = 25;
      state.view.message = "Transcribing source audio locally.";
      const worker = new SpeechWorkerClient(
        this.workerPath,
        this.modelRoot,
        (progress) => {
          state.view.status = "transcribing";
          state.view.progress_percent = Math.max(
            state.view.progress_percent ?? 25,
            Math.round(25 + progress * 0.15),
          );
        },
      );
      state.worker = worker;
      await worker.ready(state.controller.signal);
      const pendingSources = audioSources.filter(
        (source) =>
          !state.results.some(
            (result) => result.source_id === source.source_id,
          ),
      );
      const directory = await import("node:fs/promises").then(({ mkdtemp }) =>
        mkdtemp(join(this.tempRoot, `${state.view.job_id}-`)),
      );
      tempDirectory = directory;
      for (const [index, source] of pendingSources.entries()) {
        if (state.controller.signal.aborted) throw new Error("cancelled");
        const path = join(directory, `${source.source_id}.f32le`);
        const prepared = await this.library.prepareSpeechAudio(
          source.source_id,
          path,
          state.controller.signal,
        );
        if (prepared.source.sha256 !== source.sha256)
          throw new Error("The source changed during local transcription.");
        const transcript = await worker.transcribe({
          projectId: state.view.project_id,
          sourceId: source.source_id,
          audioPath: prepared.proxy.path,
          durationUs: source.duration_us,
          sourceStartUs: prepared.sourceStartUs,
          transcriptId: `transcript-${randomUUID()}`,
          modelSha256,
          signal: state.controller.signal,
        });
        const result: TranscriptionSourceResult = {
          source_id: source.source_id,
          transcript,
          analysis: buildTranscriptAnalysis({
            projectId: state.view.project_id,
            sourceId: source.source_id,
            sourceSha256: source.sha256,
            durationUs: source.duration_us,
            silences: prepared.proxy.silences,
          }),
        };
        await this.store.write({
          schema_version: "1.0",
          project_id: state.view.project_id,
          source_id: source.source_id,
          source_sha256: source.sha256,
          model_revision: localSpeechModel.revision,
          transcript,
          analysis: result.analysis,
        });
        state.results = [
          ...state.results.filter(
            (existing) => existing.source_id !== source.source_id,
          ),
          result,
        ].sort(
          (left, right) =>
            allSources.findIndex((item) => item.source_id === left.source_id) -
            allSources.findIndex((item) => item.source_id === right.source_id),
        );
        this.results.set(state.view.project_id, state.results);
        state.view.completed_source_count = state.results.length;
        state.view.word_count = state.results.reduce(
          (total, item) => total + countWords(item.transcript),
          0,
        );
        state.view.progress_percent = Math.round(
          40 + ((index + 1) / pendingSources.length) * 60,
        );
      }
      state.view.status = "completed";
      state.view.progress_percent = 100;
      state.view.message = allSources.some(
        (source) =>
          !source.streams.some((stream) => stream.media_type === "audio"),
      )
        ? "One or more sources have no audio track."
        : "Transcript ready.";
    } catch (error: unknown) {
      state.view.status = state.controller.signal.aborted
        ? "cancelled"
        : "failed";
      state.view.progress_percent = null;
      state.view.message = state.controller.signal.aborted
        ? "Transcription was interrupted. Start it again."
        : error instanceof TranscriptionTaskError
          ? error.userMessage
          : error instanceof MediaError && error.code === "UNSUPPORTED_PROFILE"
            ? "This source's audio timing needs a supported synchronization profile."
            : error instanceof MediaError && error.code === "FIDELITY_MISMATCH"
              ? "The project changed. Reopen it before transcribing."
              : "Local transcription failed. Check this source's audio and try again.";
    } finally {
      await state.worker?.close();
      delete state.worker;
      if (tempDirectory)
        await import("node:fs/promises").then(({ rm }) =>
          rm(tempDirectory!, { recursive: true, force: true }),
        );
    }
  }
}

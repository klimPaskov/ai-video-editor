import { parentPort, workerData } from "node:worker_threads";
import { env, LogLevel, pipeline } from "@huggingface/transformers";
import {
  buildLocalTranscript,
  localSpeechModel,
  localSpeechChunkLengthSeconds,
  localSpeechChunkStrideSeconds,
  normalizeTimedWordChunks,
  readSpeechAudioProxy,
  verifySpeechModelCache,
  type TranscriptBuildFailureReason,
  TranscriptBuildError,
} from "../../../packages/media-engine/src/transcription.ts";

interface WorkerData {
  cacheRoot: string;
  allowModelNetwork: boolean;
}

interface TranscribeRequest {
  type: "transcribe";
  projectId: string;
  sourceId: string;
  audioPath: string;
  durationUs: number;
  sourceStartUs: number;
  transcriptId: string;
  modelSha256: string;
}

type WorkerFailureReason =
  | "model"
  | "audio_proxy"
  | "model_inference"
  | "model_output"
  | `transcript_${TranscriptBuildFailureReason}`;

type WorkerOutput =
  | { type: "model-progress"; progress: number }
  | { type: "ready" }
  | { type: "source-result"; sourceId: string; transcript: unknown }
  | { type: "worker-error"; reason: WorkerFailureReason };

const port = parentPort;
if (!port) throw new Error("Speech worker requires a parent port.");
const configuration = workerData as WorkerData;
let busy = false;

function send(message: WorkerOutput): void {
  port!.postMessage(message);
}

async function main(): Promise<void> {
  if (
    !configuration ||
    typeof configuration.cacheRoot !== "string" ||
    configuration.cacheRoot.length === 0 ||
    typeof configuration.allowModelNetwork !== "boolean"
  )
    throw new Error("Invalid speech-worker configuration.");
  env.cacheDir = configuration.cacheRoot;
  env.allowLocalModels = true;
  env.allowRemoteModels = configuration.allowModelNetwork;
  env.useFS = true;
  env.useFSCache = true;
  env.useBrowserCache = false;
  env.logLevel = LogLevel.ERROR;
  const verifiedModelHash = await verifySpeechModelCache(
    configuration.cacheRoot,
  );
  const transcriber = await pipeline(
    "automatic-speech-recognition",
    localSpeechModel.id,
    {
      revision: localSpeechModel.revision,
      dtype: "q8",
      device: "cpu",
      progress_callback: (event) => {
        if (
          event &&
          typeof event === "object" &&
          "progress" in event &&
          typeof event.progress === "number" &&
          Number.isFinite(event.progress)
        )
          send({
            type: "model-progress",
            progress: Math.max(0, Math.min(100, event.progress)),
          });
      },
    },
  );
  env.allowRemoteModels = false;
  if (
    verifiedModelHash !==
    (await verifySpeechModelCache(configuration.cacheRoot))
  )
    throw new Error("The local speech model changed during initialization.");
  send({ type: "ready" });
  port!.on("message", async (request: TranscribeRequest) => {
    if (busy) {
      send({ type: "worker-error", reason: "model_inference" });
      return;
    }
    busy = true;
    let failureReason: WorkerFailureReason = "audio_proxy";
    try {
      const audio = await readSpeechAudioProxy(request.audioPath);
      failureReason = "model_inference";
      const output = await transcriber(audio, {
        return_timestamps: "word",
        chunk_length_s: localSpeechChunkLengthSeconds,
        stride_length_s: localSpeechChunkStrideSeconds,
        do_sample: false,
        num_beams: 1,
      });
      if (Array.isArray(output))
        throw new Error("Local model returned multiple outputs.");
      failureReason = "model_output";
      let transcript;
      try {
        const chunks = normalizeTimedWordChunks(output.chunks);
        transcript = buildLocalTranscript(
          {
            projectId: request.projectId,
            sourceId: request.sourceId,
            durationUs: request.durationUs,
            sourceStartUs: request.sourceStartUs,
            language: null,
            modelSha256: request.modelSha256,
            transcriptId: request.transcriptId,
          },
          chunks,
        );
      } catch (error) {
        if (error instanceof TranscriptBuildError)
          failureReason = `transcript_${error.reason}`;
        throw error;
      }
      send({ type: "source-result", sourceId: request.sourceId, transcript });
    } catch {
      send({ type: "worker-error", reason: failureReason });
    } finally {
      busy = false;
    }
  });
}

void main().catch(() => send({ type: "worker-error", reason: "model" }));

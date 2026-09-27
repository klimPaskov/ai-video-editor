import { parentPort, workerData } from "node:worker_threads";
import { env, LogLevel, pipeline } from "@huggingface/transformers";
import {
  buildLocalTranscript,
  localSpeechModel,
  readSpeechAudioProxy,
  verifySpeechModelCache,
} from "../../../packages/media-engine/src/transcription.ts";
import type { TimedWordChunk } from "../../../packages/media-engine/src/transcription.ts";

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

interface PipelineWord {
  text: string;
  timestamp: readonly [number, number];
}

type WorkerOutput =
  | { type: "model-progress"; progress: number }
  | { type: "ready" }
  | { type: "source-result"; sourceId: string; transcript: unknown }
  | { type: "worker-error"; reason: "model" | "source" };

const port = parentPort;
if (!port) throw new Error("Speech worker requires a parent port.");
const configuration = workerData as WorkerData;
let busy = false;

function send(message: WorkerOutput): void {
  port!.postMessage(message);
}

function words(value: unknown): TimedWordChunk[] {
  if (!Array.isArray(value))
    throw new Error("Local model did not return word timing.");
  const chunks: TimedWordChunk[] = [];
  for (const item of value as PipelineWord[]) {
    if (
      !item ||
      typeof item.text !== "string" ||
      !Array.isArray(item.timestamp) ||
      item.timestamp.length !== 2 ||
      !item.timestamp.every(
        (part) => typeof part === "number" && Number.isFinite(part),
      )
    )
      throw new Error("Local model returned invalid word timing.");
    chunks.push({ text: item.text, timestamp: item.timestamp });
  }
  return chunks;
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
      send({ type: "worker-error", reason: "source" });
      return;
    }
    busy = true;
    try {
      const audio = await readSpeechAudioProxy(request.audioPath);
      const output = await transcriber(audio, {
        return_timestamps: "word",
        chunk_length_s: 30,
        stride_length_s: 5,
        do_sample: false,
        num_beams: 1,
      });
      if (Array.isArray(output))
        throw new Error("Local model returned multiple outputs.");
      const chunks = words(output.chunks);
      const transcript = buildLocalTranscript(
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
      send({ type: "source-result", sourceId: request.sourceId, transcript });
    } catch {
      send({ type: "worker-error", reason: "source" });
    } finally {
      busy = false;
    }
  });
}

void main().catch(() => send({ type: "worker-error", reason: "model" }));

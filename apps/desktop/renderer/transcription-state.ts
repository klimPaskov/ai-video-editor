import type { Reply } from "../src/bridge.ts";
import type {
  TranscriptionJobRequest,
  TranscriptionProjectView,
} from "../../../packages/domain/src/transcription.ts";

export type ReadTranscription = (
  request: TranscriptionJobRequest,
) => Promise<Reply<TranscriptionProjectView>>;

export interface TranscriptionPollResult {
  view: TranscriptionProjectView | undefined;
  issue: string | null;
}

/** Keep the active job handle when one status request times out or fails. */
export async function pollTranscriptionView(
  projectId: string,
  current: TranscriptionProjectView | undefined,
  read: ReadTranscription,
): Promise<TranscriptionPollResult> {
  const jobId = current?.project_id === projectId ? current.job.job_id : null;
  try {
    const reply = await read({
      schema_version: "1.0",
      project_id: projectId,
      job_id: jobId,
    });
    return reply.ok
      ? { view: reply.value, issue: null }
      : { view: current, issue: reply.message };
  } catch {
    return {
      view: current,
      issue: "Transcript status could not be loaded. Try again.",
    };
  }
}

import assert from "node:assert/strict";
import test from "node:test";
import { pollTranscriptionView } from "../../apps/desktop/renderer/transcription-state.ts";
import type { TranscriptionProjectView } from "../../packages/domain/src/transcription.ts";

test("a timed-out transcription poll keeps the same job ID for the next request", async () => {
  const active: TranscriptionProjectView = {
    project_id: "project-0001",
    job: {
      project_id: "project-0001",
      job_id: "transcription-run-0001",
      status: "transcribing",
      progress_percent: 42,
      source_count: 1,
      completed_source_count: 0,
      word_count: 0,
      message: "Transcribing source audio locally.",
    },
    results: [],
  };
  const requests: string[] = [];
  const timedOut = await pollTranscriptionView(
    active.project_id,
    active,
    async (request) => {
      requests.push(request.job_id ?? "");
      throw new Error("Status request timed out.");
    },
  );
  assert.equal(timedOut.view, active);
  assert.equal(
    timedOut.issue,
    "Transcript status could not be loaded. Try again.",
  );

  const resumed = await pollTranscriptionView(
    active.project_id,
    timedOut.view,
    async (request) => {
      requests.push(request.job_id ?? "");
      return {
        ok: true,
        value: {
          ...active,
          job: {
            ...active.job,
            status: "completed",
            progress_percent: 100,
            message: "Transcript ready.",
          },
        },
      };
    },
  );
  assert.deepEqual(requests, [active.job.job_id, active.job.job_id]);
  assert.equal(resumed.view?.job.status, "completed");
  assert.equal(resumed.issue, null);
});

test("polling a different project does not reuse another project's job ID", async () => {
  const previous: TranscriptionProjectView = {
    project_id: "project-0001",
    job: {
      project_id: "project-0001",
      job_id: "transcription-run-0001",
      status: "cancelled",
      progress_percent: null,
      source_count: 1,
      completed_source_count: 0,
      word_count: 0,
      message: "Transcription was interrupted. Start it again.",
    },
    results: [],
  };
  let requestedJobId: string | null | undefined;
  await pollTranscriptionView("project-0002", previous, async (request) => {
    requestedJobId = request.job_id;
    return { ok: false, message: "Open this project first." };
  });
  assert.equal(requestedJobId, null);
});

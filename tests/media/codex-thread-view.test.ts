import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCodexThreadProjectRequest,
  assertCodexThreadSendRequest,
  assertCodexThreadView,
} from "../../packages/domain/src/codex-thread-view.ts";

test("conversation IPC accepts only compact path-free state and exact intent", () => {
  const view = {
    status: "running",
    projectId: "project-1",
    messages: [
      {
        id: "message-1",
        role: "user",
        text: "Trim the start.",
        complete: true,
      },
      { id: "message-2", role: "codex", text: "Working…", complete: false },
    ],
    activities: [
      {
        id: "activity-1",
        kind: "edit",
        label: "Applying an edit",
        complete: false,
      },
    ],
    message: null,
    retryable: false,
  };
  assertCodexThreadView(view);
  assertCodexThreadProjectRequest({
    schema_version: "1.0",
    project_id: "project-1",
  });
  assertCodexThreadSendRequest({
    schema_version: "1.0",
    project_id: "project-1",
    text: "Trim the start.",
  });
  for (const invalid of [
    { ...view, path: "C:\\private\\recording.mp4" },
    { ...view, status: "closed" },
    { ...view, retryable: true },
    { ...view, status: "ready", messages: [], retryable: true },
    { ...view, projectId: null },
    { ...view, messages: [...view.messages, view.messages[0]] },
    {
      ...view,
      activities: [{ ...view.activities[0], label: "private\0value" }],
    },
  ])
    assert.throws(() => assertCodexThreadView(invalid));
  const missingRetryability = { ...view } as Record<string, unknown>;
  delete missingRetryability.retryable;
  assert.throws(() => assertCodexThreadView(missingRetryability));
  assert.throws(() =>
    assertCodexThreadProjectRequest({
      schema_version: "1.0",
      project_id: "project-1",
      thread_id: "server-owned",
    }),
  );
  assert.throws(() =>
    assertCodexThreadSendRequest({
      schema_version: "1.0",
      project_id: "project-1",
      text: "",
    }),
  );
});

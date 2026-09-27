import assert from "node:assert/strict";
import test from "node:test";
import {
  ThreadStreamProjector,
  threadStreamInternals,
} from "../../packages/codex-bridge/src/thread-stream.ts";
import { CodexThreadProtocolError } from "../../packages/codex-bridge/src/thread-protocol.ts";

function projector(): ThreadStreamProjector {
  return new ThreadStreamProjector({
    experimentalApiNegotiated: true,
    generation: 7,
    threadId: "thread-1",
    allowedMcpServer: "codex-video-edit",
    allowedMcpTools: new Set(["draft.trim"]),
  });
}

test("stream correlation ignores stale generations and rejects divergent lifecycle", () => {
  const stream = projector();
  assert.equal(stream.beginTurn(6, "stale"), null);
  assert.deepEqual(
    stream.observe(7, "turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress", items: [] },
    }),
    {
      type: "turn_started",
      generation: 7,
      threadId: "thread-1",
      turnId: "turn-1",
    },
  );
  assert.equal(stream.beginTurn(7, "turn-1"), null);
  assert.throws(
    () =>
      stream.observe(7, "turn/started", {
        threadId: "thread-1",
        turn: { id: "turn-2", status: "inProgress", items: [] },
      }),
    (error: unknown) =>
      error instanceof CodexThreadProtocolError && error.code === "protocol",
  );
  assert.throws(
    () => stream.observe(7, "account/updated", {}),
    (error: unknown) =>
      error instanceof CodexThreadProtocolError && error.code === "forbidden",
  );
});

test("message projection is bounded and strips paths, credentials and email", () => {
  const stream = projector();
  stream.beginTurn(7, "turn-1");
  stream.observe(7, "item/started", {
    threadId: "thread-1",
    turnId: "turn-1",
    startedAtMs: 1,
    item: { id: "message-1", type: "agentMessage", text: "" },
  });
  const event = stream.observe(7, "item/agentMessage/delta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "message-1",
    delta:
      "Opened C:\\Users\\person\\secret.txt for private@example.test using sk-abcdefghijklmnop.",
  });
  assert.equal(event?.type, "message_delta");
  assert.ok(!JSON.stringify(event).includes("Users"));
  assert.ok(!JSON.stringify(event).includes("private@example"));
  assert.ok(!JSON.stringify(event).includes("sk-"));
  assert.match(JSON.stringify(event), /private path/u);
  assert.deepEqual(
    stream.observe(7, "item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 2,
      item: {
        id: "message-1",
        type: "agentMessage",
        text: "Saved C:\\Users\\person\\secret.txt.",
      },
    }),
    {
      type: "item_completed",
      generation: 7,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "message-1",
      kind: "message",
      text: "Saved [private path]",
    },
  );
  assert.throws(
    () => threadStreamInternals.redactText("x".repeat(16 * 1024 + 1)),
    CodexThreadProtocolError,
  );
});

test("forbidden items and unowned MCP calls fail closed without raw projection", () => {
  for (const item of [
    { id: "command-1", type: "commandExecution", command: "type secret" },
    {
      id: "mcp-1",
      type: "mcpToolCall",
      server: "unowned-server",
      tool: "draft.trim",
      arguments: { path: "C:\\private" },
      status: "inProgress",
    },
  ]) {
    const stream = projector();
    stream.beginTurn(7, "turn-1");
    assert.throws(
      () =>
        stream.observe(7, "item/started", {
          threadId: "thread-1",
          turnId: "turn-1",
          startedAtMs: 1,
          item,
        }),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "forbidden",
    );
    assert.throws(
      () => stream.observe(7, "skills/changed", {}),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "forbidden",
    );
  }
});

test("owned MCP activity omits arguments, results and paths", () => {
  const stream = projector();
  stream.beginTurn(7, "turn-1");
  const event = stream.observe(7, "item/started", {
    threadId: "thread-1",
    turnId: "turn-1",
    startedAtMs: 1,
    item: {
      id: "mcp-1",
      type: "mcpToolCall",
      server: "codex-video-edit",
      tool: "draft.trim",
      arguments: { source: "C:\\private\\source.mp4", token: "SECRET" },
      result: { private: true },
      status: "inProgress",
    },
  });
  assert.deepEqual(event, {
    type: "item_started",
    generation: 7,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "mcp-1",
    kind: "edit",
    label: "Applying an edit",
  });
  assert.ok(!JSON.stringify(event).includes("private"));
  assert.ok(!JSON.stringify(event).includes("SECRET"));
});

test("interrupt response is not terminal; first completion remains authoritative", () => {
  const stream = projector();
  stream.beginTurn(7, "turn-1");
  stream.markInterruptRequested(7, "turn-1");
  assert.deepEqual(
    stream.observe(7, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    }),
    {
      type: "turn_terminal",
      status: "completed",
      generation: 7,
      threadId: "thread-1",
      turnId: "turn-1",
    },
  );
  assert.throws(
    () =>
      stream.observe(7, "turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "interrupted", items: [] },
      }),
    (error: unknown) =>
      error instanceof CodexThreadProtocolError && error.code === "protocol",
  );
});

test("disconnect makes a running turn uncertain and rejects stale reconnect traffic", () => {
  const stream = projector();
  stream.beginTurn(7, "turn-1");
  assert.deepEqual(stream.advanceGeneration(8), {
    type: "connection_uncertain",
    generation: 7,
    threadId: "thread-1",
    turnId: "turn-1",
  });
  assert.equal(
    stream.observe(7, "turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed", items: [] },
    }),
    null,
  );
  assert.equal(stream.currentGeneration(), 8);
  assert.equal(stream.beginTurn(8, "turn-2"), null);
});

test("recent history restores redacted messages and seeds the active turn", () => {
  const stream = projector();
  const history = stream.restoreHistory({
    data: [
      {
        id: "turn-active",
        items: [
          {
            type: "userMessage",
            id: "user-active",
            clientId: "client-active",
            content: [
              { type: "text", text: "Continue the edit", text_elements: [] },
            ],
          },
          {
            type: "agentMessage",
            id: "agent-active",
            text: "Working from /home/person/private.mov",
            phase: null,
            memoryCitation: null,
          },
          {
            type: "mcpToolCall",
            id: "edit-active",
            server: "codex-video-edit",
            tool: "draft.trim",
            status: "inProgress",
            arguments: { token: "SECRET" },
          },
        ],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: 2,
        completedAt: null,
        durationMs: null,
      },
      {
        id: "turn-complete",
        items: [
          {
            type: "userMessage",
            id: "user-complete",
            clientId: "client-complete",
            content: [
              {
                type: "text",
                text: "Trim C:\\Users\\person\\source.mov",
                text_elements: [],
              },
              { type: "skill", name: "timeline-editor", path: "/private" },
            ],
          },
          {
            type: "agentMessage",
            id: "agent-complete",
            text: "Done for private@example.test",
            phase: null,
            memoryCitation: null,
          },
          {
            type: "mcpToolCall",
            id: "edit-complete",
            server: "codex-video-edit",
            tool: "draft.trim",
            status: "completed",
            arguments: { source: "C:\\private" },
          },
        ],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
      },
    ],
    nextCursor: "older-page",
    backwardsCursor: "newer-page",
  });
  assert.equal(history.activeTurnId, "turn-active");
  assert.equal(history.terminalStatus, null);
  assert.equal(history.failureCategory, null);
  assert.equal(history.retryable, false);
  assert.deepEqual(
    history.messages.map(({ role, complete }) => ({ role, complete })),
    [
      { role: "user", complete: true },
      { role: "codex", complete: true },
      { role: "user", complete: true },
      { role: "codex", complete: false },
    ],
  );
  assert.deepEqual(
    history.activities.map(({ kind, complete }) => ({ kind, complete })),
    [
      { kind: "edit", complete: true },
      { kind: "edit", complete: false },
    ],
  );
  assert.ok(!JSON.stringify(history).includes("Users"));
  assert.ok(!JSON.stringify(history).includes("example.test"));
  assert.ok(!JSON.stringify(history).includes("SECRET"));
  assert.deepEqual(
    stream.observe(7, "item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-active",
      itemId: "agent-active",
      delta: " and continuing",
    }),
    {
      type: "message_delta",
      generation: 7,
      threadId: "thread-1",
      turnId: "turn-active",
      itemId: "agent-active",
      text: " and continuing",
    },
  );
});

test("resume retryability comes only from the newest failed user turn", () => {
  const userMessage = (id: string, text: string) => ({
    type: "userMessage",
    id,
    content: [{ type: "text", text, text_elements: [] }],
  });
  const restore = (data: unknown[]) =>
    projector().restoreHistory({
      data,
      nextCursor: null,
      backwardsCursor: null,
    });
  const failed = restore([
    {
      id: "turn-failed-newest",
      items: [userMessage("user-failed-newest", "Retry this request")],
      status: "failed",
      error: {
        message: "private-authentication-error",
        codexErrorInfo: "unauthorized",
        additionalDetails: "private-provider-detail",
        misalignment: null,
      },
    },
    {
      id: "turn-completed-older",
      items: [userMessage("user-completed-older", "Earlier request")],
      status: "completed",
    },
  ]);
  assert.equal(failed.activeTurnId, null);
  assert.equal(failed.terminalStatus, "failed");
  assert.equal(failed.failureCategory, "authentication");
  assert.equal(failed.retryable, true);
  assert.equal(failed.messages.at(-1)?.text, "Retry this request");
  assert.ok(!JSON.stringify(failed).includes("private-authentication-error"));
  assert.ok(!JSON.stringify(failed).includes("private-provider-detail"));

  const completedAfterFailure = restore([
    {
      id: "turn-completed-newest",
      items: [userMessage("user-completed-newest", "Finished request")],
      status: "completed",
    },
    {
      id: "turn-failed-older",
      items: [userMessage("user-failed-older", "Old failed request")],
      status: "failed",
    },
  ]);
  assert.equal(completedAfterFailure.terminalStatus, "completed");
  assert.equal(completedAfterFailure.failureCategory, null);
  assert.equal(completedAfterFailure.retryable, false);

  const interrupted = restore([
    {
      id: "turn-interrupted",
      items: [userMessage("user-interrupted", "Interrupted request")],
      status: "interrupted",
    },
  ]);
  assert.equal(interrupted.terminalStatus, "interrupted");
  assert.equal(interrupted.failureCategory, null);
  assert.equal(interrupted.retryable, false);

  const failedWithoutRequest = restore([
    { id: "turn-failed-without-request", items: [], status: "failed" },
  ]);
  assert.equal(failedWithoutRequest.terminalStatus, "failed");
  assert.equal(failedWithoutRequest.failureCategory, null);
  assert.equal(failedWithoutRequest.retryable, false);

  const failedPromptOutsideBoundedHistory = restore([
    {
      id: "turn-failed-overflow",
      items: [
        userMessage("user-before-bounded-history", "Oldest saved request"),
        ...Array.from({ length: 200 }, (_, index) => ({
          type: "agentMessage",
          id: `agent-${index}`,
          text: "A saved response.",
        })),
      ],
      status: "failed",
    },
  ]);
  assert.equal(failedPromptOutsideBoundedHistory.messages.length, 200);
  assert.equal(
    failedPromptOutsideBoundedHistory.messages.some(
      (message) => message.role === "user",
    ),
    false,
  );
  assert.equal(failedPromptOutsideBoundedHistory.retryable, false);
});

test("live failed turns expose only fixed authentication and rate-limit categories", () => {
  const observeFailure = (id: string, codexErrorInfo: unknown) => {
    const stream = projector();
    stream.beginTurn(7, id);
    return stream.observe(7, "turn/completed", {
      threadId: "thread-1",
      turn: {
        id,
        status: "failed",
        items: [],
        error: {
          message: "private-raw-error",
          codexErrorInfo,
          additionalDetails: "private-detail",
          misalignment: null,
        },
      },
    });
  };
  const authentication = observeFailure("turn-auth-error", "unauthorized");
  assert.equal(authentication?.type, "turn_terminal");
  assert.equal(
    authentication?.type === "turn_terminal"
      ? authentication.failureCategory
      : null,
    "authentication",
  );
  assert.ok(!JSON.stringify(authentication).includes("private-raw-error"));
  assert.ok(!JSON.stringify(authentication).includes("private-detail"));

  const rateLimit = observeFailure("turn-rate-limit", "rateLimitExceeded");
  assert.equal(
    rateLimit?.type === "turn_terminal" ? rateLimit.failureCategory : null,
    "rate_limit",
  );

  const ambiguousHttpUnauthorized = observeFailure("turn-http-unauthorized", {
    httpConnectionFailed: { httpStatusCode: 401 },
  });
  assert.equal(
    ambiguousHttpUnauthorized?.type === "turn_terminal"
      ? ambiguousHttpUnauthorized.failureCategory
      : null,
    "other",
  );

  const malformedErrorCategory = observeFailure(
    "turn-malformed-error-category",
    {
      httpConnectionFailed: { httpStatusCode: 429 },
      unauthorized: true,
    },
  );
  assert.equal(
    malformedErrorCategory?.type === "turn_terminal"
      ? malformedErrorCategory.failureCategory
      : null,
    "other",
  );

  const serviceUnavailable = observeFailure(
    "turn-service-unavailable",
    "serverOverloaded",
  );
  assert.equal(
    serviceUnavailable?.type === "turn_terminal"
      ? serviceUnavailable.failureCategory
      : null,
    "service",
  );
});

test("history rejects non-app inputs, forbidden tools and divergent pagination", () => {
  for (const value of [
    { data: [], nextCursor: null, backwardsCursor: null, private: true },
    {
      data: [
        {
          id: "turn-1",
          items: [
            {
              type: "userMessage",
              id: "user-1",
              content: [{ type: "localImage", path: "/private" }],
            },
          ],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      ],
      nextCursor: null,
      backwardsCursor: null,
    },
    {
      data: [
        {
          id: "turn-1",
          items: [
            {
              type: "mcpToolCall",
              id: "mcp-1",
              server: "other-server",
              tool: "draft.trim",
              status: "completed",
            },
          ],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
        },
      ],
      nextCursor: null,
      backwardsCursor: null,
    },
  ]) {
    const stream = projector();
    assert.throws(
      () => stream.restoreHistory(value),
      (error: unknown) => error instanceof CodexThreadProtocolError,
    );
    assert.throws(
      () => stream.beginTurn(7, "later-turn"),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "forbidden",
    );
  }
});

test("history accepts omitted wire defaults and preserves completed active items", () => {
  const stream = projector();
  const history = stream.restoreHistory({
    data: [
      {
        id: "turn-active",
        items: [
          {
            type: "userMessage",
            id: "user-complete",
            content: [{ type: "text", text: "Keep editing" }],
          },
          {
            type: "mcpToolCall",
            id: "edit-complete",
            server: "codex-video-edit",
            tool: "draft.trim",
            status: "completed",
          },
          {
            type: "collabAgentToolCall",
            id: "subagent-complete",
            status: "failed",
          },
        ],
        status: "inProgress",
      },
    ],
  });
  assert.deepEqual(
    history.activities.map(({ kind, complete }) => ({ kind, complete })),
    [
      { kind: "edit", complete: true },
      { kind: "subagent", complete: true },
    ],
  );
  assert.equal(
    stream.observe(7, "item/completed", {
      threadId: "thread-1",
      turnId: "turn-active",
      completedAtMs: 2,
      item: {
        type: "userMessage",
        id: "user-complete",
        content: [{ type: "text", text: "Keep editing" }],
      },
    }),
    null,
  );
  assert.equal(
    stream.observe(7, "item/completed", {
      threadId: "thread-1",
      turnId: "turn-active",
      completedAtMs: 3,
      item: {
        type: "mcpToolCall",
        id: "edit-complete",
        server: "codex-video-edit",
        tool: "draft.trim",
        status: "completed",
      },
    }),
    null,
  );
});

test("history enforces turn, item, identity and aggregate text bounds", () => {
  const invalidPages = [
    {
      data: Array.from({ length: 101 }, (_, index) => ({
        id: `turn-${index}`,
        items: [],
        status: "completed",
      })),
    },
    {
      data: [
        {
          id: "turn-items",
          items: Array.from({ length: 1001 }, (_, index) => ({
            type: "agentMessage",
            id: `item-${index}`,
            text: "bounded",
          })),
          status: "completed",
        },
      ],
    },
    {
      data: [
        { id: "turn-duplicate", items: [], status: "completed" },
        { id: "turn-duplicate", items: [], status: "completed" },
      ],
    },
    {
      data: [
        {
          id: "turn-duplicate-items",
          items: [
            { type: "agentMessage", id: "item-duplicate", text: "one" },
            { type: "agentMessage", id: "item-duplicate", text: "two" },
          ],
          status: "completed",
        },
      ],
    },
    {
      data: [
        {
          id: "turn-text-budget",
          items: Array.from({ length: 9 }, (_, index) => ({
            type: "agentMessage",
            id: `large-item-${index}`,
            text: "x".repeat(64 * 1024),
          })),
          status: "completed",
        },
      ],
    },
  ];
  for (const page of invalidPages) {
    assert.throws(
      () => projector().restoreHistory(page),
      (error: unknown) =>
        error instanceof CodexThreadProtocolError && error.code === "protocol",
    );
  }
});

test("server user echoes remain correlated without becoming empty Codex replies", () => {
  const stream = projector();
  stream.beginTurn(7, "turn-echo");
  const item = {
    id: "user-echo",
    type: "userMessage",
    content: [{ type: "text", text: "Trim the fixture.", text_elements: [] }],
  };
  assert.equal(
    stream.observe(7, "item/started", {
      threadId: "thread-1",
      turnId: "turn-echo",
      startedAtMs: 1,
      item,
    }),
    null,
  );
  assert.equal(
    stream.observe(7, "item/completed", {
      threadId: "thread-1",
      turnId: "turn-echo",
      completedAtMs: 2,
      item,
    }),
    null,
  );
  assert.equal(
    stream.observe(7, "item/completed", {
      threadId: "thread-1",
      turnId: "turn-echo",
      completedAtMs: 2,
      item,
    }),
    null,
  );
  assert.throws(
    () =>
      stream.observe(7, "item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-echo",
        itemId: "user-echo",
        delta: "Wrong speaker",
      }),
    CodexThreadProtocolError,
  );
});

test("owned read tools report reading activity instead of claiming an edit", () => {
  const stream = new ThreadStreamProjector({
    experimentalApiNegotiated: true,
    generation: 7,
    threadId: "thread-1",
    allowedMcpServer: "codex-video-edit",
    allowedMcpTools: new Set([
      "project.get_summary",
      "timeline.get_summary",
      "transcript.get_range",
    ]),
  });
  stream.beginTurn(7, "turn-read");
  for (const tool of [
    "project.get_summary",
    "timeline.get_summary",
    "transcript.get_range",
  ]) {
    const event = stream.observe(7, "item/started", {
      threadId: "thread-1",
      turnId: "turn-read",
      startedAtMs: 1,
      item: {
        id: tool,
        type: "mcpToolCall",
        server: "codex-video-edit",
        tool,
        status: "inProgress",
      },
    });
    assert.equal(event?.type, "item_started");
    if (event?.type === "item_started") {
      assert.equal(event.kind, "activity");
      assert.equal(
        event.label,
        tool === "transcript.get_range"
          ? "Reading the transcript"
          : "Reading the project",
      );
    }
  }
});

test("owned dynamic transcript reads report activity instead of edits", () => {
  const stream = new ThreadStreamProjector({
    experimentalApiNegotiated: true,
    generation: 7,
    threadId: "thread-1",
    allowedMcpServer: "codex-video-edit",
    allowedMcpTools: new Set<string>(),
    allowedDynamicNamespace: "codex_video_edit",
    allowedDynamicTools: new Set(["transcript_get_range"]),
  });
  stream.beginTurn(7, "turn-transcript");
  const event = stream.observe(7, "item/started", {
    threadId: "thread-1",
    turnId: "turn-transcript",
    startedAtMs: 1,
    item: {
      id: "transcript-read",
      type: "dynamicToolCall",
      namespace: "codex_video_edit",
      tool: "transcript_get_range",
      arguments: { source_start_us: 0, source_end_us: 1000 },
      status: "inProgress",
    },
  });
  assert.equal(event?.type, "item_started");
  if (event?.type === "item_started") {
    assert.equal(event.kind, "activity");
    assert.equal(event.label, "Reading the transcript");
  }
});

test("owned dynamic tool activity hides arguments and survives history restore", () => {
  const options = {
    experimentalApiNegotiated: true as const,
    generation: 7,
    threadId: "thread-1",
    allowedMcpServer: "codex-video-edit",
    allowedMcpTools: new Set<string>(),
    allowedDynamicNamespace: "codex_video_edit",
    allowedDynamicTools: new Set(["project_get_summary", "cut_trim_edge"]),
  };
  const stream = new ThreadStreamProjector(options);
  stream.beginTurn(7, "turn-dynamic");
  const item = {
    id: "dynamic-call",
    type: "dynamicToolCall",
    namespace: "codex_video_edit",
    tool: "cut_trim_edge",
    arguments: { secret: "private-dynamic-argument" },
    status: "inProgress",
  };
  const started = stream.observe(7, "item/started", {
    threadId: "thread-1",
    turnId: "turn-dynamic",
    startedAtMs: 1,
    item,
  });
  assert.equal(started?.type, "item_started");
  if (started?.type === "item_started") {
    assert.equal(started.kind, "edit");
    assert.equal(started.label, "Applying an edit");
  }
  const completed = stream.observe(7, "item/completed", {
    threadId: "thread-1",
    turnId: "turn-dynamic",
    completedAtMs: 2,
    item: {
      ...item,
      status: "completed",
      contentItems: [{ type: "inputText", text: "private-tool-result" }],
      success: true,
    },
  });
  assert.equal(completed?.type, "item_completed");
  assert.doesNotMatch(JSON.stringify([started, completed]), /private-/u);
  const restored = new ThreadStreamProjector(options).restoreHistory({
    data: [
      {
        id: "turn-dynamic",
        items: [{ ...item, status: "completed" }],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
      },
    ],
    nextCursor: null,
  });
  assert.equal(restored.activities[0]?.kind, "edit");
  assert.equal(restored.activities[0]?.complete, true);
  assert.doesNotMatch(JSON.stringify(restored), /private-/u);
});

test("foreign dynamic tool activity remains forbidden", () => {
  const stream = new ThreadStreamProjector({
    experimentalApiNegotiated: true,
    generation: 7,
    threadId: "thread-1",
    allowedMcpServer: "codex-video-edit",
    allowedMcpTools: new Set(),
    allowedDynamicNamespace: "codex_video_edit",
    allowedDynamicTools: new Set(["project_get_summary"]),
  });
  stream.beginTurn(7, "turn-foreign");
  assert.throws(
    () =>
      stream.observe(7, "item/started", {
        threadId: "thread-1",
        turnId: "turn-foreign",
        item: {
          id: "foreign-call",
          type: "dynamicToolCall",
          namespace: "external",
          tool: "project_get_summary",
          status: "inProgress",
        },
      }),
    CodexThreadProtocolError,
  );
});

test("poisoned stream disconnect marks uncertainty once without restoring permissions", () => {
  const stream = projector();
  stream.beginTurn(7, "turn-poisoned");
  assert.throws(
    () =>
      stream.observe(7, "item/started", {
        threadId: "thread-1",
        turnId: "turn-poisoned",
        item: { id: "forbidden-item", type: "commandExecution" },
      }),
    CodexThreadProtocolError,
  );
  assert.deepEqual(stream.disconnect(7), {
    type: "connection_uncertain",
    generation: 7,
    threadId: "thread-1",
    turnId: "turn-poisoned",
  });
  assert.equal(stream.disconnect(7), null);
  assert.throws(
    () => stream.beginTurn(7, "another-turn"),
    CodexThreadProtocolError,
  );
});

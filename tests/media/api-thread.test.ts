import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiProviderThreads } from "../../apps/desktop/src/api-thread.ts";
import type { ApiProviderClient } from "../../packages/api-providers/src/client.ts";
import { ApiProviderError } from "../../packages/api-providers/src/types.ts";
import type { ApiChatCompletion } from "../../packages/api-providers/src/types.ts";
import {
  assertApiThreadProjectRequest,
  assertApiThreadSendRequest,
  assertApiThreadView,
} from "../../packages/domain/src/api-thread-view.ts";

const project = "project-001";
const provider = "deepseek" as const;
const key = "sk-private-secret-123456";
const stop = (content: string): ApiChatCompletion => ({
  model: "deepseek-chat",
  content,
  toolCalls: [],
  finishReason: "stop",
});
const call = (
  name: string,
  input: unknown = { schema_version: "1.0", project_id: project },
  id = "call-001",
): ApiChatCompletion => ({
  model: "deepseek-chat",
  content: null,
  toolCalls: [{ id, name, arguments: JSON.stringify(input) }],
  finishReason: "tool_calls",
});

async function fixture(
  complete: Pick<ApiProviderClient, "complete">["complete"],
  invoke: ConstructorParameters<typeof ApiProviderThreads>[3] = async () => ({
    ok: true,
  }),
  selectedModel = "deepseek-chat",
) {
  const root = await mkdtemp(join(tmpdir(), "api-threads-"));
  const threads = new ApiProviderThreads(
    root,
    { selected: async () => ({ key, model: selectedModel }) },
    { complete },
    invoke,
  );
  return {
    root,
    threads,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("open and reopen are local-only; explicit send persists redacted history", async () => {
  let paid = 0;
  const f = await fixture(async (_provider, _key, request) => {
    paid++;
    assert.equal(request.messages.at(-1)?.role, "user");
    return stop(`Saved at C:\\private\\video.mp4. ${key}`);
  });
  try {
    assert.equal((await f.threads.get(project, provider)).status, "closed");
    assert.equal((await f.threads.open(project, provider)).status, "ready");
    assert.equal(paid, 0);
    const view = await f.threads.send(
      project,
      provider,
      `Check /private/media/file.mp4 ${key}`,
    );
    assert.equal(paid, 1);
    assert.equal(view.status, "ready");
    assert.equal(view.messages.length, 2);
    assertApiThreadView(view);
    const encoded = JSON.stringify(view);
    assert.equal(encoded.includes(key), false);
    assert.equal(encoded.includes("C:\\private"), false);
    assert.equal(encoded.includes("/private/media"), false);
    await f.threads.close(project, provider);
    const files = await readdir(join(f.root, "api-provider-threads"));
    assert.equal(files.length, 1);
    const disk = await readFile(
      join(f.root, "api-provider-threads", files[0]!),
      "utf8",
    );
    assert.equal(disk.includes(key), false);
    assert.equal(disk.includes("/private/media"), false);
    const reopened = new ApiProviderThreads(
      f.root,
      { selected: async () => ({ key, model: "deepseek-chat" }) },
      {
        complete: async () => {
          throw new Error("no paid call on open");
        },
      },
      async () => ({}),
    );
    assert.deepEqual(
      (await reopened.open(project, provider)).messages,
      view.messages,
    );
  } finally {
    await f.cleanup();
  }
});

test("tool calls require exact finish reason, name, schema and active project", async () => {
  const bad: ApiChatCompletion[] = [
    { ...call("project_get_summary"), finishReason: "length" },
    call("file_delete"),
    call("project_get_summary", {
      schema_version: "1.0",
      project_id: "project-002",
    }),
    call("project_get_summary", {
      schema_version: "1.0",
      project_id: project,
      shell: "x",
    }),
    { ...stop("partial"), finishReason: "length" },
  ];
  for (const response of bad) {
    let invoked = 0;
    const f = await fixture(
      async () => response,
      async () => {
        invoked++;
        return {};
      },
    );
    try {
      await f.threads.open(project, provider);
      const view = await f.threads.send(project, provider, "Read the project");
      assert.equal(view.status, "failed");
      assert.equal(view.messages.length, 1);
      assert.equal(invoked, 0);
      assert.match(view.message!, /response/);
    } finally {
      await f.cleanup();
    }
  }
});

test("validated tools execute sequentially within four completions and eight calls", async () => {
  const requests: unknown[] = [];
  const invoked: string[] = [];
  let round = 0;
  const f = await fixture(
    async (_provider, _key, request) => {
      requests.push(request);
      round++;
      if (round <= 3)
        return call("project_get_summary", undefined, `call-00${round}`);
      return stop("The draft was inspected.");
    },
    async (_project, name) => {
      invoked.push(name);
      return { schema_version: "1.0", ok: true };
    },
  );
  try {
    await f.threads.open(project, provider);
    const view = await f.threads.send(project, provider, "Inspect this draft");
    assert.equal(view.status, "ready");
    assert.equal(round, 4);
    assert.deepEqual(invoked, [
      "project.get_summary",
      "project.get_summary",
      "project.get_summary",
    ]);
    assert.equal(view.messages.length, 2);
    assert.equal(JSON.stringify(requests[3]).includes("toolCallId"), true);
    assert.equal(JSON.stringify(requests[3]).includes('"tools"'), false);
  } finally {
    await f.cleanup();
  }
});

test("Gemini replays bounded thought signatures with parallel tool results only in main memory", async () => {
  const signature = "signed-function-part-001";
  let round = 0;
  const invoked: string[] = [];
  const f = await fixture(
    async (selectedProvider, _key, request) => {
      assert.equal(selectedProvider, "gemini");
      round++;
      if (round === 1)
        return {
          model: "gemini-3.8-flash",
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "call-001",
              name: "project_get_summary",
              arguments: JSON.stringify({
                schema_version: "1.0",
                project_id: project,
              }),
              thoughtSignature: signature,
            },
            {
              id: "call-002",
              name: "timeline_get_summary",
              arguments: JSON.stringify({
                schema_version: "1.0",
                project_id: project,
              }),
            },
          ],
        };
      assert.equal(round, 2);
      assert.deepEqual(
        request.messages.map((message) => message.role),
        ["system", "user", "assistant", "tool", "tool"],
      );
      const assistant = request.messages[2];
      assert.equal(assistant?.role, "assistant");
      if (assistant?.role === "assistant") {
        assert.equal(assistant.toolCalls?.[0]?.thoughtSignature, signature);
        assert.equal(assistant.toolCalls?.[1]?.thoughtSignature, undefined);
      }
      assert.equal(request.messages[3]?.role, "tool");
      assert.equal(request.messages[4]?.role, "tool");
      return {
        ...stop("The project was inspected."),
        model: "gemini-3.8-flash",
      };
    },
    async (_project, name) => {
      invoked.push(name);
      return { status: "read" };
    },
    "gemini-3.8-flash",
  );
  try {
    await f.threads.open(project, "gemini");
    const view = await f.threads.send(project, "gemini", "Inspect the draft");
    assert.equal(view.status, "ready");
    assert.deepEqual(invoked, ["project.get_summary", "timeline.get_summary"]);
    assert.equal(JSON.stringify(view).includes(signature), false);
    const stored = await readFile(
      join(f.root, "api-provider-threads", `${project}.gemini.json`),
      "utf8",
    );
    assert.equal(stored.includes(signature), false);
  } finally {
    await f.cleanup();
  }
});

test("Gemini 3 missing first function signature and foreign signature fail before tools run", async () => {
  for (const selectedProvider of ["gemini", "deepseek"] as const) {
    let invoked = 0;
    const f = await fixture(
      async () => ({
        model:
          selectedProvider === "gemini" ? "gemini-3.8-flash" : "deepseek-chat",
        content: null,
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call-001",
            name: "project_get_summary",
            arguments: JSON.stringify({
              schema_version: "1.0",
              project_id: project,
            }),
            ...(selectedProvider === "deepseek"
              ? { thoughtSignature: "untrusted-foreign-signature" }
              : {}),
          },
        ],
      }),
      async () => {
        invoked++;
        return {};
      },
      selectedProvider === "gemini" ? "gemini-3.8-flash" : "deepseek-chat",
    );
    try {
      await f.threads.open(project, selectedProvider);
      const view = await f.threads.send(
        project,
        selectedProvider,
        "Inspect the draft",
      );
      assert.equal(view.status, "failed");
      assert.equal(invoked, 0);
      assert.match(view.message!, /response/u);
    } finally {
      await f.cleanup();
    }
  }
});

test("API providers receive transcript pages only through the bounded read tool", async () => {
  const input = {
    schema_version: "1.0",
    project_id: project,
    source_id: "source-001",
    source_start_us: 0,
    source_end_us: 1_000_000,
    offset: 0,
    limit: 250,
  };
  let round = 0;
  const invoked: Array<[string, unknown]> = [];
  const f = await fixture(
    async (_selectedProvider, _selectedKey, request) => {
      round++;
      if (round === 1) {
        const reader = request.tools?.find(
          (tool) => tool.name === "transcript_get_range",
        );
        assert.ok(reader);
        const parameters = reader.parameters as {
          properties: { limit: { maximum: number } };
          required: string[];
        };
        assert.equal(parameters.properties.limit.maximum, 250);
        assert.ok(parameters.required.includes("source_start_us"));
        assert.ok(parameters.required.includes("source_end_us"));
        assert.equal(parameters.required.includes("transcript_id"), false);
        return call("transcript_get_range", input);
      }
      assert.equal(request.messages.at(-1)?.role, "tool");
      return stop("I reviewed the requested transcript page.");
    },
    async (requestedProject, name, parsed) => {
      assert.equal(requestedProject, project);
      invoked.push([name, parsed]);
      return { transcript_id: "transcript-001", words: [] };
    },
  );
  try {
    await f.threads.open(project, provider);
    const view = await f.threads.send(project, provider, "Review speech");
    assert.equal(view.status, "ready");
    assert.deepEqual(invoked, [["transcript.get_range", input]]);
  } finally {
    await f.cleanup();
  }

  let rejectedInvocations = 0;
  const invalid = await fixture(
    async () => call("transcript_get_range", { ...input, limit: 251 }),
    async () => {
      rejectedInvocations++;
      return {};
    },
  );
  try {
    await invalid.threads.open(project, provider);
    const view = await invalid.threads.send(
      project,
      provider,
      "Review this transcript",
    );
    assert.equal(view.status, "failed");
    assert.equal(rejectedInvocations, 0);
  } finally {
    await invalid.cleanup();
  }
});

test("range-cut function is offered to API providers and routes to the guarded dotted tool", async () => {
  const input = {
    schema_version: "1.0",
    request_id: "api-range-cut-001",
    project_id: project,
    draft_id: "draft-001",
    base_revision_id: "revision-001",
    expected_sequence: 0,
    expected_timeline_sha256: "a".repeat(64),
    pass_group_id: "spoken-cuts-001",
    reason: "Remove the selected pause",
    start_us: 250_000,
    end_us: 750_000,
  };
  let round = 0;
  const invoked: Array<[string, unknown]> = [];
  const f = await fixture(
    async (_provider, _key, request) => {
      round++;
      if (round === 1) {
        assert.ok(
          request.tools?.some((tool) => tool.name === "cut_delete_range"),
        );
        return call("cut_delete_range", input);
      }
      assert.equal(request.messages.at(-1)?.role, "tool");
      return stop("The range cut was committed.");
    },
    async (_project, name, parsed) => {
      invoked.push([name, parsed]);
      return { status: "committed" };
    },
  );
  try {
    await f.threads.open(project, provider);
    const view = await f.threads.send(project, provider, "Cut the pause");
    assert.equal(view.status, "ready");
    assert.deepEqual(invoked, [["cut.delete_range", input]]);
  } finally {
    await f.cleanup();
  }
});

test("split function routes exact clip intent to the guarded shared tool", async () => {
  const input = {
    schema_version: "1.0",
    request_id: "api-split-001",
    project_id: project,
    draft_id: "draft-001",
    base_revision_id: "revision-001",
    expected_sequence: 0,
    expected_timeline_sha256: "a".repeat(64),
    pass_group_id: "spoken-cuts-001",
    reason: "Split at the requested beat",
    clip_id: "clip-001",
    timeline_position_us: 500_000,
  };
  let round = 0;
  const invoked: Array<[string, unknown]> = [];
  const f = await fixture(
    async (_provider, _key, request) => {
      round++;
      if (round === 1) {
        const split = request.tools?.find((tool) => tool.name === "cut_split");
        assert.ok(split);
        assert.ok(Array.isArray(split.parameters.required));
        assert.ok(split.parameters.required.includes("clip_id"));
        assert.ok(split.parameters.required.includes("timeline_position_us"));
        return call("cut_split", input);
      }
      assert.equal(request.messages.at(-1)?.role, "tool");
      return stop("The split was committed.");
    },
    async (_project, name, parsed) => {
      invoked.push([name, parsed]);
      return { status: "committed" };
    },
  );
  try {
    await f.threads.open(project, provider);
    const view = await f.threads.send(project, provider, "Split this clip");
    assert.equal(view.status, "ready");
    assert.deepEqual(invoked, [["cut.split", input]]);
  } finally {
    await f.cleanup();
  }
});

test("range-batch function is offered to API providers and routes unchanged to the guard", async () => {
  const input = {
    schema_version: "1.0",
    request_id: "api-range-batch-001",
    project_id: project,
    draft_id: "draft-001",
    base_revision_id: "revision-001",
    expected_sequence: 0,
    expected_timeline_sha256: "a".repeat(64),
    pass_group_id: "spoken-cuts-001",
    reason: "Remove two confirmed pauses",
    ranges: [
      { start_us: 700_000, end_us: 800_000 },
      { start_us: 100_000, end_us: 200_000 },
    ],
  };
  let round = 0;
  const invoked: Array<[string, unknown]> = [];
  const f = await fixture(
    async (_provider, _key, request) => {
      round++;
      if (round === 1) {
        const batch = request.tools?.find(
          (tool) => tool.name === "cut_delete_ranges",
        );
        assert.ok(batch);
        assert.ok(Array.isArray(batch.parameters.required));
        assert.ok(batch.parameters.required.includes("ranges"));
        return call("cut_delete_ranges", input);
      }
      return stop("The confirmed ranges were committed.");
    },
    async (_project, name, parsed) => {
      invoked.push([name, parsed]);
      return { status: "committed" };
    },
  );
  try {
    await f.threads.open(project, provider);
    const view = await f.threads.send(
      project,
      provider,
      "Cut these two exact ranges",
    );
    assert.equal(view.status, "ready");
    assert.deepEqual(invoked, [["cut.delete_ranges", input]]);
  } finally {
    await f.cleanup();
  }
});

test("tool chain stops at the round limit before an unanswerable edit", async () => {
  let invoked = 0;
  const f = await fixture(
    async () => call("project_get_summary"),
    async () => {
      invoked++;
      return {};
    },
  );
  try {
    await f.threads.open(project, provider);
    const view = await f.threads.send(project, provider, "Keep reading");
    assert.equal(view.status, "failed");
    assert.equal(invoked, 3);
    assert.equal(view.messages.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("tool budget rejects a ninth call without executing it", async () => {
  let round = 0;
  let invoked = 0;
  const first: ApiChatCompletion = {
    model: "deepseek-chat",
    content: null,
    finishReason: "tool_calls",
    toolCalls: Array.from({ length: 8 }, (_, index) => ({
      id: `call-${index + 1}`,
      name: "project_get_summary",
      arguments: JSON.stringify({ schema_version: "1.0", project_id: project }),
    })),
  };
  const f = await fixture(
    async () =>
      ++round === 1 ? first : call("project_get_summary", undefined, "call-9"),
    async () => {
      invoked++;
      return { ok: true };
    },
  );
  try {
    await f.threads.open(project, provider);
    const view = await f.threads.send(project, provider, "Inspect the draft");
    assert.equal(view.status, "failed");
    assert.equal(invoked, 8);
    assert.equal(round, 2);
  } finally {
    await f.cleanup();
  }
});

test("a second Send cannot start while selection is pending; no connection preserves prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "api-threads-"));
  let release!: () => void;
  const selected = new Promise<null>((resolve) => {
    release = () => resolve(null);
  });
  let paid = 0;
  const threads = new ApiProviderThreads(
    root,
    { selected: async () => selected },
    {
      complete: async () => {
        paid++;
        return stop("unused");
      },
    },
    async () => ({}),
  );
  try {
    await threads.open(project, provider);
    const pending = threads.send(project, provider, "Keep my unsent request");
    await assert.rejects(threads.send(project, provider, "Second request"));
    release();
    const view = await pending;
    assert.equal(view.status, "failed");
    assert.equal(view.messages[0]?.text, "Keep my unsent request");
    assert.equal(paid, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupt aborts the paid request without fabricated assistant text or replay", async () => {
  let requests = 0;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(async (_provider, _key, _request, signal) => {
    requests++;
    started();
    return new Promise<ApiChatCompletion>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error(`raw ${key}`)), {
        once: true,
      });
    });
  });
  try {
    await f.threads.open(project, provider);
    const pending = f.threads.send(
      project,
      provider,
      "Please inspect the draft",
    );
    await begun;
    assert.equal(
      (await f.threads.interrupt(project, provider)).status,
      "interrupting",
    );
    const settled = await pending;
    assert.equal(settled.status, "failed");
    assert.equal(settled.messages.length, 1);
    assert.equal(settled.message?.includes(key), false);
    assert.equal(requests, 1);
  } finally {
    await f.cleanup();
  }
});

test("provider errors preserve user prompt but never raw error details", async () => {
  const f = await fixture(async () => {
    throw new Error(`raw endpoint, ${key}`);
  });
  try {
    await f.threads.open(project, provider);
    const view = await f.threads.send(
      project,
      provider,
      "Inspect the current cut",
    );
    assert.equal(view.status, "failed");
    assert.equal(view.messages[0]?.text, "Inspect the current cut");
    assert.equal(view.messages.length, 1);
    const persisted = await readFile(
      join(f.root, "api-provider-threads", `${project}.${provider}.json`),
      "utf8",
    );
    assert.equal(persisted.includes("raw endpoint"), false);
    assert.equal(persisted.includes(key), false);
    await f.threads.close(project, provider);
    assert.equal((await f.threads.open(project, provider)).status, "failed");
  } finally {
    await f.cleanup();
  }
});

test("rate or quota rejection has an actionable redacted conversation error", async () => {
  const f = await fixture(async () => {
    throw new ApiProviderError("rate_limited");
  });
  try {
    await f.threads.open(project, provider);
    const view = await f.threads.send(project, provider, "Trim this fixture");
    assert.equal(view.status, "failed");
    assert.equal(
      view.message,
      "The provider rate or quota limit was reached. Check your API account before sending again.",
    );
    assert.deepEqual(
      view.messages.map((item) => item.role),
      ["user"],
    );
    const persisted = await readFile(
      join(f.root, "api-provider-threads", `${project}.${provider}.json`),
      "utf8",
    );
    assert.ok(!persisted.includes(key));
    assert.ok(!persisted.includes("rate_limited"));
  } finally {
    await f.cleanup();
  }
});

test("revoked API connection has an actionable redacted conversation error", async () => {
  const f = await fixture(async () => {
    throw new ApiProviderError("authentication_failed");
  });
  try {
    await f.threads.open(project, provider);
    const view = await f.threads.send(project, provider, "Inspect the cut");
    assert.equal(view.status, "failed");
    assert.equal(
      view.message,
      "The provider rejected this API connection. Check the key and account access in Settings before sending again.",
    );
    assert.deepEqual(
      view.messages.map((item) => item.role),
      ["user"],
    );
    const persisted = await readFile(
      join(f.root, "api-provider-threads", `${project}.${provider}.json`),
      "utf8",
    );
    assert.ok(!persisted.includes(key));
    assert.ok(!persisted.includes("authentication_failed"));
  } finally {
    await f.cleanup();
  }
});

test("IPC request and view validators reject surplus fields and malformed roles", () => {
  assertApiThreadProjectRequest({
    schema_version: "1.0",
    project_id: project,
    provider,
  });
  assertApiThreadSendRequest({
    schema_version: "1.0",
    project_id: project,
    provider,
    text: "Edit",
  });
  assert.throws(() =>
    assertApiThreadSendRequest({
      schema_version: "1.0",
      project_id: project,
      provider,
      text: "Edit",
      key,
    }),
  );
  assert.throws(() =>
    assertApiThreadProjectRequest({
      schema_version: "1.0",
      project_id: "../outside",
      provider,
    }),
  );
  assert.throws(() =>
    assertApiThreadView({
      status: "ready",
      projectId: project,
      provider,
      messages: [{ id: "message-1", role: "tool", text: "x" }],
      message: null,
    }),
  );
});

test(
  "a linked parent directory cannot redirect conversation history",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "api-threads-linked-"));
    try {
      await mkdir(join(root, "real"));
      await symlink(join(root, "real"), join(root, "linked"), "dir");
      const threads = new ApiProviderThreads(
        join(root, "linked"),
        { selected: async () => null },
        {
          complete: async () => {
            throw new Error("No network expected");
          },
        },
        async () => ({}),
      );
      await assert.rejects(
        threads.open(project, provider),
        /Invalid conversation storage/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

import assert from "node:assert/strict";
import test from "node:test";
import { ApiProviderClient } from "../../packages/api-providers/src/client.ts";
import { ApiProviderError } from "../../packages/api-providers/src/types.ts";
import type { ProviderId } from "../../packages/api-providers/src/types.ts";

const key = "test-provider-key-12345";
const completion = {
  model: "test-model",
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_project", arguments: '{"scope":"draft"}' },
          },
        ],
      },
    },
  ],
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ApiProviderError);
    assert.equal(error.code, code);
    assert.ok(!JSON.stringify(error).includes(key));
    return true;
  };
}

test("each provider uses its pinned HTTPS models and completion endpoint without redirects", async () => {
  const urls: string[] = [];
  const client = new ApiProviderClient({
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${key}`,
      );
      const gemini = String(url).startsWith(
        "https://generativelanguage.googleapis.com/",
      );
      assert.equal(
        new Headers(init?.headers).get("x-goog-api-client"),
        gemini ? "ai-video-editor/0.0.0" : null,
      );
      if (init?.method === "GET")
        return json({ data: [{ id: "test-model" }, { id: "test-model" }] });
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.messages, [
        { role: "user", content: "Trim the start" },
      ]);
      assert.equal(body.stream, false);
      assert.equal(body.max_tokens, gemini ? undefined : 64);
      assert.equal(body.max_completion_tokens, gemini ? 64 : undefined);
      return json(completion);
    },
  });
  for (const provider of ["deepseek", "openai", "gemini"] as const) {
    assert.deepEqual(await client.listModels(provider, key), ["test-model"]);
    assert.deepEqual(
      await client.complete(provider, key, {
        model: "test-model",
        messages: [{ role: "user", content: "Trim the start" }],
        maxTokens: 64,
      }),
      {
        model: "test-model",
        content: null,
        toolCalls: [
          {
            id: "call_1",
            name: "read_project",
            arguments: '{"scope":"draft"}',
          },
        ],
        finishReason: "tool_calls",
      },
    );
  }
  assert.deepEqual(urls, [
    "https://api.deepseek.com/models",
    "https://api.deepseek.com/chat/completions",
    "https://api.openai.com/v1/models",
    "https://api.openai.com/v1/chat/completions",
    "https://generativelanguage.googleapis.com/v1beta/openai/models",
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  ]);
});

test("Gemini preserves a bounded opaque thought signature on the exact parallel tool call", async () => {
  const signature = "opaque+/=_-ASCII09";
  const response = structuredClone(completion);
  response.model = "gemini-3-test";
  response.choices[0]!.message.tool_calls[0] = {
    ...response.choices[0]!.message.tool_calls[0]!,
    extra_content: { google: { thought_signature: signature } },
  } as (typeof response.choices)[number]["message"]["tool_calls"][number];
  response.choices[0]!.message.tool_calls.push({
    id: "call_2",
    type: "function",
    function: { name: "read_project", arguments: '{"scope":"draft"}' },
  });
  let posts = 0;
  const client = new ApiProviderClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      posts++;
      if (posts === 1) {
        assert.equal(body.max_completion_tokens, 4096);
        return json(response);
      }
      assert.deepEqual(body.messages[1], {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_project", arguments: '{"scope":"draft"}' },
            extra_content: { google: { thought_signature: signature } },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "read_project", arguments: '{"scope":"draft"}' },
          },
        ],
      });
      assert.deepEqual(body.messages.slice(2), [
        {
          role: "tool",
          tool_call_id: "call_1",
          name: "read_project",
          content: "{}",
        },
        {
          role: "tool",
          tool_call_id: "call_2",
          name: "read_project",
          content: "{}",
        },
      ]);
      return json({
        model: "gemini-3-test",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Done" },
          },
        ],
      });
    },
  });
  const first = await client.complete("gemini", key, {
    model: "gemini-3-test",
    messages: [{ role: "user", content: "Read the draft" }],
  });
  assert.deepEqual(first.toolCalls, [
    {
      id: "call_1",
      name: "read_project",
      arguments: '{"scope":"draft"}',
      thoughtSignature: signature,
    },
    {
      id: "call_2",
      name: "read_project",
      arguments: '{"scope":"draft"}',
    },
  ]);
  const second = await client.complete("gemini", key, {
    model: "gemini-3-test",
    messages: [
      { role: "user", content: "Read the draft" },
      { role: "assistant", content: null, toolCalls: first.toolCalls },
      { role: "tool", toolCallId: "call_1", content: "{}" },
      { role: "tool", toolCallId: "call_2", content: "{}" },
    ],
  });
  assert.equal(second.content, "Done");
  assert.equal(posts, 2);
});

test("malformed and oversized Gemini thought metadata fails closed", async () => {
  const malformed = [
    { google: { thought_signature: "" } },
    { google: { thought_signature: "bad\nvalue" } },
    { google: { thought_signature: "é" } },
    { google: { thought_signature: "a".repeat(16 * 1024 + 1) } },
    { google: { thought_signature: "ok", secret: "unreviewed" } },
    { google: { thought_signature: "ok" }, other: {} },
    { google: [] },
    { google: { thought_signature: { value: "ok" } } },
  ];
  for (const extra_content of malformed) {
    const response = structuredClone(completion) as unknown as {
      choices: [{ message: { tool_calls: Array<Record<string, unknown>> } }];
    };
    response.choices[0].message.tool_calls[0]!.extra_content = extra_content;
    const client = new ApiProviderClient({
      fetchImpl: async () => json(response),
    });
    await assert.rejects(
      client.complete("gemini", key, {
        model: "gemini-3-test",
        messages: [{ role: "user", content: "hello" }],
      }),
      errorCode("invalid_response"),
    );
  }
});

test("Gemini metadata is not accepted as another provider's completion", async () => {
  const response = structuredClone(completion) as unknown as {
    choices: [{ message: { tool_calls: Array<Record<string, unknown>> } }];
  };
  response.choices[0].message.tool_calls[0]!.extra_content = {
    google: { thought_signature: "opaqueASCII" },
  };
  const client = new ApiProviderClient({
    fetchImpl: async () => json(response),
  });
  for (const provider of ["openai", "deepseek"] as const) {
    await assert.rejects(
      client.complete(provider, key, {
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      }),
      errorCode("invalid_response"),
    );
  }
});

test("thought signatures cannot be replayed to another provider or injected malformed", async () => {
  let calls = 0;
  const client = new ApiProviderClient({
    fetchImpl: async () => {
      calls++;
      return json(completion);
    },
  });
  for (const provider of ["openai", "deepseek", "gemini"] as const) {
    for (const thoughtSignature of ["bad\rvalue", "x".repeat(16 * 1024 + 1)]) {
      await assert.rejects(
        client.complete(provider, key, {
          model: "test-model",
          messages: [
            {
              role: "assistant",
              content: null,
              toolCalls: [
                {
                  id: "call_1",
                  name: "read_project",
                  arguments: "{}",
                  thoughtSignature,
                },
              ],
            },
          ],
        }),
        errorCode("invalid_request"),
      );
    }
  }
  await assert.rejects(
    client.complete("openai", key, {
      model: "test-model",
      messages: [
        {
          role: "assistant",
          content: null,
          toolCalls: [
            {
              id: "call_1",
              name: "read_project",
              arguments: "{}",
              thoughtSignature: "opaqueASCII",
            },
          ],
        },
      ],
    }),
    errorCode("invalid_request"),
  );
  await assert.rejects(
    client.complete("gemini", key, {
      model: "test-model",
      messages: [
        { role: "user", content: "hello" },
        { role: "tool", toolCallId: "call_1", content: "{}" },
      ],
    }),
    errorCode("invalid_request"),
  );
  assert.equal(calls, 0);
});

test("an arbitrary provider or endpoint is rejected before any network request", async () => {
  let calls = 0;
  const client = new ApiProviderClient({
    fetchImpl: async () => {
      calls++;
      return json({ data: [] });
    },
  });
  await assert.rejects(
    client.listModels("https://private.invalid" as ProviderId, key),
    errorCode("invalid_request"),
  );
  assert.equal(calls, 0);
});

test("redirected and cross-origin responses are rejected without leaking response data", async () => {
  const redirected = json({ data: [] });
  Object.defineProperty(redirected, "redirected", { value: true });
  const crossOrigin = json({ data: [] });
  Object.defineProperty(crossOrigin, "url", {
    value: "https://other.invalid/models",
  });
  for (const response of [redirected, crossOrigin]) {
    const client = new ApiProviderClient({ fetchImpl: async () => response });
    await assert.rejects(
      client.listModels("deepseek", key),
      errorCode("invalid_response"),
    );
  }
});

test("provider failures discard raw errors, bodies, and response headers", async () => {
  for (const [status, expected] of [
    [401, "authentication_failed"],
    [403, "authentication_failed"],
    [429, "rate_limited"],
    [500, "provider_rejected"],
  ] as const) {
    const client = new ApiProviderClient({
      fetchImpl: async () =>
        new Response(`private ${key}`, {
          status,
          headers: { "x-private": key },
        }),
    });
    await assert.rejects(client.listModels("openai", key), errorCode(expected));
  }
  const thrown = new ApiProviderClient({
    fetchImpl: async () => {
      throw new Error(`network exposed ${key}`);
    },
  });
  await assert.rejects(
    thrown.listModels("openai", key),
    errorCode("network_error"),
  );
});

test("oversized and malformed provider bodies fail closed", async () => {
  const badResponses = [
    new Response("{}", { headers: { "content-length": "99999999" } }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
    json({ data: [{ id: "bad\nmodel" }] }),
    json({ data: "not a list" }),
  ];
  for (const response of badResponses) {
    const client = new ApiProviderClient({ fetchImpl: async () => response });
    await assert.rejects(
      client.listModels("deepseek", key),
      errorCode("invalid_response"),
    );
  }
});

test("tool calls stay unexecuted and malformed arguments are rejected", async () => {
  const raw = structuredClone(completion);
  raw.choices[0]!.message.tool_calls[0]!.function.arguments = "{bad json";
  const client = new ApiProviderClient({ fetchImpl: async () => json(raw) });
  await assert.rejects(
    client.complete("deepseek", key, {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
    }),
    errorCode("invalid_response"),
  );
});

test("request bounds prevent unbounded content or tools before network access", async () => {
  let calls = 0;
  const client = new ApiProviderClient({
    fetchImpl: async () => {
      calls++;
      return json(completion);
    },
  });
  for (const request of [
    { model: "bad\nmodel", messages: [{ role: "user", content: "hello" }] },
    {
      model: "test-model",
      messages: [{ role: "user", content: "x".repeat(33000) }],
    },
    {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      maxTokens: 99999,
    },
    {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      tools: Array.from({ length: 9 }, (_, i) => ({
        name: `tool_${i}`,
        description: "test",
        parameters: { type: "object" },
      })),
    },
  ]) {
    await assert.rejects(
      client.complete(
        "openai",
        key,
        request as Parameters<typeof client.complete>[2],
      ),
      errorCode("invalid_request"),
    );
  }
  assert.equal(calls, 0);
});

test("caller cancellation aborts a pending request and returns a fixed error", async () => {
  const controller = new AbortController();
  const client = new ApiProviderClient({
    fetchImpl: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(key)), {
          once: true,
        });
      }),
  });
  const request = client.listModels("openai", key, controller.signal);
  controller.abort();
  await assert.rejects(request, errorCode("request_cancelled"));
});

test("request deadline aborts a pending provider call", async () => {
  const client = new ApiProviderClient({
    timeoutMs: 100,
    fetchImpl: (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(key)), {
          once: true,
        });
      }),
  });
  await assert.rejects(
    client.listModels("openai", key),
    errorCode("request_timeout"),
  );
});

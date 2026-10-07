import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { CodexClient } from "../../packages/codex-bridge/src/client.ts";
import {
  decodeAccount,
  decodeInitialization,
  decodeModels,
  decodeSkills,
} from "../../packages/codex-bridge/src/metadata.ts";
import { CodexTransportError } from "../../packages/codex-bridge/src/transport.ts";

test("account metadata accepts ChatGPT account type and strips private fields", () => {
  assert.deepEqual(decodeAccount({ requiresOpenaiAuth: true, account: null }), {
    status: "signed_out",
  });
  assert.deepEqual(
    decodeAccount({
      requiresOpenaiAuth: true,
      account: {
        type: "chatgpt",
        email: "private@example.test",
        planType: "pro",
        token: "PRIVATE",
      },
    }),
    { status: "chatgpt", plan: "pro" },
  );
  for (const value of [
    {},
    { requiresOpenaiAuth: false },
    { requiresOpenaiAuth: true, account: { type: "apiKey" } },
    { requiresOpenaiAuth: true, account: { type: "amazonBedrock" } },
    {
      requiresOpenaiAuth: true,
      account: {
        type: "chatgpt",
        email: null,
        planType: "PRIVATE_UNKNOWN_PLAN",
      },
    },
  ])
    assert.throws(() => decodeAccount(value), CodexTransportError);
});

const model = {
  id: "dynamic-id",
  model: "runtime-model",
  displayName: "Runtime model",
  description: "Runtime description",
  hidden: false,
  isDefault: true,
  multiAgentVersion: "v2",
  supportedReasoningEfforts: [
    { reasoningEffort: "runtime-effort", description: "Runtime effort" },
  ],
  defaultReasoningEffort: "runtime-effort",
  privateField: "PRIVATE",
};
test("model metadata is runtime-derived, bounded, paginated and detached", () => {
  const result = decodeModels({ data: [model], nextCursor: "opaque" });
  assert.equal(result.cursor, "opaque");
  assert.equal(result.models[0]?.multiAgentVersion, "v2");
  assert.deepEqual(result.models[0]?.reasoning, ["runtime-effort"]);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.deepEqual(
    decodeModels({ data: [{ ...model, hidden: true }] }).models,
    [],
  );
  for (const data of [
    [model, model],
    [{ ...model, defaultReasoningEffort: "unsupported" }],
    [{ ...model, hidden: "false" }],
    [{ ...model, multiAgentVersion: "unexpected" }],
  ])
    assert.throws(() => decodeModels({ data }), CodexTransportError);
  assert.throws(
    () => decodeModels({ data: [], nextCursor: "" }),
    CodexTransportError,
  );
});

test("skills cannot silently substitute a different context or hide scan errors", () => {
  const skill = {
    name: "local-skill",
    description: "Local guidance",
    enabled: true,
    path: "/private/skill",
    token: "PRIVATE",
  };
  assert.deepEqual(
    decodeSkills(
      { data: [{ cwd: "/context", skills: [skill], errors: [] }] },
      "/context",
    ),
    [{ name: skill.name, description: skill.description, enabled: true }],
  );
  for (const entry of [
    { cwd: "/other", skills: [], errors: [] },
    { cwd: "/context", skills: [], errors: [{}] },
    { cwd: "/context", skills: [{ ...skill, enabled: 1 }], errors: [] },
  ])
    assert.throws(
      () => decodeSkills({ data: [entry] }, "/context"),
      CodexTransportError,
    );
});

test("initialization metadata rejects missing fields and excludes extra data", () => {
  assert.throws(
    () => decodeInitialization({ userAgent: "old" }),
    CodexTransportError,
  );
  assert.deepEqual(
    decodeInitialization({
      userAgent: "runtime",
      codexHome: "/private",
      platformFamily: "unix",
      platformOs: "linux",
      credentials: "PRIVATE",
    }),
    {
      userAgent: "runtime",
      codexHome: "/private",
      platformFamily: "unix",
      platformOs: "linux",
    },
  );
});

test("client rejects non-Codex executable versions and supports safe close during startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-client-"));
  const client = new CodexClient({
    executable: process.execPath,
    cwd: root,
    codexHome: root,
    environment: {
      SystemRoot: process.env.SystemRoot,
      OPENAI_API_KEY: "PRIVATE",
    },
  });
  try {
    await assert.rejects(client.account(), CodexTransportError);
    await assert.rejects(client.startLogin(), CodexTransportError);
    await assert.rejects(client.cancelLogin(), CodexTransportError);
    await assert.rejects(client.logout(), CodexTransportError);
    await assert.rejects(client.rateLimits(), CodexTransportError);
    assert.deepEqual(client.authState(), {
      status: "idle",
      account: null,
      error: null,
    });
    await assert.rejects(
      client.connect(),
      (error: unknown) =>
        error instanceof CodexTransportError && error.code === "protocol",
    );
    const opening = client.connect();
    const rejection = assert.rejects(
      opening,
      (error: unknown) =>
        error instanceof CodexTransportError && error.code === "closed",
    );
    await client.close();
    await rejection;
    assert.throws(
      () =>
        new CodexClient({
          executable: "relative",
          cwd: resolve("."),
          codexHome: root,
          environment: {},
        }),
      CodexTransportError,
    );
  } finally {
    await client.close();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopApiProviders,
  editingModels,
} from "../../apps/desktop/src/api-providers.ts";
import {
  assertApiProvidersView,
  type ApiProviderId,
} from "../../packages/domain/src/api-providers.ts";

const testKey = "TEST-ONLY-PROVIDER-KEY";
test("model chooser intersects live IDs with reviewed Chat Completions families", () => {
  assert.deepEqual(
    editingModels("openai", [
      "babbage-002",
      "gpt-4.1",
      "gpt-4.1-mini-2025-04-14",
      "gpt-4o-mini",
      "gpt-4o-realtime-preview",
      "gpt-5",
      "text-embedding-3-large",
    ]),
    ["gpt-4.1", "gpt-4.1-mini-2025-04-14", "gpt-4o-mini"],
  );
  assert.deepEqual(
    editingModels("deepseek", [
      "deepseek-flash",
      "deepseek-v4-pro",
      "deepseek-embedding",
    ]),
    ["deepseek-flash", "deepseek-v4-pro"],
  );
  assert.deepEqual(
    editingModels("gemini", [
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-2.5-flash-image",
      "gemini-3.8-live",
      "gemini-3.8-live-extended-thinking",
      "gemini-3.8-flash-tts",
      "gemini-3.8-flash-lite-tts",
      "gemini-3.5-transcribe",
      "gemini-3.1-flash-tts-preview",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-embedding-001",
    ]),
    [
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-2.5-pro",
    ],
  );
});

test("provider view requires exactly one state for each fixed provider", () => {
  const entry = (id: ApiProviderId) => ({
    id,
    connected: false,
    remembered: false,
    canRemember: true,
    models: [],
    selectedModel: null,
    busy: false,
    message: null,
  });
  assertApiProvidersView({
    providers: [entry("deepseek"), entry("openai"), entry("gemini")],
  });
  assert.throws(() =>
    assertApiProvidersView({
      providers: [entry("deepseek"), entry("openai"), entry("openai")],
    }),
  );
  assert.throws(() =>
    assertApiProvidersView({ providers: [entry("deepseek"), entry("openai")] }),
  );
});

test("an authenticated catalog with no compatible models stays disconnected", async () => {
  const account = new DesktopApiProviders(
    {
      get: async () => null,
      getModel: async () => null,
      status: async () => ({
        hasKey: false,
        remembered: false,
        canRemember: true,
      }),
      set: async () => {
        throw new Error("Must not store unsupported key");
      },
      setModel: async () => undefined,
      remove: async () => undefined,
    },
    { listModels: async () => ["babbage-002", "text-embedding-3-large"] },
  );
  const view = await account.connect({
    provider: "openai",
    key: testKey,
    remember: false,
  });
  assert.equal(view.providers[1]?.connected, false);
  assert.equal(
    view.providers[1]?.message,
    "No supported editing models are available for this key.",
  );
});
function harness(canRemember: boolean) {
  const keys = new Map<ApiProviderId, { value: string; remembered: boolean }>();
  const savedModels = new Map<ApiProviderId, string>();
  const calls: { provider: ApiProviderId; key: string }[] = [];
  const account = new DesktopApiProviders(
    {
      get: async (provider) => keys.get(provider)?.value ?? null,
      getModel: async (provider) => savedModels.get(provider) ?? null,
      status: async (provider) => ({
        hasKey: keys.has(provider),
        remembered: keys.get(provider)?.remembered ?? false,
        canRemember,
      }),
      set: async (provider, key, { remember }) => {
        keys.set(provider, { value: key, remembered: remember });
        savedModels.delete(provider);
        return { hasKey: true, remembered: remember, canRemember };
      },
      setModel: async (provider, model) => {
        savedModels.set(provider, model);
      },
      remove: async (provider) => {
        keys.delete(provider);
        savedModels.delete(provider);
      },
    },
    {
      listModels: async (provider, key) => {
        calls.push({ provider, key });
        if (key === "INVALID-KEY") throw new Error(`PRIVATE ${key}`);
        return provider === "deepseek"
          ? ["deepseek-flash"]
          : provider === "openai"
            ? ["gpt-4.1"]
            : ["gemini-3.8-flash", "gemini-3.8-live"];
      },
    },
  );
  return { account, calls, keys, savedModels };
}

test("explicit API-key connection discovers separate catalogs without exposing keys", async () => {
  const { account, calls } = harness(true);
  assert.equal((await account.get()).providers[0]?.connected, false);
  let view = await account.connect({
    provider: "deepseek",
    key: testKey,
    remember: true,
  });
  assert.equal(view.providers[0]?.remembered, true);
  assert.deepEqual(view.providers[0]?.models, ["deepseek-flash"]);
  assert.ok(!JSON.stringify(view).includes(testKey));
  view = await account.selectModel({
    provider: "deepseek",
    model: "deepseek-flash",
  });
  assert.equal(view.providers[0]?.selectedModel, "deepseek-flash");
  assert.deepEqual(await account.selected("deepseek"), {
    key: testKey,
    model: "deepseek-flash",
  });
  await assert.rejects(
    account.selectModel({ provider: "deepseek", model: "fabricated" }),
  );
  view = await account.connect({
    provider: "openai",
    key: testKey,
    remember: false,
  });
  assert.deepEqual(view.providers[1]?.models, ["gpt-4.1"]);
  assert.deepEqual(
    calls.map((entry) => entry.provider),
    ["deepseek", "openai"],
  );
  view = await account.remove({ provider: "deepseek" });
  assert.equal(view.providers[0]?.connected, false);
  assert.equal(await account.selected("deepseek"), null);
});

test("Gemini key and live model selection stay separate from other providers", async () => {
  const { account, calls, keys, savedModels } = harness(true);
  await account.connect({ provider: "openai", key: testKey, remember: true });
  await account.selectModel({ provider: "openai", model: "gpt-4.1" });
  let view = await account.connect({
    provider: "gemini",
    key: "TEST-ONLY-GEMINI-KEY",
    remember: true,
  });
  assert.deepEqual(view.providers[2]?.models, ["gemini-3.8-flash"]);
  assert.equal(view.providers[2]?.selectedModel, null);
  await assert.rejects(
    account.selectModel({ provider: "gemini", model: "gemini-3.8-live" }),
  );
  view = await account.selectModel({
    provider: "gemini",
    model: "gemini-3.8-flash",
  });
  assert.equal(view.providers[2]?.selectedModel, "gemini-3.8-flash");
  assert.equal(view.providers[1]?.selectedModel, "gpt-4.1");
  assert.equal(savedModels.get("gemini"), "gemini-3.8-flash");
  assert.deepEqual(await account.selected("gemini"), {
    key: "TEST-ONLY-GEMINI-KEY",
    model: "gemini-3.8-flash",
  });
  assert.deepEqual(
    calls.map((call) => call.provider),
    ["openai", "gemini"],
  );
  view = await account.connect({
    provider: "gemini",
    key: "REPLACEMENT-GEMINI-KEY",
    remember: true,
  });
  assert.equal(view.providers[2]?.selectedModel, null);
  assert.equal(savedModels.has("gemini"), false);
  assert.equal(view.providers[1]?.selectedModel, "gpt-4.1");
  view = await account.remove({ provider: "gemini" });
  assert.equal(view.providers[2]?.connected, false);
  assert.equal(keys.has("gemini"), false);
  assert.equal(view.providers[1]?.selectedModel, "gpt-4.1");
  assert.ok(!JSON.stringify(view).includes("TEST-ONLY-GEMINI-KEY"));
});

test("remembered choice restores only after live catalog revalidation", async () => {
  const { account, keys, savedModels } = harness(true);
  await account.connect({ provider: "openai", key: testKey, remember: true });
  await account.selectModel({ provider: "openai", model: "gpt-4.1" });
  assert.equal(savedModels.get("openai"), "gpt-4.1");
  const store = {
    get: async (provider: ApiProviderId) => keys.get(provider)?.value ?? null,
    getModel: async (provider: ApiProviderId) =>
      savedModels.get(provider) ?? null,
    status: async (provider: ApiProviderId) => ({
      hasKey: keys.has(provider),
      remembered: keys.get(provider)?.remembered ?? false,
      canRemember: true,
    }),
    set: async () => {
      throw new Error("Connection is not needed on reopen");
    },
    setModel: async () => undefined,
    remove: async () => undefined,
  };
  const restarted = new DesktopApiProviders(store, {
    listModels: async () => ["gpt-4.1", "gpt-4o"],
  });
  assert.equal((await restarted.get()).providers[1]?.selectedModel, "gpt-4.1");
  const changedCatalog = new DesktopApiProviders(store, {
    listModels: async () => ["gpt-4o"],
  });
  assert.equal((await changedCatalog.get()).providers[1]?.selectedModel, null);
  await account.connect({
    provider: "openai",
    key: "REPLACEMENT-PROVIDER-KEY",
    remember: true,
  });
  assert.equal(savedModels.get("openai"), undefined);
  assert.equal((await account.get()).providers[1]?.selectedModel, null);
});

test("failed model persistence leaves the previous selection intact", async () => {
  const account = new DesktopApiProviders(
    {
      get: async () => testKey,
      getModel: async () => null,
      status: async () => ({
        hasKey: true,
        remembered: true,
        canRemember: true,
      }),
      set: async () => {
        throw new Error("Unexpected key replacement");
      },
      setModel: async () => {
        throw new Error(`PRIVATE ${testKey}`);
      },
      remove: async () => undefined,
    },
    { listModels: async () => ["gpt-4.1"] },
  );
  const view = await account.selectModel({
    provider: "openai",
    model: "gpt-4.1",
  });
  assert.equal(view.providers[1]?.selectedModel, null);
  assert.equal(
    view.providers[1]?.message,
    "Model choice could not be saved. Try again.",
  );
  assert.ok(!JSON.stringify(view).includes(testKey));
});

test("insecure persistence and invalid credentials never replace a working key", async () => {
  const { account, calls } = harness(false);
  let view = await account.connect({
    provider: "deepseek",
    key: testKey,
    remember: true,
  });
  assert.equal(view.providers[0]?.connected, false);
  assert.equal(
    view.providers[0]?.message,
    "Secure storage is unavailable. Use this session only.",
  );
  assert.equal(calls.length, 0);
  view = await account.connect({
    provider: "deepseek",
    key: testKey,
    remember: false,
  });
  assert.equal(view.providers[0]?.connected, true);
  view = await account.connect({
    provider: "deepseek",
    key: "INVALID-KEY",
    remember: false,
  });
  assert.equal(
    view.providers[0]?.message,
    "Connection failed. Check the key and try again.",
  );
  assert.equal(view.providers[0]?.connected, true);
  assert.ok(!JSON.stringify(view).includes("INVALID-KEY"));
});

test("a saved key with an unavailable secure backend stays removable", async () => {
  let removed = false;
  const account = new DesktopApiProviders(
    {
      get: async () => null,
      getModel: async () => null,
      status: async () => ({
        hasKey: false,
        remembered: !removed,
        canRemember: false,
      }),
      set: async () => {
        throw new Error("Unavailable");
      },
      setModel: async () => undefined,
      remove: async () => {
        removed = true;
      },
    },
    { listModels: async () => [] },
  );
  const view = await account.get();
  assert.equal(view.providers[0]?.connected, false);
  assert.equal(view.providers[0]?.remembered, true);
  assert.match(view.providers[0]?.message ?? "", /unavailable/);
  assert.equal(
    (await account.remove({ provider: "deepseek" })).providers[0]?.remembered,
    false,
  );
});

test("temporary key-read failure does not permanently suppress model discovery", async () => {
  let reads = 0;
  const account = new DesktopApiProviders(
    {
      get: async () => {
        if (++reads === 1) throw new Error("Temporary protected-store failure");
        return testKey;
      },
      getModel: async () => null,
      status: async () => ({
        hasKey: true,
        remembered: true,
        canRemember: true,
      }),
      set: async () => ({ hasKey: true, remembered: true, canRemember: true }),
      setModel: async () => undefined,
      remove: async () => undefined,
    },
    { listModels: async () => ["deepseek-chat"] },
  );
  assert.deepEqual((await account.get()).providers[0]?.models, []);
  assert.deepEqual((await account.get()).providers[0]?.models, [
    "deepseek-chat",
  ]);
  assert.equal(reads >= 2, true);
});

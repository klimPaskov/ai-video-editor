/** Real protected-key and live-model restart in packaged isolated Electron. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "playwright/test";
import type { ApiProviderId } from "../../packages/domain/src/api-providers.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
assert.equal(process.env.XDG_CURRENT_DESKTOP, "GNOME");
assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS);
await access("/.dockerenv");
const executablePath = process.argv[2];
const privateKeyPath = process.argv[3];
const providerArgument = process.argv.find((argument) =>
  argument.startsWith("--provider="),
);
const providerValue = providerArgument?.slice("--provider=".length) ?? "openai";
if (!(["deepseek", "openai", "gemini"] as string[]).includes(providerValue))
  throw new Error("Unsupported provider test selection");
const provider = providerValue as ApiProviderId;
if (
  !executablePath?.startsWith("/home/node/") ||
  !privateKeyPath?.startsWith("/home/node/browser-test/test-results/")
)
  throw new Error("Native test inputs must stay in the isolated guest");
const keyStat = await lstat(privateKeyPath);
if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.mode & 0o077)
  throw new Error("Private key input is not restricted");
let key: string;
try {
  key = (await readFile(privateKeyPath, "utf8")).trim();
} finally {
  await unlink(privateKeyPath);
}
if (key.length < 8 || key.length > 1024 || !/^[\x21-\x7e]+$/u.test(key))
  throw new Error("Invalid private key input");

const evidence = await mkdtemp(
  join(resolve("test-results"), "native-remembered-model-"),
);
await chmod(evidence, 0o700);
const configRoot = await mkdtemp(join(evidence, "account-"));
await chmod(configRoot, 0o700);
const keyFile = join(
  configRoot,
  `ai-video-editor/api-provider-keys/${provider}.key`,
);
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const resources = join(dirname(executablePath), "resources");
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify({
    asarHash: sha(await readFile(join(resources, "app.asar"))),
    testHash: sha(await readFile(fileURLToPath(import.meta.url))),
  }),
);

let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let step = "launch";
let passed = false;
try {
  const launch = async () =>
    _electron.launch({
      executablePath,
      chromiumSandbox: true,
      env: { ...process.env, DISPLAY: ":99", XDG_CONFIG_HOME: configRoot },
      timeout: 30000,
    });
  const openSettings = async () => {
    assert.ok(electron);
    const page = await electron.firstWindow();
    assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(page.url(), "ai-video-editor://app/index.html");
    const storage = await electron.evaluate(({ safeStorage }) => ({
      available: safeStorage.isEncryptionAvailable(),
      backend: safeStorage.getSelectedStorageBackend(),
    }));
    assert.deepEqual(storage, { available: true, backend: "gnome_libsecret" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", { name: "API providers", exact: true })
      .click();
    await page.locator("#api-provider-id").selectOption(provider);
    return page;
  };

  electron = await launch();
  let page = await openSettings();
  step = "remember-key-and-model";
  await expect(page.locator("#api-provider-remember")).toBeEnabled();
  await page.locator("#api-provider-remember").check();
  await page.locator("#api-provider-key").fill(key);
  await page.locator("#api-provider-connect").click();
  await expect(page.locator("#api-provider-key")).toHaveValue("");
  await expect(page.locator("#api-provider-status")).toHaveText(
    "Key saved on this device",
    { timeout: 90000 },
  );
  const connected = await page.evaluate(() => window.desktop.getApiProviders());
  assert.ok(connected.ok);
  const account = connected.value.providers.find(
    (item) => item.id === provider,
  );
  assert.ok(
    account?.connected && account.remembered && account.models.length > 0,
  );
  assert.ok(!JSON.stringify(connected.value).includes(key));
  const model =
    (provider === "openai"
      ? account.models.find((id) => id === "gpt-4.1-mini")
      : undefined) ?? account.models[0]!;
  await page.locator("#api-provider-model").selectOption(model);
  await expect(page.locator("#api-provider-model")).toHaveValue(model);
  await expect
    .poll(async () => {
      const result = await page.evaluate(() =>
        window.desktop.getApiProviders(),
      );
      return result.ok
        ? result.value.providers.find((item) => item.id === provider)
            ?.selectedModel
        : null;
    })
    .toBe(model);
  const saved = await lstat(keyFile);
  assert.ok(saved.isFile() && !saved.isSymbolicLink() && saved.nlink === 1);
  assert.equal(saved.mode & 0o077, 0);
  const bytes = await readFile(keyFile);
  assert.ok(!bytes.includes(Buffer.from(key)));
  assert.ok(!bytes.includes(Buffer.from(model)));
  step = "protected-restart";
  await electron.close();
  electron = await launch();
  page = await openSettings();
  await expect(page.locator("#api-provider-status")).toHaveText(
    "Key saved on this device",
    { timeout: 90000 },
  );
  await expect(page.locator("#api-provider-model")).toHaveValue(model);
  await expect(page.locator("#api-provider-key")).toHaveValue("");
  const reopened = await page.evaluate(() => window.desktop.getApiProviders());
  assert.ok(reopened.ok);
  const restored = reopened.value.providers.find(
    (item) => item.id === provider,
  );
  assert.ok(restored?.connected && restored.remembered);
  assert.equal(restored.selectedModel, model);
  assert.ok(restored.models.includes(model));
  assert.ok(!JSON.stringify(reopened.value).includes(key));
  await page.screenshot({
    path: join(evidence, "native-remembered-private.png"),
  });
  if (process.argv.includes("--inspect")) {
    console.log(JSON.stringify({ inspectionReady: true, evidence }));
    const deadline = Date.now() + 300000;
    while (true) {
      try {
        await access(join(evidence, "inspection.done"));
        break;
      } catch {
        /* Guest-only visual inspection releases the hold. */
      }
      if (Date.now() > deadline) throw new Error("Inspection timeout");
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  step = "remove-protected-key";
  await page.locator("#api-provider-remove").click();
  await expect(page.locator("#api-provider-status")).toHaveText(
    "Add a key to discover models",
  );
  const removed = await page.evaluate(() => window.desktop.getApiProviders());
  assert.ok(removed.ok);
  const disconnected = removed.value.providers.find(
    (item) => item.id === provider,
  );
  assert.ok(
    disconnected && !disconnected.connected && !disconnected.remembered,
  );
  assert.equal(disconnected.selectedModel, null);
  await assert.rejects(access(keyFile));
  passed = true;
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({
      status: "pass",
      scope: "P2-packaged-remembered-api-model",
      provider,
      packagedNativeWindow: true,
      secureBackend: "gnome_libsecret",
      authenticatedCatalog: true,
      protectedKeyWithoutPlaintext: true,
      rememberedModelRestoredAfterLiveDiscovery: true,
      keyAndModelRemoved: true,
      paidTurnStarted: false,
      hostInput: false,
    }),
  );
} catch {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ status: "fail", step, detailsOmitted: true }),
  );
  console.error(`Native protected-model test failed at ${step}.`);
  process.exitCode = 1;
} finally {
  key = "";
  await electron?.close();
  // Failed runs must not retain the user's credential in guest app storage.
  await unlink(keyFile).catch(() => undefined);
}
if (passed) console.log(JSON.stringify({ status: "pass", evidence }));

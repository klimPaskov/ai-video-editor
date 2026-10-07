/** Packaged API-key Settings boundary in the unprivileged isolated guest. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "playwright/test";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await access("/.dockerenv");
const executablePath = process.argv[2];
if (!executablePath?.startsWith("/home/node/"))
  throw new Error("Packaged executable must be in the isolated guest");
const evidence = await mkdtemp(
  join(resolve("test-results"), "native-api-providers-"),
);
await chmod(evidence, 0o700);
const configRoot = await mkdtemp(join(evidence, "account-"));
await chmod(configRoot, 0o700);
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const resources = join(dirname(executablePath), "resources");
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify({
    asarHash: sha(await readFile(join(resources, "app.asar"))),
    runtimeManifestHash: sha(
      await readFile(join(resources, "codex/manifest.json")),
    ),
    testHash: sha(await readFile(fileURLToPath(import.meta.url))),
  }),
);

let step = "launch";
let passed = false;
let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env: { ...process.env, DISPLAY: ":99", XDG_CONFIG_HOME: configRoot },
    timeout: 30000,
  });
  const page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  step = "provider-settings";
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "API providers", exact: true })
    .click();
  await expect(page.locator("#api-provider-settings")).toBeVisible();
  await expect(page.locator("#codex-settings")).toBeHidden();
  await expect(page.locator("#appearance-settings")).toBeHidden();
  await expect(page.locator("#api-provider-status")).toHaveText(
    "Add a key to discover models",
    { timeout: 60000 },
  );
  const initial = await page.evaluate(() => window.desktop.getApiProviders());
  assert.ok(initial.ok);
  assert.deepEqual(
    initial.value.providers.map((item) => item.id),
    ["deepseek", "openai", "gemini"],
  );
  assert.ok(
    initial.value.providers.every(
      (item) => !item.connected && item.models.length === 0,
    ),
  );
  step = "key-rejection";
  const testOnlyKey = "TEST-ONLY-NO-CREDIT-KEY";
  await page.locator("#api-provider-key").fill(testOnlyKey);
  await page.locator("#api-provider-connect").click();
  assert.equal(await page.locator("#api-provider-key").inputValue(), "");
  await expect(page.locator("#api-provider-error")).toBeVisible({
    timeout: 60000,
  });
  const after = await page.evaluate(() => window.desktop.getApiProviders());
  assert.ok(after.ok);
  assert.ok(!JSON.stringify(after.value).includes(testOnlyKey));
  assert.equal(after.value.providers[0]?.connected, false);
  step = "provider-switch";
  await page.locator("#api-provider-id").selectOption("gemini");
  await expect(page.locator("#api-provider-status")).toHaveText(
    "Add a key to discover models",
  );
  await expect(page.locator("#api-provider-key")).toHaveValue("");
  await expect(page.locator("#api-provider-model-settings")).toBeHidden();
  await expect(page.locator("#api-provider-model")).toHaveValue("");
  await expect(page.locator("#api-provider-model")).toBeDisabled();
  const gemini = await page.evaluate(() => window.desktop.getApiProviders());
  assert.ok(gemini.ok);
  assert.deepEqual(
    gemini.value.providers.find((item) => item.id === "gemini"),
    {
      id: "gemini",
      connected: false,
      remembered: false,
      canRemember: gemini.value.providers[0]!.canRemember,
      models: [],
      selectedModel: null,
      busy: false,
      message: null,
    },
  );
  await page.screenshot({
    path: join(evidence, "native-settings-private.png"),
  });
  if (process.argv.includes("--inspect")) {
    console.log(JSON.stringify({ inspectionReady: true, evidence }));
    const deadline = Date.now() + 300000;
    while (true) {
      try {
        await access(join(evidence, "inspection.done"));
        break;
      } catch {
        /* Guest-only visual review releases the hold. */
      }
      if (Date.now() > deadline) throw new Error("Guest inspection timed out");
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  passed = true;
} catch {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ status: "fail", step, detailsOmitted: true }),
  );
  console.error(`Native API provider Settings check failed at ${step}.`);
  process.exitCode = 1;
} finally {
  await electron?.close();
}
if (passed) {
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({
      status: "pass",
      scope: "P2-guest-local-api-provider-settings-rejected-key",
      packagedNativeWindow: true,
      oneSelectedSettingsPanel: true,
      keyClearedFromRendererInput: true,
      paidTurnStarted: false,
      authenticatedProviderTested: false,
      hostInput: false,
    }),
  );
  console.log(JSON.stringify({ status: "pass", evidence }));
}

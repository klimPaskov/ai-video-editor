/** Optional authenticated model-catalog check in the isolated packaged guest. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await assertNativeTestEnvironment();
const executablePath = process.argv[2];
const privateKeyPath = process.argv[3];
if (
  !executablePath?.startsWith("/home/node/") ||
  !privateKeyPath?.startsWith("/home/node/browser-test/test-results/")
)
  throw new Error("Packaged executable and private key must stay in the guest");
const keyStat = await stat(privateKeyPath);
if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0)
  throw new Error("Private key file is not restricted");
let key: string;
try {
  key = (await readFile(privateKeyPath, "utf8")).trim();
} finally {
  await unlink(privateKeyPath);
}
if (key.length < 8 || key.length > 1024 || !/^[\x21-\x7e]+$/u.test(key))
  throw new Error("Invalid private key input");

const evidence = await mkdtemp(
  join(resolve("test-results"), "native-live-catalog-"),
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
  electron = await launch();
  let page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  step = "authenticated-catalog";
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "API providers", exact: true })
    .click();
  await page.locator("#api-provider-id").selectOption("openai");
  await page.locator("#api-provider-remember").uncheck({ force: true });
  await page.locator("#api-provider-key").fill(key);
  await page.locator("#api-provider-connect").click();
  assert.equal(await page.locator("#api-provider-key").inputValue(), "");
  await expect(page.locator("#api-provider-status")).toHaveText(
    "Key available for this session",
    { timeout: 90000 },
  );
  const state = await page.evaluate(() => window.desktop.getApiProviders());
  assert.ok(state.ok);
  const account = state.value.providers.find((entry) => entry.id === "openai");
  assert.ok(account?.connected);
  assert.equal(account.remembered, false);
  assert.ok(account.models.length > 0);
  assert.ok(
    account.models.every((id) =>
      /^gpt-4(?:\.1(?:-(?:mini|nano))?|o(?:-mini)?)(?:-\d{4}-\d{2}-\d{2})?$/u.test(
        id,
      ),
    ),
  );
  assert.ok(!JSON.stringify(state.value).includes(key));
  const model =
    account.models.find((id) => id === "gpt-4.1-mini") ?? account.models[0]!;
  await page.locator("#api-provider-model").selectOption(model);
  await expect
    .poll(async () => {
      const reply = await page.evaluate(() => window.desktop.getApiProviders());
      return reply.ok
        ? reply.value.providers.find((entry) => entry.id === "openai")
            ?.selectedModel
        : null;
    })
    .toBe(model);
  await page.screenshot({ path: join(evidence, "catalog-private.png") });
  step = "session-only-reopen";
  await electron.close();
  electron = await launch();
  page = await electron.firstWindow();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "API providers", exact: true })
    .click();
  await page.locator("#api-provider-id").selectOption("openai");
  await expect(page.locator("#api-provider-status")).toHaveText(
    "Add a key to discover models",
  );
  const reopened = await page.evaluate(() => window.desktop.getApiProviders());
  assert.ok(reopened.ok);
  assert.equal(
    reopened.value.providers.find((entry) => entry.id === "openai")?.connected,
    false,
  );
  passed = true;
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({
      status: "pass",
      scope: "P2-packaged-openai-authenticated-model-catalog",
      packagedNativeWindow: true,
      authenticatedCatalog: true,
      modelCount: account.models.length,
      modelSelectionValidated: true,
      sessionOnlyReopen: true,
      paidTurnStarted: false,
      hostInput: false,
    }),
  );
} catch {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ status: "fail", step, detailsOmitted: true }),
  );
  console.error(`Native API catalog check failed at ${step}.`);
  process.exitCode = 1;
} finally {
  key = "";
  await electron?.close();
}
if (passed) console.log(JSON.stringify({ status: "pass", evidence }));

/** Real packaged settings + real signed-out App Server. No authenticated turn. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await access("/.dockerenv");
const executablePath = process.argv[2];
assert.ok(executablePath);
await mkdir(resolve("test-results"), { recursive: true });
const evidence = await mkdtemp(resolve("test-results/native-codex-"));
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify(
    {
      asarHash: hash(
        await readFile(join(dirname(executablePath), "resources/app.asar")),
      ),
      runtimeManifestHash: hash(
        await readFile(
          join(dirname(executablePath), "resources/codex/manifest.json"),
        ),
      ),
      mcpManifestHash: hash(
        await readFile(
          join(dirname(executablePath), "resources/mcp/manifest.json"),
        ),
      ),
      testHash: hash(
        await readFile(resolve("tests/native/codex-settings.test.ts")),
      ),
    },
    null,
    2,
  ),
);
const configRoot = await mkdtemp("/tmp/codex-video-edit-account-");
const env = { ...process.env, XDG_CONFIG_HOME: configRoot };
const mcpMarker = join(configRoot, "untrusted-mcp-command-ran");
const codexHome = join(configRoot, "codex-video-edit", "codex", "account");
await mkdir(codexHome, { recursive: true, mode: 0o700 });
await writeFile(
  join(codexHome, "config.toml"),
  `[mcp_servers.untrusted_test]\ncommand = "/usr/bin/python3"\nargs = ["-c", ${JSON.stringify(`from pathlib import Path; Path(${JSON.stringify(mcpMarker)}).write_text('ran')`)}]\nenabled = true\n`,
  { mode: 0o600 },
);
await writeFile(
  join(evidence, "private-config-location.json"),
  JSON.stringify({ configRoot }),
);
let electron = await _electron.launch({
  executablePath,
  chromiumSandbox: true,
  env,
  timeout: 30000,
});
let step = "initial-window";
try {
  let page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "codex-video-edit://app/index.html");
  // Keep OAuth URLs in main memory and suppress only the external browser launch.
  // Login start/cancel still go through the packaged main and actual official server.
  await electron.evaluate(({ shell }) => {
    const state = globalThis as typeof globalThis & { testLoginOpens?: number };
    state.testLoginOpens = 0;
    shell.openExternal = async (url) => {
      const target = new URL(url);
      assertURL(target);
      state.testLoginOpens!++;
    };
    function assertURL(url: URL): void {
      if (
        url.origin !== "https://auth.openai.com" ||
        url.pathname !== "/oauth/authorize"
      )
        throw new Error("Unexpected auth target");
    }
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.locator("#codex-login")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#appearance-settings")).toBeHidden();
  await expect(page.locator("#codex-model-settings")).toBeHidden();
  const state = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(state.ok);
  assert.equal(state.value.account, "signed_out");
  assert.equal(state.value.connection, "connected");
  await assert.rejects(access(mcpMarker));
  step = "state-privacy";
  const keys: string[] = [];
  function collect(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collect(child);
    }
  }
  collect(state);
  const forbiddenKeys = keys.filter((key) =>
    ["authUrl", "loginId", "email", "token", "path", "codexHome"].includes(key),
  );
  await writeFile(
    join(evidence, "privacy-audit.json"),
    JSON.stringify({
      forbiddenKeys,
      legacyTextPatternHits:
        JSON.stringify(state).match(
          /authUrl|loginId|CODEX_HOME|auth\.openai\.com/g,
        ) ?? [],
    }),
  );
  assert.deepEqual(forbiddenKeys, []);
  step = "login-initiation";
  await page.locator("#codex-login").click();
  await expect(page.locator("#codex-cancel-login")).toBeVisible({
    timeout: 30000,
  });
  assert.equal(
    await electron.evaluate(
      () =>
        (globalThis as typeof globalThis & { testLoginOpens: number })
          .testLoginOpens,
    ),
    1,
  );
  step = "login-cancellation";
  await page.locator("#codex-cancel-login").click();
  await expect(page.locator("#codex-login")).toBeVisible({ timeout: 30000 });
  await expect(page.locator("#codex-cancel-login")).toBeHidden();
  await page.screenshot({ path: join(evidence, "signed-out-settings.png") });
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeFocused();
  step = "restart";
  await electron.close();
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30000,
  });
  page = await electron.firstWindow();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.locator("#codex-login")).toBeVisible({ timeout: 30000 });
  const reopenedState = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(reopenedState.ok);
  assert.equal(reopenedState.value.account, "signed_out");
  assert.equal(reopenedState.value.connection, "connected");
  await assert.rejects(access(mcpMarker));
  await page.screenshot({ path: join(evidence, "reopened-settings.png") });
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.locator("#interface-scale").selectOption("2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.locator("#codex-login")).toBeVisible();
  assert.equal(
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
    ),
    2,
  );
  await page.screenshot({ path: join(evidence, "settings-200.png") });
  step = "guest-inspection";
  if (process.argv.includes("--inspect")) {
    console.log(JSON.stringify({ inspectionReady: true, evidence }));
    const deadline = Date.now() + 600000;
    while (true) {
      try {
        await access(join(evidence, "inspection.done"));
        break;
      } catch {
        /* Wait for guest-only input inspection. */
      }
      if (Date.now() > deadline)
        throw new Error("Native inspection did not finish");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        status: "pass",
        packagedNativeWindow: true,
        realSignedOutRuntime: true,
        ownedMcpVerifiedAtStartup: true,
        hostileMcpServerDisabled: true,
        hostileMcpCommandNotRun: true,
        managedLoginStartedAndCanceled: true,
        browserLaunchSuppressedForTest: true,
        browserOpened: false,
        reopenedSignedOut: true,
        authenticated: false,
        modelDiscoveryAuthenticated: false,
        edit: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "pass", evidence }));
} catch {
  try {
    await (
      await electron.firstWindow()
    ).screenshot({ path: join(evidence, "failure-window.png") });
  } catch {
    /* Retain original assertion failure. */
  }
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ status: "fail", step, detailsOmitted: true }),
  );
  console.error(
    "Native Codex settings assertion failed; private protocol omitted.",
  );
  process.exitCode = 1;
} finally {
  await electron.close();
}

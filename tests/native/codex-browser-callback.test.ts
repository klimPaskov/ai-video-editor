/** Exercise packaged App Server browser-login denial and opt-in real success. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "playwright/test";

assert.equal(process.platform, "linux", "Requires isolated Linux guest");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await readFile("/.dockerenv");
const executablePath = process.argv[2];
if (!executablePath?.startsWith("/home/node/workspaces/"))
  throw new Error("Packaged executable must be inside the isolated guest");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(
  join(evidenceRoot, "native-codex-browser-callback-"),
);
await chmod(evidence, 0o700);
const configRoot = await mkdtemp(join(evidence, "account-"));
await chmod(configRoot, 0o700);
const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const resources = join(dirname(executablePath), "resources");
const awaitBrowserSuccess = process.argv.includes("--await-browser-success");
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify({
    asarHash: sha256(await readFile(join(resources, "app.asar"))),
    runtimeManifestHash: sha256(
      await readFile(join(resources, "codex/manifest.json")),
    ),
    testHash: sha256(await readFile(fileURLToPath(import.meta.url))),
  }),
);

let step = "launch";
let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env: { ...process.env, DISPLAY: ":99", XDG_CONFIG_HOME: configRoot },
    timeout: 30000,
  });
  let page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  await electron.evaluate(({ shell }) => {
    const testState = globalThis as typeof globalThis & {
      __codexCallbackTest?: { urls: string[] };
    };
    testState.__codexCallbackTest = { urls: [] };
    shell.openExternal = async (url: string) => {
      testState.__codexCallbackTest?.urls.push(url);
    };
  });

  step = "open-settings";
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  step = "open-codex-settings";
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  step = "signed-out-login-control";
  await expect(page.locator("#codex-login")).toBeVisible({ timeout: 60000 });
  await expect(page.locator("#codex-disclosure")).toContainText(
    "bounded local transcript pages",
  );
  await expect(page.locator("#codex-disclosure")).toContainText(
    "included in later turns",
  );
  await expect(page.locator("#codex-disclosure")).toContainText(
    "Source audio/video stays on this device",
  );
  step = "signed-out-account-state";
  const initial = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(initial.ok);
  assert.equal(initial.value.account, "signed_out");

  step = "start-browser-attempt";
  await page.locator("#codex-login").click();
  await expect(page.locator("#codex-cancel-login")).toBeVisible({
    timeout: 60000,
  });
  await expect
    .poll(
      () =>
        electron!.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __codexCallbackTest?: { urls: string[] };
              }
            ).__codexCallbackTest?.urls.length ?? 0,
        ),
      { timeout: 15000 },
    )
    .toBe(1);
  const authUrlText = await electron.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __codexCallbackTest?: { urls: string[] };
        }
      ).__codexCallbackTest?.urls[0] ?? "",
  );
  const authUrl = new URL(authUrlText);
  assert.equal(authUrl.origin, "https://auth.openai.com");
  assert.equal(authUrl.pathname, "/oauth/authorize");
  const redirect = authUrl.searchParams.get("redirect_uri");
  const state = authUrl.searchParams.get("state");
  assert.ok(redirect && state);
  const callback = new URL(redirect);
  assert.equal(callback.protocol, "http:");
  assert.equal(callback.hostname, "localhost");
  assert.ok(["1455", "1457"].includes(callback.port));
  assert.equal(callback.pathname, "/auth/callback");

  if (awaitBrowserSuccess) {
    step = "wait-for-browser-success";
    await writeFile(join(evidence, "authorization-url.txt"), authUrlText, {
      mode: 0o600,
    });
    console.log(`AUTHORIZATION_URL ${authUrlText}`);
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.desktop.getCodex());
          return (
            state.ok &&
            !state.value.busy &&
            state.value.connection === "connected" &&
            state.value.account === "signed_in" &&
            state.value.models.length > 0
          );
        },
        { timeout: 450_000, intervals: [250, 500, 1000, 2000] },
      )
      .toBe(true);
    const signedIn = await page.evaluate(() => window.desktop.getCodex());
    assert.ok(signedIn.ok);
    assert.equal(signedIn.value.account, "signed_in");
    assert.equal(signedIn.value.connection, "connected");
    assert.ok(signedIn.value.models.length > 0);
    assert.ok(!JSON.stringify(signedIn.value).includes(authUrlText));
    assert.doesNotMatch(
      JSON.stringify(signedIn.value),
      /access[_-]?token|refresh[_-]?token/iu,
    );
    const userData = await electron.evaluate(({ app }) =>
      app.getPath("userData"),
    );
    assert.equal(resolve(userData), join(configRoot, "ai-video-editor"));
    const authFile = join(userData, "codex/account/auth.json");
    const authMetadata = await stat(authFile);
    assert.ok(authMetadata.isFile());
    assert.equal(authMetadata.mode & 0o077, 0);

    step = "reopen-signed-in-account";
    await electron.close();
    electron = await _electron.launch({
      executablePath,
      chromiumSandbox: true,
      env: { ...process.env, DISPLAY: ":99", XDG_CONFIG_HOME: configRoot },
      timeout: 30000,
    });
    page = await electron.firstWindow();
    assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(page.url(), "ai-video-editor://app/index.html");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.desktop.getCodex());
          return (
            state.ok &&
            !state.value.busy &&
            state.value.connection === "connected" &&
            state.value.account === "signed_in" &&
            state.value.models.length > 0
          );
        },
        { timeout: 90_000, intervals: [250, 500, 1000] },
      )
      .toBe(true);
    const reopened = await page.evaluate(() => window.desktop.getCodex());
    assert.ok(reopened.ok);
    assert.equal(reopened.value.account, "signed_in");
    assert.ok(!JSON.stringify(reopened.value).includes(authUrlText));
    assert.equal((await stat(authFile)).mode & 0o077, 0);
    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify({
        status: "pass",
        scope: "P2-packaged-real-browser-oauth-success",
        packagedNativeWindow: true,
        appServerAccountSignedIn: true,
        liveModelsDiscovered: reopened.value.models.length,
        signedInStateRestoredAfterReopen: true,
        authorizationUrlExcludedFromRendererState: true,
        credentialsAndResultRemainInGuest: true,
      }),
    );
    console.log(JSON.stringify({ status: "pass" }));
  } else {
    step = "reject-mismatched-state";
    const wrongState = new URL(callback);
    wrongState.hostname = "127.0.0.1";
    wrongState.searchParams.set("state", `${state}-wrong`);
    wrongState.searchParams.set("error", "access_denied");
    const rejected = await fetch(wrongState, {
      signal: AbortSignal.timeout(5000),
    });
    await rejected.arrayBuffer();
    assert.equal(rejected.status, 400);
    await expect(page.locator("#codex-cancel-login")).toBeVisible();
    await expect(page.locator("#codex-error")).toBeHidden();
    const pending = await page.evaluate(() => window.desktop.getCodex());
    assert.ok(pending.ok);
    assert.equal(pending.value.account, "signing_in");
    assert.ok(!JSON.stringify(pending.value).includes(state));

    step = "complete-denied-callback";
    const privateDescription = "private-test-oauth-error-detail";
    const denied = new URL(callback);
    denied.hostname = "127.0.0.1";
    denied.searchParams.set("state", state);
    denied.searchParams.set("error", "access_denied");
    denied.searchParams.set("error_description", privateDescription);
    const completion = await fetch(denied, {
      signal: AbortSignal.timeout(10000),
    });
    await completion.arrayBuffer();
    await expect(page.locator("#codex-login")).toBeVisible({ timeout: 30000 });
    await expect(page.locator("#codex-error")).toHaveText(
      "Sign-in did not finish. Try again.",
    );
    await expect(page.locator("#codex-account")).toHaveText(
      "Sign in to use Codex",
    );
    const failed = await page.evaluate(() => window.desktop.getCodex());
    assert.ok(failed.ok);
    assert.equal(failed.value.account, "signed_out");
    assert.equal(failed.value.busy, false);
    assert.ok(!JSON.stringify(failed.value).includes(privateDescription));
    assert.ok(!JSON.stringify(failed.value).includes(authUrlText));
    assert.ok(
      !(await page.locator("body").innerText()).includes(privateDescription),
    );
    assert.ok(!(await page.locator("body").innerText()).includes(state));
    assert.ok(!(await page.locator("body").innerText()).includes(authUrlText));

    step = "retry-after-callback-failure";
    await page.locator("#codex-login").click();
    await expect(page.locator("#codex-cancel-login")).toBeVisible({
      timeout: 30000,
    });
    await expect
      .poll(
        () =>
          electron!.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  __codexCallbackTest?: { urls: string[] };
                }
              ).__codexCallbackTest?.urls.length ?? 0,
          ),
        { timeout: 15000 },
      )
      .toBe(2);
    await page.locator("#codex-cancel-login").click();
    await expect(page.locator("#codex-login")).toBeVisible({ timeout: 30000 });
    const retried = await page.evaluate(() => window.desktop.getCodex());
    assert.ok(retried.ok);
    assert.equal(retried.value.account, "signed_out");
    assert.ok(!JSON.stringify(retried.value).includes(privateDescription));

    await writeFile(
      join(evidence, "result.json"),
      JSON.stringify({
        status: "pass",
        scope: "P2-packaged-real-appserver-oauth-callback-denial",
        packagedNativeWindow: true,
        callbackStateMismatchRejected: true,
        correlatedDenialReturnedToSignedOut: true,
        privateProviderDetailRedacted: true,
        subsequentAttemptCanceled: true,
        authenticationSucceeded: false,
        externalBrowserOrHostInputUsed: false,
      }),
    );
    console.log(JSON.stringify({ status: "pass", evidence }));
  }
} catch (error) {
  try {
    const failurePage = await electron?.firstWindow();
    await failurePage?.screenshot({
      path: join(evidence, "failure-window.png"),
      timeout: 5000,
    });
  } catch {
    /* Preserve the original failure without exposing page or provider text. */
  }
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({
      status: "fail",
      step,
      errorName: error instanceof Error ? error.name : "unknown",
      detailsOmitted: true,
    }),
  );
  console.error(`Packaged browser callback test failed at ${step}.`);
  process.exitCode = 1;
} finally {
  await electron?.close().catch(() => undefined);
}

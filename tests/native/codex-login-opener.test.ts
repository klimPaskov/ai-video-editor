/** Real packaged login opener in a guest-local browser; no account completion claim. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";

assert.equal(process.platform, "linux", "Requires isolated Linux guest");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await assertNativeTestEnvironment();
await access("/usr/bin/xdg-open");
await access("/usr/bin/chromium");
const executablePath = process.argv[2];
if (!executablePath?.startsWith("/home/node/"))
  throw new Error("Packaged executable must be inside the isolated guest");
const root = resolve("test-results");
await mkdir(root, { recursive: true });
const evidence = await mkdtemp(join(root, "native-codex-login-opener-"));
await chmod(evidence, 0o700);
const configRoot = await mkdtemp(join(evidence, "account-"));
await chmod(configRoot, 0o700);
const sha256 = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const resources = join(dirname(executablePath), "resources");
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

async function browserProcesses(): Promise<Set<number>> {
  const found = new Set<number>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const args = await readFile(`/proc/${name}/cmdline`);
      if (args.includes(Buffer.from("/chromium"))) found.add(Number(name));
    } catch {
      // A process may exit while /proc is enumerated.
    }
  }
  return found;
}

async function authOpenerProcesses(): Promise<Set<number>> {
  const found = new Set<number>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const args = await readFile(`/proc/${name}/cmdline`);
      if (
        args.includes(Buffer.from("/xdg-open")) &&
        args.includes(Buffer.from("auth.openai.com/oauth/authorize"))
      )
        found.add(Number(name));
    } catch {
      // The opener can exit during enumeration.
    }
  }
  return found;
}

async function launchedAuthBrowser(before: Set<number>): Promise<boolean> {
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/u.test(name) || before.has(Number(name))) continue;
    try {
      const args = await readFile(`/proc/${name}/cmdline`);
      if (
        args.includes(Buffer.from("/chromium")) &&
        args.includes(Buffer.from("https://auth.openai.com/oauth/authorize"))
      )
        return true;
    } catch {
      // The opener can exit after handing the page to Chromium.
    }
  }
  return false;
}

const before = await browserProcesses();
const beforeOpeners = await authOpenerProcesses();
const env = {
  ...process.env,
  DISPLAY: ":99",
  BROWSER: "/usr/bin/chromium",
  XDG_CONFIG_HOME: configRoot,
};
let step = "launch";
let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
let passed = false;
let cleanupOk = true;
try {
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30000,
  });
  const page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  step = "signed-out-settings";
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.locator("#codex-login")).toBeVisible({ timeout: 60000 });
  const initial = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(initial.ok);
  assert.equal(initial.value.account, "signed_out");
  step = "guest-browser-open";
  await page.locator("#codex-login").click();
  await expect(page.locator("#codex-cancel-login")).toBeVisible({
    timeout: 60000,
  });
  await expect
    .poll(() => launchedAuthBrowser(before), { timeout: 30000 })
    .toBe(true);
  await page.screenshot({ path: join(evidence, "packaged-settings.png") });
  if (process.argv.includes("--inspect")) {
    console.log(JSON.stringify({ inspectionReady: true, evidence }));
    const deadline = Date.now() + 600000;
    while (true) {
      try {
        await access(join(evidence, "inspection.done"));
        break;
      } catch {
        // Only guest-local visual inspection releases this hold.
      }
      if (Date.now() > deadline) throw new Error("Guest inspection timed out");
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  step = "cancel";
  await page.locator("#codex-cancel-login").click();
  await expect(page.locator("#codex-login")).toBeVisible({ timeout: 60000 });
  const after = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(after.ok);
  assert.equal(after.value.account, "signed_out");
  passed = true;
} catch {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ status: "fail", step, detailsOmitted: true }),
  );
  console.error(`Guest login opener check failed at ${step}.`);
  process.exitCode = 1;
} finally {
  for (const pid of await authOpenerProcesses()) {
    if (beforeOpeners.has(pid)) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The test-owned opener may have already exited.
    }
  }
  for (const pid of await browserProcesses()) {
    if (before.has(pid)) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Chromium may have already exited.
    }
  }
  try {
    await electron?.close();
    await expect
      .poll(
        async () =>
          [...(await browserProcesses())].filter((pid) => !before.has(pid))
            .length +
          [...(await authOpenerProcesses())].filter(
            (pid) => !beforeOpeners.has(pid),
          ).length,
        { timeout: 10000 },
      )
      .toBe(0);
  } catch {
    cleanupOk = false;
    await writeFile(
      join(evidence, "failure.json"),
      JSON.stringify({ status: "fail", step: "cleanup", detailsOmitted: true }),
    );
    console.error("Guest login opener cleanup failed.");
    process.exitCode = 1;
  }
}
if (passed && cleanupOk) {
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({
      status: "pass",
      scope: "P2-guest-local-managed-login-opener-and-cancel",
      packagedNativeWindow: true,
      guestBrowserStartedWithOfficialAuthRoute: true,
      loginCancelled: true,
      managedBrowserLoginCompleted: false,
      hostBrowserUsed: false,
    }),
  );
  console.log(JSON.stringify({ status: "pass", evidence }));
}

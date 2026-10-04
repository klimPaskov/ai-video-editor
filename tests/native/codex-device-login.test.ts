/** Packaged ChatGPT device-code initiation in an isolated native guest. */
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

assert.equal(process.platform, "linux");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await access("/.dockerenv");
await access("/usr/bin/chromium");
await access("/usr/bin/xdg-open");
const executablePath = process.argv[2];
if (!executablePath?.startsWith("/home/node/"))
  throw new Error("Packaged executable must be inside the isolated guest");
const root = resolve("test-results");
await mkdir(root, { recursive: true });
const evidence = await mkdtemp(join(root, "native-codex-device-login-"));
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

async function matchingProcesses(
  kind: "browser" | "opener",
): Promise<Set<number>> {
  const found = new Set<number>();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const args = await readFile(`/proc/${name}/cmdline`);
      if (
        kind === "browser"
          ? args.includes(Buffer.from("/chromium"))
          : args.includes(Buffer.from("/xdg-open")) &&
            args.includes(Buffer.from("auth.openai.com/codex/device"))
      )
        found.add(Number(name));
    } catch {
      // A test-owned browser or opener may exit during enumeration.
    }
  }
  return found;
}
async function newCount(
  kind: "browser" | "opener",
  before: Set<number>,
): Promise<number> {
  return [...(await matchingProcesses(kind))].filter((pid) => !before.has(pid))
    .length;
}
async function browserOpened(before: Set<number>): Promise<boolean> {
  for (const pid of await matchingProcesses("browser")) {
    if (before.has(pid)) continue;
    try {
      const args = await readFile(`/proc/${pid}/cmdline`);
      if (args.includes(Buffer.from("https://auth.openai.com/codex/device")))
        return true;
    } catch {
      // Chromium may navigate after the initial command starts.
    }
  }
  return false;
}

const beforeBrowser = await matchingProcesses("browser");
const beforeOpener = await matchingProcesses("opener");
const env = {
  ...process.env,
  DISPLAY: ":99",
  BROWSER: "/usr/bin/chromium",
  XDG_CONFIG_HOME: configRoot,
};
let step = "launch";
let passed = false;
let completed = false;
let cleanupOk = true;
let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
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
  await expect(page.locator("#codex-device-login")).toBeVisible({
    timeout: 60000,
  });
  const initial = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(initial.ok);
  assert.equal(initial.value.account, "signed_out");
  step = "device-code-start";
  await page.locator("#codex-device-login").click();
  await expect(page.locator("#codex-device-details")).toBeVisible({
    timeout: 60000,
  });
  const code = (await page.locator("#codex-device-code").textContent()) ?? "";
  assert.match(code, /^[A-Za-z0-9-]{4,32}$/u);
  assert.equal(
    await page.locator("#codex-device-url").getAttribute("href"),
    "https://auth.openai.com/codex/device",
  );
  const pending = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(pending.ok);
  assert.equal(pending.value.account, "signing_in");
  assert.ok(!JSON.stringify(pending.value).includes(code));
  step = "guest-device-page";
  await page.locator("#codex-device-url").click();
  await expect
    .poll(() => browserOpened(beforeBrowser), { timeout: 30000 })
    .toBe(true);
  await page.screenshot({ path: join(evidence, "native-settings.png") });
  if (process.argv.includes("--inspect")) {
    console.log(JSON.stringify({ inspectionReady: true, evidence }));
    const deadline = Date.now() + 600000;
    while (true) {
      try {
        await access(join(evidence, "inspection.done"));
        break;
      } catch {
        // Guest-only visual inspection releases this hold.
      }
      if (Date.now() > deadline) throw new Error("Guest inspection timed out");
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  const current = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(current.ok);
  if (
    process.argv.includes("--inspect") &&
    current.value.account === "signed_in"
  ) {
    step = "completed";
    await expect(page.locator("#codex-device-details")).toBeHidden();
    assert.equal(await page.locator("#codex-device-code").textContent(), "");
    assert.ok(current.value.plan);
    completed = true;
  } else {
    step = "cancel";
    await page.locator("#codex-cancel-login").click();
    await expect(page.locator("#codex-login")).toBeVisible({ timeout: 60000 });
    await expect(page.locator("#codex-device-details")).toBeHidden();
    assert.equal(await page.locator("#codex-device-code").textContent(), "");
    const after = await page.evaluate(() => window.desktop.getCodex());
    assert.ok(after.ok);
    assert.equal(after.value.account, "signed_out");
  }
  passed = true;
} catch {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ status: "fail", step, detailsOmitted: true }),
  );
  console.error(`Guest device sign-in check failed at ${step}.`);
  process.exitCode = 1;
} finally {
  for (const [kind, before] of [
    ["opener", beforeOpener],
    ["browser", beforeBrowser],
  ] as const) {
    for (const pid of await matchingProcesses(kind)) {
      if (before.has(pid)) continue;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // A test-owned process may have already exited.
      }
    }
  }
  try {
    await electron?.close();
    await expect
      .poll(
        async () =>
          (await newCount("browser", beforeBrowser)) +
          (await newCount("opener", beforeOpener)),
        { timeout: 10000 },
      )
      .toBe(0);
  } catch {
    cleanupOk = false;
    await writeFile(
      join(evidence, "failure.json"),
      JSON.stringify({ status: "fail", step: "cleanup", detailsOmitted: true }),
    );
    console.error("Guest device sign-in cleanup failed.");
    process.exitCode = 1;
  }
}
if (passed && cleanupOk) {
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({
      status: "pass",
      scope: completed
        ? "P2-guest-local-managed-device-code-completion"
        : "P2-guest-local-managed-device-code-start-and-cancel",
      packagedNativeWindow: true,
      officialDevicePageOpenedInGuest: true,
      codeLimitedToExplicitSettingsResponse: true,
      cancelReturnedSignedOut: !completed,
      managedLoginCompleted: completed,
      hostBrowserUsed: false,
    }),
  );
  console.log(JSON.stringify({ status: "pass", evidence }));
}

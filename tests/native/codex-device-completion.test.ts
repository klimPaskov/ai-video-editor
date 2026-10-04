/** Reopen a privately authorized device-code account in the isolated native guest. */
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
const configRoot = process.argv[3];
if (
  !executablePath?.startsWith("/home/node/") ||
  !configRoot?.startsWith("/home/node/")
)
  throw new Error(
    "Packaged executable and account must remain in the isolated guest",
  );
const evidence = await mkdtemp(
  join(resolve("test-results"), "native-codex-device-completion-"),
);
await chmod(evidence, 0o700);
const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const resources = join(dirname(executablePath), "resources");
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify({
    asarHash: hash(await readFile(join(resources, "app.asar"))),
    runtimeManifestHash: hash(
      await readFile(join(resources, "codex/manifest.json")),
    ),
    testHash: hash(await readFile(fileURLToPath(import.meta.url))),
  }),
);

let passed = false;
let step = "launch";
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
  step = "reconciled-account";
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(page.locator("#codex-logout")).toBeVisible({ timeout: 60000 });
  await expect(page.locator("#codex-device-details")).toBeHidden();
  assert.equal(await page.locator("#codex-device-code").textContent(), "");
  const account = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(account.ok);
  assert.equal(account.value.account, "signed_in");
  assert.ok(account.value.plan);
  step = "runtime-catalog";
  await expect
    .poll(
      async () => {
        const current = await page.evaluate(() => window.desktop.getCodex());
        return current.ok ? current.value.models.length : 0;
      },
      { timeout: 60000 },
    )
    .toBeGreaterThan(0);
  const catalog = await page.evaluate(() => window.desktop.getCodex());
  assert.ok(catalog.ok);
  assert.ok(catalog.value.skills.length > 0);
  await page.screenshot({
    path: join(evidence, "native-settings-private.png"),
  });
  passed = true;
} catch {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ status: "fail", step, detailsOmitted: true }),
  );
  console.error(
    `Guest managed device sign-in completion check failed at ${step}.`,
  );
  process.exitCode = 1;
} finally {
  await electron?.close();
}
if (passed) {
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({
      status: "pass",
      scope: "P2-guest-local-managed-device-code-completion-and-reopen",
      packagedNativeWindow: true,
      authoritativeAccountReconciled: true,
      oneTimeCodeCleared: true,
      runtimeModelAndSkillCatalog: true,
      hostBrowserUsed: false,
    }),
  );
  console.log(JSON.stringify({ status: "pass", evidence }));
}

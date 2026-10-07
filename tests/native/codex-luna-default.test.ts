/** Packaged Codex subscription default with a fresh, isolated app preference. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, expect } from "playwright/test";

assert.equal(process.platform, "linux", "Requires isolated Linux guest");
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await access("/.dockerenv");
const executablePath = process.argv[2];
const accountArgument = process.argv[3];
assert.ok(executablePath && accountArgument);
assert.ok(isAbsolute(executablePath) && isAbsolute(accountArgument));
const existingConfig = await realpath(accountArgument);
assert.equal(existingConfig, resolve(accountArgument));
const credential = join(
  existingConfig,
  "codex-video-edit/codex/account/auth.json",
);
const credentialInfo = await stat(credential);
assert.ok(credentialInfo.isFile());
assert.equal(credentialInfo.mode & 0o077, 0);

await mkdir(resolve("test-results"), { recursive: true });
const evidence = await mkdtemp(resolve("test-results/native-codex-luna-"));
await chmod(evidence, 0o700);
const freshConfig = await mkdtemp("/tmp/codex-video-edit-luna-");
await chmod(freshConfig, 0o700);
const account = join(freshConfig, "codex-video-edit/codex/account");
await mkdir(account, { recursive: true, mode: 0o700 });
await copyFile(credential, join(account, "auth.json"));
await chmod(join(account, "auth.json"), 0o600);
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify({
    asarHash: sha256(
      await readFile(join(dirname(executablePath), "resources/app.asar")),
    ),
    testHash: sha256(await readFile(fileURLToPath(import.meta.url))),
  }),
);
const env = { ...process.env, XDG_CONFIG_HOME: freshConfig };
let step = "launch";
try {
  for (const launchNumber of [1, 2]) {
    const electron = await _electron.launch({
      executablePath,
      chromiumSandbox: true,
      env,
      timeout: 30000,
    });
    try {
      const page = await electron.firstWindow();
      assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
      assert.equal(page.url(), "codex-video-edit://app/index.html");
      step = `catalog-${launchNumber}`;
      await expect
        .poll(
          async () => {
            const reply = await page.evaluate(() => window.desktop.getCodex());
            return (
              reply.ok &&
              reply.value.account === "signed_in" &&
              !reply.value.busy &&
              reply.value.models.length > 0
            );
          },
          { timeout: 90000 },
        )
        .toBe(true);
      const reply = await page.evaluate(() => window.desktop.getCodex());
      assert.ok(reply.ok);
      const view = reply.value;
      const offered = view.models.find(
        (model) =>
          model.id === "gpt-6-luna" && model.reasoning.includes("high"),
      );
      if (offered) {
        assert.deepEqual(view.selection, {
          modelId: "gpt-6-luna",
          reasoning: "high",
        });
        assert.equal(view.message, null);
      } else {
        assert.equal(view.selection, null);
        assert.match(
          view.message ?? "",
          /GPT-6-Luna with high reasoning is unavailable/,
        );
      }
      step = `visible-settings-${launchNumber}`;
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Codex", exact: true }).click();
      await expect(page.locator("#codex-model-settings")).toBeVisible();
      if (offered) {
        await expect(page.locator("#codex-model")).toHaveValue("gpt-6-luna");
        await expect(page.locator("#codex-reasoning")).toHaveValue("high");
      }
      await page.screenshot({
        path: join(evidence, `settings-${launchNumber}.png`),
      });
      await writeFile(
        join(evidence, `catalog-${launchNumber}.json`),
        JSON.stringify({
          offered: Boolean(offered),
          selected: view.selection,
          modelIds: view.models.map((model) => model.id),
        }),
      );
      if (launchNumber === 2 && process.argv.includes("--inspect")) {
        await writeFile(join(evidence, "inspection.ready"), "ready\n");
        await expect
          .poll(
            async () =>
              access(join(evidence, "inspection.done"))
                .then(() => true)
                .catch(() => false),
            { timeout: 600000 },
          )
          .toBe(true);
      }
    } finally {
      await electron.close();
    }
  }
  console.log(JSON.stringify({ status: "pass", evidence }));
} catch (error) {
  console.error(JSON.stringify({ status: "fail", step, error: String(error) }));
  process.exitCode = 1;
}

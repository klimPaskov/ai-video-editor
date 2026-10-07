/** Signed-in packaged account/settings evidence. No model turn or source mutation. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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
const configArgument = process.argv[3];
assert.ok(executablePath && configArgument);
assert.ok(isAbsolute(executablePath) && isAbsolute(configArgument));
assert.ok(executablePath.startsWith("/home/node/workspaces/"));
const configRoot = await realpath(configArgument);
assert.equal(configRoot, resolve(configArgument));
const resultRoot = resolve("test-results");
await mkdir(resultRoot, { recursive: true });
const evidence = await mkdtemp(
  join(resultRoot, "native-codex-signed-in-settings-"),
);
await chmod(evidence, 0o700);
const sha256 = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
const resources = join(dirname(executablePath), "resources");
await writeFile(
  join(evidence, "provenance.json"),
  JSON.stringify({
    asarHash: sha256(await readFile(join(resources, "app.asar"))),
    runtimeManifestHash: sha256(
      await readFile(join(resources, "codex/manifest.json")),
    ),
    mcpManifestHash: sha256(
      await readFile(join(resources, "mcp/manifest.json")),
    ),
    testHash: sha256(await readFile(fileURLToPath(import.meta.url))),
  }),
);
const env = { ...process.env, XDG_CONFIG_HOME: configRoot };
let step = "launch";
let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
  for (const launchNumber of [1, 2]) {
    electron = await _electron.launch({
      executablePath,
      chromiumSandbox: true,
      env,
      timeout: 30000,
    });
    const page = await electron.firstWindow();
    assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(page.url(), "codex-video-edit://app/index.html");
    await electron.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw new Error("External browser disabled in isolated test");
      };
    });
    step = `account-${launchNumber}`;
    await expect
      .poll(
        async () => {
          const reply = await page.evaluate(() => window.desktop.getCodex());
          return (
            reply.ok &&
            reply.value.connection === "connected" &&
            reply.value.account === "signed_in" &&
            !reply.value.busy &&
            reply.value.models.length > 0 &&
            reply.value.skills.length > 0
          );
        },
        { timeout: 60000 },
      )
      .toBe(true);
    const reply = await page.evaluate(() => window.desktop.getCodex());
    assert.ok(reply.ok);
    const state = reply.value;
    assert.ok(
      state.limits.length > 0,
      "The signed-in runtime supplied no usage windows",
    );
    step = `visible-settings-${launchNumber}`;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Codex", exact: true }).click();
    await expect(page.locator("#appearance-settings")).toBeHidden();
    await expect(page.locator("#codex-settings")).toBeVisible();
    await expect(page.locator("#codex-login")).toBeHidden();
    await expect(page.locator("#codex-logout")).toBeVisible();
    await expect(page.locator("#codex-account")).toHaveText(
      `ChatGPT · ${state.plan ?? "Signed in"}`,
    );
    await expect(page.locator("#codex-model-settings")).toBeVisible();
    assert.ok(state.selection, "No runtime-validated model selection");
    await expect(page.locator("#codex-model")).toHaveValue(
      state.selection.modelId,
    );
    await expect(page.locator("#codex-reasoning")).toHaveValue(
      state.selection.reasoning,
    );
    assert.deepEqual(
      await page.locator("#codex-model option").allTextContents(),
      ["Choose a model", ...state.models.map((model) => model.name)],
    );
    await expect(page.locator("#codex-limits")).toBeVisible();
    await expect(page.locator("#codex-limits li")).toHaveCount(
      state.limits.length,
    );
    const visibleLimits = await page
      .locator("#codex-limits li")
      .allTextContents();
    for (const [index, limit] of state.limits.entries()) {
      const reset =
        limit.resetsAt === null
          ? ""
          : ` · resets ${await page.evaluate((seconds) => new Date(seconds * 1000).toLocaleString(), limit.resetsAt)}`;
      assert.ok(
        visibleLimits[index] ===
          `${limit.name}: ${Math.round(limit.remainingPercent)}% remaining${reset}`,
        "Visible usage does not match the current runtime window",
      );
    }
    await expect(page.locator("#codex-advanced")).toBeVisible();
    await page.locator("#codex-advanced summary").click();
    await expect(page.locator("#codex-skills li")).toHaveCount(
      state.skills.length,
    );
    const labels = await page.locator("#codex-skills li").allTextContents();
    assert.deepEqual(
      labels,
      state.skills.map(
        (skill) => `${skill.name}${skill.enabled ? "" : " (disabled)"}`,
      ),
    );
    await page.screenshot({
      path: join(evidence, `settings-${launchNumber}.png`),
      fullPage: true,
    });
    if (launchNumber === 1) {
      step = "runtime-skill-refresh";
      const userData = await electron.evaluate(({ app }) =>
        app.getPath("userData"),
      );
      const changedSkill = join(
        userData,
        "codex/context/.agents/skills/runtime-refresh-fixture/SKILL.md",
      );
      await mkdir(dirname(changedSkill), { recursive: true, mode: 0o700 });
      await writeFile(
        changedSkill,
        "---\nname: runtime-refresh-fixture\ndescription: Synthetic skill added while Codex is connected.\n---\nRead-only test fixture.\n",
        { mode: 0o600 },
      );
      await expect
        .poll(
          async () => {
            const current = await page.evaluate(() =>
              window.desktop.getCodex(),
            );
            return (
              current.ok &&
              current.value.skills.some(
                (skill) => skill.name === "runtime-refresh-fixture",
              )
            );
          },
          { timeout: 45000, intervals: [250, 500, 1000] },
        )
        .toBe(true);
      await expect(
        page
          .locator("#codex-skills li")
          .filter({ hasText: "runtime-refresh-fixture" }),
      ).toBeVisible();
    } else {
      assert.ok(
        state.skills.some((skill) => skill.name === "runtime-refresh-fixture"),
      );
    }
    if (launchNumber === 2 && process.argv.includes("--inspect")) {
      console.log(JSON.stringify({ inspectionReady: true, evidence }));
      const deadline = Date.now() + 600000;
      while (true) {
        try {
          await access(join(evidence, "inspection.done"));
          break;
        } catch {
          // Guest-only display/input inspection writes the marker.
        }
        if (Date.now() > deadline)
          throw new Error("Guest inspection timed out");
        await new Promise((done) => setTimeout(done, 1000));
      }
    }
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toBeFocused();
    await electron.close();
    electron = undefined;
  }
  step = "explicit-logout-launch";
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30000,
  });
  const logoutPage = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  await electron.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("External browser disabled in isolated test");
    };
  });
  await expect
    .poll(
      async () => {
        const reply = await logoutPage.evaluate(() =>
          window.desktop.getCodex(),
        );
        return (
          reply.ok &&
          !reply.value.busy &&
          reply.value.connection === "connected" &&
          reply.value.account === "signed_in" &&
          reply.value.models.length > 0
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
  await logoutPage
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await logoutPage.locator("#settings-codex").click();
  await expect(logoutPage.locator("#codex-logout")).toBeVisible();
  step = "explicit-logout-action";
  await logoutPage.locator("#codex-logout").click();
  await expect
    .poll(
      async () => {
        const reply = await logoutPage.evaluate(() =>
          window.desktop.getCodex(),
        );
        return (
          reply.ok &&
          !reply.value.busy &&
          reply.value.connection === "connected" &&
          reply.value.account === "signed_out" &&
          reply.value.plan === null &&
          reply.value.models.length === 0 &&
          reply.value.limits.length === 0
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
  await expect(logoutPage.locator("#codex-login")).toBeVisible();
  await expect(logoutPage.locator("#codex-device-login")).toBeVisible();
  await expect(logoutPage.locator("#codex-logout")).toBeHidden();
  await expect(logoutPage.locator("#codex-model-settings")).toBeHidden();
  await expect(logoutPage.locator("#codex-limits")).toBeHidden();
  await expect(logoutPage.locator("#codex-account")).toHaveText(
    "Sign in to use Codex",
  );
  await logoutPage.keyboard.press("Escape");
  await electron.close();
  electron = undefined;

  step = "logout-persisted-reopen";
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30000,
  });
  const signedOutPage = await electron.firstWindow();
  await electron.evaluate(({ shell }) => {
    shell.openExternal = async () => {
      throw new Error("External browser disabled in isolated test");
    };
  });
  await expect
    .poll(
      async () => {
        const reply = await signedOutPage.evaluate(() =>
          window.desktop.getCodex(),
        );
        return (
          reply.ok &&
          !reply.value.busy &&
          reply.value.connection === "connected" &&
          reply.value.account === "signed_out" &&
          reply.value.models.length === 0 &&
          reply.value.limits.length === 0
        );
      },
      { timeout: 60000 },
    )
    .toBe(true);
  await signedOutPage
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await signedOutPage.locator("#settings-codex").click();
  await expect(signedOutPage.locator("#codex-login")).toBeVisible();
  await expect(signedOutPage.locator("#codex-logout")).toBeHidden();
  await expect(signedOutPage.locator("#codex-model-settings")).toBeHidden();
  await expect(signedOutPage.locator("#codex-limits")).toBeHidden();
  await signedOutPage.screenshot({
    path: join(evidence, "signed-out-after-logout.png"),
    fullPage: true,
  });
  await electron.close();
  electron = undefined;
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({
      status: "pass",
      scope: "P2-signed-in-settings-and-usage",
      packagedNativeWindow: true,
      signedInRuntime: true,
      planAndUsageMatchedRuntime: true,
      skillsMatchedRuntime: true,
      skillChangeRefreshedWhileSettingsOpen: true,
      reopenPassed: true,
      explicitLogoutPassed: true,
      logoutPersistedAfterPackagedReopen: true,
      signedOutModelsAndUsageHidden: true,
      managedBrowserLoginCompleted: false,
      modelTurnStarted: false,
    }),
  );
  console.log(JSON.stringify({ status: "pass", evidence }));
} catch {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({
      status: "fail",
      step,
      detailsOmitted: true,
    }),
  );
  console.error(
    `Signed-in native settings check failed at ${step}; private details omitted.`,
  );
  process.exitCode = 1;
} finally {
  await electron?.close().catch(() => {});
}

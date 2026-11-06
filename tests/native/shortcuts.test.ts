/**
 * Settings, Shortcuts: the section lists every action with its keys; a key is
 * rebound by pressing it, refused with a plain sentence when it clashes or is
 * not allowed, saved across a restart, and the recording keys are registered
 * with the system (and move when changed). Restore all defaults undoes it.
 *
 * node tests/native/shortcuts.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect as baseExpect } from "playwright/test";
import type { ElectronApplication, Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { shortcutActions } from "../../packages/domain/src/shortcuts.ts";

await assertNativeTestEnvironment();
const expect = baseExpect.configure({ timeout: 30_000 });
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-shortcuts-"));
const configRoot = join(evidence, "config");

const launch = () =>
  _electron.launch({
    executablePath,
    env: { ...process.env, XDG_CONFIG_HOME: configRoot },
    chromiumSandbox: true,
    timeout: 60_000,
  });
const registered = (electron: ElectronApplication, accelerator: string) =>
  electron.evaluate(
    ({ globalShortcut }, value) => globalShortcut.isRegistered(value),
    accelerator,
  );
async function openShortcuts(page: Page): Promise<void> {
  await page.locator("#settings").click();
  await page.locator("#settings-shortcuts").click();
  await expect(page.locator("#shortcut-list li")).toHaveCount(
    shortcutActions.length,
  );
}
const keyOf = (page: Page, id: string) =>
  page.locator(`[data-shortcut-key="${id}"]`);
const message = (page: Page) => page.locator("#shortcut-message");

async function rebind(page: Page, id: string, keys: string): Promise<void> {
  await keyOf(page, id).click();
  await expect(keyOf(page, id)).toHaveText("Press the keys…");
  await page.keyboard.press(keys);
}

let electron = await launch();
try {
  let page = await electron.firstWindow();
  await expect(page.locator("#import")).toBeVisible({ timeout: 60_000 });
  await openShortcuts(page);

  // Every action shows its default; the recording keys are registered.
  await expect(keyOf(page, "record.start")).toHaveText("Ctrl+Shift+F9");
  await expect(keyOf(page, "edit.split")).toHaveText("S");
  await expect(keyOf(page, "frame.next")).toHaveText("→");
  const status = await page.evaluate(() => window.desktop.getShortcutStatus());
  assert.ok(status.ok);
  assert.deepEqual(status.value.unavailable, [], "the guest accepts the keys");
  for (const key of [
    "CommandOrControl+Shift+F9",
    "CommandOrControl+Shift+F10",
    "CommandOrControl+Shift+F11",
  ])
    assert.ok(await registered(electron, key), `${key} is registered`);

  // Rebinding saves at once.
  await rebind(page, "edit.split", "x");
  await expect(keyOf(page, "edit.split")).toHaveText("X");
  await expect(message(page)).toHaveText("Shortcut saved.");

  // A clash is refused in plain words, and nothing changes.
  await rebind(page, "edit.zoom", "x");
  await expect(message(page)).toContainText("use the same shortcut");
  await expect(keyOf(page, "edit.zoom")).toHaveText("Z");

  // A key that works in other programs needs Ctrl, Alt or a function key.
  await rebind(page, "record.stop", "q");
  await expect(message(page)).toContainText(
    "needs Ctrl, Alt or a function key",
  );
  await expect(keyOf(page, "record.stop")).toHaveText("Ctrl+Shift+F11");

  // Moving a recording key moves the system registration.
  await rebind(page, "record.start", "Alt+F2");
  await expect(keyOf(page, "record.start")).toHaveText("Alt+F2");
  await expect(message(page)).toHaveText("Shortcut saved.");
  assert.ok(await registered(electron, "Alt+F2"));
  assert.ok(!(await registered(electron, "CommandOrControl+Shift+F9")));

  // Turning one off clears it.
  await page
    .getByRole("button", { name: /Turn off the shortcut for Add a zoom/u })
    .click();
  await expect(keyOf(page, "edit.zoom")).toHaveText("Off");

  await page.screenshot({ path: join(evidence, "shortcuts.png") });

  // The choices survive a restart.
  await electron.close();
  electron = await launch();
  page = await electron.firstWindow();
  await expect(page.locator("#import")).toBeVisible({ timeout: 60_000 });
  await openShortcuts(page);
  await expect(keyOf(page, "edit.split")).toHaveText("X");
  await expect(keyOf(page, "record.start")).toHaveText("Alt+F2");
  await expect(keyOf(page, "edit.zoom")).toHaveText("Off");
  assert.ok(await registered(electron, "Alt+F2"));

  // Appearance's own Save keeps the shortcuts.
  await page.locator("#settings-appearance").click();
  await page.locator("#save-settings").click();
  await expect(page.locator("#settings-dialog")).toBeHidden();
  await openShortcuts(page);
  await expect(keyOf(page, "edit.split")).toHaveText("X");

  // Restore all defaults.
  await page.locator("#shortcuts-reset-all").click();
  await expect(message(page)).toHaveText(
    "Every shortcut is back to its default.",
  );
  await expect(keyOf(page, "edit.split")).toHaveText("S");
  await expect(keyOf(page, "record.start")).toHaveText("Ctrl+Shift+F9");
  assert.ok(await registered(electron, "CommandOrControl+Shift+F9"));
  assert.ok(!(await registered(electron, "Alt+F2")));

  console.log(JSON.stringify({ evidence, result: "shortcuts ok" }));
} finally {
  await electron.close().catch(() => undefined);
}

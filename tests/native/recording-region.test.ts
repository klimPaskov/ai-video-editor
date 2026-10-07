/**
 * Packaged native region recording with a labelled synthetic display (a
 * test pattern, not a screen): choose "Part of the screen", cancel once with
 * Escape, then drag an area on the real overlay window, record it and
 * check the take has exactly that size.
 *
 * node tests/native/recording-region.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { ElectronApplication, Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-recording-region-"));
const result: Record<string, unknown> = {
  scope: "P4-native-region-recording-synthetic-display",
  realHardware: false,
};
let step = "launch";
const electron = await _electron.launch({
  executablePath,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: join(evidence, "config"),
    AI_VIDEO_EDITOR_TEST_CAPTURE: "1",
  },
  chromiumSandbox: true,
  timeout: 30_000,
});

async function overlay(app: ElectronApplication): Promise<Page> {
  const window = await app.waitForEvent("window", { timeout: 15_000 });
  await window.waitForLoadState("domcontentloaded");
  assert.match(window.url(), /\/region\.html$/u);
  await expect(window.locator("#hint")).toBeVisible();
  return window;
}

try {
  const page = await electron.firstWindow();
  step = "open";
  await page
    .getByRole("button", { name: "New recording", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "New recording" });
  await expect(dialog).toBeVisible();
  const whole = dialog.getByRole("radio", { name: "Whole screen" });
  const part = dialog.getByRole("radio", { name: "Part of the screen" });
  await expect(whole).toHaveAttribute("aria-checked", "true");

  step = "cancel";
  let picker = overlay(electron);
  await part.click();
  let picked = await picker;
  // The overlay closes as the key is handled.
  await picked.keyboard.press("Escape").catch(() => undefined);
  await expect(whole).toHaveAttribute("aria-checked", "true", {
    timeout: 10_000,
  });
  await expect(page.locator("#record-area-size")).toBeHidden();

  step = "drag";
  picker = overlay(electron);
  await part.click();
  picked = await picker;
  const size = await picked.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  // A quarter in from the top left, half the width and height.
  await picked.mouse.move(size.width / 4, size.height / 4);
  await picked.mouse.down();
  await picked.mouse.move(size.width / 2, size.height / 2, { steps: 5 });
  await picked.mouse.move((size.width * 3) / 4, (size.height * 3) / 4, {
    steps: 5,
  });
  await picked.mouse.up();
  await expect(picked.locator("#confirm")).toBeVisible();
  await picked.screenshot({ path: join(evidence, "region-overlay.png") });
  await picked.keyboard.press("Enter").catch(() => undefined);
  await expect(part).toHaveAttribute("aria-checked", "true", {
    timeout: 10_000,
  });
  // The synthetic display is 320×180; half of it is 160×90.
  await expect(page.locator("#record-area-size")).toHaveText(
    "160×90 area. Choose Part of the screen again to change it.",
  );
  await page.screenshot({ path: join(evidence, "region-setup.png") });

  step = "record";
  await page.locator("#record-start").click();
  await expect(page.locator("#record-pause")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#record-elapsed")).toHaveText("0:01", {
    timeout: 10_000,
  });
  await page.locator("#record-stop").click();
  await expect(dialog).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });

  step = "verify";
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;
  assert.equal(project.source.width, 160);
  assert.equal(project.source.height, 90);
  result.take = { width: 160, height: 90 };
  result.step = "complete";
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ evidence, result }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, result }, null, 2),
  );
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}

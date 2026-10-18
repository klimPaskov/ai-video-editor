/**
 * Visual check of the timeline strip on an existing many-part project.
 *
 * node tests/native/timeline-strip-look.test.ts <packaged-executable> <config-root>
 *
 * Opens the first project of an existing profile (for example one left by a
 * user-footage run) in Edit and saves screenshots of the strip. It changes
 * nothing but the project's current step.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";

await assertNativeTestEnvironment();
const [executablePath, configRoot] = process.argv.slice(2);
assert.ok(executablePath && configRoot, "Executable and profile are required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-strip-look-"));
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: resolve(configRoot) },
  chromiumSandbox: true,
  timeout: 60_000,
});
try {
  const page = await electron.firstWindow();
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = [...listed.value].sort(
    (a, b) => (b.clips?.length ?? 0) - (a.clips?.length ?? 0),
  )[0]!;
  await page.locator(`#projects [data-project-id="${project.id}"]`).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 600_000 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible({ timeout: 300_000 });
  await expect(page.locator("#preview-message")).toBeHidden({
    timeout: 120_000,
  });
  await page.screenshot({ path: join(evidence, "edit.png") });
  await page
    .locator(".timeline-strip")
    .screenshot({ path: join(evidence, "strip.png") });
  console.log(
    JSON.stringify({
      evidence,
      parts: project.clips?.length ?? 0,
      summary: await page.locator(".timeline-summary").textContent(),
      labels: await page
        .locator(".timeline-clip")
        .evaluateAll(
          (blocks) => blocks.filter((block) => block.textContent).length,
        ),
    }),
  );
} finally {
  await electron.close().catch(() => undefined);
}

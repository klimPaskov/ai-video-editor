/**
 * Packaged native Home project options: rename and delete (P3-06).
 *
 * node tests/native/project-manage.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { ElectronApplication } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-project-manage-"));
const configRoot = join(evidence, "config");
const userData = join(configRoot, appIdentity.slug);
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

const sourcePath = join(evidence, "Demo.mp4");
await runProcess({
  executable: "ffmpeg",
  args: [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-color_range",
    "tv",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    sourcePath,
  ],
  timeoutMs: 120_000,
});
const sourceHash = sha(await readFile(sourcePath));

const launch = () =>
  _electron.launch({
    executablePath,
    env: { ...process.env, XDG_CONFIG_HOME: configRoot },
    chromiumSandbox: true,
    timeout: 30_000,
  });
async function stubDialogs(electron: ElectronApplication) {
  await electron.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [source],
    });
  }, sourcePath);
}

let step = "launch";
const result: Record<string, unknown> = {
  scope: "P3-06-native-project-manage",
};
let electron = await launch();
try {
  await stubDialogs(electron);
  let page = await electron.firstWindow();
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;
  // A conversation file stands in for the project's side data.
  const thread = join(userData, "claude", "threads", `${project.id}.json`);
  await mkdir(join(userData, "claude", "threads"), { recursive: true });
  await writeFile(thread, "{}");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  const card = page.locator(`#projects [data-project-id="${project.id}"]`);
  await expect(card).toBeVisible();

  step = "rename";
  const options = page.getByRole("button", {
    name: `Options for ${project.name}`,
  });
  await options.click();
  const dialog = page.locator("#project-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#project-name")).toBeFocused();
  await expect(page.locator("#project-name")).toHaveValue(project.name);
  await page.locator("#project-name").fill("bad/name");
  await page.locator("#project-save").click();
  await expect(page.locator("#project-dialog-error")).toBeVisible();
  await page.locator("#project-name").fill("  Weekly update  ");
  await page.screenshot({ path: join(evidence, "rename.png") });
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(card).toContainText("Weekly update");
  await expect(
    page.getByRole("button", { name: "Options for Weekly update" }),
  ).toBeFocused();
  result.renamed = true;

  step = "reopen";
  await electron.close();
  electron = await launch();
  await stubDialogs(electron);
  page = await electron.firstWindow();
  await expect(
    page.locator(`#projects [data-project-id="${project.id}"]`),
  ).toContainText("Weekly update", { timeout: 30_000 });
  // Opening it shows the new name too.
  await page.locator(`#projects [data-project-id="${project.id}"]`).click();
  await expect(page.locator("#source-name")).toHaveText("Weekly update", {
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  result.reopened = true;

  step = "delete";
  await page.getByRole("button", { name: "Options for Weekly update" }).click();
  await page.locator("#project-delete").click();
  await expect(page.locator("#project-dialog-title")).toHaveText(
    "Delete project?",
  );
  await expect(page.locator("#project-delete-cancel")).toBeFocused();
  await expect(page.locator("#project-delete-text")).toContainText(
    "Your recordings stay in Media",
  );
  await page.screenshot({ path: join(evidence, "delete-confirm.png") });
  // Cancel goes back without deleting.
  await page.locator("#project-delete-cancel").click();
  await expect(page.locator("#project-rename-view")).toBeVisible();
  await page.locator("#project-delete").click();
  await page.locator("#project-delete-confirm").click();
  // Either the dialog closes or it shows why the delete failed.
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLDialogElement>("#project-dialog")!.open ||
      !document.querySelector<HTMLElement>("#project-dialog-error")!.hidden,
    undefined,
    { timeout: 30_000 },
  );
  assert.equal(
    await page.locator("#project-dialog-error").isVisible(),
    false,
    (await page.locator("#project-dialog-error").textContent()) ?? "",
  );
  await expect(page.locator("#project-dialog")).toBeHidden();
  await expect(page.locator("#projects-section")).toBeHidden();
  await expect(page.locator("#library li")).toHaveCount(1);
  const after = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(after.ok);
  assert.deepEqual(after.value, []);
  assert.deepEqual(
    (await readdir(join(userData, "project-store"))).filter(
      (entry) => !entry.startsWith("."),
    ),
    [],
  );
  await assert.rejects(readFile(thread));
  await page.screenshot({ path: join(evidence, "deleted.png") });
  result.deleted = true;

  step = "media-kept";
  // The recording is still in Media and makes a new project.
  await page.locator("#library .create-project").first().click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  const recreated = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(recreated.ok);
  assert.equal(recreated.value.length, 1);
  assert.equal(sha(await readFile(sourcePath)), sourceHash);
  result.sourceUnchanged = true;
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
  ).catch(() => undefined);
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}

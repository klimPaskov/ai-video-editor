/**
 * Packaged native recording with a camera, using labelled synthetic devices
 * (a test pattern instead of a screen and of a camera, a test tone instead of
 * a microphone; no real hardware is claimed). The take is recorded with the
 * camera chosen in the recording window; when it stops, the project opens
 * with the camera already linked, in sync, and with exactly the screen
 * recording's number of frames.
 *
 * node tests/native/camera-recording.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { openDisclosures, openFullEditor } from "./disclosures.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-camera-recording-"));
const result: Record<string, unknown> = {
  scope: "camera-recording-synthetic-devices",
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
try {
  const page = await electron.firstWindow();
  step = "setup";
  await page
    .getByRole("button", { name: "New recording", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "New recording" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#record-camera option")).toHaveText([
    "No camera",
    "Test pattern (not a camera)",
  ]);
  // Recording without a camera stays the default.
  await expect(page.locator("#record-camera")).toHaveValue("");
  await expect(page.locator("#record-camera-note")).toBeHidden();
  await page
    .locator("#record-camera")
    .selectOption({ label: "Test pattern (not a camera)" });
  await expect(page.locator("#record-camera-note")).toBeVisible();
  await page.screenshot({ path: join(evidence, "record-setup-camera.png") });

  step = "record";
  await page.locator("#record-start").click();
  await expect(page.locator("#record-pause")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#record-elapsed")).toHaveText("0:01", {
    timeout: 20_000,
  });
  await page.locator("#record-pause").click();
  await page.waitForTimeout(500);
  await page.locator("#record-pause").click();
  await expect(page.locator("#record-elapsed")).toHaveText("0:02", {
    timeout: 20_000,
  });

  step = "stop";
  await page.locator("#record-stop").click();
  await expect(dialog).toBeHidden({ timeout: 90_000 });
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });

  step = "verify";
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 1);
  const project = listed.value[0]!;
  const camera = await page.evaluate(
    (id) => window.desktop.getCamera({ schema_version: "1.0", project_id: id }),
    project.id,
  );
  assert.ok(camera.ok);
  assert.equal(camera.value.linked, true);
  assert.equal(camera.value.offset_us, 0);
  assert.equal(camera.value.width, 1280);
  assert.equal(camera.value.height, 720);
  assert.match(camera.value.file_name ?? "", /camera\.mkv$/u);
  // The camera has exactly the screen's frames.
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const assets = join(userData, "media-library", "assets");
  const files = (await readdir(assets)).filter((name) =>
    name.endsWith(".media"),
  );
  assert.equal(files.length, 2, "the screen and the camera recording");
  const frames = async (file: string) =>
    Number(
      (
        await runProcess({
          executable: "ffprobe",
          args: [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_packets",
            "-show_entries",
            "stream=nb_read_packets",
            "-of",
            "csv=p=0",
            join(assets, file),
          ],
        })
      ).stdout
        .toString()
        .trim(),
    );
  const counts = await Promise.all(files.map(frames));
  assert.equal(counts[0], counts[1], `frame counts ${counts}`);
  result.frames = counts[0];

  step = "tools";
  await openFullEditor(page);
  await openDisclosures(page);
  await expect(page.locator("#camera-status")).toHaveText("Camera in sync");
  await expect(page.locator("#camera-add")).toBeHidden();
  await page.screenshot({ path: join(evidence, "camera-tools.png") });
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

/**
 * Packaged native recording recovery with labelled synthetic devices: a
 * take is running when the app is killed; the next launch offers it on
 * Home, and Recover imports what was captured and opens it as a project.
 *
 * node tests/native/recording-recovery.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, expect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(
  join(evidenceRoot, "native-recording-recovery-"),
);
const result: Record<string, unknown> = {
  scope: "P4-native-recording-recovery-synthetic-devices",
  realHardware: false,
};
const launch = () =>
  _electron.launch({
    executablePath,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(evidence, "config"),
      AI_VIDEO_EDITOR_TEST_CAPTURE: "1",
    },
    chromiumSandbox: true,
    timeout: 30_000,
  });
let step = "record";
let electron = await launch();
try {
  let page = await electron.firstWindow();
  await page
    .getByRole("button", { name: "New recording", exact: true })
    .click();
  await page.locator("#record-start").click();
  await expect(page.locator("#record-elapsed")).toHaveText("0:02", {
    timeout: 20_000,
  });

  step = "crash";
  electron.process().kill("SIGKILL");
  // The capture must stop by itself: no FFmpeg may keep recording into
  // this test's folder once the app is gone.
  const capturing = async () => {
    const found: string[] = [];
    for (const pid of await readdir("/proc").catch(() => [] as string[])) {
      if (!/^\d+$/u.test(pid)) continue;
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
        () => "",
      );
      if (command.includes(evidence) && command.includes("segment-"))
        found.push(pid);
    }
    return found;
  };
  for (let wait = 0; wait < 40 && (await capturing()).length; wait++)
    await delay(250);
  assert.deepEqual(await capturing(), [], "capture stopped with the app");
  result.captureStoppedWithApp = true;

  step = "relaunch";
  electron = await launch();
  page = await electron.firstWindow();
  const notice = page.getByRole("region", { name: "Interrupted recording" });
  await expect(notice).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#recovery-text")).toContainText("was interrupted");
  await page.screenshot({ path: join(evidence, "recovery-notice.png") });

  step = "recover";
  await page.locator("#recovery-recover").click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 1);
  const project = listed.value[0]!;
  assert.match(project.name, /^Recording .+\.mkv$/u);
  const durationUs = project.timeline.durationUs;
  assert.ok(
    durationUs >= 1_500_000 && durationUs <= 5_000_000,
    `duration ${durationUs}`,
  );
  assert.equal(project.source.previewAvailable, true);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(notice).toBeHidden();
  result.recovered = { durationUs };
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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertTwoSourceInitialProjectSnapshot } from "../../packages/domain/src/project.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

assert.equal(
  process.platform,
  "linux",
  "Native tests require the isolated guest",
);
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await access("/.dockerenv");
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const root = resolve("test-results");
await mkdir(root, { recursive: true });
const evidence = await mkdtemp(join(root, "native-two-source-"));
const sources: string[] = [];
const originals: Buffer[] = [];
for (const [index, pattern] of ["testsrc", "testsrc2"].entries()) {
  const source = join(evidence, `part-${index + 1}.mp4`);
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      `${pattern}=size=96x64:rate=2:duration=1`,
      "-vf",
      "setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
      "-c:v",
      "libx264",
      "-qp",
      "0",
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
      source,
    ],
  });
  sources.push(source);
  originals.push(await readFile(source));
}
const env = { ...process.env, XDG_CONFIG_HOME: join(evidence, "config") };
let electron = await _electron.launch({
  executablePath,
  chromiumSandbox: true,
  env,
  timeout: 30_000,
});
async function canvasBytes(page: Page): Promise<Buffer> {
  return Buffer.from(
    await page
      .locator("canvas")
      .evaluate((node) =>
        Array.from(
          (node as HTMLCanvasElement)
            .getContext("2d")!
            .getImageData(0, 0, 96, 64).data,
        ),
      ),
  );
}
async function seek(page: Page, timeUs: number): Promise<void> {
  await page.locator("#seek").evaluate((node, value) => {
    const input = node as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, timeUs);
  const seconds = timeUs / 1_000_000;
  await expect(page.locator("#time")).toHaveText(
    `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}`,
  );
}
try {
  let page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "codex-video-edit://app/index.html");
  await electron.evaluate(({ dialog }, paths) => {
    let index = 0;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [paths[index++]!],
    });
  }, sources);
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add footage" })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Add footage" }).click();
  await expect(page.locator("#duration")).toHaveText(" / 0:02.000", {
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Add footage" })).toBeHidden();
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  assert.equal(listed.value.length, 2);
  const combined = listed.value.find(
    (project) => project.sources?.length === 2,
  );
  assert.ok(combined);
  const restoreBeforeEdit = await page.evaluate(
    (request) => window.desktop.applyManualRestoreRange(request),
    {
      schema_version: "1.0" as const,
      projectId: combined.id,
      draftId: combined.draft.id,
      baseRevisionId: combined.draft.baseRevisionId,
      expectedSequence: combined.draft.sequence,
      expectedTimelineSha256: combined.draft.timelineSha256,
      sourceId: combined.sources![1]!.id,
      sourceStartUs: 0,
      sourceEndUs: 100_000,
    },
  );
  assert.equal(restoreBeforeEdit.ok, false);
  if (!restoreBeforeEdit.ok)
    assert.equal(
      restoreBeforeEdit.message,
      "Switch to Edit to restore a source range.",
    );
  const baselinePath = join(
    userData,
    "project-store",
    combined.id,
    "baseline.json",
  );
  const baselineBytes = await readFile(baselinePath);
  const baseline: unknown = JSON.parse(baselineBytes.toString("utf8"));
  assertTwoSourceInitialProjectSnapshot(baseline);
  assert.deepEqual(
    combined.sources?.map((source) => source.id),
    baseline.project.source_ids,
  );
  const library = new MediaLibrary(join(userData, "media-library"));
  const expectedSecond = Buffer.from(
    (await library.frame(baseline.sources[1].source_id, 0)).rgbaBase64,
    "base64",
  );
  await seek(page, 750_000);
  const firstFrame = await canvasBytes(page);
  await seek(page, 1_000_000);
  assert.deepEqual(await canvasBytes(page), expectedSecond);
  assert.notDeepEqual(firstFrame, expectedSecond);
  await page.getByRole("button", { name: "Source details" }).click();
  await expect(page.locator("#source-properties")).toContainText("Part 1");
  await expect(page.locator("#source-properties")).toContainText("Part 2");
  await page.screenshot({ path: join(evidence, "two-source-join.png") });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible();
  await expect(page.locator("#trim-start")).toBeDisabled();
  await expect(page.locator("#trim-end")).toBeDisabled();
  await expect(page.locator("#split-clip")).toBeDisabled();
  await expect(page.locator("#undo-edit")).toBeDisabled();
  await expect(page.locator("#redo-edit")).toBeDisabled();
  await seek(page, 750_000);
  await expect(page.locator("#trim-start")).toBeEnabled();
  await page.locator("#trim-start").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:01.250");
  const editedProjects = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(editedProjects.ok);
  const edited = editedProjects.value.find(
    (project) => project.id === combined.id,
  );
  assert.equal(edited?.clips?.[0]?.sourceStartUs, 750_000);
  assert.equal(edited?.clips?.[1]?.timelineStartUs, 250_000);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#duration")).toHaveText(" / 0:02.000");
  const restoredProjects = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(restoredProjects.ok);
  const restored = restoredProjects.value.find(
    (project) => project.id === combined.id,
  );
  assert.equal(restored?.clips?.[0]?.sourceStartUs, 0);
  assert.equal(restored?.clips?.[1]?.timelineStartUs, 1_000_000);
  await expect(page.locator("#redo-edit")).toBeEnabled();
  await page.locator("#redo-edit").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:01.250");
  const redoneProjects = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(redoneProjects.ok);
  const redone = redoneProjects.value.find(
    (project) => project.id === combined.id,
  );
  assert.equal(redone?.clips?.[0]?.sourceStartUs, 750_000);
  assert.equal(redone?.clips?.[1]?.timelineStartUs, 250_000);
  await seek(page, 0);
  assert.deepEqual(
    await canvasBytes(page),
    Buffer.from(
      (await library.frame(baseline.sources[0].source_id, 750_000)).rgbaBase64,
      "base64",
    ),
  );
  await expect(page.locator("#undo-edit")).toBeEnabled();
  await page.locator("#undo-edit").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:02.000");
  await seek(page, 500_000);
  await expect(page.locator("#split-clip")).toBeEnabled();
  await page.locator("#split-clip").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:02.000");
  const splitProjects = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(splitProjects.ok);
  const split = splitProjects.value.find(
    (project) => project.id === combined.id,
  );
  assert.equal(split?.clips?.length, 3);
  assert.equal(split?.clips?.[0]?.timelineEndUs, 500_000);
  assert.equal(split?.clips?.[1]?.sourceStartUs, 500_000);
  assert.equal(split?.clips?.[2]?.timelineStartUs, 1_000_000);
  await seek(page, 750_000);
  assert.deepEqual(await canvasBytes(page), firstFrame);
  await page.locator("#trim-start").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:01.750");
  const trimmedFragmentProjects = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(trimmedFragmentProjects.ok);
  const trimmedFragment = trimmedFragmentProjects.value.find(
    (project) => project.id === combined.id,
  );
  assert.equal(trimmedFragment?.clips?.[1]?.sourceStartUs, 750_000);
  assert.equal(trimmedFragment?.clips?.[2]?.timelineStartUs, 750_000);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#duration")).toHaveText(" / 0:02.000");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#duration")).toHaveText(" / 0:02.000");
  const unsplitProjects = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(unsplitProjects.ok);
  assert.equal(
    unsplitProjects.value.find((project) => project.id === combined.id)?.clips
      ?.length,
    2,
  );
  await seek(page, 250_000);
  await page.locator("#mark-in").click();
  await seek(page, 1_500_000);
  await page.locator("#mark-out").click();
  await expect(page.locator("#cut-selection")).toHaveText(
    "In 0:00.250 · Out 0:01.500",
  );
  await expect(page.locator("#cut-range")).toBeEnabled();
  await page.locator("#cut-range").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:00.750");
  const cutProjects = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(cutProjects.ok);
  const cut = cutProjects.value.find((project) => project.id === combined.id);
  assert.equal(cut?.clips?.length, 2);
  assert.equal(cut?.clips?.[0]?.timelineEndUs, 250_000);
  assert.equal(cut?.clips?.[1]?.timelineStartUs, 250_000);
  assert.equal(cut?.clips?.[1]?.sourceStartUs, 500_000);
  const expectedAfterCut = Buffer.from(
    (await library.frame(baseline.sources[1].source_id, 500_000)).rgbaBase64,
    "base64",
  );
  await seek(page, 250_000);
  await expect
    .poll(async () => (await canvasBytes(page)).equals(expectedAfterCut), {
      timeout: 30_000,
    })
    .toBe(true);
  await page.locator("#restore-toggle").click();
  await expect(page.locator("#restore-form")).toBeVisible();
  await page
    .locator("#restore-source")
    .selectOption(baseline.sources[1].source_id);
  await page.locator("#restore-source-start").fill("0.000000");
  await expect(page.locator("#restore-submit")).toBeDisabled();
  await expect(page.locator("#restore-error")).toHaveText(
    "Enter both source times to restore the interval.",
  );
  await page.locator("#restore-source-start").fill("");
  await page.locator("#restore-source-start").fill("0.500000");
  await page.locator("#restore-source-end").fill("1.000000");
  await expect(page.locator("#restore-submit")).toBeDisabled();
  await expect(page.locator("#restore-error")).toHaveText(
    "That source interval is already visible in the draft.",
  );
  await page.locator("#restore-source-start").fill("0.000000");
  await page.locator("#restore-source-end").fill("0.500000");
  await expect(page.locator("#restore-submit")).toBeEnabled();
  if (process.argv.includes("--inspect")) {
    const marker = join(evidence, "restore-inspection.done"),
      deadline = Date.now() + 300_000;
    await page.screenshot({ path: join(evidence, "restore-form.png") });
    await writeFile(join(evidence, "restore-inspection.ready"), "ready\n");
    while (Date.now() < deadline) {
      if (
        await access(marker).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((done) => setTimeout(done, 500));
    }
    await access(marker);
  }
  await page.locator("#restore-submit").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:01.250");
  const manuallyRestoredProjects = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(manuallyRestoredProjects.ok);
  const manuallyRestored = manuallyRestoredProjects.value.find(
    (project) => project.id === combined.id,
  );
  assert.ok(manuallyRestored);
  const restoredSourceInterval = manuallyRestored.clips?.find(
    (clip) =>
      clip.sourceId === baseline.sources[1].source_id &&
      clip.sourceStartUs === 0 &&
      clip.sourceEndUs === 500_000,
  );
  assert.equal(restoredSourceInterval?.timelineStartUs, 250_000);
  await seek(page, 250_000);
  await expect
    .poll(async () => (await canvasBytes(page)).equals(expectedSecond), {
      timeout: 30_000,
    })
    .toBe(true);
  if (process.argv.includes("--inspect")) {
    const marker = join(evidence, "restore-complete.done"),
      deadline = Date.now() + 300_000;
    await page.screenshot({ path: join(evidence, "restore-committed.png") });
    await writeFile(join(evidence, "restore-complete.ready"), "ready\n");
    console.log(JSON.stringify({ restoreCompleteReady: true, evidence }));
    while (Date.now() < deadline) {
      if (
        await access(marker).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((done) => setTimeout(done, 500));
    }
    await access(marker);
  }
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  for (let index = 0; index < sources.length; index++) {
    assert.deepEqual(await readFile(sources[index]!), originals[index]);
    assert.deepEqual(
      await readFile(baseline.sources[index]!.managed_path),
      originals[index],
    );
  }
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  for (let index = 0; index < sources.length; index++)
    assert.deepEqual(await readFile(sources[index]!), originals[index]);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#duration")).toHaveText(" / 0:00.750");
  await seek(page, 250_000);
  await expect
    .poll(async () => (await canvasBytes(page)).equals(expectedAfterCut), {
      timeout: 30_000,
    })
    .toBe(true);
  await expect(page.locator("#cut-selection")).toBeHidden();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator("#duration")).toHaveText(" / 0:02.000");
  await seek(page, 250_000);
  const expectedRestoredFirst = Buffer.from(
    (await library.frame(baseline.sources[0].source_id, 0)).rgbaBase64,
    "base64",
  );
  await expect
    .poll(async () => (await canvasBytes(page)).equals(expectedRestoredFirst), {
      timeout: 30_000,
    })
    .toBe(true);
  await expect(page.locator("#frame")).toBeVisible();
  await expect(page.locator("#cut-range")).toBeInViewport();
  await page.screenshot({
    path: join(evidence, "two-source-range-controls.png"),
  });
  await electron.close();

  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30_000,
  });
  page = await electron.firstWindow();
  await page.locator(`#projects [data-project-id="${combined.id}"]`).click();
  await expect(page.locator("#duration")).toHaveText(" / 0:02.000", {
    timeout: 30_000,
  });
  await seek(page, 1_000_000);
  assert.deepEqual(await canvasBytes(page), expectedSecond);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  for (let index = 0; index < sources.length; index++) {
    assert.deepEqual(await readFile(sources[index]!), originals[index]);
    assert.deepEqual(
      await readFile(baseline.sources[index]!.managed_path),
      originals[index],
    );
  }
  await expect(page.locator("#redo-edit")).toBeEnabled();
  await page.locator("#redo-edit").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:00.750");
  await seek(page, 250_000);
  await expect
    .poll(async () => (await canvasBytes(page)).equals(expectedAfterCut), {
      timeout: 30_000,
    })
    .toBe(true);
  await expect(page.locator("#redo-edit")).toBeEnabled();
  await page.locator("#redo-edit").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:01.250");
  await seek(page, 250_000);
  await expect
    .poll(async () => (await canvasBytes(page)).equals(expectedSecond), {
      timeout: 30_000,
    })
    .toBe(true);
  await page.locator("#undo-edit").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:00.750");
  await page.locator("#undo-edit").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:02.000");
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  for (let index = 0; index < sources.length; index++) {
    assert.deepEqual(await readFile(sources[index]!), originals[index]);
    assert.deepEqual(
      await readFile(baseline.sources[index]!.managed_path),
      originals[index],
    );
  }
  await page.screenshot({ path: join(evidence, "two-source-reopened.png") });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#interface-scale").selectOption("2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#settings-dialog")).toBeHidden();
  assert.equal(
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.getZoomFactor(),
    ),
    2,
  );
  await page.locator("#edit-actions").scrollIntoViewIfNeeded();
  await expect(page.locator("#edit-actions")).toBeInViewport();
  const actionBounds = await page.locator("#edit-actions").boundingBox();
  assert.ok(actionBounds);
  assert.ok(actionBounds.x >= 0);
  const viewportWidth = await page.evaluate(() => window.innerWidth);
  assert.ok(actionBounds.x + actionBounds.width <= viewportWidth);
  await page.screenshot({ path: join(evidence, "two-source-edit-200.png") });
  if (process.argv.includes("--inspect")) {
    await writeFile(join(evidence, "inspection.ready"), "ready\n");
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      if (
        await access(join(evidence, "inspection.done")).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        scope: "two-source-native-project",
        packaged: true,
        nativeWindow: true,
        sourceCount: 2,
        exactJoinFrame: true,
        reopen: true,
        manualRedo: true,
        redoSurvivesReopen: true,
        manualRestore: true,
        restoreUndoAndRedoSurviveReopen: true,
        originalsAndManagedCopiesUnchanged: true,
        baselineUnchanged: true,
        syntheticFixtureHashes: originals.map((bytes) =>
          createHash("sha256").update(bytes).digest("hex"),
        ),
      },
      null,
      2,
    ),
  );
  process.stdout.write(JSON.stringify({ evidence, result: "passed" }) + "\n");
} finally {
  await electron.close();
}

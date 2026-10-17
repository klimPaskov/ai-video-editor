/**
 * Packaged native run on the user's own two recordings (P10 groundwork).
 *
 * node tests/native/user-footage.test.ts <packaged-executable> <first.mp4> <second.mp4> [--skip-export]
 *
 * Imports the recordings in the given order through the visible UI, runs the
 * deterministic Magic Edit (Balanced), turns on captions and loudness, makes a
 * manual refinement, checks shared Undo/Redo, reopens the project, exports the
 * default lossless master and a separately requested MP4, and checks that the
 * originals and managed copies never change. It runs no AI assistant, so it is
 * not the final acceptance in docs/40; that needs a signed-in Claude or Codex.
 *
 * Footage, transcripts, screenshots and outputs stay in the isolated guest's
 * ignored test-results. Only aggregate facts are printed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { ElectronApplication, Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { appIdentity } from "../../packages/domain/src/app-identity.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const [executablePath, firstPath, secondPath] = process.argv.slice(2);
assert.ok(
  executablePath && firstPath && secondPath,
  "Executable and both recordings are required",
);
const skipExport = process.argv.includes("--skip-export");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-user-footage-"));
const configRoot = join(evidence, "config");
const outputs = join(evidence, "outputs");
await mkdir(outputs, { mode: 0o700 });
const started = Date.now();
const elapsed = () => Math.round((Date.now() - started) / 1000);

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function probe(path: string) {
  return JSON.parse(
    (
      await runProcess({
        executable: "ffprobe",
        args: [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-count_packets",
          "-of",
          "json",
          path,
        ],
        timeoutMs: 1_800_000,
        maxOutputBytes: 8 * 1024 * 1024,
      })
    ).stdout.toString(),
  ) as {
    streams: Array<Record<string, unknown>>;
    format: Record<string, unknown>;
  };
}

const originals = [firstPath, secondPath].map((path) => resolve(path));
const originalHashes = await Promise.all(originals.map(fileHash));
let step = "launch";
const result: Record<string, unknown> = {
  scope: "P10-groundwork-user-footage",
  assistant: "none (deterministic Magic Edit only)",
};
const marks: Array<[string, number]> = [];
const mark = (name: string) => {
  step = name;
  marks.push([name, elapsed()]);
  console.log(JSON.stringify({ step: name, seconds: elapsed() }));
};

const launch = () =>
  _electron.launch({
    executablePath,
    env: { ...process.env, XDG_CONFIG_HOME: configRoot },
    chromiumSandbox: true,
    timeout: 60_000,
  });

async function dialogs(electron: ElectronApplication, save: string | null) {
  await electron.evaluate(
    ({ dialog }, value) => {
      let index = 0;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [value.sources[index++]!],
      });
      dialog.showSaveDialog = async () =>
        value.save
          ? { canceled: false, filePath: value.save }
          : { canceled: true, filePath: "" };
    },
    { sources: originals, save },
  );
}

// Adding footage creates a new two-source project beside the first one.
let projectId: string | null = null;
async function project(page: Page) {
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const found = projectId
    ? listed.value.find((view) => view.id === projectId)
    : listed.value.find((view) => view.sources?.length === 2);
  assert.ok(found, "the two-source project is listed");
  projectId = found.id;
  return found;
}

// How long the preview takes to show the frame after an edit or a seek.
const frameWaits: Record<string, number> = {};
async function frameShown(page: Page, label: string) {
  const start = Date.now();
  await expect(page.locator("#preview-message")).toBeHidden({
    timeout: 120_000,
  });
  frameWaits[label] = Date.now() - start;
}

let electron = await launch();
try {
  await dialogs(electron, null);
  let page = await electron.firstWindow();
  mark("import");
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add footage" })).toBeVisible({
    timeout: 600_000,
  });
  await page.getByRole("button", { name: "Add footage" }).click();
  await expect(page.getByRole("button", { name: "Add footage" })).toBeHidden({
    timeout: 600_000,
  });
  await expect(page.locator("#frame")).toBeVisible({ timeout: 600_000 });
  let current = await project(page);
  const userData = join(configRoot, appIdentity.slug);
  const folder = join(userData, "project-store", current.id);
  const baselineBytes = await readFile(join(folder, "baseline.json"));
  const baseline = JSON.parse(baselineBytes.toString("utf8")) as {
    sources: Array<{ source_id: string; managed_path: string; sha256: string }>;
  };
  assert.equal(baseline.sources.length, 2);
  // The second recording follows the first, and both managed copies match.
  assert.deepEqual(
    baseline.sources.map((source) => source.sha256),
    originalHashes,
  );
  for (const [index, source] of baseline.sources.entries())
    assert.equal(await fileHash(source.managed_path), originalHashes[index]);
  assert.deepEqual(
    current.clips?.map((clip) => clip.sourceId),
    baseline.sources.map((s) => s.source_id),
  );
  const originalDurationUs = current.timeline.durationUs;
  result.imported = {
    sources: 2,
    inOrder: true,
    durationSeconds: Math.round(originalDurationUs / 1e6),
  };
  await page.screenshot({ path: join(evidence, "imported.png") });

  mark("magic-edit");
  await page.getByRole("button", { name: "Auto Edit", exact: true }).click();
  await expect(page.locator("#magic-start")).toBeVisible();
  await expect(page.locator("#magic-preset")).toHaveValue("balanced");
  await page.locator("#magic-start").click();
  await expect(page.locator("#magic-status")).toContainText("Removed", {
    timeout: 4 * 3_600_000,
  });
  await expect(page.locator("#magic-error")).toBeHidden();
  const summary = (await page.locator("#magic-status").textContent()) ?? "";
  current = await project(page);
  const journal = join(folder, "draft", "journal");
  const records = async () =>
    Promise.all(
      (await readdir(journal).catch(() => []))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(
          async (name) =>
            JSON.parse(await readFile(join(journal, name), "utf8")) as {
              origin: string;
              kind: string;
            },
        ),
    );
  const magic = (await records()).filter(
    (record) => record.origin === "magic_wand",
  );
  result.magicEdit = {
    transactions: magic.length,
    removedSeconds: Math.round(
      (originalDurationUs - current.timeline.durationUs) / 1e6,
    ),
    editedSeconds: Math.round(current.timeline.durationUs / 1e6),
    summaryLength: summary.length,
  };
  await frameShown(page, "afterMagicEdit");
  await page.screenshot({ path: join(evidence, "magic-edit.png") });

  mark("captions-audio");
  // Caption and audio choices are undoable draft edits; wait for each save.
  const sequence = async () => (await project(page)).draft.sequence;
  const saved = async (before: number) =>
    expect
      .poll(sequence, { timeout: 300_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThan(before);
  let captions = false;
  if (await page.locator("#captions-enabled").isEnabled()) {
    let before = await sequence();
    await page.locator("#captions-enabled").check();
    await saved(before);
    before = await sequence();
    await page.locator("#captions-style").selectOption("highlight");
    await saved(before);
    captions = true;
  }
  const beforeAudio = await sequence();
  await page.locator("#audio-normalize").check();
  await saved(beforeAudio);
  current = await project(page);
  result.presentation = { captions, loudness: true };

  mark("manual-refinement");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible({ timeout: 300_000 });
  const beforeManual = (await project(page)).draft.sequence;
  // Split at the join between the recordings, then check shared Undo/Redo.
  const join0 = (await project(page)).clips!.find(
    (clip, index, all) =>
      index > 0 && clip.sourceId !== all[index - 1]!.sourceId,
  );
  if (join0) {
    await page.evaluate((us) => {
      const seek = document.querySelector<HTMLInputElement>("#seek")!;
      seek.value = String(us);
      seek.dispatchEvent(new Event("input"));
    }, join0.timelineStartUs + 1_000_000);
    await expect(page.locator(".preview")).not.toHaveClass(/loading/u, {
      timeout: 120_000,
    });
    await page.locator("#split-clip").click();
    await expect.poll(sequence, { timeout: 300_000 }).toBe(beforeManual + 1);
    await page.locator("#undo-edit").click();
    await expect.poll(sequence, { timeout: 300_000 }).toBe(beforeManual + 2);
    await page.locator("#redo-edit").click();
    await expect.poll(sequence, { timeout: 300_000 }).toBe(beforeManual + 3);
  }
  current = await project(page);
  result.manual = {
    splitAtJoinWithUndoRedo: Boolean(join0),
    sequence: current.draft.sequence,
  };
  await frameShown(page, "afterRedo");
  await page.evaluate(
    (us) => {
      const seek = document.querySelector<HTMLInputElement>("#seek")!;
      seek.value = String(us);
      seek.dispatchEvent(new Event("input"));
    },
    Math.round(current.timeline.durationUs * 0.75),
  );
  await frameShown(page, "seek");
  result.previewFrameMs = frameWaits;
  await page.screenshot({ path: join(evidence, "edit.png") });

  mark("reopen");
  const head = {
    sequence: current.draft.sequence,
    sha: current.draft.timelineSha256,
    duration: current.timeline.durationUs,
  };
  await electron.close();
  electron = await launch();
  await dialogs(electron, null);
  page = await electron.firstWindow();
  await page.locator(`#projects [data-project-id="${current.id}"]`).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 600_000 });
  current = await project(page);
  assert.deepEqual(
    {
      sequence: current.draft.sequence,
      sha: current.draft.timelineSha256,
      duration: current.timeline.durationUs,
    },
    head,
  );
  result.reopened = true;

  if (!skipExport) {
    mark("export-master");
    const master = join(outputs, "User footage master.mkv");
    await dialogs(electron, master);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.locator("#export-profile")).toHaveValue(
      "lossless_master",
    );
    await page.locator("#export-start").click();
    await expect(page.locator("#export-done")).toBeVisible({
      timeout: 8 * 3_600_000,
    });
    await expect(page.locator("#export-result")).toContainText(
      "verified lossless",
    );
    const done = await page.evaluate(
      (id) =>
        window.desktop.getExport({ schema_version: "1.0", project_id: id }),
      current.id,
    );
    assert.ok(done.ok);
    assert.equal(done.value.result?.samplesEqual, true);
    const probed = await probe(master);
    const video = probed.streams.find(
      (stream) => stream.codec_type === "video",
    )!;
    const audio = probed.streams.find(
      (stream) => stream.codec_type === "audio",
    )!;
    assert.equal(video.codec_name, "ffv1");
    assert.equal(video.width, 2560);
    assert.equal(video.height, 1440);
    assert.match(String(audio.codec_name), /^pcm_/u);
    const frames = Number(video.nb_read_packets);
    const expectedFrames = Math.round((head.duration * 60) / 1e6);
    assert.ok(
      Math.abs(frames - expectedFrames) <= 2,
      `${frames} vs ${expectedFrames}`,
    );
    result.master = {
      appVerifiedSampleEquality: true,
      codec: video.codec_name,
      size: `${video.width}x${video.height}`,
      frames,
      gigabytes: Math.round(Number(probed.format.size) / 1e8) / 10,
      independentFullDecode:
        "not run: too large for the guest's memory budget; the app's own export verification compared decoded samples",
    };
    await page.screenshot({ path: join(evidence, "export-master.png") });

    mark("export-mp4");
    const share = join(outputs, "User footage share.mp4");
    await dialogs(electron, share);
    await page.locator("#export-again").click();
    await page.locator("#export-profile").selectOption("smaller_mp4");
    await page.locator("#export-start").click();
    await expect(page.locator("#export-done")).toBeVisible({
      timeout: 8 * 3_600_000,
    });
    const shared = await probe(share);
    const sharedVideo = shared.streams.find(
      (stream) => stream.codec_type === "video",
    )!;
    assert.ok(Math.abs(Number(sharedVideo.nb_read_packets) - frames) <= 2);
    result.mp4 = {
      frames: Number(sharedVideo.nb_read_packets),
      megabytes: Math.round(Number(shared.format.size) / 1e6),
    };
  }

  mark("immutability");
  assert.deepEqual(await Promise.all(originals.map(fileHash)), originalHashes);
  for (const [index, source] of baseline.sources.entries())
    assert.equal(await fileHash(source.managed_path), originalHashes[index]);
  assert.deepEqual(
    await readFile(join(folder, "baseline.json")),
    baselineBytes,
  );
  result.sourcesUnchanged = true;
  result.step = "complete";
  result.marks = marks;
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ evidence, result }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, result, marks }, null, 2),
  ).catch(() => undefined);
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}

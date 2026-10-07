/**
 * Packaged native export: import a tagged H.264/AAC source, cut a range,
 * export the lossless master and a smaller MP4 through the Export step,
 * cancel a running export, and verify every published file independently.
 *
 * node tests/native/export.test.ts <packaged-executable> [--inspect]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, expect } from "playwright/test";
import type { ElectronApplication, Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { rawFrameBytes } from "../../packages/media-engine/src/render.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const inspect = process.argv.includes("--inspect");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-export-"));
const configRoot = join(evidence, "config");
const outputs = join(evidence, "exports");
await mkdir(outputs, { mode: 0o700 });
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

async function ffmpeg(args: string[]): Promise<Buffer> {
  return (
    await runProcess({
      executable: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
      timeoutMs: 300_000,
      maxOutputBytes: 1024 * 1024 * 1024,
    })
  ).stdout;
}

const sourcePath = join(evidence, "Talk.mp4");
await ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=30:duration=6",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000:duration=6",
  "-c:v",
  "libx264",
  "-g",
  "60",
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
  "-c:a",
  "aac",
  "-ac",
  "2",
  "-shortest",
  sourcePath,
]);
const sourceHash = sha(await readFile(sourcePath));

let step = "launch";
const result: Record<string, unknown> = { scope: "P9-03-native-export" };
const launch = () =>
  _electron.launch({
    executablePath,
    env: { ...process.env, XDG_CONFIG_HOME: configRoot },
    chromiumSandbox: true,
    timeout: 30_000,
  });

async function stub(electron: ElectronApplication): Promise<void> {
  await electron.evaluate(
    ({ dialog, shell }, value) => {
      const state = globalThis as unknown as {
        __savePath?: string;
        __revealed?: string[];
        __opened?: string[];
      };
      state.__revealed = [];
      state.__opened = [];
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [value.source],
      });
      dialog.showSaveDialog = async () =>
        state.__savePath
          ? { canceled: false, filePath: state.__savePath }
          : { canceled: true, filePath: "" };
      shell.showItemInFolder = (file: string) => {
        state.__revealed!.push(file);
      };
      shell.openPath = async (file: string) => {
        state.__opened!.push(file);
        return "";
      };
      shell.openExternal = async () => {
        throw new Error("External launch disabled in isolated test");
      };
    },
    { source: sourcePath },
  );
}

async function savePath(electron: ElectronApplication, file: string | null) {
  await electron.evaluate((_, value) => {
    (globalThis as unknown as { __savePath?: string | null }).__savePath =
      value;
  }, file);
}

async function hold(name: string): Promise<void> {
  if (!inspect) return;
  await writeFile(join(evidence, `${name}.ready`), "ready\n");
  console.log(JSON.stringify({ inspectionReady: name, evidence }));
  const done = join(evidence, `${name}.done`);
  for (let index = 0; index < 720; index++) {
    try {
      await access(done);
      return;
    } catch {
      await delay(250);
    }
  }
}

async function decode(file: string, pixelFormat: string, audioRaw: string) {
  return {
    video: await ffmpeg([
      "-i",
      file,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "rawvideo",
      "-pix_fmt",
      pixelFormat,
      "-f",
      "rawvideo",
      "pipe:1",
    ]),
    audio: await ffmpeg([
      "-i",
      file,
      "-map",
      "0:a:0",
      "-c:a",
      `pcm_${audioRaw}`,
      "-f",
      audioRaw,
      "pipe:1",
    ]),
  };
}

async function exportView(page: Page, projectId: string) {
  const reply = await page.evaluate(
    (id) => window.desktop.getExport({ schema_version: "1.0", project_id: id }),
    projectId,
  );
  assert.ok(reply.ok);
  return reply.value;
}

const electron = await launch();
try {
  await stub(electron);
  const page = await electron.firstWindow();
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;

  step = "cut";
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible();
  // Remove 1.0 s .. 2.5 s of output time (not frame-aligned at the end).
  const cut = await page.evaluate(
    (value) =>
      window.desktop.applyManualRangeCut({
        schema_version: "1.0",
        projectId: value.id,
        draftId: value.draft.id,
        baseRevisionId: value.draft.baseRevisionId,
        expectedSequence: value.draft.sequence,
        expectedTimelineSha256: value.draft.timelineSha256,
        startUs: 1_000_000,
        endUs: 2_510_000,
      }),
    project,
  );
  assert.ok(cut.ok, "The range cut must commit");
  const edited = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(edited.ok);
  const clips = edited.value.find((item) => item.id === project.id)!.clips!;
  assert.equal(clips.length, 2);

  step = "export-step";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator("#export-actions")).toBeVisible();
  await expect(page.locator("#export-profile")).toHaveValue("lossless_master");
  await expect(page.locator("#export-profile-note")).toContainText("FFV1");
  await page.screenshot({ path: join(evidence, "export-setup.png") });
  await hold("export-setup");

  step = "save-dialog-cancel";
  await savePath(electron, null);
  await page.locator("#export-start").click();
  // The request returns only after the dialog closed without a choice.
  await expect(page.locator("#export-start")).toBeEnabled({ timeout: 60_000 });
  await expect(page.locator("#export-setup")).toBeVisible();
  assert.equal((await exportView(page, project.id)).status, "idle");

  step = "lossless-export";
  const master = join(outputs, "Talk master.mkv");
  await savePath(electron, master);
  await page.locator("#export-start").click();
  await expect(page.locator("#export-done")).toBeVisible({ timeout: 300_000 });
  await expect(page.locator("#export-result")).toContainText("Talk master.mkv");
  await expect(page.locator("#export-result")).toContainText(
    "verified lossless",
  );
  const done = await exportView(page, project.id);
  assert.equal(done.status, "completed");
  assert.equal(done.result?.samplesEqual, true);
  assert.equal(done.result?.draftSequence, 1);
  await page.screenshot({ path: join(evidence, "export-done.png") });
  await hold("export-done");
  await page.locator("#export-reveal").click();
  await page.locator("#export-open").click();
  const opened = await electron.evaluate(() => {
    const state = globalThis as unknown as {
      __revealed?: string[];
      __opened?: string[];
    };
    return { revealed: state.__revealed ?? [], opened: state.__opened ?? [] };
  });
  assert.deepEqual(opened, { revealed: [master], opened: [master] });

  step = "independent-verification";
  // Expected canonical: full no-seek decode of the source, sliced by the
  // frames whose presentation starts inside each clip's source range.
  const full = await decode(sourcePath, "yuv420p", "f32le");
  const frameBytes = rawFrameBytes("yuv420p", 320, 180);
  const expectedVideo: Buffer[] = [];
  const expectedAudio: Buffer[] = [];
  for (const clip of clips) {
    const first = Math.ceil((clip.sourceStartUs * 30) / 1_000_000);
    const end = Math.ceil((clip.sourceEndUs * 30) / 1_000_000);
    expectedVideo.push(
      full.video.subarray(first * frameBytes, end * frameBytes),
    );
    expectedAudio.push(full.audio.subarray(first * 1600 * 8, end * 1600 * 8));
  }
  const exported = await decode(master, "yuv420p", "f32le");
  assert.equal(sha(exported.video), sha(Buffer.concat(expectedVideo)));
  assert.equal(sha(exported.audio), sha(Buffer.concat(expectedAudio)));
  const probe = JSON.parse(
    (
      await runProcess({
        executable: "ffprobe",
        args: ["-v", "error", "-show_streams", "-of", "json", master],
      })
    ).stdout.toString(),
  ) as { streams: Record<string, unknown>[] };
  const video = probe.streams.find((stream) => stream.codec_type === "video")!;
  const audio = probe.streams.find((stream) => stream.codec_type === "audio")!;
  assert.equal(video.codec_name, "ffv1");
  assert.equal(video.pix_fmt, "yuv420p");
  assert.equal(video.color_space, "bt709");
  assert.equal(audio.codec_name, "pcm_f32le");
  result.losslessMaster = {
    frames: exported.video.length / frameBytes,
    independentFrameEquality: true,
    independentAudioEquality: true,
  };

  step = "smaller-export";
  await page.locator("#export-again").click();
  await expect(page.locator("#export-setup")).toBeVisible();
  await page.locator("#export-profile").selectOption("smaller_mp4");
  await expect(page.locator("#export-profile-note")).toContainText(
    "Compressed",
  );
  const share = join(outputs, "Talk share.mp4");
  await savePath(electron, share);
  await page.locator("#export-start").click();
  await expect(page.locator("#export-done")).toBeVisible({ timeout: 300_000 });
  await expect(page.locator("#export-result")).not.toContainText(
    "verified lossless",
  );
  const shared = await decode(share, "yuv420p", "f32le");
  assert.equal(
    shared.video.length / frameBytes,
    exported.video.length / frameBytes,
  );
  result.smallerMp4 = { frames: shared.video.length / frameBytes };

  step = "cancel";
  await page.locator("#export-again").click();
  await page.locator("#export-profile").selectOption("lossless_master");
  const cancelled = join(outputs, "Cancelled.mkv");
  await savePath(electron, cancelled);
  await page.locator("#export-start").click();
  await page.locator("#export-cancel").click({ timeout: 30_000 });
  await expect(page.locator("#export-error")).toHaveText(
    "Export cancelled. No file was saved.",
    { timeout: 60_000 },
  );
  await expect(page.locator("#export-setup")).toBeVisible();
  assert.deepEqual((await readdir(outputs)).sort(), [
    "Talk master.mkv",
    "Talk share.mp4",
  ]);

  step = "unchanged-source";
  assert.equal(sha(await readFile(sourcePath)), sourceHash);
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

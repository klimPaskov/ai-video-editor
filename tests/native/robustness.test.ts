/**
 * Robustness: a synthetic recording (2 s of tone, 2 s of silence) is exported
 * to a folder that does not exist and to a genuinely full volume, transcribed
 * with no speech in it, and reopened after its managed source file is gone.
 * Each case must end in a plain message and a usable window, never a hang, a
 * crash or an uncaught page error.
 *
 * node tests/native/robustness.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect as baseExpect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { openStep } from "./disclosures.ts";

await assertNativeTestEnvironment();
// The guest shares a busy machine: allow slow starts, saves and navigation.
const expect = baseExpect.configure({ timeout: 30_000 });
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-robust-"));

const sampleRate = 48_000;
const samplesPerFrame = 24_000;
const frames = 8;
const audio = Buffer.alloc(frames * samplesPerFrame * 2);
for (let sample = 0; sample < 2 * sampleRate; sample++)
  audio.writeInt16LE(
    Math.round(12_000 * Math.sin((2 * Math.PI * 440 * sample) / sampleRate)),
    sample * 2,
  );
const width = 96;
const height = 64;
const video = Buffer.alloc(frames * width * height * 4);
for (let frame = 0; frame < frames; frame++)
  for (let pixel = 0; pixel < width * height; pixel++)
    video.set(
      [(180 + frame * 23) % 256, (100 + frame * 17) % 256, 40, 255],
      (frame * width * height + pixel) * 4,
    );
const videoPath = join(evidence, "video.bgra");
const audioPath = join(evidence, "tone.s16le");
const sourcePath = join(evidence, "Tone then silence.mkv");
await writeFile(videoPath, video, { mode: 0o600 });
await writeFile(audioPath, audio, { mode: 0o600 });
await encodeVerifiedMaster(
  {
    videoPath,
    audioPath,
    role: "canonical",
    format: {
      width,
      height,
      frameRate: { numerator: 2, denominator: 1 },
      pixelFormat: "bgra",
      color: {
        range: "pc",
        space: "gbr",
        primaries: "bt709",
        transfer: "bt709",
      },
      audio: { format: "s16le", sampleRate, channelLayout: "mono" },
    },
  },
  sourcePath,
);

const configRoot = join(evidence, "config");
const launch = (extra: string[] = []) =>
  _electron.launch({
    executablePath,
    // Chromium keeps its shared memory in /dev/shm unless told otherwise; the
    // full-disk case fills that volume, so keep Chromium off it.
    args: ["--disable-dev-shm-usage", ...extra],
    env: { ...process.env, XDG_CONFIG_HOME: configRoot },
    chromiumSandbox: true,
    timeout: 30_000,
  });
let electron = await launch();
const problems: string[] = [];
/** Opens the project from Home, or finds the app already showing it. */
const openProject = async (page: Page, id: string) => {
  const row = page.locator(`[data-project-id="${id}"]`);
  await expect
    .poll(
      async () =>
        (await row.isVisible()) || (await page.locator("#frame").isVisible()),
      { timeout: 120_000 },
    )
    .toBe(true);
  if (await row.isVisible()) await row.click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
};
const watch = (page: Page) => {
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
};
/** A message a person can act on: words, not a stack trace or an internal code. */
const plain = (text: string | null) => {
  assert.ok(text && text.trim().length > 8, `a message was shown (${text})`);
  assert.ok(
    !/\sat \S+:\d+|Error:|ENOENT|EACCES|undefined|\[object/u.test(text),
    text,
  );
};
let step = "start";
try {
  await electron.evaluate(
    ({ dialog }, files) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [files.source],
      });
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: files.master,
      });
    },
    {
      source: sourcePath,
      master: join(evidence, "no-such-folder", "master.mkv"),
    },
  );
  let page = await electron.firstWindow();
  watch(page);
  await expect(page.locator("#import")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 120_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;

  step = "export-to-an-unwritable-place";
  await openStep(page, "Export");
  await page.locator("#export-start").click();
  // The folder does not exist (as a full or removed disk would fail): a plain
  // message, the Export button back, no hang.
  await expect
    .poll(
      async () =>
        (await page.locator("#export-error").isVisible()) ||
        (await page.locator("#export-done").isVisible()),
      { timeout: 120_000 },
    )
    .toBe(true);
  assert.equal(await page.locator("#export-done").isVisible(), false);
  plain(await page.locator("#export-error").textContent());
  await expect(page.locator("#export-start")).toBeEnabled();
  await page.screenshot({ path: join(evidence, "export-failed.png") });

  step = "export-to-a-full-disk";
  // A genuinely full disk: /dev/shm is a small memory-backed volume in the
  // guest; fill it to the last byte and export into it.
  const full = "/dev/shm";
  const filler = join(full, `ai-video-editor-full-${process.pid}.fill`);
  const target = join(full, `ai-video-editor-export-${process.pid}.mkv`);
  const handle = await open(filler, "w");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      try {
        await handle.write(chunk);
      } catch {
        break;
      }
    }
    for (let size = 4096; size >= 1; size = Math.floor(size / 2))
      for (;;) {
        try {
          await handle.write(Buffer.alloc(size));
        } catch {
          break;
        }
      }
    const left = await statfs(full);
    assert.ok(left.bavail * left.bsize < 4096, "the volume is full");
    await electron.evaluate(({ dialog }, path) => {
      const counted = globalThis as unknown as { saveCalls: number };
      counted.saveCalls = 0;
      dialog.showSaveDialog = async () => {
        counted.saveCalls += 1;
        return { canceled: false, filePath: path };
      };
    }, target);
    await page.locator("#export-start").click();
    // The earlier failure is still showing, and a full disk can fail faster
    // than the running state can be observed: wait for this export to ask
    // where to save, give it a moment, then wait for how it ends.
    await expect
      .poll(
        () =>
          electron.evaluate(
            () => (globalThis as unknown as { saveCalls: number }).saveCalls,
          ),
        { timeout: 30_000 },
      )
      .toBe(1);
    await page.waitForTimeout(3_000);
    await expect(page.locator("#export-running")).toBeHidden({
      timeout: 120_000,
    });
    await expect(page.locator("#export-error")).toBeVisible();
    assert.equal(await page.locator("#export-done").isVisible(), false);
    plain(await page.locator("#export-error").textContent());
    await expect(page.locator("#export-start")).toBeEnabled();
    await page.screenshot({ path: join(evidence, "export-disk-full.png") });
  } finally {
    await handle.close();
    await rm(filler, { force: true });
    await rm(target, { force: true });
  }

  step = "a-clip-with-no-speech";
  await electron.close();
  // A recording that is only a tone has no speech to find: transcribing says
  // so in plain words and leaves the button usable. (Offline model download is
  // not simulated here: the model library fetches outside Chromium, so a
  // proxy flag cannot cut it; that case is untested.)
  electron = await launch();
  page = await electron.firstWindow();
  watch(page);
  await openProject(page, project.id);
  await openStep(page, "Magic Edit");
  await page.locator("#auto-edit-more > summary").click();
  await page.getByRole("button", { name: "Transcribe locally" }).click();
  // Since e9a4b51 a clip with no speech is a finished transcript with no
  // words, not an error.
  await expect(page.locator("#transcription-status")).toContainText(
    "Transcript complete",
    { timeout: 180_000 },
  );
  await expect(page.locator("#transcription-error")).toBeHidden();
  await page.screenshot({
    path: join(evidence, "transcription-without-speech.png"),
  });

  step = "source-removed-from-disk";
  const sourceFile = await page.evaluate(async (id) => {
    const reply = await window.desktop.listProjects();
    return reply.ok ? (reply.value.find((p) => p.id === id)?.id ?? null) : null;
  }, project.id);
  assert.equal(sourceFile, project.id);
  await electron.close();
  const media = join(configRoot, "ai-video-editor", "media-library", "assets");
  const managed = (await readdir(media)).filter((name) =>
    name.endsWith(".media"),
  );
  assert.ok(managed.length > 0, "the managed source is where expected");
  for (const name of managed) await rm(join(media, name));
  electron = await launch();
  page = await electron.firstWindow();
  watch(page);
  // The project is still listed (or reopens by itself); opening it explains,
  // never hangs or crashes.
  const row = page.locator(`[data-project-id="${project.id}"]`);
  const explained = async () =>
    (await page.locator("#error").isVisible()) ||
    (await page.locator("#preview-message").isVisible());
  await expect
    .poll(async () => (await row.isVisible()) || (await explained()), {
      timeout: 120_000,
    })
    .toBe(true);
  if (!(await explained())) await row.click();
  await expect.poll(explained, { timeout: 60_000 }).toBe(true);
  const shown = (await page.locator("#error").isVisible())
    ? await page.locator("#error").textContent()
    : await page.locator("#preview-message").textContent();
  plain(shown);
  await page.screenshot({ path: join(evidence, "source-missing.png") });
  // Home is still reachable.
  // Home is where a project that cannot open leaves you; if it opened, go there.
  const home = page.getByRole("button", { name: "Home" });
  if (await home.isVisible()) await home.click();
  await expect(page.locator("#import")).toBeVisible();

  assert.deepEqual(problems, [], "no uncaught page errors");
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({ step: "complete" }),
  );
  console.log(JSON.stringify({ evidence, step: "complete" }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, problems }, null, 2),
  );
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}

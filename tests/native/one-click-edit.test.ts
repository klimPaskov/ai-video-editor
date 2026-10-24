/**
 * Packaged native one-click AI edit by a real, signed-in Claude on a short
 * public speech sample: Auto Edit shows one action; "Edit my video" runs the
 * rough cut and then the full edit; the edit lands in the shared draft with
 * Claude's attribution and can be reviewed.
 *
 * node tests/native/one-click-edit.test.ts <packaged-executable>
 *   <claude-bin-dir> <profile-config-root>
 *
 * The profile is a private config root whose Claude Code sign-in the user
 * completed themselves (docs/48); no credential is copied. The sample is the
 * public JFK speech clip (hash pinned) over a generated picture.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { openDisclosures } from "./disclosures.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const [executablePath, claudeBin, profile] = process.argv.slice(2);
assert.ok(
  executablePath && claudeBin && profile,
  "executable, claude bin and profile are required",
);
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-one-click-"));

const sampleRevision = "fbe92bd97d48f3ec17779d8d8f2964e1c6bc7634";
const sampleSha256 =
  "aa81c2552465568567e670f3823117e633900d16bd6202346a72f3c8464c74c8";
const response = await fetch(
  `https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/${sampleRevision}/jfk.wav`,
  { redirect: "follow" },
);
assert.ok(response.ok);
const sample = Buffer.from(await response.arrayBuffer());
assert.equal(createHash("sha256").update(sample).digest("hex"), sampleSha256);
const samplePath = join(evidence, "speech.wav");
await writeFile(samplePath, sample, { mode: 0o600 });
const sourcePath = join(evidence, "Short talk.mkv");
const speech = (
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-i",
      samplePath,
      "-ar",
      "48000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    ],
    maxOutputBytes: 64 * 1024 * 1024,
  })
).stdout;
// Whole 0.5 s frames of a plain picture under the speech.
const samplesPerFrame = 24_000;
const frames = Math.ceil(speech.length / 2 / samplesPerFrame);
const audio = Buffer.concat([
  speech,
  Buffer.alloc(frames * samplesPerFrame * 2 - speech.length),
]);
const width = 640;
const height = 360;
const video = Buffer.alloc(frames * width * height * 4);
for (let pixel = 0; pixel < frames * width * height; pixel++)
  video.set([0x33, 0x24, 0x1d, 255], pixel * 4);
const videoPath = join(evidence, "video.bgra");
const audioPath = join(evidence, "speech.s16le");
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
      audio: { format: "s16le", sampleRate: 48_000, channelLayout: "mono" },
    },
  },
  sourcePath,
);

const started = Date.now();
const elapsed = () => Math.round((Date.now() - started) / 1000);
let step = "launch";
const result: Record<string, unknown> = {
  scope: "one-click-ai-edit",
  assistant: "Claude (signed in, real model)",
};
const configRoot = resolve(profile);
const electron = await _electron.launch({
  executablePath,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: configRoot,
    PATH: `${resolve(claudeBin)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  },
  chromiumSandbox: true,
  timeout: 60_000,
});
try {
  await electron.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, sourcePath);
  const page = await electron.firstWindow();
  await expect
    .poll(
      async () => {
        const reply = await page.evaluate(() => window.desktop.getClaude());
        return reply.ok ? reply.value.status : "error";
      },
      { timeout: 120_000 },
    )
    .toBe("signed_in");
  step = "import";
  const before = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(before.ok);
  const known = new Set(before.value.map((view) => view.id));
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 120_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value.find((view) => !known.has(view.id))!;
  const folder = join(
    configRoot,
    "ai-video-editor",
    "project-store",
    project.id,
  );

  step = "auto-edit-is-minimal";
  await page.getByRole("button", { name: "Auto Edit", exact: true }).click();
  await expect(page.locator("#auto-all-start")).toBeVisible();
  // Only the one action shows; everything else is under More options.
  for (const id of [
    "#magic-start",
    "#audio-card",
    "#captions-card",
    "#sound-card",
  ])
    await expect(page.locator(id)).toBeHidden();
  await page.screenshot({ path: join(evidence, "auto-edit-ready.png") });

  step = "edit-my-video";
  await page.locator("#auto-all-start").click();
  await expect(page.locator("#auto-all-stop")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#auto-all-status")).toContainText("Step 1 of 2");
  let shots = 0;
  let last = "";
  const finished = page.locator("#auto-all-review");
  for (;;) {
    if (await finished.isVisible()) break;
    if (await page.locator("#auto-all-error").isVisible())
      throw new Error(
        (await page.locator("#auto-all-error").textContent()) ?? "failed",
      );
    const text = (await page.locator("#auto-all-status").textContent()) ?? "";
    if (text !== last && shots < 10) {
      last = text;
      await page.screenshot({
        path: join(evidence, `running-${String(++shots).padStart(2, "0")}.png`),
      });
      console.log(JSON.stringify({ seconds: elapsed(), status: text }));
    }
    if (elapsed() > 3 * 3600) throw new Error("The edit ran too long.");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  await expect(page.locator("#auto-all-status")).toContainText("edited");
  await page.screenshot({ path: join(evidence, "auto-edit-done.png") });

  step = "result";
  const thread = await page.evaluate(
    (id) =>
      window.desktop.getClaudeThread({ schema_version: "1.0", project_id: id }),
    project.id,
  );
  assert.ok(thread.ok);
  assert.equal(thread.value.fullEdit?.status, "finished");
  const journal = join(folder, "draft", "journal");
  const records = await Promise.all(
    (await readdir(journal))
      .filter((name) => name.endsWith(".json"))
      .map(
        async (name) =>
          JSON.parse(await readFile(join(journal, name), "utf8")) as {
            origin: string;
            operations: Array<{ operation_type: string }>;
          },
      ),
  );
  const claudeKinds = new Set(
    records
      .filter((record) => record.origin === "claude")
      .flatMap((record) => record.operations.map((o) => o.operation_type)),
  );
  assert.ok(claudeKinds.size > 0, "Claude committed edits");
  result.claudeOperations = [...claudeKinds].sort();
  result.changes = thread.value.fullEdit?.changes ?? 0;

  step = "review";
  await page.locator("#auto-all-review").click();
  await expect(
    page.locator('#stage-buttons [aria-label="Review"]'),
  ).toHaveAttribute("aria-current", "step");
  await openDisclosures(page);
  result.step = "complete";
  result.seconds = elapsed();
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

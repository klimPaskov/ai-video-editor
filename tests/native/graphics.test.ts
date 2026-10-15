/**
 * Packaged native motion graphics: add an animated HTML/CSS graphic, see it
 * in the live preview and on the timeline, export a verified lossless master
 * in which only the frames under the graphic change and the graphic is drawn
 * where it should be, then undo it.
 *
 * node tests/native/graphics.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { rawFrameBytes } from "../../packages/media-engine/src/render.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-graphics-"));
const configRoot = join(evidence, "config");
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

const sourcePath = join(evidence, "Demo.mp4");
await ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x180:rate=30:duration=4",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=330:sample_rate=48000:duration=4",
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
const master = join(evidence, "Demo master.mkv");

let step = "launch";
const result: Record<string, unknown> = { scope: "P12-native-graphics" };
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
  chromiumSandbox: true,
  timeout: 30_000,
});

async function seekTo(page: Page, us: number): Promise<void> {
  await page.evaluate((value) => {
    const seek = document.querySelector<HTMLInputElement>("#seek")!;
    seek.value = String(value);
    seek.dispatchEvent(new Event("input"));
  }, us);
  await expect(page.locator(".preview")).not.toHaveClass(/loading/u);
  await page.waitForTimeout(300);
}

// An opaque box that slides in over 400 ms, then holds, plus a title.
const graphic = {
  name: "Title card",
  html: '<div class="box"></div><h1 class="title">Weekly review</h1>',
  css: [
    ".box { position: absolute; left: 20px; top: 20px; width: 100px; height: 40px; background: rgb(240, 40, 40); animation: slide 400ms ease-out both }",
    ".title { position: absolute; left: 20px; top: 70px; margin: 0; font-size: 24px; color: white }",
    "@keyframes slide { from { transform: translateX(-140px) } to { transform: none } }",
  ].join(" "),
};

try {
  await electron.evaluate(
    ({ dialog }, value) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [value.source],
      });
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: value.master,
      });
    },
    { source: sourcePath, master },
  );
  const page = await electron.firstWindow();
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible();

  step = "add";
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;
  const unsafe = await page.evaluate(
    async (value) => {
      try {
        await window.desktop.applyManualGraphic(value);
        return "accepted";
      } catch {
        return "refused";
      }
    },
    {
      schema_version: "1.0" as const,
      projectId: project.id,
      draftId: project.draft.id,
      baseRevisionId: project.draft.baseRevisionId,
      expectedSequence: project.draft.sequence,
      expectedTimelineSha256: project.draft.timelineSha256,
      graphicId: null,
      startUs: 1_000_000,
      durationUs: 1_500_000,
      layer: 0,
      name: "Bad",
      html: "<script>1</script>",
      css: "",
    },
  );
  assert.equal(unsafe, "refused", "unsafe content never reaches main");
  const added = await page.evaluate(
    (value) => window.desktop.applyManualGraphic(value),
    {
      schema_version: "1.0" as const,
      projectId: project.id,
      draftId: project.draft.id,
      baseRevisionId: project.draft.baseRevisionId,
      expectedSequence: project.draft.sequence,
      expectedTimelineSha256: project.draft.timelineSha256,
      graphicId: null,
      startUs: 1_000_000,
      durationUs: 1_500_000,
      layer: 0,
      ...graphic,
    },
  );
  assert.ok(added.ok, "the graphic is saved");
  await expect(page.locator(".timeline-graphic")).toHaveText("Title card");

  step = "preview";
  await seekTo(page, 2_000_000);
  const stage = page.locator("iframe.graphics-stage");
  await expect(stage).toBeVisible();
  const inside = await stage.evaluate((frame: HTMLIFrameElement) => {
    const section = frame.contentDocument?.querySelector("section");
    const box = section?.shadowRoot?.querySelector(".box");
    const style = box ? getComputedStyle(box) : null;
    return {
      background: style?.backgroundColor,
      transform: style?.transform,
      title: section?.shadowRoot?.querySelector(".title")?.textContent,
    };
  });
  assert.deepEqual(inside, {
    background: "rgb(240, 40, 40)",
    // The slide has finished: the identity transform.
    transform: "matrix(1, 0, 0, 1, 0, 0)",
    title: "Weekly review",
  });
  await page.screenshot({ path: join(evidence, "graphics-preview.png") });
  await seekTo(page, 500_000);
  await expect(stage).toBeHidden();

  step = "export";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator("#export-actions")).toBeVisible();
  await page.locator("#export-start").click();
  await expect(page.locator("#export-done")).toBeVisible({ timeout: 300_000 });
  await expect(page.locator("#export-result")).toContainText(
    "verified lossless",
  );
  const decode = (file: string, format: string) =>
    ffmpeg([
      "-i",
      file,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "rawvideo",
      "-pix_fmt",
      format,
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
  const original = await decode(sourcePath, "yuv420p");
  const exported = await decode(master, "yuv420p");
  assert.equal(exported.length, original.length);
  const frameBytes = rawFrameBytes("yuv420p", 320, 180);
  const differing: number[] = [];
  for (let frame = 0; frame < original.length / frameBytes; frame++) {
    const range = [frame * frameBytes, (frame + 1) * frameBytes] as const;
    if (!exported.subarray(...range).equals(original.subarray(...range)))
      differing.push(frame);
  }
  // On screen from 1.0 s for 1.5 s: output frames 30–74 at 30 fps.
  assert.deepEqual(
    differing,
    Array.from({ length: 45 }, (_, index) => index + 30),
  );
  // After the slide, the box is drawn at its place in its colour.
  const rgb = await decode(master, "rgb24");
  const at = (frame: number, x: number, y: number) => {
    const offset = (frame * 320 * 180 + y * 320 + x) * 3;
    return [...rgb.subarray(offset, offset + 3)];
  };
  const [r, g, b] = at(60, 70, 40);
  assert.ok(r! > 220 && g! < 70 && b! < 70, `box colour ${[r, g, b]}`);
  result.export = { graphicFrames: differing.length, othersBitIdentical: true };

  step = "undo";
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.locator("#undo-edit").click();
  await expect(page.locator(".timeline-graphic")).toHaveCount(0, {
    timeout: 30_000,
  });

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

/**
 * Packaged native camera layouts: a screen recording gets a camera video
 * (chosen in the Camera dialog), then three layout changes (a corner camera,
 * the camera filling the picture, the screen alone again) are made through
 * the manual layout requests, exported in a verified lossless master and
 * decoded. Before the first change and after the last, frames are
 * bit-identical to the recording; in the corner the camera's colour fills the
 * circle and the rest of the picture is the recording's; when the camera
 * fills the picture it is the camera's colour. Undo removes a change, and the
 * recordings stay unchanged.
 *
 * node tests/native/camera-layout.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect as baseExpect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { openDisclosures } from "./disclosures.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const expect = baseExpect.configure({ timeout: 30_000 });
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-camera-"));
const configRoot = join(evidence, "config");
const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const width = 640;
const height = 360;

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

const screenPath = join(evidence, "Screen.mp4");
await ffmpeg([
  "-f",
  "lavfi",
  "-i",
  `color=c=0x305070:s=${width}x${height}:r=30:d=8`,
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=330:sample_rate=48000:duration=8",
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
  screenPath,
]);
// The camera: a solid warm colour, at another size and rate than the screen.
const cameraPath = join(evidence, "Camera.mp4");
await ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "color=c=0xe0502a:s=1280x720:r=25:d=9",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  cameraPath,
]);
const screenHash = sha(await readFile(screenPath));
const cameraHash = sha(await readFile(cameraPath));
const master = join(evidence, "Camera master.mkv");

let step = "launch";
const result: Record<string, unknown> = { scope: "camera-layout" };
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
  chromiumSandbox: true,
  timeout: 30_000,
});

async function head(page: Page) {
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  return listed.value[0]!;
}

try {
  let chosen = screenPath;
  await electron.evaluate(
    ({ dialog }, value) => {
      const state = globalThis as unknown as { __next?: string };
      state.__next = value.screen;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [state.__next!],
      });
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: value.master,
      });
    },
    { screen: screenPath, master },
  );
  const page = await electron.firstWindow();
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible();
  const project = await head(page);

  step = "no-camera-yet";
  const layoutRequest = async (
    fields: Partial<{
      layoutId: string | null;
      atUs: number;
      kind: "screen" | "camera" | "pip";
      corner: "top_left" | "top_right" | "bottom_left" | "bottom_right";
      size: number;
      shape: "circle" | "rounded" | "rect";
      moveUs: number;
    }>,
  ) => {
    const current = await head(page);
    return page.evaluate((value) => window.desktop.applyManualLayout(value), {
      schema_version: "1.0" as const,
      projectId: current.id,
      draftId: current.draft.id,
      baseRevisionId: current.draft.baseRevisionId,
      expectedSequence: current.draft.sequence,
      expectedTimelineSha256: current.draft.timelineSha256,
      layoutId: null,
      atUs: 0,
      kind: "pip" as const,
      corner: "bottom_right" as const,
      size: 0.3,
      shape: "circle" as const,
      faceZoom: 1,
      focusX: 0.5,
      focusY: 0.5,
      moveUs: 0,
      ...fields,
    });
  };
  const refused = await page.evaluate(
    async (value) => {
      try {
        const reply = await window.desktop.applyManualLayout(value);
        return reply.ok ? "accepted" : "refused";
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
      layoutId: null,
      atUs: 1_000_000,
      kind: "pip" as const,
      corner: "bottom_right" as const,
      size: 0.3,
      shape: "circle" as const,
      faceZoom: 1,
      focusX: 0.5,
      focusY: 0.5,
      moveUs: 0,
    },
  );
  assert.equal(refused, "refused", "a camera layout needs a camera video");

  step = "add-camera";
  await electron.evaluate(({ dialog }, file) => {
    const state = globalThis as unknown as { __next?: string };
    state.__next = file;
    void dialog;
  }, cameraPath);
  await openDisclosures(page);
  await expect(page.locator("#camera-add")).toBeVisible();
  await page.locator("#camera-add").click();
  await expect(page.locator("#camera-status")).toHaveText("Camera in sync");
  await expect(page.locator("#camera-add")).toBeHidden();
  const linked = await page.evaluate(
    (id) => window.desktop.getCamera({ schema_version: "1.0", project_id: id }),
    project.id,
  );
  assert.ok(linked.ok);
  assert.equal(linked.value.linked, true);
  assert.equal(linked.value.width, 1280);
  assert.equal(linked.value.offset_us, 0);
  chosen = cameraPath;
  // The offset buttons move the camera by a tenth of a second.
  await page.locator("#camera-later").click();
  await expect(page.locator("#camera-status")).toHaveText("Camera +0.1 s");
  await page.locator("#camera-earlier").click();
  await expect(page.locator("#camera-status")).toHaveText("Camera in sync");

  step = "layouts";
  // Corner camera from 2 s (through the tools), full camera from 4 s, the
  // screen from 6 s.
  await page.evaluate(() => {
    const seek = document.querySelector<HTMLInputElement>("#seek")!;
    seek.value = "2000000";
    seek.dispatchEvent(new Event("input"));
  });
  await page.locator("#camera-layout").selectOption("pip");
  await page.locator("#camera-shape").selectOption("circle");
  await page.locator("#camera-size").selectOption("large");
  await page.locator("#camera-apply").click();
  await expect(page.locator(".timeline-layout")).toHaveCount(1);
  for (const fields of [
    { atUs: 4_000_000, kind: "camera" as const },
    { atUs: 6_000_000, kind: "screen" as const },
  ]) {
    const reply = await layoutRequest(fields);
    assert.ok(reply.ok, `${fields.kind} change is saved`);
  }
  await expect(page.locator(".timeline-layout")).toHaveCount(2);
  // The preview shows the camera where the layouts put it.
  const seekTo = async (us: number) => {
    await page.evaluate((value) => {
      const seek = document.querySelector<HTMLInputElement>("#seek")!;
      seek.value = String(value);
      seek.dispatchEvent(new Event("input"));
    }, us);
    await page.waitForTimeout(500);
  };
  await seekTo(3_000_000);
  await expect(page.locator(".camera-pip")).toBeVisible();
  await expect(page.locator(".camera-full")).toBeHidden();
  await page.screenshot({ path: join(evidence, "preview-corner.png") });
  await seekTo(5_000_000);
  await expect(page.locator(".camera-full")).toBeVisible();
  await page.screenshot({ path: join(evidence, "preview-full.png") });
  await seekTo(7_000_000);
  await expect(page.locator(".camera-pip")).toBeHidden();
  await expect(page.locator(".camera-full")).toBeHidden();
  await seekTo(0);
  const layouts = (await head(page)).layouts ?? [];
  assert.equal(layouts.length, 3);
  assert.deepEqual(
    layouts.map((item) => item.kind),
    ["pip", "camera", "screen"],
  );

  step = "export";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator("#export-actions")).toBeVisible();
  await page.locator("#export-start").click();
  await expect(page.locator("#export-done")).toBeVisible({ timeout: 600_000 });
  await expect(page.locator("#export-result")).toContainText(
    "verified lossless",
  );

  step = "frames";
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
  const rgbSource = await decode(screenPath, "rgb24");
  const rgb = await decode(master, "rgb24");
  assert.equal(rgb.length, rgbSource.length);
  const frameBytes = width * height * 3;
  const at = (buffer: Buffer, frame: number, x: number, y: number) => {
    const offset = frame * frameBytes + (y * width + x) * 3;
    return [...buffer.subarray(offset, offset + 3)] as [number, number, number];
  };
  const frameOf = (seconds: number) => Math.round(seconds * 30);
  const same = (frame: number) =>
    rgb
      .subarray(frame * frameBytes, (frame + 1) * frameBytes)
      .equals(rgbSource.subarray(frame * frameBytes, (frame + 1) * frameBytes));
  // Before and after the camera is shown, frames are the recording's own
  // (to the precision of the colour conversion used for this comparison).
  for (const seconds of [0.5, 1.5, 7, 7.9]) {
    assert.ok(same(frameOf(seconds)), `${seconds}s equals the recording`);
  }
  // A corner camera: its circle (the large size, 0.34 of the width, bottom right) is the
  // camera's colour; the rest of the picture is still the recording.
  const circleCentre = [
    Math.round(width * (1 - 0.03 - 0.17)),
    Math.round(height - 0.03 * width - (0.34 * width) / 2),
  ] as const;
  const inCircle = at(rgb, frameOf(3), circleCentre[0], circleCentre[1]);
  assert.ok(
    inCircle[0] > 190 && inCircle[1] < 130 && inCircle[2] < 90,
    `camera colour in the corner: ${inCircle}`,
  );
  assert.deepEqual(
    at(rgb, frameOf(3), 40, 40),
    at(rgbSource, frameOf(3), 40, 40),
  );
  // The camera fills the picture.
  const full = at(rgb, frameOf(5), 100, 100);
  assert.ok(full[0] > 190 && full[2] < 90, `full camera colour: ${full}`);
  const fullFar = at(rgb, frameOf(5), width - 10, height - 10);
  assert.ok(fullFar[0] > 190 && fullFar[2] < 90);
  result.frames = { corner: inCircle, full };

  step = "undo";
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.locator("#undo-edit").click();
  await expect
    .poll(async () => ((await head(page)).layouts ?? []).length, {
      timeout: 30_000,
    })
    .toBe(2);

  step = "recordings-unchanged";
  assert.equal(sha(await readFile(screenPath)), screenHash);
  assert.equal(sha(await readFile(cameraPath)), cameraHash);
  assert.ok(chosen);
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

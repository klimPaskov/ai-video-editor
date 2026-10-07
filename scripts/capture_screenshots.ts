/**
 * Captures the documentation screenshots in docs/images from the packaged
 * app, using a synthetic demo clip and the labelled synthetic recording
 * devices. Runs only in the isolated native test environment.
 *
 * node scripts/capture_screenshots.ts <packaged-executable> [output-dir]
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertNativeTestEnvironment } from "./native-test-environment.ts";
import { runProcess } from "../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const output = resolve(process.argv[3] ?? "docs/images");
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(resolve("test-results"), "screenshots-"));

// A tidy stand-in for a screen recording: a window with a sidebar, a
// chart-like panel and a title over a soft gradient.
const clip = join(work, "Product walkthrough.mp4");
const font = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf";
const text = (
  value: string,
  x: string,
  y: string,
  size: number,
  color: string,
) =>
  `drawtext=fontfile=${font}:text='${value}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}`;
await runProcess({
  executable: "ffmpeg",
  args: [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "gradients=s=1920x1080:c0=0x241a5c:c1=0x0d4a63:x0=0:y0=0:x1=1920:y1=1080:speed=0.004:rate=30:duration=16",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=48000:duration=16,volume=0.05",
    "-vf",
    [
      "drawbox=x=160:y=120:w=1600:h=840:color=0xf6f7fb:t=fill",
      "drawbox=x=160:y=120:w=1600:h=64:color=0xe6e8f0:t=fill",
      "drawbox=x=160:y=184:w=280:h=776:color=0xeceef5:t=fill",
      "drawbox=x=196:y=230:w=200:h=28:color=0x6d4aff@0.85:t=fill",
      "drawbox=x=196:y=290:w=170:h=22:color=0xc9cbd8:t=fill",
      "drawbox=x=196:y=340:w=190:h=22:color=0xc9cbd8:t=fill",
      "drawbox=x=196:y=390:w=150:h=22:color=0xc9cbd8:t=fill",
      "drawbox=x=500:y=330:w=1200:h=420:color=0xffffff:t=fill",
      "drawbox=x=560:y='690-2*t*10':w=90:h='60+t*10':color=0x6d4aff:t=fill",
      "drawbox=x=700:y='640-t*12':w=90:h='110+t*12':color=0x8b6cff:t=fill",
      "drawbox=x=840:y='600-t*8':w=90:h='150+t*8':color=0x6d4aff:t=fill",
      "drawbox=x=980:y='560-t*6':w=90:h='190+t*6':color=0x8b6cff:t=fill",
      "drawbox=x=1120:y='520-t*9':w=90:h='230+t*9':color=0x6d4aff:t=fill",
      "drawbox=x=1260:y=470:w=380:h=200:color=0xf1eeff:t=fill",
      text("Weekly product review", "500", "240", 54, "0x1d2033"),
      text("Active projects", "1290", "500", 28, "0x5a5f78"),
      text("128", "1290", "560", 72, "0x6d4aff"),
      text("Overview", "236", "232", 22, "white"),
    ].join(","),
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
    "-c:a",
    "aac",
    "-shortest",
    clip,
  ],
  timeoutMs: 300_000,
});

const electron = await _electron.launch({
  executablePath,
  env: {
    ...process.env,
    XDG_CONFIG_HOME: join(work, "config"),
    AI_VIDEO_EDITOR_TEST_CAPTURE: "1",
  },
  chromiumSandbox: true,
  timeout: 30_000,
});
async function shot(page: Page, name: string): Promise<void> {
  // No hover highlight in the pictures.
  await page.mouse.move(2, 895);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(output, `${name}.png`) });
}
async function seekTo(page: Page, us: number): Promise<void> {
  await page.evaluate((value) => {
    const seek = document.querySelector<HTMLInputElement>("#seek")!;
    seek.value = String(value);
    seek.dispatchEvent(new Event("input"));
  }, us);
  await expect(page.locator(".preview")).not.toHaveClass(/loading/u);
}
try {
  await electron.evaluate(({ BrowserWindow, dialog }, file) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, clip);
  const page = await electron.firstWindow();

  await page
    .getByRole("button", { name: "New recording", exact: true })
    .click();
  await expect(page.locator("#record-start")).toBeEnabled();
  await shot(page, "record");
  await page.locator("#record-cancel").click();

  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible();
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  let project = listed.value[0]!;
  const head = () => ({
    schema_version: "1.0" as const,
    projectId: project.id,
    draftId: project.draft.id,
    baseRevisionId: project.draft.baseRevisionId,
    expectedSequence: project.draft.sequence,
    expectedTimelineSha256: project.draft.timelineSha256,
  });
  const zoom = await page.evaluate(
    (request) => window.desktop.applyManualZoom(request),
    {
      ...head(),
      zoomId: null,
      startUs: 3_000_000,
      endUs: 7_000_000,
      centerX: 0.68,
      centerY: 0.52,
      scale: 1.5,
    },
  );
  assert.ok(zoom.ok);
  const refreshed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(refreshed.ok);
  project = refreshed.value[0]!;
  const speed = await page.evaluate(
    (request) => window.desktop.applyManualSpeed(request),
    { ...head(), startUs: 10_000_000, endUs: 14_000_000, speed: 4 },
  );
  assert.ok(speed.ok);
  // Before the zoom, so the whole frame shows; the zoom and the sped-up
  // part are visible on the timeline strip.
  await seekTo(page, 1_500_000);
  await page.waitForTimeout(800);
  await shot(page, "edit");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator("#export-actions")).toBeVisible();
  await shot(page, "export");

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.locator("#projects")).toBeVisible();
  await shot(page, "home");
  console.log(JSON.stringify({ output }));
} finally {
  await electron.close().catch(() => undefined);
}

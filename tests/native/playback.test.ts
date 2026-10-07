/**
 * Packaged native draft playback: a source with one solid colour per second
 * has its green second cut out. Playing the draft must cross the cut without
 * showing green, decode audio, stop at the end and pause on request.
 *
 * node tests/native/playback.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-playback-"));
const sourcePath = join(evidence, "Colours.mp4");
const colours = ["red", "green", "blue", "yellow"];
await runProcess({
  executable: "ffmpeg",
  args: [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...colours.flatMap((colour) => [
      "-f",
      "lavfi",
      "-i",
      `color=c=${colour}:size=320x180:rate=30:duration=1`,
    ]),
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=4",
    "-filter_complex",
    "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]",
    "-map",
    "[v]",
    "-map",
    "4:a",
    "-c:v",
    "libx264",
    "-g",
    "30",
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
    sourcePath,
  ],
  timeoutMs: 120_000,
});

type Sample = {
  t: number;
  colour: string;
  playing: boolean;
  audioBytes: number;
  label: string | null;
};

/** Reads the visible preview video's centre pixel as a colour name. */
async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const video = [
      ...document.querySelectorAll<HTMLVideoElement>(".preview-video"),
    ].find((item) => !item.hidden);
    const play = document.getElementById("play")!;
    const seek = document.getElementById("seek") as HTMLInputElement;
    let colour = "none";
    let audioBytes = 0;
    if (video && video.readyState >= 2) {
      const canvas = new OffscreenCanvas(32, 18);
      const context = canvas.getContext("2d")!;
      context.drawImage(video, 0, 0, 32, 18);
      const [r, g, b] = context.getImageData(16, 9, 1, 1).data;
      colour =
        r! > 180 && g! > 180 && b! < 90
          ? "yellow"
          : r! > 180 && g! < 90 && b! < 90
            ? "red"
            : r! < 90 && g! > 90 && b! < 90
              ? "green"
              : r! < 90 && g! < 90 && b! > 180
                ? "blue"
                : `rgb(${r},${g},${b})`;
      audioBytes = (
        video as HTMLVideoElement & { webkitAudioDecodedByteCount: number }
      ).webkitAudioDecodedByteCount;
    }
    return {
      t: Number(seek.value),
      colour,
      playing: Boolean(video && !video.paused),
      audioBytes,
      label: play.getAttribute("aria-label"),
    };
  });
}

async function seekTo(page: Page, timeUs: number): Promise<void> {
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

let step = "launch";
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: join(evidence, "config") },
  chromiumSandbox: true,
  timeout: 30_000,
});
try {
  await electron.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, sourcePath);
  const page = await electron.firstWindow();
  step = "import";
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#play")).toBeVisible();
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;
  assert.ok(project);

  step = "cut-green";
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#edit-actions")).toBeVisible();
  await seekTo(page, 1_000_000);
  await page.locator("#mark-in").click();
  await seekTo(page, 2_000_000);
  await page.locator("#mark-out").click();
  await expect(page.locator("#cut-range")).toBeEnabled();
  await page.locator("#cut-range").click();
  await expect(page.locator("#duration")).toHaveText(" / 0:03.000");

  step = "play-across-cut";
  await seekTo(page, 0);
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Pause");
  const samples: Sample[] = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await sample(page);
    samples.push(value);
    if (value.label === "Play" && samples.length > 3) break;
    await page.waitForTimeout(40);
  }
  await writeFile(
    join(evidence, "samples.json"),
    JSON.stringify(samples, null, 1),
  );
  const seen = samples
    .filter((value) => value.colour !== "none")
    .map((value) => value.colour);
  const order = seen.filter((colour, index) => colour !== seen[index - 1]);
  assert.deepEqual(
    order,
    ["red", "blue", "yellow"],
    `colour order ${order.join(",")}`,
  );
  assert.ok(!seen.includes("green"), "The cut-out second must never be shown");
  assert.ok(
    samples.some((value) => value.audioBytes > 0),
    "Audio must be decoded during playback",
  );
  // Stopped at the end on the exact still frame.
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play", {
    timeout: 10_000,
  });
  await expect(page.locator("#frame")).toBeVisible();
  const end = Number(await page.locator("#seek").inputValue());
  assert.ok(end >= 2_900_000, `ended at ${end}`);
  await page.screenshot({ path: join(evidence, "playback-ended.png") });

  step = "pause";
  await seekTo(page, 0);
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Pause");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(evidence, "playback-running.png") });
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play");
  const paused = Number(await page.locator("#seek").inputValue());
  assert.ok(paused > 1_000_000 && paused < 2_900_000, `paused at ${paused}`);
  await expect(page.locator("#frame")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  assert.equal(Number(await page.locator("#seek").inputValue()), paused);

  step = "keyboard";
  await page.locator("#seek").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Pause");
  await page.keyboard.press("Space");
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "Play");

  step = "media-route-confined";
  // The renderer's CSP has no connect-src, so script cannot read media bytes.
  const rendererFetch = await page.evaluate(async (id) => {
    try {
      await fetch(new URL(`media/${id}/x`, location.href));
      return "allowed";
    } catch {
      return "blocked";
    }
  }, project.id);
  assert.equal(rendererFetch, "blocked");
  const sourceId = project.source.id;
  const statuses = await electron.evaluate(
    async ({ net }, value) => {
      const codes: number[] = [];
      for (const path of [
        `media/${value.project}/${value.source}`,
        `media/${value.project}/not-a-source`,
        `media/other-project/${value.source}`,
      ])
        codes.push(
          (
            await net.fetch(`ai-video-editor://app/${path}`, {
              headers: { Range: "bytes=0-99" },
            })
          ).status,
        );
      return codes;
    },
    { project: project.id, source: sourceId },
  );
  assert.deepEqual(statuses, [206, 404, 404]);

  const result = {
    scope: "P3-05-native-playback",
    colourOrder: order,
    samples: samples.length,
    audioDecoded: true,
    endedAtUs: end,
    pausedAtUs: paused,
  };
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ evidence, result }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step }, null, 2),
  );
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}

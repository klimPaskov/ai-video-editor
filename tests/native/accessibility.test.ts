/** Guest-only keyboard and media-preference checks; not screen-reader evidence. */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { Locator, Page } from "playwright/test";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";
import {
  encodeVerifiedMaster,
  sha256,
} from "../../packages/media-engine/src/lossless.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";

assert.equal(process.platform, "linux", "Run only in isolated guest");
assert.ok(process.getuid);
assert.equal(process.getuid(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath && isAbsolute(executablePath));
await access(executablePath);
await mkdir(resolve("test-results"), { recursive: true });
const evidence = await mkdtemp(resolve("test-results/native-accessibility-"));
const config = join(evidence, "config");
const env = { ...process.env, XDG_CONFIG_HOME: config };
let app = await _electron.launch({
  executablePath,
  chromiumSandbox: true,
  env,
  timeout: 30000,
});
try {
  const userData = await app.evaluate(({ app }) => app.getPath("userData"));
  const within = relative(config, userData);
  assert.ok(within && !within.startsWith("..") && !isAbsolute(within));
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
  await app.close();
  // Production services create actual records from a verified synthetic FFV1/PCM source.
  const raw = Buffer.alloc(32 * 24 * 4 * 3);
  for (let frame = 0; frame < 3; frame++)
    for (let pixel = 0; pixel < 32 * 24; pixel++) {
      const i = (frame * 32 * 24 + pixel) * 4;
      raw[i] = (pixel * 13 + frame * 80) % 256;
      raw[i + 1] = (pixel * 7 + frame * 30) % 256;
      raw[i + 2] = (pixel * 3 + frame * 90) % 256;
      raw[i + 3] = 255;
    }
  const videoPath = join(evidence, "canonical.raw"),
    audioPath = join(evidence, "canonical.pcm"),
    source = join(evidence, "Keyboard fixture.mkv");
  await writeFile(videoPath, raw);
  await writeFile(audioPath, Buffer.alloc(72000 * 2));
  await encodeVerifiedMaster(
    {
      videoPath,
      audioPath,
      role: "canonical",
      format: {
        width: 32,
        height: 24,
        frameRate: { numerator: 2, denominator: 1 },
        pixelFormat: "bgra",
        color: {
          range: "pc",
          space: "gbr",
          primaries: "bt709",
          transfer: "bt709",
        },
        audio: { format: "s16le", sampleRate: 48000, channelLayout: "mono" },
      },
    },
    source,
  );
  const sourceHash = sha256(await readFile(source));
  const library = new MediaLibrary(join(userData, "media-library"));
  const media = await library.importFile(source);
  const store = new ProjectStore(join(userData, "project-store"), library);
  const project = await store.createFromMedia(media.id);
  const baselinePath = join(
    userData,
    "project-store",
    project.project.project_id,
    "baseline.json",
  );
  const baseline = await readFile(baselinePath);
  app = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    window.setSize(1366, 768);
    window.focus();
  });
  async function tabTo(target: Locator): Promise<void> {
    await expect(target).toBeVisible();
    for (let count = 0; count < 60; count++) {
      if (await target.evaluate((node) => document.activeElement === node))
        return;
      await page.keyboard.press("Tab");
    }
    throw new Error("Control was not reachable with Tab");
  }
  async function activate(target: Locator): Promise<void> {
    await tabTo(target);
    await page.keyboard.press("Enter");
  }
  async function assertPixels(page: Page, frame: number): Promise<void> {
    await expect(page.locator("#frame")).toBeVisible();
    const actual = await page
      .locator("#frame")
      .evaluate((node) =>
        Array.from(
          (node as HTMLCanvasElement)
            .getContext("2d")!
            .getImageData(0, 0, 32, 24).data,
        ),
      );
    const expected = Buffer.from(
      raw.subarray(frame * 32 * 24 * 4, (frame + 1) * 32 * 24 * 4),
    );
    for (let i = 0; i < expected.length; i += 4) {
      const b = expected[i]!;
      expected[i] = expected[i + 2]!;
      expected[i + 2] = b;
    }
    assert.deepEqual(Buffer.from(actual), expected);
  }
  const primary = page.getByRole("button", {
    name: "Import video",
    exact: true,
  });
  function luminance(rgb: string): number {
    const parts = rgb
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number)
      .map((n) => n / 255)
      .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
    return parts[0]! * 0.2126 + parts[1]! * 0.7152 + parts[2]! * 0.0722;
  }
  async function contrast(): Promise<number> {
    const colors = await primary.evaluate((node) => ({
      foreground: getComputedStyle(node).color,
      background: getComputedStyle(node).backgroundColor,
    }));
    const a = luminance(colors.foreground),
      b = luminance(colors.background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }
  // Hover is measured separately; the subsequent application workflow uses keyboard input only.
  const normalContrast = await contrast();
  await primary.hover();
  const hoverContrast = await contrast();
  assert.ok(normalContrast >= 4.5 && hoverContrast >= 4.5);
  await page.mouse.move(0, 0);
  await activate(
    page.locator(`[data-project-id="${project.project.project_id}"]`),
  );
  await expect(
    page.getByRole("button", { name: "Home", exact: true }),
  ).toBeFocused();
  await assertPixels(page, 0);
  await activate(page.getByRole("button", { name: "Next frame", exact: true }));
  await expect(page.locator("#time")).toHaveText("0:00.500");
  await assertPixels(page, 1);
  for (const name of [
    "Auto Edit",
    "Edit",
    "Review",
    "Export",
    "Record or Import",
  ]) {
    const stage = page
      .locator("#stage-buttons")
      .getByRole("button", { name, exact: true });
    await activate(stage);
    await expect(stage).toHaveAttribute("aria-current", "step");
    await assertPixels(page, 1);
  }
  await page.emulateMedia({
    forcedColors: "active",
    contrast: "more",
    reducedMotion: "reduce",
  });
  assert.equal(
    await page.evaluate(
      () =>
        matchMedia("(forced-colors: active)").matches &&
        matchMedia("(prefers-contrast: more)").matches &&
        matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    true,
  );
  const current = page.locator('#stage-buttons [aria-current="step"]');
  assert.equal(
    await current.evaluate((node) =>
      getComputedStyle(node).textDecorationLine.includes("underline"),
    ),
    true,
  );
  await tabTo(current);
  assert.equal(
    await current.evaluate(
      (node) =>
        getComputedStyle(node).outlineStyle !== "none" &&
        parseFloat(getComputedStyle(node).outlineWidth) >= 2,
    ),
    true,
  );
  const animated = await page.evaluate(() =>
    Array.from(document.querySelectorAll("body *:not(canvas)")).some((node) => {
      const style = getComputedStyle(node);
      return (
        style.animationName !== "none" ||
        style.transitionDuration
          .split(",")
          .some((value) => parseFloat(value) !== 0)
      );
    }),
  );
  assert.equal(animated, false);
  await assertPixels(page, 1);
  await activate(
    page.getByRole("button", { name: "Previous frame", exact: true }),
  );
  await expect(page.locator("#time")).toHaveText("0:00.000");
  await assertPixels(page, 0);
  await activate(page.getByRole("button", { name: "Next frame", exact: true }));
  await expect(page.locator("#time")).toHaveText("0:00.500");
  await assertPixels(page, 1);
  await activate(
    page.getByRole("button", { name: "Source details", exact: true }),
  );
  await expect(
    page.getByRole("button", { name: "Close source details" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Source details", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Control+,");
  await expect(
    page.getByLabel("Interface size", { exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Source details", exact: true }),
  ).toBeFocused();
  await page.screenshot({
    path: join(evidence, "forced-colors-reduced-motion.png"),
  });
  const projectCard = page.locator(
    `[data-project-id="${project.project.project_id}"]`,
  );
  const oldProjectCard = await projectCard.elementHandle();
  assert.ok(oldProjectCard);
  await activate(page.getByRole("button", { name: "Home", exact: true }));
  await expect
    .poll(() => oldProjectCard.evaluate((node) => node.isConnected))
    .toBe(false);
  await expect(projectCard).toBeFocused();
  await activate(projectCard);
  await assertPixels(page, 0);
  assert.deepEqual(await readFile(baselinePath), baseline);
  assert.equal(sha256(await readFile(source)), sourceHash);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        scope: "P1 keyboard and emulated media preferences",
        normalContrast,
        hoverContrast,
        keyboardWorkflow: true,
        forcedColors: true,
        reducedMotion: true,
        exactOpaqueCanvasSamples: true,
        screenReader: "not tested by this suite",
        computerUse: false,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ evidence, executablePath }));
} finally {
  await app.close();
}

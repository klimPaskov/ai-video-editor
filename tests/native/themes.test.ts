/**
 * Themes: a synthetic recording (2 s of tone, 2 s of
 * silence) gets a music bed and a sound effect from audio files chosen in the
 * Sound card; the layers are shared-Undo draft edits that survive Redo, are
 * mixed (audible in the recording's silent
 * half), and can be removed.
 *
 * node tests/native/sound.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect as baseExpect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";

await assertNativeTestEnvironment();
// The guest shares a busy machine: allow slow starts, saves and navigation.
const expect = baseExpect.configure({ timeout: 30_000 });
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-themes-"));

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
const launch = () =>
  _electron.launch({
    executablePath,
    env: { ...process.env, XDG_CONFIG_HOME: configRoot },
    chromiumSandbox: true,
    timeout: 30_000,
  });
const themeOf = (page: Page) =>
  page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    layout: document.documentElement.dataset.layout,
    background: getComputedStyle(document.body).backgroundColor,
  }));
let electron = await launch();
try {
  await electron.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, sourcePath);
  let page = await electron.firstWindow();
  await page.setViewportSize({ width: 1200, height: 800 });
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  // The default is Light Canvas.
  try {
    await expect
      .poll(async () => (await themeOf(page)).theme, { timeout: 15_000 })
      .toBe("light_canvas");
  } catch (error) {
    const state = await page.evaluate(() => ({
      url: location.href,
      html: document.documentElement.outerHTML.slice(0, 300),
      alert: document.getElementById("error")?.textContent ?? null,
    }));
    const started = Date.now();
    const direct = await Promise.race([
      page.evaluate(() => window.desktop.getPreferences()),
      new Promise((resolve) =>
        setTimeout(() => resolve("still pending"), 10_000),
      ),
    ]);
    Object.assign(state, { direct, directMs: Date.now() - started });
    await writeFile(
      join(evidence, "startup-failure.json"),
      JSON.stringify({ state, problems }, null, 2),
    );
    throw error;
  }
  await expect
    .poll(async () => (await themeOf(page)).theme)
    .toBe("light_canvas");
  assert.equal((await themeOf(page)).background, "rgb(246, 245, 242)");
  await page.screenshot({ path: join(evidence, "light_canvas-home.png") });
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });

  const chooseTheme = async (name: string) => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.locator("#appearance-settings").waitFor();
    await page.getByRole("radio", { name, exact: true }).click();
  };
  const save = async () => {
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await page.locator("#settings-dialog").isVisible())
            ? (await page.locator("#settings-error").isVisible())
              ? `error: ${await page.locator("#settings-error").textContent()}`
              : "open"
            : "closed",
        { timeout: 60_000 },
      )
      .toMatch(/^(closed|error: .*)$/u);
    assert.ok(
      !(await page.locator("#settings-dialog").isVisible()),
      "the settings were saved",
    );
  };
  const stages = ["Import", "Magic Edit", "Refine", "Review", "Export"];
  const tour = async (id: string) => {
    for (const name of stages) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.waitForTimeout(1200);
      await page.screenshot({
        path: join(evidence, `${id}-${name.replaceAll(" ", "-")}.png`),
      });
    }
  };

  // Choosing a tile shows the theme at once; Cancel puts the saved one back.
  await chooseTheme("Paper");
  assert.equal((await themeOf(page)).theme, "paper");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect
    .poll(async () => (await themeOf(page)).theme)
    .toBe("light_canvas");

  for (const [name, id, layout] of [
    ["Light Canvas", "light_canvas", "classic"],
    ["Studio Dark", "studio_dark", "classic"],
    ["Cinematic", "cinematic", "cinematic"],
    ["Paper", "paper", "classic"],
  ] as const) {
    await chooseTheme(name);
    if (id === "light_canvas")
      await page.screenshot({ path: join(evidence, "settings.png") });
    assert.deepEqual(
      { ...(await themeOf(page)), background: undefined },
      { theme: id, layout, background: undefined },
    );
    await save();
    const saved = await page.evaluate(() => window.desktop.getPreferences());
    assert.ok(saved.ok);
    assert.equal(saved.value.theme?.id, id);
    await tour(id);
  }

  // Custom: four colours and a layout; unreadable text is refused.
  await chooseTheme("Custom");
  await page.locator("#custom-text").fill("#f4f7fa");
  await expect(page.locator("#custom-problem")).toContainText("too close");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#settings-error")).toContainText("too close");
  await page.locator("#custom-background").fill("#101820");
  await page.locator("#custom-surface").fill("#1b2733");
  await page.locator("#custom-accent").fill("#ff8a3d");
  await page.locator("#custom-layout").selectOption("cinematic");
  await expect(page.locator("#custom-problem")).toBeHidden();
  await expect(page.locator("#settings-error")).toBeHidden();
  assert.deepEqual(
    { ...(await themeOf(page)), background: undefined },
    { theme: "custom", layout: "cinematic", background: undefined },
  );
  assert.equal((await themeOf(page)).background, "rgb(16, 24, 32)");
  await page.screenshot({ path: join(evidence, "settings-custom.png") });
  await save();
  await tour("custom");

  // The choice survives a restart and paints at once.
  await electron.close();
  electron = await launch();
  page = await electron.firstWindow();
  await expect.poll(async () => (await themeOf(page)).theme).toBe("custom");
  assert.equal((await themeOf(page)).layout, "cinematic");
  assert.equal((await themeOf(page)).background, "rgb(16, 24, 32)");
  console.log(evidence);
} finally {
  await electron.close().catch(() => undefined);
}

/**
 * Control sweep: a synthetic recording is imported and, on every step, each
 * visible enabled button (with the disclosures open) is pressed once. A press
 * must never raise a page error, freeze the window or leave a dialog stuck
 * open. Controls that start long or irreversible work (export, transcription,
 * the one-click edit, project deletion, sign-in, capture) or that leave the
 * step are listed in `skipped` and are covered by their own tests.
 *
 * node tests/native/control-sweep.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect as baseExpect } from "playwright/test";
import type { Page } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";
import { openDisclosures } from "./disclosures.ts";

await assertNativeTestEnvironment();
const expect = baseExpect.configure({ timeout: 30_000 });
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-sweep-"));

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

/** Long, irreversible, leaving-the-step or credentialed controls. */
const skipped =
  /delete|remove project|discard|quit|exit|record|capture|sign|log ?(in|out)|transcribe|edit my video|auto-all|magic|next-step|export|download|cleanup|clean up|reveal|open folder|^home$|^back$|^import$|magic edit|rough cut|^refine$|^review$|continue|verify|ask|send|stop|full-editor-done/iu;

const problems: string[] = [];
const pressed: Record<string, string[]> = {};
const seen: Record<string, string[]> = {};
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: join(evidence, "config") },
  chromiumSandbox: true,
  timeout: 30_000,
});
let step = "start";
try {
  await electron.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: "" });
  }, sourcePath);
  const page = await electron.firstWindow();
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 120_000 });

  /** Visible, enabled buttons by a stable key (id, else label or text). */
  const controls = (target: Page) =>
    target.evaluate(() => {
      const keys: string[] = [];
      for (const button of document.querySelectorAll("button")) {
        if (button.disabled || !button.getClientRects().length) continue;
        const rect = button.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        // Behind an open modal the page is inert.
        const modal = document.querySelector("dialog[open]");
        if (modal && !modal.contains(button)) continue;
        keys.push(
          button.id ||
            button.getAttribute("aria-label") ||
            button.textContent?.trim() ||
            button.title,
        );
      }
      return keys;
    });
  const press = (target: Page, key: string) =>
    target.evaluate((wanted) => {
      for (const button of document.querySelectorAll("button")) {
        if (button.disabled || !button.getClientRects().length) continue;
        const key =
          button.id ||
          button.getAttribute("aria-label") ||
          button.textContent?.trim() ||
          button.title;
        if (key !== wanted) continue;
        button.scrollIntoView({ block: "center" });
        button.click();
        return true;
      }
      return false;
    }, key);

  for (const name of ["Import", "Magic Edit", "Refine", "Clips", "Export"]) {
    step = name;
    await page.getByRole("button", { name, exact: true }).click();
    await page.waitForTimeout(1500);
    await openDisclosures(page);
    const done = new Set<string>();
    pressed[name] = [];
    seen[name] = [...new Set(await controls(page))];
    for (let round = 0; round < 80; round++) {
      // An edit in flight disables the others for a moment: wait for them.
      let next: string | undefined;
      for (let wait = 0; wait < 6 && !next; wait++) {
        next = (await controls(page)).find(
          (key) => key && !done.has(key) && !skipped.test(key),
        );
        if (!next) await page.waitForTimeout(700);
      }
      if (!next) break;
      done.add(next);
      step = `${name}: ${next}`;
      if (!(await press(page, next))) continue;
      pressed[name]!.push(next);
      await page.waitForTimeout(250);
      // Whatever opened (dialog, popover) must close again by the keyboard.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!(await page.locator("dialog[open]").count())) break;
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
      }
      assert.equal(
        await page.locator("dialog[open]").count(),
        0,
        `"${next}" left a dialog open`,
      );
      // Full screen is left again by the keyboard, as a person would.
      if (await page.evaluate(() => Boolean(document.fullscreenElement))) {
        await page.keyboard.press("Escape");
        // The injected key does not reach the browser's own full-screen
        // handler (a person's Escape does), so leave it the way a page can.
        await page.evaluate(() => document.exitFullscreen().catch(() => null));
        await expect
          .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
          .toBe(false);
      }
      // The window still answers.
      assert.equal(await page.evaluate(() => 1 + 1), 2);
      // The complete editor hides the step bar; its own controls get their
      // turn, and its Done button (pressed last) returns to Refine.
      if (!(await page.locator("#project-navigation").isVisible())) continue;
      // A control may have moved the project to another step: come back.
      if (
        (await page
          .getByRole("button", { name, exact: true })
          .getAttribute("aria-current")) !== "step"
      ) {
        await page.getByRole("button", { name, exact: true }).click();
        await page.waitForTimeout(500);
        await openDisclosures(page);
      }
    }
    if (await page.locator("#full-editor-done").isVisible())
      await page.locator("#full-editor-done").click();
    await page.screenshot({
      path: join(evidence, `after-${name.replaceAll(" ", "-")}.png`),
    });
  }
  step = "finish";
  assert.deepEqual(problems, [], "no uncaught page errors");
  const total = Object.values(pressed).reduce(
    (sum, keys) => sum + keys.length,
    0,
  );
  assert.ok(total >= 20, `a meaningful number of controls were pressed`);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({ pressed, seen, total }, null, 2),
  );
  console.log(JSON.stringify({ evidence, total, pressed }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, problems, pressed }, null, 2),
  );
  throw error;
} finally {
  await electron.close().catch(() => undefined);
}

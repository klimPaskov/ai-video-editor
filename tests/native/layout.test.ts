/**
 * Layout audit: a synthetic recording (2 s of tone, 2 s of
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
import { auditLayout, type LayoutFinding } from "./layout-audit.ts";
import { openDisclosures } from "./disclosures.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { encodeVerifiedMaster } from "../../packages/media-engine/src/lossless.ts";

await assertNativeTestEnvironment();
// The guest shares a busy machine: allow slow starts, saves and navigation.
const expect = baseExpect.configure({ timeout: 30_000 });
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-layout-"));

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
const enforce = process.argv.includes("--enforce");
const subset = (name: string, all: string[]) =>
  process.env[name] ? process.env[name]!.split(",") : all;
const themes = subset("AUDIT_THEMES", [
  "light_canvas",
  "studio_dark",
  "cinematic",
  "paper",
  "custom",
]);
const sizes = subset("AUDIT_SIZES", [
  "1440x900@1",
  "1200x800@1",
  "1000x700@1",
  "1200x800@1.5",
  "1200x800@2",
]);
const customTheme = {
  id: "custom",
  custom: {
    background: "#101820",
    surface: "#1b2733",
    text: "#f4f7fa",
    accent: "#ff8a3d",
    layout: "cinematic",
  },
} as const;
const choiceFor = (id: string) =>
  id === "custom" ? customTheme : ({ id } as { id: string });

const report: Array<{ where: string; findings: LayoutFinding[] }> = [];
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
  chromiumSandbox: true,
  timeout: 30_000,
});
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
    { source: sourcePath, master: join(evidence, "audit master.mkv") },
  );
  const page = await electron.firstWindow();
  await expect(page.locator("#import")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 120_000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const projectId = listed.value[0]!.id;

  const audit = async (where: string) => {
    await page.waitForTimeout(500);
    const findings = await auditLayout(page);
    report.push({ where, findings });
    if (findings.length) {
      console.log(`${where}: ${findings.length} finding(s)`);
      for (const finding of findings)
        console.log(`    ${finding.kind}: ${finding.detail}`);
      await page.screenshot({
        path: join(
          evidence,
          `finding-${where.replaceAll(/[^a-z0-9]+/giu, "-").toLowerCase()}.png`,
        ),
      });
    }
  };
  const go = async (name: string, id: string) => {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.isVisible()) await button.click();
    else await page.locator("#stage-select").selectOption(id);
    await expect(page.locator("#stage-select")).toHaveValue(id);
  };

  for (const themeId of themes)
    for (const size of sizes) {
      const [dimensions, scale] = size.split("@");
      const [w, h] = dimensions!.split("x").map(Number);
      const tag = `${themeId} ${size}`;
      await electron.evaluate(
        ({ BrowserWindow }, [width, height]) => {
          const win = BrowserWindow.getAllWindows()[0]!;
          win.setContentSize(width!, height!);
        },
        [w!, h!],
      );
      const saved = await page.evaluate(
        (value) => window.desktop.setPreferences(value),
        { interfaceScale: Number(scale), theme: choiceFor(themeId) } as never,
      );
      assert.ok(saved.ok, `preferences saved for ${tag}`);
      await page.reload();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe(themeId);
      await page.waitForTimeout(800);
      await audit(`${tag} / Home`);
      await page.screenshot({
        path: join(evidence, `${themeId}-${size.replace("@", "x")}-home.png`),
      });
      await page.locator(`[data-project-id="${projectId}"]`).click();
      await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
      const stages: Array<[string, string]> = [
        ["Record or Import", "record_import"],
        ["Auto Edit", "auto_edit"],
        ["Edit", "edit"],
        ["Review", "review"],
        ["Export", "export"],
      ];
      for (const [name, id] of stages) {
        await go(name, id);
        await audit(`${tag} / ${name}`);
        await page.screenshot({
          path: join(
            evidence,
            `${themeId}-${size.replace("@", "x")}-${id}.png`,
          ),
        });
        if (id === "auto_edit" || id === "edit" || id === "export") {
          await openDisclosures(page);
          await audit(`${tag} / ${name} with more open`);
          await page.evaluate(() => {
            for (const details of document.querySelectorAll("details.more"))
              (details as HTMLDetailsElement).open = false;
          });
        }
      }
      // States that need doing something first, once per theme and again at
      // the largest interface size for the default theme.
      if (
        size === "1200x800@1" ||
        (themeId === "light_canvas" && size === "1200x800@2")
      ) {
        await go("Auto Edit", "auto_edit");
        // Claude is not signed in here: starting shows the plain failure.
        await page.locator("#auto-all-start").click();
        await expect(page.locator("#auto-all-error")).toBeVisible();
        await audit(`${tag} / Auto Edit after a failed start`);
        await go("Review", "review");
        await page.locator("#check-draft-integrity").click();
        await expect(page.locator("#draft-integrity-result")).toBeVisible();
        await audit(`${tag} / Review with the integrity result`);
        await go("Export", "export");
        await page.locator("#export-start").click();
        await expect
          .poll(
            async () =>
              (await page.locator("#export-running").isVisible()) ||
              (await page.locator("#export-done").isVisible()),
          )
          .toBe(true);
        if (await page.locator("#export-running").isVisible())
          await audit(`${tag} / Export running`);
        await expect(page.locator("#export-done")).toBeVisible({
          timeout: 300_000,
        });
        await audit(`${tag} / Export done`);
        await page.locator("#export-again").click();
        // The project card's options dialog and the recording dialog, from Home.
        await page.getByRole("button", { name: "Home" }).click();
        await page.locator(".card-options").first().click();
        await audit(`${tag} / Project options dialog`);
        await page.keyboard.press("Escape");
        if (await page.locator("#record-new").isVisible()) {
          await page.locator("#record-new").click();
          await audit(`${tag} / New recording dialog`);
          await page.keyboard.press("Escape");
        }
        await page.locator(`[data-project-id="${projectId}"]`).click();
        await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
      }
      // The assistant drawer and the source details.
      await go("Edit", "edit");
      const claude = page.getByRole("button", { name: "Claude", exact: true });
      if (await claude.isVisible()) {
        await claude.click();
        await audit(`${tag} / Edit with the Claude drawer`);
        await page.screenshot({
          path: join(
            evidence,
            `${themeId}-${size.replace("@", "x")}-drawer.png`,
          ),
        });
        await claude.click();
      }
      const details = page.locator("#source-details");
      if (await details.isVisible()) {
        await details.click();
        await audit(`${tag} / Edit with source details`);
        await details.click();
      }
      // Settings, section by section.
      await page.getByRole("button", { name: "Settings" }).click();
      await audit(`${tag} / Settings Appearance`);
      await page.screenshot({
        path: join(
          evidence,
          `${themeId}-${size.replace("@", "x")}-settings.png`,
        ),
      });
      for (const [section, id] of [
        ["Claude", "settings-claude"],
        ["Codex", "settings-codex"],
        ["API providers", "settings-api-providers"],
      ] as const) {
        await page.locator(`#${id}`).click();
        await audit(`${tag} / Settings ${section}`);
      }
      await page
        .getByRole("button", { name: "Cancel" })
        .first()
        .click()
        .catch(async () => {
          await page.keyboard.press("Escape");
        });
      await expect(page.locator("#settings-dialog")).not.toBeVisible();
      await page
        .getByRole("button", { name: "Home" })
        .click()
        .catch(() => undefined);
    }

  const failing = report.filter((entry) => entry.findings.length);
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  // The same finding repeats across themes: show each once with where it began.
  const unique = new Map<string, string>();
  for (const entry of failing)
    for (const finding of entry.findings) {
      const key = `${finding.kind}: ${finding.detail.replace(/\d+/gu, "N")}`;
      if (!unique.has(key)) unique.set(key, entry.where);
    }
  console.log(
    JSON.stringify(
      {
        evidence,
        screens: report.length,
        screensWithFindings: failing.length,
        distinct: [...unique].map(
          ([finding, where]) => `${finding} [first at ${where}]`,
        ),
      },
      null,
      2,
    ),
  );
  if (enforce) assert.equal(failing.length, 0, "layout findings");
} finally {
  await electron.close().catch(() => undefined);
}

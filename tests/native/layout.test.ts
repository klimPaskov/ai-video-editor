/**
 * Layout audit of the packaged app: every step, the assistant drawer, source
 * details, Settings, the recording and project dialogs, in every theme at
 * several window sizes and interface scales, on a long file name. It reports
 * controls cut off, overlapping or too small, unreadable text, and checks that
 * each step's primary action (such as Continue) is visible and clickable.
 *
 * node tests/native/layout.test.ts <packaged-executable> [--enforce]
 * AUDIT_THEMES and AUDIT_SIZES (comma lists, e.g. 900x600@1) narrow a run.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect as baseExpect } from "playwright/test";
import {
  auditLayout,
  checkPrimaryAction,
  type LayoutFinding,
} from "./layout-audit.ts";
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
// A long name, as a recording gets: it must not push the step's actions away.
const sourcePath = join(
  evidence,
  "Screen recording of the quarterly product walkthrough with the whole team 2026-10-30 14-22-11.mkv",
);
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
  "1000x650@1.5",
  "900x600@1",
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
    // AUDIT_SHOTS=1 keeps a picture of every audited screen for review.
    if (process.env.AUDIT_SHOTS) {
      const name = where.replaceAll(/[^a-z0-9]+/giu, "-").toLowerCase();
      await shot(join(evidence, `look-${name}.png`));
      // A page taller than the window also gets a picture of its end.
      const scrolls = await page.evaluate(() => {
        // The content area, not the document, is what scrolls.
        const visiblePage = document.querySelector<HTMLElement>(
          "#viewer:not([hidden]) .project-page",
        );
        const main = visiblePage ?? document.querySelector("main")!;
        if (main.scrollHeight <= main.clientHeight + 2) return false;
        main.scrollTo(0, main.scrollHeight);
        return true;
      });
      if (scrolls) {
        await page.waitForTimeout(250);
        await shot(join(evidence, `look-${name}-end.png`));
        await page.evaluate(() =>
          (
            document.querySelector<HTMLElement>(
              "#viewer:not([hidden]) .project-page",
            ) ?? document.querySelector("main")!
          ).scrollTo(0, 0),
        );
      }
    }
    if (findings.length) {
      console.log(`${where}: ${findings.length} finding(s)`);
      for (const finding of findings)
        console.log(`    ${finding.kind}: ${finding.detail}`);
      await shot(
        join(
          evidence,
          `finding-${where.replaceAll(/[^a-z0-9]+/giu, "-").toLowerCase()}.png`,
        ),
      );
    }
  };
  /**
   * A picture of the window itself: page screenshots ignore the interface
   * scale (they show the top-left corner of the zoomed page).
   */
  const shot = async (path: string) => {
    const png = await electron.evaluate(async ({ BrowserWindow }) => {
      const image =
        await BrowserWindow.getAllWindows()[0]!.webContents.capturePage();
      return image.toPNG().toString("base64");
    });
    await writeFile(path, Buffer.from(png, "base64"));
  };
  /** The step's main action must be on screen and receive a click. */
  const primary = async (where: string) => {
    const findings = await checkPrimaryAction(page);
    report.push({ where: `${where} primary action`, findings });
    if (findings.length) {
      console.log(`${where} primary action: ${findings[0]!.detail}`);
      await shot(
        join(
          evidence,
          `finding-primary-${where.replaceAll(/[^a-z0-9]+/giu, "-").toLowerCase()}.png`,
        ),
      );
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
      await shot(
        join(evidence, `${themeId}-${size.replace("@", "x")}-home.png`),
      );
      await page.locator(`[data-project-id="${projectId}"]`).click();
      await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
      const stages: Array<[string, string]> = [
        ["Import", "record_import"],
        ["Magic Edit", "auto_edit"],
        ["Refine", "edit"],
        ["Clips", "clips"],
        ["Export", "export"],
      ];
      for (const [name, id] of stages) {
        await go(name, id);
        await audit(`${tag} / ${name}`);
        await primary(`${tag} / ${name}`);
        await shot(
          join(evidence, `${themeId}-${size.replace("@", "x")}-${id}.png`),
        );
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
        await go("Magic Edit", "auto_edit");
        // Claude is not signed in here: starting shows the plain failure.
        await page.locator("#auto-all-start").click();
        // Where the speech model is slow to arrive the edit is still running:
        // audit that state, then stop it, instead of waiting for the failure.
        const failed = await page
          .locator("#auto-all-error")
          .waitFor({ state: "visible", timeout: 45_000 })
          .then(
            () => true,
            () => false,
          );
        await audit(
          `${tag} / Magic Edit after a ${failed ? "failed start" : "start"}`,
        );
        if (!failed) {
          await page.locator("#auto-all-stop").click();
          await expect(page.locator("#auto-all-start")).toBeVisible();
          // The local transcript keeps running until it is stopped too.
          await page.evaluate(() =>
            document
              .querySelector<HTMLButtonElement>("#stop-transcription")
              ?.click(),
          );
          await expect
            .poll(
              () =>
                page.evaluate(async (id) => {
                  const reply = await window.desktop.getTranscription({
                    schema_version: "1.0",
                    project_id: id,
                    job_id: null,
                  });
                  return reply.ok ? reply.value.job.status : "unknown";
                }, projectId),
              { timeout: 60_000 },
            )
            .not.toMatch(/^(preparing|downloading_model|transcribing)$/u);
        }
        await go("Export", "export");
        await page.locator("#export-start").click();
        await expect
          .poll(
            async () =>
              (await page.locator("#export-running").isVisible()) ||
              (await page.locator("#done-actions").isVisible()),
          )
          .toBe(true);
        if (await page.locator("#export-running").isVisible())
          await audit(`${tag} / Export running`);
        await expect(page.locator("#done-actions")).toBeVisible({
          timeout: 300_000,
        });
        await audit(`${tag} / Done`);
        await shot(
          join(evidence, `${themeId}-${size.replace("@", "x")}-done.png`),
        );
        await page.locator("#done-keep").click();
        await expect(page.locator("#export-done")).toBeVisible();
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
      // Import with the assistant drawer open and with a message banner showing
      // (what a first run without Claude sets up): Continue must stay reachable.
      await go("Import", "record_import");
      const assistant = page.getByRole("button", {
        name: "Claude",
        exact: true,
      });
      if (await assistant.isVisible()) {
        await assistant.click();
        await audit(`${tag} / Import with the Claude drawer`);
        // Below 900 px of page width the drawer covers the step by design.
        if (w! / Number(scale) > 900)
          await primary(`${tag} / Import with the Claude drawer`);
        await shot(
          join(
            evidence,
            `${themeId}-${size.replace("@", "x")}-import-drawer.png`,
          ),
        );
        await assistant.click();
      }
      await page.evaluate(() => {
        const banner = document.getElementById("error")!;
        banner.textContent =
          "Claude Code is not installed. Open Settings > Claude to set it up.";
        banner.hidden = false;
      });
      await audit(`${tag} / Import with a message banner`);
      await primary(`${tag} / Import with a message banner`);
      await shot(
        join(
          evidence,
          `${themeId}-${size.replace("@", "x")}-import-banner.png`,
        ),
      );
      await page.evaluate(() => {
        document.getElementById("error")!.hidden = true;
      });
      // The assistant drawer and the source details.
      await go("Refine", "edit");
      const claude = page.getByRole("button", { name: "Claude", exact: true });
      if (await claude.isVisible()) {
        await claude.click();
        await audit(`${tag} / Refine with the Claude drawer`);
        await shot(
          join(evidence, `${themeId}-${size.replace("@", "x")}-drawer.png`),
        );
        await claude.click();
      }
      const details = page.locator("#source-details");
      if (await details.isVisible()) {
        await details.click();
        await audit(`${tag} / Refine with source details`);
        await details.click();
      }
      // Settings, section by section.
      await page.getByRole("button", { name: "Settings" }).click();
      await audit(`${tag} / Settings Appearance`);
      await shot(
        join(evidence, `${themeId}-${size.replace("@", "x")}-settings.png`),
      );
      for (const [section, id] of [
        ["Claude", "settings-claude"],
        ["Codex", "settings-codex"],
        ["API providers", "settings-api-providers"],
        ["Shortcuts", "settings-shortcuts"],
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

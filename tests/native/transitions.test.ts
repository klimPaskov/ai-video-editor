/**
 * Packaged native transitions: a cut leaves a place for a transition, the
 * Edit control adds a dip to black there, the live preview draws it (fully
 * covering at the cut, absent outside its window), a verified lossless master
 * differs from the cut footage only inside the transition's window and is
 * black at the cut frame, and Remove and Undo behave as for other edits.
 *
 * node tests/native/transitions.test.ts <packaged-executable>
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
import { openFullEditor, openStep, exportFinished } from "./disclosures.ts";

await assertNativeTestEnvironment();
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-transitions-"));
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
const result: Record<string, unknown> = { scope: "native-transitions" };
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

/** The overlay's opacity in the live preview, or null when none is drawn. */
async function overlayOpacity(page: Page): Promise<number | null> {
  const stage = page.locator("iframe.graphics-stage");
  if (!(await stage.isVisible())) return null;
  return stage.evaluate((frame: HTMLIFrameElement) => {
    const overlay = frame.contentDocument
      ?.querySelector("section")
      ?.shadowRoot?.querySelector(".tr");
    return overlay ? Number(getComputedStyle(overlay).opacity) : null;
  });
}

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
  await openFullEditor(page);
  await expect(page.locator("#edit-actions")).toBeVisible();
  await page.locator("#edit-more > summary").click();

  step = "no-cut-yet";
  // A transition needs a cut: with one clip the control says so and is off.
  await expect(page.locator("#transition-add")).toBeDisabled();
  await expect(page.locator("#transition-add")).toHaveAttribute(
    "aria-label",
    /no cut yet/u,
  );

  step = "cut";
  // Cutting 1.0 s to 2.0 s leaves a real cut at 1.0 s of the output.
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  const project = listed.value[0]!;
  const cut = await page.evaluate(
    (value) => window.desktop.applyManualRangeCut(value),
    {
      schema_version: "1.0" as const,
      projectId: project.id,
      draftId: project.draft.id,
      baseRevisionId: project.draft.baseRevisionId,
      expectedSequence: project.draft.sequence,
      expectedTimelineSha256: project.draft.timelineSha256,
      startUs: 1_000_000,
      endUs: 2_000_000,
    },
  );
  assert.ok(cut.ok, "the range is cut");
  // Reopen so the page shows the new draft.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: /Demo/u }).first().click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 60_000 });
  await openFullEditor(page);
  await expect(page.locator("#edit-actions")).toBeVisible();
  if (
    !(await page
      .locator("#edit-more")
      .evaluate((el) => el.hasAttribute("open")))
  )
    await page.locator("#edit-more > summary").click();

  step = "refuses-a-point-that-is-not-a-cut";
  const refused = await page.evaluate(
    async (value) => {
      const draft = value.draft;
      try {
        const reply = await window.desktop.applyManualTransition({
          schema_version: "1.0" as const,
          projectId: value.id,
          draftId: draft.id,
          baseRevisionId: draft.baseRevisionId,
          expectedSequence: draft.sequence,
          expectedTimelineSha256: draft.timelineSha256,
          transitionId: null,
          atUs: 500_000,
          kind: "dip" as const,
          durationUs: 600_000,
          color: "#000000",
        });
        return reply.ok ? "accepted" : reply.message;
      } catch {
        return "refused";
      }
    },
    { id: project.id, draft: cut.value.draft },
  );
  assert.notEqual(refused, "accepted");
  result.notACut = refused;

  step = "add";
  await seekTo(page, 1_100_000);
  await page.locator("#transition-kind").selectOption("dip:#000000");
  await page.locator("#transition-length").selectOption("600000");
  await expect(page.locator("#transition-add")).toBeEnabled();
  await expect(page.locator("#transition-add")).toHaveText("Add transition");
  await page.locator("#transition-add").click();
  await expect(page.locator(".timeline-transition")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.locator("#transition-add")).toHaveText("Change transition");
  await expect(page.locator("#transition-remove")).toBeVisible();

  step = "filmstrip";
  // The strip shows pictures of the edit under its parts and a time ruler.
  await expect(
    page.locator(".timeline-thumbs.filled canvas").first(),
  ).toBeVisible({ timeout: 60_000 });
  const filmstrip = await page.evaluate(() => {
    const cells = [
      ...document.querySelectorAll<HTMLCanvasElement>(
        ".timeline-thumbs canvas",
      ),
    ];
    const drawn = cells.filter((canvas) => {
      const data = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      for (let at = 0; at < data.length; at += 4)
        if (data[at]! + data[at + 1]! + data[at + 2]! > 30) return true;
      return false;
    });
    return {
      cells: cells.length,
      drawn: drawn.length,
      labels: [...document.querySelectorAll(".timeline-tick")].map(
        (tick) => tick.textContent,
      ),
    };
  });
  assert.ok(filmstrip.cells >= 3, `cells: ${filmstrip.cells}`);
  assert.equal(filmstrip.drawn, filmstrip.cells, "no blank picture");
  assert.ok(filmstrip.labels.length >= 2, `labels: ${filmstrip.labels}`);
  assert.equal(filmstrip.labels[0], "0:00");
  await page.locator("#timeline-strip").screenshot({
    path: join(evidence, "filmstrip.png"),
  });
  result.filmstrip = filmstrip;

  step = "preview";
  // The window is 0.7 s to 1.3 s, centred on the cut at 1.0 s.
  await seekTo(page, 1_000_000);
  await expect(page.locator("iframe.graphics-stage")).toBeVisible();
  const atCut = await overlayOpacity(page);
  assert.equal(atCut, 1, "the cut is fully covered");
  await page.screenshot({ path: join(evidence, "transition-at-cut.png") });
  await seekTo(page, 850_000);
  const inside = await overlayOpacity(page);
  assert.ok(inside! > 0 && inside! < 1, `partly covered: ${inside}`);
  await seekTo(page, 500_000);
  await expect(page.locator("iframe.graphics-stage")).toBeHidden();
  await seekTo(page, 1_500_000);
  await expect(page.locator("iframe.graphics-stage")).toBeHidden();
  result.preview = { atCut, partway: inside };

  step = "styles";
  // Every style covers the picture at the cut, in its own colour. Changing
  // the style of an existing transition applies at once.
  const styles: [string, [number, number, number]][] = [
    ["dip:#ffffff", [255, 255, 255]],
    ["wipe_right:#1a73e8", [26, 115, 232]],
    ["wipe_left:#1a73e8", [26, 115, 232]],
    ["iris:#000000", [0, 0, 0]],
    ["dip:#000000", [0, 0, 0]],
  ];
  const seen: Record<string, number[]> = {};
  for (const [choice, expected] of styles) {
    await seekTo(page, 1_100_000);
    await page.locator("#transition-kind").selectOption(choice);
    await expect(page.locator(".timeline-transition")).toHaveCount(1);
    await expect(page.locator("#edit-actions")).toHaveAttribute(
      "aria-busy",
      "false",
      { timeout: 30_000 },
    );
    await seekTo(page, 1_000_000);
    await expect(page.locator("iframe.graphics-stage")).toBeVisible();
    const picture = join(
      evidence,
      `transition-${choice.replace(":#", "-")}.png`,
    );
    await page.locator(".preview").screenshot({ path: picture });
    const pixels = await ffmpeg([
      "-i",
      picture,
      "-vf",
      "crop=1:1:iw/2:ih/2",
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    seen[choice] = [...pixels];
    // Evidence of the motion: the same style a third of the way in.
    await seekTo(page, 900_000);
    await page.locator(".preview").screenshot({
      path: join(evidence, `transition-${choice.replace(":#", "-")}-in.png`),
    });
    for (const [index, value] of expected.entries())
      assert.ok(
        Math.abs(pixels[index]! - value) <= 12,
        `${choice} covers the centre: ${[...pixels]} against ${expected}`,
      );
  }
  result.styles = seen;
  assert.equal(
    await page.locator("#transition-kind").inputValue(),
    "dip:#000000",
  );

  step = "export";
  await openStep(page, "Export");
  await expect(page.locator("#export-actions")).toBeVisible();
  await page.locator("#export-start").click();
  await exportFinished(page, 300_000);
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
  const frameBytes = rawFrameBytes("yuv420p", 320, 180);
  // 4 s minus the 1 s cut at 30 fps.
  assert.equal(exported.length / frameBytes, 90);
  // Output frame f shows source frame f before the cut and f + 30 after it.
  const differing: number[] = [];
  for (let frame = 0; frame < 90; frame++) {
    const sourceFrame = frame < 30 ? frame : frame + 30;
    const a = exported.subarray(frame * frameBytes, (frame + 1) * frameBytes);
    const b = original.subarray(
      sourceFrame * frameBytes,
      (sourceFrame + 1) * frameBytes,
    );
    if (!a.equals(b)) differing.push(frame);
  }
  assert.ok(differing.length >= 12, `frames changed: ${differing.length}`);
  assert.ok(
    differing.every((frame) => frame >= 21 && frame <= 38),
    `only the window changes: ${differing.join(",")}`,
  );
  // The first frame after the cut is black.
  const rgb = await decode(master, "rgb24");
  const mean = (frame: number) => {
    const size = 320 * 180 * 3;
    let total = 0;
    for (const value of rgb.subarray(frame * size, (frame + 1) * size))
      total += value;
    return total / size;
  };
  assert.ok(mean(30) < 4, `the cut frame is black: ${mean(30)}`);
  assert.ok(mean(25) < mean(10) * 0.9, "the frames before it are darkening");
  result.export = {
    changedFrames: differing.length,
    first: differing[0],
    last: differing.at(-1),
    cutFrameMean: mean(30),
  };

  step = "remove-and-undo";
  await openFullEditor(page);
  await expect(page.locator("#edit-actions")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await seekTo(page, 1_100_000);
  await page.locator("#transition-remove").click();
  await expect(page.locator(".timeline-transition")).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.locator("#undo-edit").click();
  await expect(page.locator(".timeline-transition")).toHaveCount(1, {
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

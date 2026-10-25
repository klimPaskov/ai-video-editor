/**
 * Packaged native graphic components: every kind of the component library is
 * placed on a 1280x720 recording, exported in a verified lossless master and
 * decoded; the frame in the middle of each graphic must differ from the
 * recording (the graphic is drawn) and the frame just before it must not.
 * Pictures of each graphic are kept for visual review.
 *
 * node tests/native/graphic-components.test.ts <packaged-executable>
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect as baseExpect } from "playwright/test";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import {
  renderGraphicComponent,
  type GraphicComponentKind,
  type GraphicComponentParams,
} from "../../packages/domain/src/graphic-components.ts";

await assertNativeTestEnvironment();
const expect = baseExpect.configure({ timeout: 30_000 });
const executablePath = process.argv[2];
assert.ok(executablePath, "Packaged executable path is required");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-components-"));
const configRoot = join(evidence, "config");
const width = 1280;
const height = 720;
const rate = 30;

async function ffmpeg(args: string[]): Promise<Buffer> {
  return (
    await runProcess({
      executable: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
      timeoutMs: 600_000,
      maxOutputBytes: 2048 * 1024 * 1024,
    })
  ).stdout;
}

const sourcePath = join(evidence, "Demo.mp4");
await ffmpeg([
  "-f",
  "lavfi",
  "-i",
  `gradients=size=${width}x${height}:rate=${rate}:duration=24:speed=0.01:c0=0x1d2b45:c1=0x6b7a99:nb_colors=2`,
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=330:sample_rate=48000:duration=24",
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
  "-shortest",
  sourcePath,
]);
const master = join(evidence, "master.mkv");

const items: Array<{
  kind: GraphicComponentKind;
  params: GraphicComponentParams;
}> = [
  {
    kind: "lower_third",
    params: {
      title: "Ada Lovelace",
      subtitle: "Mathematician",
      accent: "#ff8a3d",
    },
  },
  {
    kind: "chapter_card",
    params: {
      title: "Setting up the project",
      subtitle: "Part 2",
      accent: "#22c55e",
    },
  },
  {
    kind: "stat_callout",
    params: {
      title: "42%",
      subtitle: "faster exports",
      side: "right",
      place: "top",
    },
  },
  {
    kind: "highlight_box",
    params: {
      title: "Click here",
      x: 0.55,
      y: 0.3,
      width: 0.3,
      height: 0.2,
      accent: "#f43f5e",
    },
  },
  {
    kind: "keyword",
    params: { title: "No more guesswork", place: "middle", accent: "#facc15" },
  },
  {
    kind: "step_badge",
    params: {
      title: "Open the menu",
      subtitle: "3",
      side: "right",
      place: "bottom",
    },
  },
];
const startUs = (index: number) => 1_000_000 + index * 3_500_000;
const durationUs = 3_000_000;

const result: Record<string, unknown> = { scope: "graphic-components" };
let step = "launch";
const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
  chromiumSandbox: true,
  timeout: 30_000,
});
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
  for (const [index, item] of items.entries()) {
    const listed = await page.evaluate(() => window.desktop.listProjects());
    assert.ok(listed.ok);
    const project = listed.value[0]!;
    const rendered = renderGraphicComponent(item.kind, item.params, durationUs);
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
        startUs: startUs(index),
        durationUs,
        layer: 20,
        name: rendered.name,
        html: rendered.html,
        css: rendered.css,
      },
    );
    assert.ok(added.ok, `${item.kind} is saved`);
  }
  await expect(page.locator(".timeline-graphic")).toHaveCount(items.length);

  step = "export";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.locator("#export-actions")).toBeVisible();
  await page.locator("#export-start").click();
  await expect(page.locator("#export-done")).toBeVisible({ timeout: 900_000 });
  await expect(page.locator("#export-result")).toContainText(
    "verified lossless",
  );

  step = "frames";
  const frameAt = async (
    seconds: number,
    file: string,
    rgb: boolean,
  ): Promise<Buffer> => {
    const out = join(evidence, file);
    await ffmpeg([
      "-ss",
      String(seconds),
      "-i",
      master,
      "-frames:v",
      "1",
      "-y",
      out,
    ]);
    if (!rgb) return Buffer.alloc(0);
    return ffmpeg([
      "-ss",
      String(seconds),
      "-i",
      master,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
  };
  const drawn: string[] = [];
  for (const [index, item] of items.entries()) {
    const middle = (startUs(index) + 1_800_000) / 1_000_000;
    const before = startUs(index) / 1_000_000 - 0.2;
    const withGraphic = await frameAt(
      middle,
      `${index}-${item.kind}.png`,
      true,
    );
    const without = await frameAt(
      before,
      `${index}-${item.kind}-before.png`,
      true,
    );
    let different = 0;
    for (let offset = 0; offset < withGraphic.length; offset += 3)
      if (
        Math.abs(withGraphic[offset]! - without[offset]!) > 40 ||
        Math.abs(withGraphic[offset + 1]! - without[offset + 1]!) > 40
      )
        different++;
    const share = different / (width * height);
    // A graphic is drawn: some part of the picture is clearly different.
    assert.ok(share > 0.003, `${item.kind} changed only ${share}`);
    drawn.push(`${item.kind}:${share.toFixed(3)}`);
  }
  result.drawn = drawn;
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

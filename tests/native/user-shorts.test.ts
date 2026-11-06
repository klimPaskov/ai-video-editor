/**
 * Short clips and publishing text for finished videos, in the packaged app:
 * each video is imported, transcribed locally, clips are found, the best ones
 * are exported as vertical 9:16 MP4s with captions and a title, and the
 * YouTube/short text is written for the video and every clip. Nothing is
 * edited or uploaded; everything lands in the app's organised folder
 * (Videos/Urushi/<project>/{Shorts,Publish}).
 *
 * node tests/native/user-shorts.test.ts <packaged-executable> <video>...
 *   [--max-clips 5] [--out <folder to copy the results into>]
 *
 * The videos are the person's finished work and stay untouched (the app
 * imports read-only). No assistant account is used: clips are found from the
 * transcript and the text is the plain draft unless an API provider is set.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import { openDisclosures, openStep } from "./disclosures.ts";
import { assertNativeTestEnvironment } from "../../scripts/native-test-environment.ts";
import { organizedFolder } from "../../apps/desktop/src/publish.ts";

await assertNativeTestEnvironment();
const args = process.argv.slice(2);
const flagValue = (name: string): string | null => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? null) : null;
};
const maxClips = Number(flagValue("--max-clips") ?? 5);
const outFolder = flagValue("--out");
const flagged = new Set(
  ["--max-clips", "--out"].flatMap((name) => {
    const at = args.indexOf(name);
    return at >= 0 ? [at, at + 1] : [];
  }),
);
const [executablePath, ...videos] = args.filter(
  (_value, index) => !flagged.has(index),
);
assert.ok(executablePath && videos.length > 0, "Executable and videos needed");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const evidence = await mkdtemp(join(evidenceRoot, "native-user-shorts-"));
const configRoot = join(evidence, "config");
const results: Array<Record<string, unknown>> = [];

const electron = await _electron.launch({
  executablePath,
  env: { ...process.env, XDG_CONFIG_HOME: configRoot },
  chromiumSandbox: true,
  timeout: 60_000,
});
let step = "launch";
try {
  const videosFolder = await electron.evaluate(({ app }) =>
    app.getPath("videos"),
  );
  const page = await electron.firstWindow();
  await openDisclosures(page);
  for (const video of videos.map((path) => resolve(path))) {
    step = `import ${video}`;
    const started = Date.now();
    await electron.evaluate(({ dialog }, value) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [value],
      })) as typeof dialog.showOpenDialog;
    }, video);
    const before = await page.evaluate(() => window.desktop.listProjects());
    assert.ok(before.ok);
    const known = new Set(before.value.map((view) => view.id));
    await page
      .getByRole("button", { name: "Import video", exact: true })
      .click();
    await expect(page.locator("#frame")).toBeVisible({ timeout: 600_000 });
    const listed = await page.evaluate(() => window.desktop.listProjects());
    assert.ok(listed.ok);
    const project = listed.value.find((view) => !known.has(view.id));
    assert.ok(project, "the video became a project");

    step = `transcribe ${project.name}`;
    await openStep(page, "Magic Edit");
    await page
      .getByRole("button", { name: "Transcribe locally", exact: true })
      .click();
    await expect(page.locator("#transcription-status")).toContainText(
      "Transcript complete",
      { timeout: 60 * 60_000 },
    );
    const transcribed = Date.now();

    step = `find ${project.name}`;
    const base = { schema_version: "1.0" as const, project_id: project.id };
    await openStep(page, "Clips");
    const found = await page.evaluate(
      (request) => window.desktop.findShortClips(request),
      base,
    );
    assert.ok(found.ok, found.ok ? "" : found.message);
    const candidates =
      found.value.status === "ready" ? found.value.candidates : [];
    const chosen = candidates.slice(0, maxClips);

    let exported: string[] = [];
    if (chosen.length > 0) {
      step = `export ${project.name}`;
      const shortsFolder = organizedFolder(
        videosFolder,
        project.name,
        "Shorts",
      );
      await mkdir(shortsFolder, { recursive: true });
      await electron.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [folder],
        })) as typeof dialog.showOpenDialog;
      }, shortsFolder);
      const done = await page.evaluate(
        (request) => window.desktop.exportAllShortClips(request),
        {
          ...base,
          format: "vertical" as const,
          framing: "fit" as const,
          position: 0.5,
          captions: true,
          title: true,
          speed: 1 as const,
          clip_ids: chosen.map((candidate) => candidate.id),
        },
      );
      assert.ok(done.ok, done.ok ? "" : done.message);
      // The batch runs in the background; wait until the library has them all.
      await expect
        .poll(
          async () => {
            const view = await page.evaluate(
              (request) => window.desktop.getShortClips(request),
              base,
            );
            if (!view.ok) return -1;
            if (view.value.job.status === "failed") return -2;
            exported = view.value.library.map((saved) => saved.fileName);
            return view.value.job.status === "running"
              ? -3
              : view.value.library.length;
          },
          { timeout: 30 * 60_000, intervals: [3_000] },
        )
        .toBeGreaterThanOrEqual(chosen.length);
    }

    step = `publish ${project.name}`;
    const texts: Array<{ kind: string; title: string; by: string }> = [];
    const write = async (kind: "video" | "short", subject: string) => {
      const reply = await page.evaluate(
        (request) => window.desktop.draftPublish(request),
        {
          schema_version: "1.0" as const,
          project_id: project.id,
          kind,
          subject_id: subject,
          tone: "casual" as const,
        },
      );
      assert.ok(reply.ok, reply.ok ? "" : reply.message);
      assert.ok(reply.value.kit);
      texts.push({
        kind,
        title: reply.value.kit.youtube.title,
        by: reply.value.kit.writtenBy,
      });
    };
    await write("video", project.id);
    for (const candidate of chosen) await write("short", candidate.id);

    results.push({
      video: project.name,
      projectId: project.id,
      seconds: {
        transcribe: Math.round((transcribed - started) / 1000),
        total: Math.round((Date.now() - started) / 1000),
      },
      candidates: candidates.length,
      shorts: exported,
      texts,
    });
    await page.getByRole("button", { name: "Home", exact: true }).click();
  }

  step = "copy";
  if (outFolder) {
    await mkdir(outFolder, { recursive: true });
    await cp(join(videosFolder, "Urushi"), join(resolve(outFolder), "Urushi"), {
      recursive: true,
    });
  }
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify({ evidence, videosFolder, results }));
} catch (error) {
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify({ step, results, error: String(error) }, null, 2),
  );
  console.error(step, error);
  process.exitCode = 1;
} finally {
  await electron.close();
}

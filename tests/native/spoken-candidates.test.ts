/** Exercise transcript-candidate review in the packaged native Auto Edit view. */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "playwright/test";
import type { Page } from "playwright/test";
import { channels } from "../../apps/desktop/src/bridge.ts";
import type {
  LocalTranscript,
  TranscriptAnalysis,
  TranscriptWord,
  TranscriptionProjectView,
} from "../../packages/domain/src/transcription.ts";
import {
  encodeVerifiedMaster,
  sha256,
} from "../../packages/media-engine/src/lossless.ts";

assert.equal(
  process.platform,
  "linux",
  "Native tests require the isolated guest",
);
assert.equal(process.getuid?.(), 1000);
assert.equal(process.env.DISPLAY, ":99");
await readFile("/.dockerenv");

const executablePath = process.argv[2];
if (!executablePath?.startsWith("/home/node/workspaces/"))
  throw new Error("Packaged executable must be inside the isolated guest");
const inspect = process.argv.includes("--inspect");
const evidenceRoot = resolve("test-results");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "native-spoken-candidates-"));
await chmod(evidence, 0o700);
const configRoot = join(evidence, "config");
await mkdir(configRoot, { mode: 0o700 });

const frameSize = 96 * 64 * 4;
const video = Buffer.alloc(frameSize * 3);
const colors = [
  [20, 40, 180, 255],
  [30, 170, 50, 255],
  [190, 60, 30, 255],
];
for (let frame = 0; frame < 3; frame++) {
  for (let pixel = 0; pixel < 96 * 64; pixel++) {
    for (let channel = 0; channel < 4; channel++)
      video[frame * frameSize + pixel * 4 + channel] = colors[frame]![channel]!;
  }
}
async function assertCanvasFrame(page: Page, frame: number): Promise<void> {
  const actual = await page.locator("#frame").evaluate((node) => {
    const canvas = node as HTMLCanvasElement;
    return {
      width: canvas.width,
      height: canvas.height,
      pixels: Array.from(
        canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height)
          .data,
      ),
    };
  });
  assert.equal(actual.width, 96);
  assert.equal(actual.height, 64);
  const expected = Buffer.from(
    video.subarray(frame * frameSize, (frame + 1) * frameSize),
  );
  for (let pixel = 0; pixel < expected.length; pixel += 4) {
    const blue = expected[pixel]!;
    expected[pixel] = expected[pixel + 2]!;
    expected[pixel + 2] = blue;
  }
  assert.deepEqual(Buffer.from(actual.pixels), expected);
}
const audio = Buffer.alloc(72_000 * 2);
for (let sample = 0; sample < 72_000; sample++)
  audio.writeInt16LE(Math.round(Math.sin(sample / 20) * 6000), sample * 2);
const videoPath = join(evidence, "candidate-fixture.raw");
const audioPath = join(evidence, "candidate-fixture.pcm");
const sourcePath = join(evidence, "Candidate fixture.mkv");
await writeFile(videoPath, video);
await writeFile(audioPath, audio);
await encodeVerifiedMaster(
  {
    videoPath,
    audioPath,
    role: "canonical",
    format: {
      width: 96,
      height: 64,
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
  sourcePath,
);
const sourceHash = sha256(await readFile(sourcePath));

const tokenText = [
  "Intro.",
  "the",
  "demo",
  "the",
  "demo",
  "deploy—",
  "Actually,",
  "Hey",
  "Codex,",
  "They",
  "said",
  "“Hey",
  "Codex”",
  "Um,",
  "I",
  "mean,",
  "Acme",
  "3",
  "not",
  "two.",
];
const flagged: Record<string, NonNullable<TranscriptWord["flags"]>> = {
  Acme: ["name"],
  "3": ["number"],
  not: ["negation"],
};
function syntheticTranscript(
  projectId: string,
  sourceId: string,
): LocalTranscript {
  const words = tokenText.map((text, index) => {
    const start_us = 40_000 + index * 60_000;
    return {
      word_id: `word-${String(index + 1).padStart(6, "0")}`,
      text,
      start_us,
      end_us: start_us + 40_000,
      confidence: null,
      flags: flagged[text] ?? [],
    } satisfies TranscriptWord;
  });
  const segmentWords = [
    words.slice(0, 1),
    words.slice(1, 3),
    words.slice(3, 5),
    words.slice(5),
  ];
  return {
    schema_version: "1.0",
    transcript_id: "transcript-native-candidates-01",
    project_id: projectId,
    source_id: sourceId,
    duration_us: 1_500_000,
    language: "en",
    model: { provider: "local", name: "synthetic-fixture", version: "1" },
    segments: segmentWords.map((segment, index) => ({
      segment_id: `segment-native-candidates-${String(index + 1).padStart(2, "0")}`,
      start_us: segment[0]!.start_us,
      end_us: segment.at(-1)!.end_us,
      text: segment.map((word) => word.text).join(" "),
      words: segment,
    })),
    warnings: [
      "Word timings are local model estimates; verify before editing.",
    ],
  };
}
function syntheticAnalysis(
  projectId: string,
  sourceId: string,
): TranscriptAnalysis {
  return {
    schema_version: "1.0",
    project_id: projectId,
    source_id: sourceId,
    source_sha256: sourceHash,
    duration_us: 1_500_000,
    silence_policy: {
      version: "1",
      noise_db: -40,
      minimum_duration_us: 250_000,
    },
    silences: [],
  };
}

let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
try {
  electron = await _electron.launch({
    executablePath,
    chromiumSandbox: true,
    env: { ...process.env, DISPLAY: ":99", XDG_CONFIG_HOME: configRoot },
    timeout: 30000,
  });
  const page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({ app }) => app.isPackaged), true);
  assert.equal(page.url(), "ai-video-editor://app/index.html");
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, sourcePath);
  await page.getByRole("button", { name: "Import video", exact: true }).click();
  await expect(page.locator("#frame")).toBeVisible({ timeout: 30000 });
  const listed = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(listed.ok);
  if (!listed.ok) throw new Error("The synthetic project did not persist");
  assert.equal(listed.value.length, 1);
  const project = listed.value[0]!;
  assert.equal(project.stage, "record_import");
  const userData = await electron.evaluate(({ app }) =>
    app.getPath("userData"),
  );
  const baselinePath = join(
    userData,
    "project-store",
    project.id,
    "baseline.json",
  );
  const baselineBytes = await readFile(baselinePath);
  const transcript = syntheticTranscript(project.id, project.source.id);
  const analysis = syntheticAnalysis(project.id, project.source.id);
  const mockView: TranscriptionProjectView = {
    project_id: project.id,
    job: {
      project_id: project.id,
      job_id: null,
      status: "completed",
      progress_percent: 100,
      source_count: 1,
      completed_source_count: 1,
      word_count: transcript.segments.reduce(
        (count, segment) => count + segment.words.length,
        0,
      ),
      message: "Transcript ready.",
    },
    results: [{ source_id: project.source.id, transcript, analysis }],
  };
  await electron.evaluate(
    ({ ipcMain }, payload) => {
      ipcMain.removeHandler(payload.channel);
      ipcMain.handle(payload.channel, async () => ({
        ok: true,
        value: payload.view,
      }));
    },
    { channel: channels.transcriptionGet, view: mockView },
  );

  await page
    .getByRole("navigation", { name: "Project stages" })
    .getByRole("button", { name: "Auto Edit", exact: true })
    .click();
  const autoEdit = page
    .getByRole("navigation", { name: "Project stages" })
    .getByRole("button", { name: "Auto Edit", exact: true });
  await expect(autoEdit).toHaveAttribute("aria-current", "step");
  const transcriptDetails = page.locator("#transcript-results");
  await expect(transcriptDetails).toBeVisible({ timeout: 30000 });
  await page.locator("#transcript-summary").click();
  const reviewButton = page.getByRole("button", {
    name: "Review speech cues",
    exact: true,
  });
  await expect(reviewButton).toBeVisible();
  await reviewButton.click();
  await expect(page.locator("#speech-candidate-results")).toBeVisible();
  await expect(page.locator("#speech-candidate-summary")).toContainText(
    "review cue",
  );
  await expect(
    page.getByText("Filler · Review", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Spoken editor cue · Context only", { exact: false }),
  ).toBeVisible();
  const repeatedItem = page
    .locator(".speech-candidate-item")
    .filter({ hasText: "Repeated phrase · Review" });
  await expect(repeatedItem.locator(".speech-candidate-excerpt")).toContainText(
    "the demo the demo",
  );
  await expect(repeatedItem.locator(".speech-candidate-related")).toHaveText(
    "Earlier transcript occurrence: the demo",
  );
  await expect(page.locator(".speech-candidate-protection")).toContainText(
    "3 protected transcript words",
  );
  const beforePreview = await page.evaluate(() =>
    window.desktop.listProjects(),
  );
  assert.ok(beforePreview.ok);
  if (!beforePreview.ok)
    throw new Error("The project summary could not be read");
  const originalSequence = beforePreview.value[0]!.draft.sequence;
  const originalHash = beforePreview.value[0]!.draft.timelineSha256;
  if (inspect) {
    await page.screenshot({
      path: join(evidence, "speech-candidate-review.png"),
    });
    console.log(
      JSON.stringify({ speechCandidatesInspectionReady: true, evidence }),
    );
    const marker = join(evidence, "speech-candidates-inspection.done");
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        await readFile(marker);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    await readFile(marker);
  }

  const preview = page.getByRole("button", { name: /Preview filler · review/ });
  await expect(preview).toBeEnabled();
  await preview.click();
  await expect.poll(() => page.locator("#seek").inputValue()).toBe("820000");
  await expect(page.locator("#preview-message")).toBeHidden({ timeout: 30000 });
  await assertCanvasFrame(page, 1);
  const afterPreview = await page.evaluate(() => window.desktop.listProjects());
  assert.ok(afterPreview.ok);
  if (!afterPreview.ok)
    throw new Error("The project summary could not be read");
  assert.equal(afterPreview.value[0]!.draft.sequence, originalSequence);
  assert.equal(afterPreview.value[0]!.draft.timelineSha256, originalHash);
  assert.equal(sha256(await readFile(sourcePath)), sourceHash);
  assert.deepEqual(await readFile(baselinePath), baselineBytes);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({
      status: "pass",
      packagedNativeWindow: true,
      syntheticTranscriptIpcOnly: true,
      reviewCandidatesVisible: true,
      contextOnlyQuotedCueVisible: true,
      protectedWordsVisible: true,
      previewUsesCommittedDraftMap: true,
      draftSequenceUnchanged: true,
      baselineUnchanged: true,
      sourceUnchanged: true,
      noCandidateAppliedAsAnEdit: true,
    }),
  );
} finally {
  await electron?.close();
}

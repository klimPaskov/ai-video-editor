import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  FrameRenderError,
  renderDraftFrames,
} from "../../apps/desktop/src/frame-render.ts";
import { defaultCaptionSettings } from "../../packages/domain/src/captions.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { ProjectStore } from "../../packages/project-store/src/store.ts";
import { DraftTransactionStore } from "../../packages/project-store/src/transactions.ts";

const width = 320;
const height = 180;

async function fixture() {
  const base = resolve("test-results/frame-render");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "fixture-"));
  const source = join(root, "screen.mkv");
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${width}x${height}:rate=30:duration=1`,
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=mono",
      "-t",
      "1",
      "-c:v",
      "ffv1",
      "-pix_fmt",
      "bgra",
      "-c:a",
      "pcm_s16le",
      source,
    ],
  });
  const library = new MediaLibrary(join(root, "library"));
  const media = await library.importFile(source);
  const projects = new ProjectStore(join(root, "projects"), library);
  const active = await projects.createFromMedia(media.id);
  const drafts = new DraftTransactionStore(join(root, "projects"), projects);
  return { root, source, active, drafts };
}

/** Decodes a JPEG to packed RGB24 for pixel comparisons. */
async function decode(root: string, base64: string, name: string) {
  const path = join(root, `${name}.jpg`);
  await writeFile(path, Buffer.from(base64, "base64"));
  return (
    await runProcess({
      executable: "ffmpeg",
      args: [
        "-v",
        "error",
        "-nostdin",
        "-i",
        path,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      maxOutputBytes: 64 * 1024 * 1024,
    })
  ).stdout;
}

function meanDifference(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length);
  let total = 0;
  for (let index = 0; index < a.length; index++)
    total += Math.abs(a[index]! - b[index]!);
  return total / a.length;
}

test(
  "draft frames render through the export compositor with zooms and captions",
  { timeout: 300_000 },
  async () => {
    const { root, active, drafts } = await fixture();
    const projectId = active.project.project_id;
    try {
      const noCaptions = async () => null;
      const [plain] = await renderDraftFrames({
        drafts,
        projectId,
        timesUs: [500_000],
        maxWidth: 960,
        captions: noCaptions,
      });
      assert.equal(plain!.width, width);
      assert.equal(plain!.height, height);
      assert.equal(plain!.mimeType, "image/jpeg");
      assert.equal(plain!.timeUs, 500_000);
      // The unzoomed picture is the source frame, within JPEG error.
      const sourceFrame = (
        await runProcess({
          executable: "ffmpeg",
          args: [
            "-v",
            "error",
            "-nostdin",
            "-ss",
            "0.5",
            "-i",
            active.source.managed_path,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          maxOutputBytes: 16 * 1024 * 1024,
        })
      ).stdout;
      const plainPixels = await decode(root, plain!.dataBase64, "plain");
      assert.ok(meanDifference(plainPixels, sourceFrame) < 6);

      const snapshot = await drafts.snapshot(projectId);
      await drafts.applyManual({
        schema_version: "1.0",
        request_id: "frames-zoom-001",
        project_id: projectId,
        draft_id: snapshot.draft.draft_id,
        base_revision_id: snapshot.draft.base_revision_id,
        expected_sequence: snapshot.draft.draft_sequence,
        expected_timeline_sha256: snapshot.draft.timeline_sha256,
        pass_group: { pass_group_id: "frames-zoom", kind: "zoom" },
        reason: "Zoom on the corner.",
        operations: [
          {
            type: "set_zoom",
            zoom: {
              zoom_id: "zoom-frames-001",
              source_id: active.source.source_id,
              source_start_us: 0,
              source_end_us: 1_000_000,
              center_x: 0.25,
              center_y: 0.25,
              scale: 2,
            },
          },
        ],
      });
      const captioned = async () => ({
        cues: [
          {
            startUs: 400_000,
            endUs: 700_000,
            lines: ["Hello there"],
            lineWordCounts: [2],
            words: [
              { text: "Hello", startUs: 400_000, endUs: 550_000 },
              { text: "there", startUs: 550_000, endUs: 700_000 },
            ],
          },
        ],
        settings: {
          ...defaultCaptionSettings,
          enabled: true,
          size: "large" as const,
        },
      });
      const [zoomed, withCaption] = await renderDraftFrames({
        drafts,
        projectId,
        timesUs: [200_000, 500_000],
        maxWidth: 320,
        captions: captioned,
      });
      const [zoomedNoCaption] = await renderDraftFrames({
        drafts,
        projectId,
        timesUs: [500_000],
        maxWidth: 320,
        captions: noCaptions,
      });
      // The zoom changes the whole picture; the caption changes it again.
      assert.ok(
        meanDifference(
          await decode(root, zoomedNoCaption!.dataBase64, "z"),
          plainPixels,
        ) > 10,
      );
      const captionPixels = await decode(root, withCaption!.dataBase64, "c");
      const zoomOnly = await decode(root, zoomedNoCaption!.dataBase64, "z2");
      assert.ok(meanDifference(captionPixels, zoomOnly) > 0.5);
      assert.equal(zoomed!.timeUs, 200_000);

      const [small] = await renderDraftFrames({
        drafts,
        projectId,
        timesUs: [0],
        maxWidth: 160,
        captions: noCaptions,
      });
      assert.deepEqual([small!.width, small!.height], [160, 90]);

      await assert.rejects(
        renderDraftFrames({
          drafts,
          projectId,
          timesUs: [1_000_000],
          maxWidth: 320,
          captions: noCaptions,
        }),
        FrameRenderError,
      );
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  },
);

test(
  "several pictures with graphics each get their own graphics track",
  { timeout: 300_000 },
  async () => {
    const { root, active, drafts } = await fixture();
    const projectId = active.project.project_id;
    try {
      const snapshot = await drafts.snapshot(projectId);
      await drafts.applyManual({
        schema_version: "1.0",
        request_id: "frames-graphic-001",
        project_id: projectId,
        draft_id: snapshot.draft.draft_id,
        base_revision_id: snapshot.draft.base_revision_id,
        expected_sequence: snapshot.draft.draft_sequence,
        expected_timeline_sha256: snapshot.draft.timeline_sha256,
        pass_group: { pass_group_id: "frames-graphics", kind: "graphics" },
        reason: "Add a title.",
        operations: [
          {
            type: "set_graphic",
            graphic: {
              graphic_id: "graphic-frames-001",
              name: "Title",
              source_id: active.source.source_id,
              source_us: 0,
              duration_us: 900_000,
              layer: 0,
              html: "<div>Title</div>",
              css: "div { color: white }",
            },
          },
        ],
      });
      const directories: string[] = [];
      // Like the app's offscreen renderer: a fixed file name in the given folder.
      const renderGraphics = async (request: {
        directory: string;
        width: number;
        height: number;
        frameCount: number;
      }) => {
        directories.push(request.directory);
        const path = join(request.directory, "graphics-000.mkv");
        await runProcess({
          executable: "ffmpeg",
          args: [
            "-v",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            `color=c=red:s=${request.width}x${request.height}:r=30,format=bgra`,
            "-frames:v",
            String(request.frameCount),
            "-c:v",
            "ffv1",
            "-pix_fmt",
            "bgra",
            path,
          ],
        });
        return {
          segments: [{ startFrame: 0, frameCount: request.frameCount, path }],
        };
      };
      const frames = await renderDraftFrames({
        drafts,
        projectId,
        timesUs: [200_000, 600_000],
        maxWidth: 320,
        captions: async () => null,
        renderGraphics: renderGraphics as never,
      });
      assert.equal(frames.length, 2);
      assert.equal(new Set(directories).size, 2);
      // The opaque red graphic covers each picture.
      const pixels = await decode(root, frames[1]!.dataBase64, "graphic");
      assert.ok(pixels[0]! > 200 && pixels[1]! < 60 && pixels[2]! < 60);
    } finally {
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  },
);

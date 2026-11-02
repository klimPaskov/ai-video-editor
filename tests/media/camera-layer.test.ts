import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  layoutIntervals,
  type LayoutChange,
} from "../../packages/domain/src/layouts.ts";
import {
  cameraPieceGraph,
  renderCameraTrack,
} from "../../packages/media-engine/src/camera-layer.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

const canvas = { width: 320, height: 180 };
const frameRate = { numerator: 10, denominator: 1 };

async function ffmpeg(args: string[]): Promise<Buffer> {
  return (
    await runProcess({
      executable: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024 * 1024,
    })
  ).stdout;
}

/** The BGRA frame `index` of a segment, as raw bytes. */
async function frameOf(path: string, index: number): Promise<Buffer> {
  return ffmpeg([
    "-i",
    path,
    "-vf",
    `select=eq(n\\,${index})`,
    "-vsync",
    "0",
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgba",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
}

function pixel(frame: Buffer, x: number, y: number) {
  const offset = (y * canvas.width + x) * 4;
  return [...frame.subarray(offset, offset + 4)] as [
    number,
    number,
    number,
    number,
  ];
}

const change = (
  id: string,
  sourceUs: number,
  extra: Partial<LayoutChange> & { kind: LayoutChange["kind"] },
): LayoutChange => ({
  layout_id: id,
  source_id: "source-a",
  source_us: sourceUs,
  ...extra,
});

test("graphs for every change between arrangements are valid filter graphs", async () => {
  const layout = {
    canvas,
    geometry: { canvasAspect: 16 / 9, cameraAspect: 16 / 9 },
  };
  const states = {
    pip: {
      kind: "pip" as const,
      corner: "bottom_right" as const,
      size: 0.25,
      shape: "circle" as const,
      faceZoom: 1.5,
      focusX: 0.5,
      focusY: 0.4,
    },
    pip2: {
      kind: "pip" as const,
      corner: "top_left" as const,
      size: 0.25,
      shape: "circle" as const,
      faceZoom: 1.5,
      focusX: 0.5,
      focusY: 0.4,
    },
    camera: {
      kind: "camera" as const,
      corner: "bottom_right" as const,
      size: 0.24,
      shape: "rounded" as const,
      faceZoom: 1,
      focusX: 0.5,
      focusY: 0.5,
    },
    screen: {
      kind: "screen" as const,
      corner: "bottom_right" as const,
      size: 0.24,
      shape: "rounded" as const,
      faceZoom: 1,
      focusX: 0.5,
      focusY: 0.5,
    },
  };
  const pairs: Array<[keyof typeof states, keyof typeof states]> = [
    ["screen", "pip"],
    ["pip", "screen"],
    ["screen", "camera"],
    ["camera", "screen"],
    ["pip", "pip2"],
    ["pip", "camera"],
    ["camera", "pip"],
  ];
  for (const [from, to] of pairs) {
    const graph = cameraPieceGraph(
      {
        kind: "change",
        startUs: 0,
        endUs: 1_000_000,
        from: states[from],
        to: states[to],
      },
      layout,
      frameRate,
    );
    // The graph must run: feed it a short generated camera.
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=10:duration=1.5",
      "-filter_complex",
      `[0:v]setpts=PTS[cam];${graph}`,
      "-map",
      "[out]",
      "-frames:v",
      "10",
      "-f",
      "null",
      "-",
    ]);
  }
});

test("a camera in a corner is drawn over a transparent picture, in its shape, across cuts", async () => {
  const folder = await mkdtemp(join(tmpdir(), "camera-layer-"));
  try {
    const cameraPath = join(folder, "camera.mkv");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=0xe0402a:s=640x360:r=25:d=8",
      "-c:v",
      "ffv1",
      cameraPath,
    ]);
    // 40 output frames at 10 fps: source frames 0-19, then 60-79 (a cut).
    const clips = [
      { firstFrame: 0, outputFrames: 20, speed: 1 },
      { firstFrame: 60, outputFrames: 20, speed: 1 },
    ];
    // Pip from 1.0 s (frame 10) to the end, fully there at once; the second
    // clip's source is recording time 6 s to 8 s.
    const intervals = layoutIntervals(
      [
        change("layout-1", 1_000_000, {
          kind: "pip",
          corner: "bottom_right",
          size: 0.25,
          shape: "circle",
          move_us: 0,
        }),
      ],
      [
        {
          sourceId: "source-a",
          sourceStartUs: 0,
          sourceEndUs: 2_000_000,
          timelineStartUs: 0,
          timelineEndUs: 2_000_000,
        },
        {
          sourceId: "source-a",
          sourceStartUs: 6_000_000,
          sourceEndUs: 8_000_000,
          timelineStartUs: 2_000_000,
          timelineEndUs: 4_000_000,
        },
      ],
    );
    const track = await renderCameraTrack({
      ffmpeg: "ffmpeg",
      directory: folder,
      camera: { path: cameraPath, width: 640, height: 360, offsetUs: 0 },
      canvas,
      frameRate,
      clips,
      frameCount: 40,
      intervals,
    });
    assert.equal(track.segments.length, 1);
    assert.deepEqual(
      [track.segments[0]!.startFrame, track.segments[0]!.frameCount],
      [10, 30],
    );
    // Frames before and after the cut: transparent outside the circle,
    // camera colour inside it. 0.25 of 320 is 80 px wide, a circle 80x80.
    for (const index of [0, 12, 29]) {
      const frame = await frameOf(track.segments[0]!.path, index);
      assert.deepEqual(pixel(frame, 10, 10), [0, 0, 0, 0], `outside, ${index}`);
      // The circle's bounding box: right 0.97, bottom margin 0.03*aspect.
      const left = Math.round(0.72 * canvas.width);
      const top = Math.round(canvas.height - 0.03 * canvas.width - 80);
      const centre = pixel(frame, left + 40, top + 40);
      assert.ok(
        centre[0] > 190 && centre[1] < 100 && centre[3] === 255,
        `centre ${centre}`,
      );
      // A corner of the bounding box lies outside the circle.
      assert.equal(
        pixel(frame, left + 1, top + 1)[3],
        0,
        "box corner is clear",
      );
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a camera that fades in is transparent at first and opaque at the end", async () => {
  const folder = await mkdtemp(join(tmpdir(), "camera-layer-"));
  try {
    const cameraPath = join(folder, "camera.mkv");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "color=c=0x2a80e0:s=640x360:r=25:d=6",
      "-c:v",
      "ffv1",
      cameraPath,
    ]);
    const intervals = layoutIntervals(
      [change("layout-1", 0, { kind: "camera", move_us: 2_000_000 })],
      [
        {
          sourceId: "source-a",
          sourceStartUs: 0,
          sourceEndUs: 4_000_000,
          timelineStartUs: 0,
          timelineEndUs: 4_000_000,
        },
      ],
    );
    const track = await renderCameraTrack({
      ffmpeg: "ffmpeg",
      directory: folder,
      camera: { path: cameraPath, width: 640, height: 360, offsetUs: 0 },
      canvas,
      frameRate,
      clips: [{ firstFrame: 0, outputFrames: 40, speed: 1 }],
      frameCount: 40,
      intervals,
    });
    // A dissolve (20 frames) then a steady full camera (20 frames).
    assert.deepEqual(
      track.segments.map((segment) => [segment.startFrame, segment.frameCount]),
      [
        [0, 20],
        [20, 20],
      ],
    );
    const first = pixel(await frameOf(track.segments[0]!.path, 1), 100, 90);
    const late = pixel(await frameOf(track.segments[0]!.path, 18), 100, 90);
    const steady = pixel(await frameOf(track.segments[1]!.path, 5), 100, 90);
    assert.ok(first[3] < 40, `starts clear: ${first}`);
    assert.ok(late[3] > 200, `ends almost opaque: ${late}`);
    assert.equal(steady[3], 255);
    assert.ok(steady[2] > 190 && steady[0] < 90, `camera colour ${steady}`);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import {
  assertZoomEffects,
  zoomAt,
  zoomFilter,
  zoomIntervals,
  zoomWindow,
  type ZoomEffect,
} from "../../packages/domain/src/zoom.ts";

const zoom: ZoomEffect = {
  zoom_id: "zoom-1",
  source_id: "source-a",
  source_start_us: 1_000_000,
  source_end_us: 3_000_000,
  center_x: 0.75,
  center_y: 0.25,
  scale: 2,
};
const sources = [
  { source_id: "source-a", source_start_us: 0, source_end_us: 10_000_000 },
];

test("zooms are validated against sources and never overlap", () => {
  assertZoomEffects([zoom], sources);
  for (const bad of [
    [{ ...zoom, scale: 5 }],
    [{ ...zoom, center_x: 1.2 }],
    [{ ...zoom, source_end_us: 1_200_000 }],
    [{ ...zoom, source_id: "other" }],
    [{ ...zoom, source_end_us: 11_000_000 }],
    [
      zoom,
      {
        ...zoom,
        zoom_id: "zoom-2",
        source_start_us: 2_000_000,
        source_end_us: 4_000_000,
      },
    ],
    [zoom, { ...zoom }],
  ])
    assert.throws(() => assertZoomEffects(bad, sources));
});

test("zooms follow cuts and ease only at their real edges", () => {
  // The middle second of the zoom's source range is cut out.
  const clips = [
    {
      sourceId: "source-a",
      timelineStartUs: 0,
      timelineEndUs: 2_000_000,
      sourceStartUs: 0,
      sourceEndUs: 2_000_000,
    },
    {
      sourceId: "source-a",
      timelineStartUs: 2_000_000,
      timelineEndUs: 9_000_000,
      sourceStartUs: 3_000_000 - 500_000,
      sourceEndUs: 9_500_000,
    },
  ];
  const pieces = zoomIntervals([zoom], clips);
  assert.deepEqual(
    pieces.map((piece) => [
      piece.startUs,
      piece.endUs,
      piece.easeIn,
      piece.easeOut,
    ]),
    [
      [1_000_000, 2_000_000, true, false],
      [2_000_000, 2_500_000, false, true],
    ],
  );
  assert.equal(zoomAt(pieces, 900_000).scale, 1);
  assert.equal(zoomAt(pieces, 1_000_000).scale, 1);
  assert.ok(
    zoomAt(pieces, 1_100_000).scale > 1 && zoomAt(pieces, 1_100_000).scale < 2,
  );
  assert.equal(zoomAt(pieces, 1_800_000).scale, 2);
  // Across the cut the zoom holds instead of easing out and in again.
  assert.equal(zoomAt(pieces, 2_000_000).scale, 2);
  assert.ok(zoomAt(pieces, 2_450_000).scale < 2);
  assert.equal(zoomAt(pieces, 2_500_000).scale, 1);
  assert.deepEqual(zoomWindow(2, 0.9, 0.1), { x: 0.5, y: 0, size: 0.5 });
});

test(
  "the export filter changes only frames inside a zoom",
  { timeout: 60_000 },
  async () => {
    const width = 160,
      height = 90,
      rate = 10;
    const source = (
      await runProcess({
        executable: "ffmpeg",
        args: [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=${width}x${height}:rate=${rate}:duration=4`,
          "-pix_fmt",
          "bgra",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        maxOutputBytes: 64 * 1024 * 1024,
      })
    ).stdout;
    const clips = [
      {
        sourceId: "source-a",
        timelineStartUs: 0,
        timelineEndUs: 4_000_000,
        sourceStartUs: 0,
        sourceEndUs: 4_000_000,
      },
    ];
    const filter = zoomFilter(zoomIntervals([zoom], clips), width, height)!;
    assert.equal(zoomFilter([], width, height), null);
    const { spawn } = await import("node:child_process");
    const output = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("ffmpeg", [
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pixel_format",
        "bgra",
        "-video_size",
        `${width}x${height}`,
        "-framerate",
        String(rate),
        "-i",
        "pipe:0",
        "-vf",
        filter,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "pipe:1",
      ]);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.resume();
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? resolve(Buffer.concat(chunks))
          : reject(new Error(`ffmpeg ${code}`)),
      );
      child.stdin.end(source);
    });
    assert.equal(output.length, source.length);
    const frameBytes = width * height * 4;
    const changed: number[] = [];
    for (let frame = 0; frame < 40; frame++) {
      const range = [frame * frameBytes, (frame + 1) * frameBytes] as const;
      if (!output.subarray(...range).equals(source.subarray(...range)))
        changed.push(frame);
    }
    // Frame 10 is the zoom's first frame at scale exactly 1; 11..29 change.
    assert.deepEqual(
      changed,
      Array.from({ length: 19 }, (_, index) => index + 11),
    );
  },
);

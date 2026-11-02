import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCaptionCues,
  defaultCaptionSettings,
  toAss,
} from "../../packages/domain/src/captions.ts";
import {
  reframeFilter,
  shortSize,
  type ShortFraming,
} from "../../packages/domain/src/short-clips.ts";
import { EngineError } from "../../packages/media-engine/src/engine-client.ts";
import { probePresentationTiming } from "../../packages/media-engine/src/presentation-timing.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import {
  exportDraft,
  planExport,
  type ExportSource,
} from "../../packages/media-engine/src/render.ts";
import {
  engineLimit,
  renderShortWithEngine,
  shortEngineParams,
} from "../../packages/media-engine/src/short-engine.ts";

/**
 * Parity between the Rust engine and the verified TypeScript pipeline on the
 * same synthetic clips. They need the engine binary: set URUSHI_ENGINE to its
 * path (built with `cargo build --release` in engine/).
 */
const engine = process.env.URUSHI_ENGINE;
const needsEngine = engine ? {} : { skip: "URUSHI_ENGINE is not set" };

async function ffmpeg(args: string[]) {
  return runProcess({
    executable: "ffmpeg",
    args: ["-hide_banner", "-nostdin", ...args],
    timeoutMs: 120_000,
    maxOutputBytes: 64 * 1024 * 1024,
  });
}

async function source(
  directory: string,
  name: string,
  args: string[],
): Promise<ExportSource> {
  const path = join(directory, name);
  await ffmpeg(["-loglevel", "error", ...args, path]);
  const probe = JSON.parse(
    (
      await runProcess({
        executable: "ffprobe",
        args: [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          path,
        ],
      })
    ).stdout.toString(),
  ) as Record<string, unknown>;
  const video = (probe.streams as Record<string, unknown>[]).find(
    (stream) => stream.codec_type === "video",
  )!;
  return {
    sourceId: name.replace(/\W/gu, "-"),
    path,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
    probe,
    timing: await probePresentationTiming("ffprobe", path, video),
  };
}

const h264 = (seconds: number) => [
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
  "-c:v",
  "libx264",
  "-preset",
  "ultrafast",
  "-g",
  "45",
  "-bf",
  "2",
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
];

const ffv1 = (seconds: number) => [
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=330:sample_rate=48000:duration=${seconds}`,
  "-c:v",
  "ffv1",
  "-level",
  "3",
  "-g",
  "1",
  "-pix_fmt",
  "bgr0",
  "-color_range",
  "pc",
  "-colorspace",
  "rgb",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "iec61966-2-1",
  "-c:a",
  "pcm_s16le",
  "-shortest",
];

async function psnr(a: string, b: string): Promise<number> {
  const { stderr } = await ffmpeg([
    "-i",
    a,
    "-i",
    b,
    "-lavfi",
    "[0:v][1:v]psnr",
    "-f",
    "null",
    "-",
  ]);
  const match = /average:([\d.]+|inf)/u.exec(stderr.toString());
  assert.ok(match, stderr.toString());
  return match[1] === "inf" ? 100 : Number(match[1]);
}

async function describe(file: string) {
  const probe = JSON.parse(
    (
      await runProcess({
        executable: "ffprobe",
        args: [
          "-v",
          "error",
          "-count_packets",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          file,
        ],
      })
    ).stdout.toString(),
  ) as { streams: Record<string, unknown>[]; format: { duration: string } };
  const video = probe.streams.find((s) => s.codec_type === "video")!;
  const audio = probe.streams.find((s) => s.codec_type === "audio");
  return {
    width: video.width,
    height: video.height,
    frames: Number(video.nb_read_packets),
    audioSeconds: audio ? Number(audio.duration) : null,
    seconds: Number(probe.format.duration),
  };
}

const colour = {
  range: "tv",
  space: "bt709",
  primaries: "bt709",
  transfer: "bt709",
};

async function both(
  directory: string,
  input: ExportSource,
  framing: ShortFraming,
  captions: boolean,
) {
  const plan = planExport(
    [
      {
        sourceId: input.sourceId,
        sourceStartUs: 1_000_000,
        sourceEndUs: 4_000_000,
      },
    ],
    [input],
  );
  const { width, height } = shortSize("vertical");
  const ass = captions
    ? toAss(
        buildCaptionCues([
          { text: "Short", startUs: 200_000, endUs: 900_000 },
          { text: "clip", startUs: 900_000, endUs: 1_800_000 },
        ]),
        { ...defaultCaptionSettings, enabled: true },
        width,
        height,
        { marginFraction: 0.2 },
      )
    : undefined;
  const after = reframeFilter("vertical", framing, 0.5);
  const reference = join(directory, `ts-${framing}-${input.sourceId}.mp4`);
  await exportDraft({
    plan,
    profile: "smaller_mp4",
    outputPath: reference,
    replace: true,
    compose: {
      filter: "",
      after,
      ...(ass ? { ass } : {}),
      width,
      height,
      pixelFormat: "yuv420p",
      color: colour,
    },
  });
  const made = join(directory, `rs-${framing}-${input.sourceId}.mp4`);
  const report = await renderShortWithEngine({
    engine: engine!,
    plan,
    outputPath: made,
    width,
    height,
    zoomFilter: "",
    graphics: [],
    reframeFilter: after,
    fill: framing === "fill",
    position: 0.5,
    ...(ass ? { ass } : {}),
    faceModel: null,
    ffmpeg: "ffmpeg",
    ffprobe: "ffprobe",
  });
  return { plan, reference, made, report };
}

const rgbArgs = ffv1(6);
for (const [label, args] of [
  ["H.264 4:2:0", h264(6)],
  ["lossless RGB (FFV1 bgr0, like a screen recording)", rgbArgs],
] as const)
  for (const framing of ["fit", "fill"] as const)
    test(
      `engine and TypeScript pipeline agree: ${label}, ${framing}, burned captions`,
      { timeout: 240_000, ...needsEngine },
      async () => {
        const directory = await mkdtemp(join(tmpdir(), "short-engine-"));
        try {
          const input = await source(directory, "input.mkv", args as string[]);
          const { plan, reference, made, report } = await both(
            directory,
            input,
            framing,
            true,
          );
          const a = await describe(reference);
          const b = await describe(made);
          assert.equal(b.frames, plan.frameCount);
          assert.equal(b.frames, a.frames);
          assert.deepEqual([b.width, b.height], [1080, 1920]);
          assert.ok(
            Math.abs(a.seconds - b.seconds) < 0.06,
            `${a.seconds} vs ${b.seconds}`,
          );
          assert.ok(
            Math.abs((a.audioSeconds ?? 0) - (b.audioSeconds ?? 0)) < 0.06,
            `${a.audioSeconds} vs ${b.audioSeconds}`,
          );
          assert.equal(report.framing, "fixed");
          assert.equal(report.attempts, 1);
          // Same picture within lossy-encoding differences. The one known
          // difference: for RGB sources the engine converts to 4:2:0 before
          // the blurred backdrop is darkened, so the backdrop's brightness
          // shifts slightly (the foreground is identical).
          const score = await psnr(reference, made);
          const floor = args === rgbArgs && framing === "fit" ? 24 : 34;
          assert.ok(score > floor, `PSNR ${score} dB`);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );

test(
  "the engine joins ranges and speeds one up like the TypeScript pipeline",
  { timeout: 240_000, ...needsEngine },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "short-engine-join-"));
    try {
      const input = await source(directory, "input.mkv", h264(10));
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 1_000_000,
            sourceEndUs: 3_000_000,
          },
          {
            sourceId: input.sourceId,
            sourceStartUs: 5_000_000,
            sourceEndUs: 8_000_000,
            speed: 3,
          },
        ],
        [input],
      );
      const { width, height } = shortSize("vertical");
      const after = reframeFilter("vertical", "fit", 0.5);
      const reference = join(directory, "ts.mp4");
      await exportDraft({
        plan,
        profile: "smaller_mp4",
        outputPath: reference,
        replace: true,
        compose: {
          filter: "",
          after,
          width,
          height,
          pixelFormat: "yuv420p",
          color: colour,
        },
      });
      const made = join(directory, "rs.mp4");
      await renderShortWithEngine({
        engine: engine!,
        plan,
        outputPath: made,
        width,
        height,
        zoomFilter: "",
        graphics: [],
        reframeFilter: after,
        fill: false,
        position: 0.5,
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
      });
      const a = await describe(reference);
      const b = await describe(made);
      assert.equal(b.frames, plan.frameCount);
      assert.equal(b.frames, a.frames);
      assert.ok(Math.abs(a.seconds - b.seconds) < 0.06);
      assert.ok((await psnr(reference, made)) > 34);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a cancelled engine render leaves no clip and no partial file",
  { timeout: 120_000, ...needsEngine },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "short-engine-cancel-"));
    try {
      const input = await source(directory, "input.mkv", h264(40));
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 0,
            sourceEndUs: 38_000_000,
          },
        ],
        [input],
      );
      const { width, height } = shortSize("vertical");
      const controller = new AbortController();
      const output = join(directory, "slow.mp4");
      const started = Date.now();
      setTimeout(() => controller.abort(), 1500);
      await assert.rejects(
        renderShortWithEngine({
          engine: engine!,
          plan,
          outputPath: output,
          width,
          height,
          zoomFilter: "",
          graphics: [],
          reframeFilter:
            "scale=2160:3840,gblur=sigma=40,scale=1080:1920,setsar=1",
          fill: false,
          position: 0.5,
          ffmpeg: "ffmpeg",
          ffprobe: "ffprobe",
          signal: controller.signal,
        }),
        (error: unknown) =>
          error instanceof EngineError && error.code === "CANCELLED",
      );
      assert.ok(Date.now() - started < 20_000);
      const names = await readdir(directory);
      assert.ok(!names.includes("slow.mp4"));
      assert.deepEqual(
        names.filter((name) => name.includes(".partial")),
        [],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("the request carries the plan and routes audio cleanup to the TypeScript pipeline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "short-engine-params-"));
  try {
    const input = await source(directory, "input.mkv", h264(4));
    const plan = planExport(
      [
        {
          sourceId: input.sourceId,
          sourceStartUs: 500_000,
          sourceEndUs: 2_500_000,
          speed: 2,
        },
      ],
      [input],
    );
    const params = shortEngineParams({
      engine: "engine",
      plan,
      outputPath: join(directory, "out.mp4"),
      width: 1080,
      height: 1920,
      zoomFilter: "",
      graphics: [{ path: "g.mkv", startFrame: 12 }],
      reframeFilter: "scale=1080:1920",
      fill: true,
      position: 0.5,
      faceModel: "model.onnx",
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
    }) as Record<string, unknown>;
    assert.equal(params.total_frames, plan.frameCount);
    assert.equal(params.zoom_filter, null);
    assert.equal(params.encoder, "software");
    assert.deepEqual(params.graphics, [{ path: "g.mkv", start_frame: 12 }]);
    const clip = (params.clips as Record<string, unknown>[])[0]!;
    assert.equal(clip.speed, 2);
    assert.equal(clip.output_frames, plan.clips[0]!.outputFrames);
    assert.equal(engineLimit({ audioCleanup: true }), "audio cleanup");
    assert.equal(engineLimit({ audioCleanup: false }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

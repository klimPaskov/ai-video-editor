import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { probePresentationTiming } from "../../packages/media-engine/src/presentation-timing.ts";
import {
  exportDraft,
  planExport,
  rawFrameBytes,
  type ExportClip,
  type ExportSource,
} from "../../packages/media-engine/src/render.ts";

const sha = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

async function ffmpeg(args: string[]): Promise<Buffer> {
  return (
    await runProcess({
      executable: "ffmpeg",
      args: ["-hide_banner", "-loglevel", "error", "-nostdin", ...args],
      timeoutMs: 120_000,
      maxOutputBytes: 512 * 1024 * 1024,
    })
  ).stdout;
}

async function source(
  directory: string,
  name: string,
  args: string[],
): Promise<ExportSource> {
  const path = join(directory, name);
  await ffmpeg([...args, path]);
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
    sha256: sha(await readFile(path)),
    probe,
    timing: await probePresentationTiming("ffprobe", path, video),
  };
}

/** Independent canonical: full decode without seeking, sliced by index. */
async function fullDecode(
  input: ExportSource,
  pixelFormat: string,
  audioRaw: string | null,
) {
  const video = await ffmpeg([
    "-i",
    input.path,
    "-map",
    "0:v:0",
    "-fps_mode",
    "passthrough",
    "-c:v",
    "rawvideo",
    "-pix_fmt",
    pixelFormat,
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  const audio = audioRaw
    ? await ffmpeg([
        "-i",
        input.path,
        "-map",
        "0:a:0",
        "-c:a",
        `pcm_${audioRaw}`,
        "-f",
        audioRaw,
        "pipe:1",
      ])
    : null;
  return { video, audio };
}

const h264Args = (seconds: number, frequency: number) => [
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=160x90:rate=30:duration=${seconds}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=${frequency}:sample_rate=48000:duration=${seconds}`,
  "-c:v",
  "libx264",
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
  "-ac",
  "2",
  "-shortest",
];

test(
  "lossless master of a cut, reordered two-source draft equals an independent decode",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-render-"));
    try {
      const first = await source(directory, "first.mp4", h264Args(4, 440));
      const second = await source(directory, "second.mp4", h264Args(3, 660));
      const clips: ExportClip[] = [
        // Not frame-aligned on purpose: 0.51 s and 2.0 s.
        {
          sourceId: first.sourceId,
          sourceStartUs: 510_000,
          sourceEndUs: 2_000_000,
        },
        {
          sourceId: second.sourceId,
          sourceStartUs: 1_000_000,
          sourceEndUs: 2_500_000,
        },
        // Earlier part of the first source after a later one.
        {
          sourceId: first.sourceId,
          sourceStartUs: 100_000,
          sourceEndUs: 400_000,
        },
        // Far enough in that video decoding starts from a seek point.
        {
          sourceId: first.sourceId,
          sourceStartUs: 3_000_000,
          sourceEndUs: 3_900_000,
        },
      ];
      const plan = planExport(clips, [first, second]);
      assert.equal(plan.format.video.pixelFormat, "yuv420p");
      assert.deepEqual(plan.format.video.frameRate, {
        numerator: 30,
        denominator: 1,
      });
      assert.equal(plan.format.audio?.raw, "f32le");
      assert.deepEqual(
        plan.clips.map((clip) => [clip.firstFrame, clip.frameCount]),
        [
          [16, 44], // 0.5333 s .. 1.9667 s
          [30, 45],
          [3, 9],
          [90, 27],
        ],
      );
      // Audio covers exactly the kept frames: 1600 samples per frame.
      assert.deepEqual(
        plan.clips.map((clip) => [clip.firstSample, clip.sampleCount]),
        [
          [16 * 1600, 44 * 1600],
          [30 * 1600, 45 * 1600],
          [3 * 1600, 9 * 1600],
          [90 * 1600, 27 * 1600],
        ],
      );
      const frameBytes = rawFrameBytes("yuv420p", 160, 90);
      const decoded = new Map([
        [first.sourceId, await fullDecode(first, "yuv420p", "f32le")],
        [second.sourceId, await fullDecode(second, "yuv420p", "f32le")],
      ]);
      const expectedVideo = createHash("sha256");
      const expectedAudio = createHash("sha256");
      for (const clip of plan.clips) {
        const full = decoded.get(clip.sourceId)!;
        expectedVideo.update(
          full.video.subarray(
            clip.firstFrame * frameBytes,
            (clip.firstFrame + clip.frameCount) * frameBytes,
          ),
        );
        const bytes = 8; // f32le stereo
        const slice = full.audio!.subarray(
          clip.firstSample * bytes,
          (clip.firstSample + clip.sampleCount) * bytes,
        );
        expectedAudio.update(slice);
        if (slice.length < clip.sampleCount * bytes)
          expectedAudio.update(
            Buffer.alloc(clip.sampleCount * bytes - slice.length),
          );
      }
      const output = join(directory, "draft master.mkv");
      const fractions: number[] = [];
      const evidence = await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: output,
        replace: false,
        onProgress: (value) => fractions.push(value.fraction),
      });
      assert.equal(evidence.canonicalVideoSha256, expectedVideo.digest("hex"));
      assert.equal(evidence.canonicalAudioSha256, expectedAudio.digest("hex"));
      assert.equal(evidence.samplesEqual, true);
      assert.equal(evidence.decodedVideoSha256, evidence.canonicalVideoSha256);
      assert.equal(evidence.decodedAudioSha256, evidence.canonicalAudioSha256);
      assert.equal(evidence.frameCount, 125);
      assert.equal(evidence.audioSampleCount, 125 * 1600);
      assert.equal(evidence.durationUs, Math.floor((125 * 1_000_000) / 30));
      assert.equal(evidence.videoCodec, "ffv1");
      assert.equal(evidence.audioCodec, "pcm_f32le");
      assert.equal(evidence.outputSha256, sha(await readFile(output)));
      assert.ok(fractions.length > 0 && fractions.at(-1)! === 1);
      assert.ok(
        fractions.every(
          (value, index) => index === 0 || value >= fractions[index - 1]!,
        ),
      );
      // Colour tags survive; sources are untouched; no staging is left behind.
      const probe = JSON.parse(
        (
          await runProcess({
            executable: "ffprobe",
            args: ["-v", "error", "-show_streams", "-of", "json", output],
          })
        ).stdout.toString(),
      ) as { streams: Record<string, unknown>[] };
      const outVideo = probe.streams.find(
        (stream) => stream.codec_type === "video",
      )!;
      assert.equal(outVideo.color_space, "bt709");
      assert.equal(outVideo.color_range, "tv");
      assert.equal(sha(await readFile(first.path)), first.sha256);
      assert.deepEqual(
        (await readdir(directory)).filter((name) => name.includes("partial")),
        [],
      );
      // Never overwrite an existing file unless replacement was confirmed.
      await assert.rejects(
        exportDraft({
          plan,
          profile: "lossless_master",
          outputPath: output,
          replace: false,
        }),
      );
      const replaced = await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: output,
        replace: true,
      });
      assert.equal(replaced.outputSha256, evidence.outputSha256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "smaller MP4 is a separate, decodable, explicitly lossy copy",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-mp4-"));
    try {
      const input = await source(directory, "input.mp4", h264Args(2, 440));
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 0,
            sourceEndUs: 1_500_000,
          },
        ],
        [input],
      );
      const output = join(directory, "share.mp4");
      const evidence = await exportDraft({
        plan,
        profile: "smaller_mp4",
        outputPath: output,
        replace: false,
      });
      assert.equal(evidence.container, "mp4");
      assert.equal(evidence.videoCodec, "h264");
      assert.equal(evidence.audioCodec, "aac");
      assert.equal(evidence.frameCount, 45);
      // The copy is compressed: its decode is not claimed equal to the render.
      assert.equal(evidence.samplesEqual, false);
      await assert.rejects(
        exportDraft({
          plan,
          profile: "smaller_mp4",
          outputPath: join(directory, "x.mkv"),
          replace: false,
        }),
        /extension/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "bgra FFV1 source with 16-bit PCM keeps exact samples and RGB tags",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-bgra-"));
    try {
      const input = await source(directory, "rgb.mkv", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=96x64:rate=2:duration=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=300:sample_rate=48000:duration=3",
        "-c:v",
        "ffv1",
        "-pix_fmt",
        "bgra",
        "-color_range",
        "pc",
        "-colorspace",
        "rgb",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-c:a",
        "pcm_s16le",
        "-ac",
        "1",
        "-shortest",
      ]);
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 500_000,
            sourceEndUs: 1_500_000,
          },
          {
            sourceId: input.sourceId,
            sourceStartUs: 2_000_000,
            sourceEndUs: 3_000_000,
          },
        ],
        [input],
      );
      assert.equal(plan.format.audio?.raw, "s16le");
      assert.deepEqual(
        plan.clips.map((clip) => [clip.firstFrame, clip.frameCount]),
        [
          [1, 2],
          [4, 2],
        ],
      );
      const full = await fullDecode(input, "bgra", "s16le");
      const frame = rawFrameBytes("bgra", 96, 64);
      const expected = Buffer.concat([
        full.video.subarray(frame, 3 * frame),
        full.video.subarray(4 * frame, 6 * frame),
      ]);
      const evidence = await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: join(directory, "out.mkv"),
        replace: false,
      });
      assert.equal(evidence.canonicalVideoSha256, sha(expected));
      assert.equal(evidence.audioCodec, "pcm_s16le");
      assert.equal(evidence.samplesEqual, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "mixed formats and variable frame rate are refused instead of converted",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-refuse-"));
    try {
      const a = await source(directory, "a.mp4", h264Args(1, 440));
      const b = await source(directory, "b.mp4", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=25:duration=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
      ]);
      assert.throws(
        () =>
          planExport(
            [
              { sourceId: a.sourceId, sourceStartUs: 0, sourceEndUs: 500_000 },
              { sourceId: b.sourceId, sourceStartUs: 0, sourceEndUs: 500_000 },
            ],
            [a, b],
          ),
        /different video or audio formats/u,
      );
      const vfrPath = join(directory, "vfr.mkv");
      const timestamps = join(directory, "ts.txt");
      await writeFile(
        timestamps,
        "# timecode format v2\n0\n40\n120\n140\n300\n",
      );
      await ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=64x64:rate=10:duration=0.5",
        "-c:v",
        "ffv1",
        "-pix_fmt",
        "yuv420p",
        "-enc_time_base",
        "1/1000",
        "-fps_mode",
        "vfr",
        "-vf",
        "setpts='N*N*0.02/TB'",
        vfrPath,
      ]);
      const vfr = await source(directory, "vfr-src.mkv", [
        "-i",
        vfrPath,
        "-c",
        "copy",
      ]);
      assert.throws(
        () =>
          planExport(
            [
              {
                sourceId: vfr.sourceId,
                sourceStartUs: 0,
                sourceEndUs: 100_000,
              },
            ],
            [vfr],
          ),
        /Variable frame rate/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "cancelling an export leaves no output or staging",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-cancel-"));
    try {
      const input = await source(directory, "long.mp4", h264Args(6, 440));
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 0,
            sourceEndUs: 6_000_000,
          },
        ],
        [input],
      );
      const controller = new AbortController();
      const output = join(directory, "cancelled.mkv");
      await assert.rejects(
        exportDraft({
          plan,
          profile: "lossless_master",
          outputPath: output,
          replace: false,
          signal: controller.signal,
          onProgress: () => controller.abort(),
        }),
        (error: Error & { code?: string }) => error.code === "CANCELLED",
      );
      assert.deepEqual((await readdir(directory)).sort(), ["long.mp4"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

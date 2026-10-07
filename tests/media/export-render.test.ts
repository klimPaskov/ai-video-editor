import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import {
  buildCaptionCues,
  defaultCaptionSettings,
  toAss,
} from "../../packages/domain/src/captions.ts";
import {
  reframeFilter,
  shortSize,
} from "../../packages/domain/src/short-clips.ts";
import {
  windowZoomIntervals,
  zoomFilter,
  zoomIntervals,
} from "../../packages/domain/src/zoom.ts";
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

test(
  "30 fps Matroska with millisecond timestamps exports exactly at its nominal rate",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-mkv30-"));
    try {
      const input = await source(directory, "screen.mkv", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=30:duration=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=500:sample_rate=48000:duration=3",
        "-c:v",
        "ffv1",
        "-pix_fmt",
        "bgr0",
        "-c:a",
        "pcm_s16le",
        "-shortest",
      ]);
      // The container rounds 1/30 s to 33/34 ms steps.
      assert.equal(input.timing.variableCadence, true);
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 1_010_000,
            sourceEndUs: 2_300_000,
          },
        ],
        [input],
      );
      assert.deepEqual(plan.format.video.frameRate, {
        numerator: 30,
        denominator: 1,
      });
      assert.deepEqual(
        plan.clips.map((clip) => [
          clip.firstFrame,
          clip.frameCount,
          clip.firstSample,
          clip.sampleCount,
        ]),
        [[31, 38, 31 * 1600, 38 * 1600]],
      );
      const full = await fullDecode(input, "bgr0", "s16le");
      const frame = rawFrameBytes("bgr0", 160, 90);
      const evidence = await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: join(directory, "out.mkv"),
        replace: false,
      });
      assert.equal(
        evidence.canonicalVideoSha256,
        sha(full.video.subarray(31 * frame, 69 * frame)),
      );
      assert.equal(
        evidence.canonicalAudioSha256,
        sha(full.audio!.subarray(31 * 1600 * 2, 69 * 1600 * 2)),
      );
      assert.equal(evidence.samplesEqual, true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

/** An FFV1 BGRA graphics segment: an opaque red box on transparency. */
async function redBoxTrack(path: string, frames: number): Promise<void> {
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    // drawbox leaves alpha at 0 on BGRA, so the box is overlaid instead.
    "color=c=black@0.0:s=160x90:r=30:d=1,format=bgra[bg];color=c=red:s=40x40:r=30:d=1,format=bgra[box];[bg][box]overlay=10:10:format=rgb",
    "-frames:v",
    String(frames),
    "-c:v",
    "ffv1",
    "-pix_fmt",
    "bgra",
    path,
  ]);
}

test(
  "burned-in captions change only the frames they cover and stay verified",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-captions-"));
    try {
      const input = await source(directory, "talk.mkv", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=30:duration=2",
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
      ]);
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 0,
            sourceEndUs: 2_000_000,
          },
        ],
        [input],
      );
      const cues = buildCaptionCues([
        { text: "Hello", startUs: 500_000, endUs: 800_000 },
        { text: "world.", startUs: 800_000, endUs: 1_000_000 },
      ]);
      const settings = {
        ...defaultCaptionSettings,
        enabled: true,
        burnIn: true,
      };
      const output = join(directory, "captioned master.mkv");
      const evidence = await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: output,
        replace: false,
        overlayAss: toAss(cues, settings, 160, 90),
      });
      assert.equal(evidence.samplesEqual, true);
      const frameBytes = rawFrameBytes("bgra", 160, 90);
      const original = (await fullDecode(input, "bgra", null)).video;
      const exported = await ffmpeg([
        "-i",
        output,
        "-c:v",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "-f",
        "rawvideo",
        "pipe:1",
      ]);
      assert.equal(exported.length, original.length);
      const changed: number[] = [];
      for (let frame = 0; frame < plan.frameCount; frame++) {
        const range = [frame * frameBytes, (frame + 1) * frameBytes] as const;
        if (!exported.subarray(...range).equals(original.subarray(...range)))
          changed.push(frame);
      }
      // The caption is on screen from 0.5 s until it leaves after its hold.
      const end = Math.ceil((cues[0]!.endUs * 30) / 1_000_000);
      assert.equal(changed[0], 15);
      assert.equal(changed.at(-1), end - 1);
      assert.equal(changed.length, end - 15);
      assert.ok(original.length > 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "zooms change only the frames they cover in a verified lossless master",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-zoom-"));
    try {
      const input = await source(directory, "screen.mkv", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=30:duration=3",
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
      ]);
      // Export output window [1 s, 3 s) of a draft whose zoom starts at
      // 0.8 s, so the window opens part-way through the zoom's ease-in.
      const zooms = windowZoomIntervals(
        zoomIntervals(
          [
            {
              zoom_id: "zoom-1",
              source_id: input.sourceId,
              source_start_us: 800_000,
              source_end_us: 2_000_000,
              center_x: 0.25,
              center_y: 0.5,
              scale: 2,
            },
          ],
          [
            {
              sourceId: input.sourceId,
              timelineStartUs: 0,
              timelineEndUs: 3_000_000,
              sourceStartUs: 0,
              sourceEndUs: 3_000_000,
            },
          ],
        ),
        1_000_000,
        3_000_000,
      );
      assert.equal(zooms[0]!.startUs, -200_000);
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 1_000_000,
            sourceEndUs: 3_000_000,
          },
        ],
        [input],
      );
      const output = join(directory, "zoomed master.mkv");
      const evidence = await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: output,
        replace: false,
        compose: {
          filter: zoomFilter(zooms, 160, 90)!,
          width: 160,
          height: 90,
          pixelFormat: "bgra",
        },
      });
      assert.equal(evidence.samplesEqual, true);
      const frameBytes = rawFrameBytes("bgra", 160, 90);
      const original = (await fullDecode(input, "bgra", null)).video.subarray(
        30 * frameBytes,
      );
      const exported = await ffmpeg([
        "-i",
        output,
        "-c:v",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "-f",
        "rawvideo",
        "pipe:1",
      ]);
      assert.equal(exported.length, original.length);
      const changed: number[] = [];
      for (let frame = 0; frame < plan.frameCount; frame++) {
        const range = [frame * frameBytes, (frame + 1) * frameBytes] as const;
        if (!exported.subarray(...range).equals(original.subarray(...range)))
          changed.push(frame);
      }
      // Source 1.0–2.0 s is zoomed (output frames 0–29); the rest is exact.
      assert.deepEqual(
        changed,
        Array.from({ length: 30 }, (_, index) => index),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a vertical short reframes with a blurred fill and burned captions",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-short-"));
    try {
      const input = await source(directory, "wide.mp4", h264Args(4, 440));
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 1_000_000,
            sourceEndUs: 3_000_000,
          },
        ],
        [input],
      );
      const { width, height } = shortSize("vertical");
      const cues = buildCaptionCues([
        { text: "Short", startUs: 0, endUs: 400_000 },
        { text: "clip.", startUs: 400_000, endUs: 900_000 },
      ]);
      const output = join(directory, "short.mp4");
      const evidence = await exportDraft({
        plan,
        profile: "smaller_mp4",
        outputPath: output,
        replace: false,
        compose: {
          filter: reframeFilter("vertical", "fit"),
          ass: toAss(
            cues,
            { ...defaultCaptionSettings, enabled: true },
            width,
            height,
            {
              marginFraction: 0.2,
            },
          ),
          width,
          height,
          pixelFormat: "yuv420p",
          color: {
            range: "tv",
            space: "bt709",
            primaries: "bt709",
            transfer: "bt709",
          },
        },
      });
      assert.equal(evidence.frameCount, 60);
      const probe = JSON.parse(
        (
          await runProcess({
            executable: "ffprobe",
            args: ["-v", "error", "-show_streams", "-of", "json", output],
          })
        ).stdout.toString(),
      ) as { streams: Record<string, unknown>[] };
      const video = probe.streams.find(
        (stream) => stream.codec_type === "video",
      )!;
      assert.equal(video.width, 1080);
      assert.equal(video.height, 1920);
      assert.equal(video.color_space, "bt709");
      const frame = await ffmpeg([
        "-i",
        output,
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ]);
      assert.equal(frame.length, 1080 * 1920 * 3);
      // The fitted 16:9 picture sits in the middle third; above it is the
      // blurred fill of the same picture, not black.
      const at = (x: number, y: number) => (y * 1080 + x) * 3;
      const top = frame.subarray(at(540, 300), at(540, 300) + 3);
      assert.ok(top[0]! + top[1]! + top[2]! > 30, `top ${[...top]}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "audio cleanup evens loudness and lowers noise without changing length",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-audio-"));
    try {
      // A quiet tone for 4 s, then 2 s of steady hiss alone.
      const input = await source(directory, "quiet.mkv", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=30:duration=6",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=300:sample_rate=48000:duration=6,volume=0.05,volume=enable='gte(t,4)':volume=0[tone];anoisesrc=d=6:c=pink:a=0.01:r=48000[noise];[tone][noise]amix=inputs=2:normalize=0",
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
      ]);
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
      const measure = async (file: string, from: number, to: number) => {
        const result = await runProcess({
          executable: "ffmpeg",
          args: [
            "-hide_banner",
            "-nostdin",
            "-ss",
            String(from),
            "-to",
            String(to),
            "-i",
            file,
            "-map",
            "0:a:0",
            "-af",
            "ebur128",
            "-f",
            "null",
            "-",
          ],
        });
        const text = result.stderr.toString();
        return Number(
          /I:\s+(-?[\d.]+) LUFS/u.exec(
            text.slice(text.lastIndexOf("Summary")),
          )![1],
        );
      };
      const plain = join(directory, "plain.mkv");
      await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: plain,
        replace: false,
      });
      const cleaned = join(directory, "cleaned.mkv");
      const evidence = await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: cleaned,
        replace: false,
        audioCleanup: { normalize: true, denoise: true },
      });
      assert.equal(evidence.samplesEqual, true);
      assert.equal(evidence.audioSampleCount, plan.sampleCount);
      const loud = await measure(cleaned, 0, 6);
      assert.ok(Math.abs(loud - -16) <= 1.5, `integrated ${loud} LUFS`);
      // Hiss relative to speech level drops after noise reduction.
      const gapBefore =
        (await measure(plain, 0, 4)) - (await measure(plain, 4.2, 6));
      const gapAfter =
        (await measure(cleaned, 0, 4)) - (await measure(cleaned, 4.2, 6));
      assert.ok(
        gapAfter > gapBefore + 3,
        `before ${gapBefore} dB, after ${gapAfter} dB`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a sped-up clip keeps every Nth source frame and time-stretched audio",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-speed-"));
    try {
      const input = await source(directory, "typing.mkv", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=30:duration=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=3",
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
      ]);
      // Normal 0–1 s, then 1–2.5 s at 3× (45 source frames → 15).
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 0,
            sourceEndUs: 1_000_000,
          },
          {
            sourceId: input.sourceId,
            sourceStartUs: 1_000_000,
            sourceEndUs: 2_500_000,
            speed: 3,
          },
        ],
        [input],
      );
      assert.equal(plan.frameCount, 45);
      assert.equal(plan.clips[1]!.outputFrames, 15);
      assert.equal(plan.sampleCount, 48_000 + 24_000);
      const output = join(directory, "sped master.mkv");
      const evidence = await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: output,
        replace: false,
      });
      assert.equal(evidence.samplesEqual, true);
      const frameBytes = rawFrameBytes("bgra", 160, 90);
      const original = (await fullDecode(input, "bgra", null)).video;
      const exported = await ffmpeg([
        "-i",
        output,
        "-c:v",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "-f",
        "rawvideo",
        "pipe:1",
      ]);
      const frame = (data: Buffer, index: number) =>
        data.subarray(index * frameBytes, (index + 1) * frameBytes);
      assert.equal(exported.length, 45 * frameBytes);
      for (let index = 0; index < 30; index++)
        assert.ok(frame(exported, index).equals(frame(original, index)));
      for (let index = 0; index < 15; index++)
        assert.ok(
          frame(exported, 30 + index).equals(frame(original, 30 + index * 3)),
          `sped frame ${index}`,
        );
      const audio = await ffmpeg([
        "-i",
        output,
        "-map",
        "0:a:0",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
      ]);
      // Mono 16-bit: 1 s at normal speed plus 0.5 s from the 3× part.
      assert.equal(audio.length, 72_000 * 2);
      // The 3× part keeps the tone's pitch: about 440 Hz, not 1320 Hz.
      let crossings = 0;
      for (let index = 52_800; index < 52_800 + 14_400; index++)
        if (
          Math.sign(audio.readInt16LE(index * 2)) !==
          Math.sign(audio.readInt16LE((index + 1) * 2))
        )
          crossings++;
      const hertz = crossings / 2 / 0.3;
      assert.ok(hertz > 400 && hertz < 480, `pitch ${hertz} Hz`);
      // The first second is the source's own samples, untouched.
      const sourceAudio = await ffmpeg([
        "-i",
        input.path,
        "-map",
        "0:a:0",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
      ]);
      assert.ok(
        audio
          .subarray(0, 48_000 * 2)
          .equals(sourceAudio.subarray(0, 48_000 * 2)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a graphics track is drawn only on its frames in a verified master",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-graphics-"));
    try {
      const input = await source(directory, "screen.mkv", [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=30:duration=1",
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
      ]);
      const first = join(directory, "graphics-000.mkv");
      const second = join(directory, "graphics-001.mkv");
      await redBoxTrack(first, 3);
      await redBoxTrack(second, 4);
      const segments = [
        { path: first, startFrame: 5, frameCount: 3 },
        { path: second, startFrame: 20, frameCount: 4 },
      ];
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 0,
            sourceEndUs: 1_000_000,
          },
        ],
        [input],
      );
      const output = join(directory, "graphics master.mkv");
      const evidence = await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: output,
        replace: false,
        compose: {
          filter: "",
          graphics: { segments },
          width: 160,
          height: 90,
          pixelFormat: "bgra",
        },
      });
      assert.equal(evidence.samplesEqual, true);
      const frameBytes = rawFrameBytes("bgra", 160, 90);
      const original = (await fullDecode(input, "bgra", null)).video;
      const exported = await ffmpeg([
        "-i",
        output,
        "-c:v",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "-f",
        "rawvideo",
        "pipe:1",
      ]);
      const changed: number[] = [];
      for (let frame = 0; frame < 30; frame++) {
        const range = [frame * frameBytes, (frame + 1) * frameBytes] as const;
        if (!exported.subarray(...range).equals(original.subarray(...range)))
          changed.push(frame);
      }
      assert.deepEqual(changed, [5, 6, 7, 20, 21, 22, 23]);
      const pixel = (frame: number, x: number, y: number) => [
        ...exported.subarray(
          frame * frameBytes + (y * 160 + x) * 4,
          frame * frameBytes + (y * 160 + x) * 4 + 4,
        ),
      ];
      assert.deepEqual(pixel(21, 30, 30), [0, 0, 255, 255]);
      // Outside the box the frame is the source's own.
      const at = 21 * frameBytes + (80 * 160 + 120) * 4;
      assert.ok(
        exported.subarray(at, at + 4).equals(original.subarray(at, at + 4)),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "graphics on 4:2:0 video change only their frames",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "export-graphics-yuv-"));
    try {
      const input = await source(directory, "talk.mp4", h264Args(1, 330));
      const first = join(directory, "graphics-000.mkv");
      const second = join(directory, "graphics-001.mkv");
      await redBoxTrack(first, 3);
      await redBoxTrack(second, 4);
      const plan = planExport(
        [
          {
            sourceId: input.sourceId,
            sourceStartUs: 0,
            sourceEndUs: 1_000_000,
          },
        ],
        [input],
      );
      const output = join(directory, "graphics.mkv.out.mkv");
      await exportDraft({
        plan,
        profile: "lossless_master",
        outputPath: output,
        replace: false,
        compose: {
          filter: "",
          graphics: {
            segments: [
              { path: first, startFrame: 5, frameCount: 3 },
              { path: second, startFrame: 20, frameCount: 4 },
            ],
          },
          width: 160,
          height: 90,
          pixelFormat: "yuv420p",
        },
      });
      const frameBytes = rawFrameBytes("yuv420p", 160, 90);
      const original = (await fullDecode(input, "yuv420p", null)).video;
      const exported = await ffmpeg([
        "-i",
        output,
        "-c:v",
        "rawvideo",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "rawvideo",
        "pipe:1",
      ]);
      const changed: number[] = [];
      for (let frame = 0; frame < 30; frame++) {
        const range = [frame * frameBytes, (frame + 1) * frameBytes] as const;
        if (!exported.subarray(...range).equals(original.subarray(...range)))
          changed.push(frame);
      }
      assert.deepEqual(changed, [5, 6, 7, 20, 21, 22, 23]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  audioAlignmentFilter,
  parseDshowAudio,
  parseInputStarts,
  parseProgress,
  parsePulseSources,
  segmentArguments,
  testToneInput,
  type DisplayTarget,
} from "../../packages/recorder/src/capture.ts";
import { CaptureSession } from "../../packages/recorder/src/session.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { probePresentationTiming } from "../../packages/media-engine/src/presentation-timing.ts";
import { planExport } from "../../packages/media-engine/src/render.ts";
import { MediaLibrary } from "../../packages/media-engine/src/library.ts";

const display: DisplayTarget = {
  id: "1",
  label: "Display 1",
  x: 1920,
  y: 0,
  width: 1279,
  height: 721,
};

test("capture arguments are lossless, constant-rate and platform specific", () => {
  const linux = segmentArguments({
    platform: "linux",
    x11Display: ":0",
    display,
    microphone: {
      id: "pulse-1",
      label: "USB mic",
      format: "pulse",
      device: "alsa_input.usb",
    },
    frameRate: 30,
    outputPath: "/tmp/out.mkv",
  });
  assert.deepEqual(
    linux.slice(linux.indexOf("x11grab") - 1, linux.indexOf("x11grab") + 9),
    [
      "-f",
      "x11grab",
      "-framerate",
      "30",
      "-video_size",
      "1278x720",
      "-draw_mouse",
      "1",
      "-i",
      ":0+1920,0",
    ],
  );
  for (const required of [
    ["-c:v", "ffv1"],
    ["-c:a", "pcm_s16le"],
    ["-fps_mode", "cfr"],
    ["-pix_fmt", "bgr0"],
  ])
    assert.equal(linux[linux.indexOf(required[0]!) + 1], required[1]);
  assert.ok(!linux.includes("-copyts"));
  assert.ok(linux.includes("-use_wallclock_as_timestamps"));
  const windows = segmentArguments({
    platform: "win32",
    display,
    microphone: {
      id: "dshow-1",
      label: "Mic",
      format: "dshow",
      device: "Microphone (USB)",
    },
    frameRate: 60,
    outputPath: "C:\\out.mkv",
  });
  assert.ok(windows.includes("gdigrab"));
  assert.equal(windows[windows.indexOf("-offset_x") + 1], "1920");
  assert.ok(windows.includes("audio=Microphone (USB)"));
  assert.throws(() =>
    segmentArguments({
      platform: "linux",
      display,
      microphone: null,
      frameRate: 30,
      outputPath: "/x.mkv",
    }),
  );
});

test("parsers read counters, devices and input start times", () => {
  assert.deepEqual(
    parseProgress(
      "frame=90\nfps=30\ndup_frames=2\ndrop_frames=1\nprogress=continue\n",
      {
        frames: 0,
        duplicated: 0,
        dropped: 0,
      },
    ),
    { frames: 90, duplicated: 2, dropped: 1 },
  );
  assert.deepEqual(
    parsePulseSources(
      "0\talsa_output.pci.monitor\tmodule\ts16le\tIDLE\n1\talsa_input.usb-Blue_Yeti\tmodule\ts16le\tIDLE\n",
    ).map((input) => input.device),
    ["alsa_input.usb-Blue_Yeti"],
  );
  assert.deepEqual(
    parseDshowAudio(
      '[dshow @ 0001] "Integrated Camera" (video)\n[dshow @ 0001] "Microphone Array (Realtek)" (audio)\n',
    ).map((input) => input.label),
    ["Microphone Array (Realtek)"],
  );
  assert.deepEqual(
    parseInputStarts(
      "Input #0, x11grab, from ':0':\n  Duration: N/A, start: 1791380214.705802, bitrate: 1 kb/s\nInput #1, pulse, from 'default':\n  Duration: N/A, start: 1791380214.874521, bitrate: 1 kb/s\n",
    ),
    [1791380214.705802, 1791380214.874521],
  );
  assert.equal(
    audioAlignmentFilter({ videoStartSeconds: 10, audioStartSeconds: 10.1 }),
    "adelay=delays=4800S:all=1,asetpts=N/SR/TB",
  );
  assert.equal(
    audioAlignmentFilter({ videoStartSeconds: 10.05, audioStartSeconds: 10 }),
    "atrim=start_sample=2400,asetpts=N/SR/TB",
  );
});

test(
  "a paused and resumed take becomes one exact, aligned, exportable lossless file",
  { timeout: 120_000 },
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "recorder-")),
    );
    try {
      const session = new CaptureSession({
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
        directory,
        request: {
          platform: "test",
          display: { ...display, x: 0, width: 160, height: 90 },
          microphone: testToneInput,
          frameRate: 30,
        },
      });
      await session.record();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await session.pause();
      assert.equal(session.state().status, "paused");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await session.record();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const finished = await session.stop();
      assert.equal(session.state().status, "finished");
      assert.ok(finished.frames >= 60, `frames ${finished.frames}`);
      // A paced source drops at most a few frames, so the counters are
      // meaningful evidence (an unpaced source reported thousands).
      assert.ok(session.state().dropped * 4 < finished.frames);
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
              finished.path,
            ],
          })
        ).stdout.toString(),
      ) as { streams: Record<string, unknown>[] } & Record<string, unknown>;
      const video = probe.streams.find(
        (stream) => stream.codec_type === "video",
      )!;
      const audio = probe.streams.find(
        (stream) => stream.codec_type === "audio",
      )!;
      assert.equal(video.codec_name, "ffv1");
      assert.equal(video.pix_fmt, "bgr0");
      assert.equal(Number(video.nb_read_packets), finished.frames);
      assert.equal(audio.codec_name, "pcm_s16le");
      assert.equal(Number(video.start_time), 0);
      // Exactly one video duration of audio: 1600 samples per 30 fps frame.
      const pcm = (
        await runProcess({
          executable: "ffmpeg",
          args: [
            "-v",
            "error",
            "-i",
            finished.path,
            "-map",
            "0:a:0",
            "-f",
            "s16le",
            "pipe:1",
          ],
          maxOutputBytes: 64 * 1024 * 1024,
        })
      ).stdout;
      assert.equal(pcm.length / 2, finished.frames * 1600);
      const record = JSON.parse(await readFile(finished.record, "utf8")) as {
        segments: {
          frames: number;
          audioOffsetSamples: number;
          interrupted: boolean;
        }[];
        pauses: unknown[];
      };
      assert.equal(record.segments.length, 2);
      assert.equal(record.pauses.length, 1);
      assert.ok(record.segments.every((segment) => !segment.interrupted));
      assert.equal(
        record.segments.reduce((sum, segment) => sum + segment.frames, 0),
        finished.frames,
      );
      // The recording is a valid constant-rate export source.
      const timing = await probePresentationTiming(
        "ffprobe",
        finished.path,
        video,
      );
      const plan = planExport(
        [
          {
            sourceId: "take",
            sourceStartUs: 0,
            sourceEndUs: finished.durationUs,
          },
        ],
        [{ sourceId: "take", path: finished.path, sha256: "x", probe, timing }],
      );
      assert.equal(plan.frameCount, finished.frames);
      assert.deepEqual(plan.format.video.frameRate, {
        numerator: 30,
        denominator: 1,
      });
      // The take imports with an exact preview: B, G, R unchanged, opaque.
      const library = new MediaLibrary(join(directory, "library"));
      const media = await library.importFile(finished.path);
      assert.equal(
        media.previewAvailable,
        true,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(video).filter(
              ([key]) => key.startsWith("color") || key.includes("pix"),
            ),
          ),
        ),
      );
      const frame = await library.frame(media.id, 0);
      const bgr0 = (
        await runProcess({
          executable: "ffmpeg",
          args: [
            "-v",
            "error",
            "-i",
            finished.path,
            "-frames:v",
            "1",
            "-pix_fmt",
            "bgr0",
            "-f",
            "rawvideo",
            "pipe:1",
          ],
          maxOutputBytes: 160 * 90 * 4 + 1024,
        })
      ).stdout;
      const rgba = Buffer.alloc(bgr0.length);
      for (let i = 0; i < bgr0.length; i += 4)
        rgba.set([bgr0[i + 2]!, bgr0[i + 1]!, bgr0[i]!, 255], i);
      assert.ok(Buffer.from(frame.rgbaBase64, "base64").equals(rgba));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

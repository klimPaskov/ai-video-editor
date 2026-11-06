import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  audioAlignmentFilter,
  parseDshowAudio,
  parseDshowDesktopAudio,
  parseInputStarts,
  parseProgress,
  parsePulseDesktopAudio,
  parsePulseSources,
  segmentArguments,
  testDesktopInput,
  testPatternCamera,
  testToneInput,
  type DisplayTarget,
} from "../../packages/recorder/src/capture.ts";
import { CaptureSession } from "../../packages/recorder/src/session.ts";
import { killProcessTree } from "../../packages/recorder/src/process-tree.ts";
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
  "computer sound from the loopback helper is mixed with the microphone and the helper ends with the capture",
  { timeout: 120_000 },
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "recorder-loopback-")),
    );
    try {
      const session = new CaptureSession({
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
        directory,
        loopback: {
          executable: process.execPath,
          args: [fileURLToPath(new URL("fake-loopback.mjs", import.meta.url))],
        },
        request: {
          platform: "test",
          display: { ...display, x: 0, width: 160, height: 90 },
          microphone: testToneInput,
          desktopAudio: {
            id: "desktop-audio",
            label: "Computer sound",
            format: "loopback",
            device: "",
          },
          frameRate: 30,
        },
      });
      await session.record();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const finished = await session.stop();
      const level = async (frequency: number) =>
        Number(
          (
            await runProcess({
              executable: "ffmpeg",
              args: [
                "-v",
                "info",
                "-i",
                finished.path,
                "-map",
                "0:a:0",
                "-af",
                `bandpass=f=${frequency}:width_type=h:w=40,volumedetect`,
                "-f",
                "null",
                "-",
              ],
            })
          ).stderr
            .toString()
            .match(/max_volume: (-?[\d.]+) dB/u)?.[1],
        );
      // 440 Hz is the microphone, 880 Hz the computer sound from the helper.
      assert.ok((await level(440)) > -40, "microphone tone present");
      assert.ok((await level(880)) > -40, "computer sound present");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a take with only computer sound from the loopback helper keeps its audio",
  { timeout: 120_000 },
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "recorder-loopback-only-")),
    );
    try {
      const session = new CaptureSession({
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
        directory,
        loopback: {
          executable: process.execPath,
          args: [fileURLToPath(new URL("fake-loopback.mjs", import.meta.url))],
        },
        request: {
          platform: "test",
          display: { ...display, x: 0, width: 160, height: 90 },
          microphone: null,
          desktopAudio: {
            id: "desktop-audio",
            label: "Computer sound",
            format: "loopback",
            device: "",
          },
          frameRate: 30,
        },
      });
      await session.record();
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const finished = await session.stop();
      const result = await runProcess({
        executable: "ffmpeg",
        args: [
          "-v",
          "info",
          "-i",
          finished.path,
          "-map",
          "0:a:0",
          "-af",
          "bandpass=f=880:width_type=h:w=40,volumedetect",
          "-f",
          "null",
          "-",
        ],
      });
      const level = Number(
        result.stderr.toString().match(/max_volume: (-?[\d.]+) dB/u)?.[1],
      );
      assert.ok(level > -40, `computer sound level ${level}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a take with the microphone and computer sound keeps one aligned audio track holding both",
  { timeout: 120_000 },
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "recorder-desktop-")),
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
          desktopAudio: testDesktopInput,
          frameRate: 30,
        },
      });
      await session.record();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const finished = await session.stop();
      const probe = JSON.parse(
        (
          await runProcess({
            executable: "ffprobe",
            args: [
              "-v",
              "error",
              "-show_streams",
              "-of",
              "json",
              finished.path,
            ],
          })
        ).stdout.toString(),
      ) as { streams: { codec_type: string; codec_name: string }[] };
      const audio = probe.streams.filter(
        (stream) => stream.codec_type === "audio",
      );
      assert.equal(audio.length, 1);
      assert.equal(audio[0]!.codec_name, "pcm_s16le");
      // Both tones (440 Hz microphone, 880 Hz computer sound) are in it.
      const levels = async (frequency: number) =>
        (
          await runProcess({
            executable: "ffmpeg",
            args: [
              "-v",
              "info",
              "-i",
              finished.path,
              "-map",
              "0:a:0",
              "-af",
              `bandpass=f=${frequency}:width_type=h:w=40,volumedetect`,
              "-f",
              "null",
              "-",
            ],
          })
        ).stderr
          .toString()
          .match(/max_volume: (-?[\d.]+) dB/u)?.[1];
      const low = Number(await levels(440));
      const high = Number(await levels(880));
      assert.ok(low > -40, `440 Hz level ${low}`);
      assert.ok(high > -40, `880 Hz level ${high}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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

test(
  "the capture supervisor finishes FFmpeg when the app's pipe closes",
  { timeout: 60_000 },
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "capture-supervisor-")),
    );
    let running: { child: ChildProcess; done: Promise<void> } | undefined;
    try {
      const session = new CaptureSession({
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
        directory,
        supervisor: {
          executable: process.execPath,
          script: fileURLToPath(
            new URL(
              "../../packages/recorder/src/capture-supervisor.ts",
              import.meta.url,
            ),
          ),
        },
        request: {
          platform: "test",
          display: {
            id: "test-pattern",
            label: "Test pattern (not a screen)",
            x: 0,
            y: 0,
            width: 160,
            height: 90,
          },
          microphone: null,
          frameRate: 30,
        },
      });
      await session.record();
      await new Promise((resolve) => setTimeout(resolve, 800));
      running = (
        session as unknown as {
          current: { child: ChildProcess; done: Promise<void> };
        }
      ).current;
      // What a crash of the app does to the supervisor: its stdin closes.
      running.child.stdin!.destroy();
      const started = Date.now();
      await running.done;
      assert.ok(Date.now() - started < 8_000, "capture ended promptly");
      assert.equal(session.state().status, "paused");
      // FFmpeg finished the file cleanly, so it has a duration.
      const probe = JSON.parse(
        (
          await runProcess({
            executable: "ffprobe",
            args: [
              "-v",
              "error",
              "-show_entries",
              "format=duration",
              "-of",
              "json",
              join(directory, "segment-001.mkv"),
            ],
          })
        ).stdout.toString(),
      ) as { format: { duration?: string } };
      assert.ok(Number(probe.format.duration) > 0.5);
      const finished = await session.stop();
      assert.ok(finished.frames >= 15);
    } finally {
      // Never leave a capture running if an assertion failed.
      if (running) killProcessTree(running.child);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("computer sound is found, kept out of the microphones and mixed into one audio track", () => {
  assert.equal(
    parsePulseDesktopAudio(
      "0\talsa_output.pci.monitor\tmodule\ts16le\tSUSPENDED\n1\talsa_output.usb.monitor\tmodule\ts16le\tRUNNING\n2\talsa_input.mic\tmodule\ts16le\tIDLE\n",
    )?.device,
    "alsa_output.usb.monitor",
  );
  assert.equal(parsePulseDesktopAudio("2\talsa_input.mic\tmodule\n"), null);
  const dshow =
    '[dshow @ 0001] "Microphone Array (Realtek)" (audio)\n[dshow @ 0001] "Stereo Mix (Realtek)" (audio)\n';
  assert.equal(parseDshowDesktopAudio(dshow)?.device, "Stereo Mix (Realtek)");
  assert.deepEqual(
    parseDshowAudio(dshow).map((input) => input.label),
    ["Microphone Array (Realtek)"],
  );
  assert.equal(parseDshowDesktopAudio('[dshow @ 0001] "Mic" (audio)\n'), null);

  const base = {
    platform: "test" as const,
    display,
    frameRate: 30 as const,
    outputPath: "/take/segment-001.mkv",
  };
  const both = segmentArguments({
    ...base,
    microphone: testToneInput,
    desktopAudio: testDesktopInput,
    camera: testPatternCamera,
    cameraOutputPath: "/take/camera-001.mkv",
  });
  // Screen 0, microphone 1, computer sound 2, camera 3; one mixed track.
  assert.ok(
    both.includes(
      "[1:a:0][2:a:0]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.97[mix]",
    ),
  );
  assert.ok(both.includes("[mix]") && both.includes("3:v:0"));
  assert.equal(both.filter((arg) => arg === "pcm_s16le").length, 1);
  const only = segmentArguments({
    ...base,
    microphone: null,
    desktopAudio: testDesktopInput,
  });
  assert.ok(only.includes("1:a:0") && !only.includes("-filter_complex"));
  assert.ok(only.includes("pcm_s16le"));
  const none = segmentArguments({ ...base, microphone: null });
  assert.ok(!none.includes("-c:a") && !none.includes("1:a:0"));
});

test("a camera arguments add a second lossless file without moving the screen's inputs", () => {
  const args = segmentArguments({
    platform: "win32",
    display,
    microphone: {
      id: "dshow-1",
      label: "Mic",
      format: "dshow",
      device: "Mic",
    },
    camera: {
      id: "dshow-video-1",
      label: "Webcam",
      format: "dshow",
      device: "Webcam",
    },
    cameraOutputPath: "C:/take/camera-001.mkv",
    frameRate: 30,
    outputPath: "C:/take/segment-001.mkv",
  });
  // Screen is input 0, the microphone 1, the camera 2.
  const inputs = args.reduce<string[]>(
    (found, arg, index) =>
      arg === "-i" ? [...found, args[index + 1]!] : found,
    [],
  );
  assert.deepEqual(inputs, ["desktop", "audio=Mic", "video=Webcam"]);
  assert.ok(args.includes("2:v:0"));
  // The first output is the screen file; the camera's own file follows it.
  assert.ok(
    args.indexOf("C:/take/segment-001.mkv") <
      args.indexOf("C:/take/camera-001.mkv"),
  );
  const cameraPart = args.slice(args.indexOf("C:/take/segment-001.mkv") + 1);
  assert.ok(cameraPart.includes("ffv1") && cameraPart.includes("-an"));
  assert.throws(() =>
    segmentArguments({
      platform: "win32",
      display,
      microphone: null,
      camera: {
        id: "x",
        label: "x",
        format: "dshow",
        device: "x",
      },
      frameRate: 30,
      outputPath: "C:/take/segment-001.mkv",
    }),
  );
});

test(
  "a take with a camera gives a camera file with the screen's own frames, across a pause",
  { timeout: 120_000 },
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "recorder-camera-")),
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
          camera: testPatternCamera,
          frameRate: 30,
        },
      });
      await session.record();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await session.pause();
      await session.record();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const finished = await session.stop();
      assert.ok(finished.cameraPath, "a camera file");
      const count = async (file: string) =>
        Number(
          (
            await runProcess({
              executable: "ffprobe",
              args: [
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-count_packets",
                "-show_entries",
                "stream=nb_read_packets,width,height,codec_name,pix_fmt",
                "-of",
                "csv=p=0",
                file,
              ],
            })
          ).stdout
            .toString()
            .trim()
            .split(",")
            .at(-1),
        );
      assert.equal(await count(finished.cameraPath!), finished.frames);
      const shape = (
        await runProcess({
          executable: "ffprobe",
          args: [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height",
            "-of",
            "csv=p=0",
            finished.cameraPath!,
          ],
        })
      ).stdout
        .toString()
        .trim();
      assert.equal(shape, "ffv1,1280,720");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProcess } from "../../packages/media-engine/src/process.ts";
import { segmentArguments } from "../../packages/recorder/src/capture.ts";
import { CaptureSession } from "../../packages/recorder/src/session.ts";

test(
  "capture starts fast and tags frames; a video-only take is finished without a rewrite",
  { timeout: 60_000 },
  async () => {
    const args = segmentArguments({
      platform: "test",
      display: { id: "t", label: "t", x: 0, y: 0, width: 64, height: 64 },
      microphone: null,
      frameRate: 30,
      outputPath: "out.mkv",
    });
    assert.equal(args[args.indexOf("-stats_period") + 1], "0.1");
    assert.match(args[args.indexOf("-vf") + 1]!, /^setparams=.*iec61966-2-1/u);
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "recording-fast-")),
    );
    try {
      const session = new CaptureSession({
        ffmpeg: "ffmpeg",
        ffprobe: "ffprobe",
        directory: root,
        request: {
          platform: "test",
          display: { id: "t", label: "t", x: 0, y: 0, width: 128, height: 72 },
          microphone: null,
          frameRate: 30,
        },
      });
      const started = performance.now();
      await session.record();
      assert.ok(performance.now() - started < 3000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const finished = await session.stop();
      // FFmpeg's own final count equals a packet-by-packet count of the file.
      const counted = await runProcess({
        executable: "ffprobe",
        args: [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-count_packets",
          "-show_entries",
          "stream=nb_read_packets",
          "-of",
          "csv=p=0",
          finished.path,
        ],
      });
      assert.equal(Number(counted.stdout.toString().trim()), finished.frames);
      assert.equal(
        createHash("sha256")
          .update(await readFile(finished.path))
          .digest("hex"),
        finished.sha256,
      );
      // The segment itself was renamed; no second copy of the media was made.
      assert.deepEqual((await readdir(root)).sort(), [
        "recording.mkv",
        "session.json",
        "take.json",
      ]);
      const tags = await runProcess({
        executable: "ffprobe",
        args: [
          "-v",
          "error",
          "-show_entries",
          "stream=color_range,color_space,color_primaries,color_transfer",
          "-of",
          "default=nw=1",
          finished.path,
        ],
      });
      assert.match(tags.stdout.toString(), /color_primaries=bt709/u);
      assert.match(tags.stdout.toString(), /color_transfer=iec61966-2-1/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

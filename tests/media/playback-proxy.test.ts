import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopPlaybackProxies } from "../../apps/desktop/src/playback-proxies.ts";
import {
  createPlaybackProxy,
  needsPlaybackProxy,
  proxyEncoder,
} from "../../packages/media-engine/src/proxy.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

async function probe(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(
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
}

async function frameTimes(path: string): Promise<string[]> {
  const output = (
    await runProcess({
      executable: "ffprobe",
      args: [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "csv=p=0",
        path,
      ],
      maxOutputBytes: 1024 * 1024,
    })
  ).stdout.toString();
  return (
    output
      .split(/\r?\n/u)
      .filter(Boolean)
      // The first frame may carry an extra side-data column.
      .map((value) => Number(value.split(",")[0]).toFixed(3))
  );
}

async function lossless(directory: string): Promise<string> {
  const path = join(directory, "take.mkv");
  await runProcess({
    executable: "ffmpeg",
    args: [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=30:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v",
      "ffv1",
      "-pix_fmt",
      "bgr0",
      "-c:a",
      "pcm_s16le",
      "-f",
      "matroska",
      path,
    ],
  });
  return path;
}

test("only sources Chromium cannot decode need a playback copy", () => {
  const stream = (codec_type: string, codec_name: string) => ({
    codec_type,
    codec_name,
  });
  assert.equal(
    needsPlaybackProxy({
      streams: [stream("video", "h264"), stream("audio", "aac")],
    }),
    false,
  );
  assert.equal(
    needsPlaybackProxy({ streams: [stream("video", "vp9")] }),
    false,
  );
  assert.equal(
    needsPlaybackProxy({
      streams: [stream("video", "ffv1"), stream("audio", "pcm_s16le")],
    }),
    true,
  );
  assert.equal(
    needsPlaybackProxy({
      streams: [stream("video", "h264"), stream("audio", "pcm_s16le")],
    }),
    true,
  );
  assert.equal(needsPlaybackProxy({ streams: [] }), true);
});

test(
  "a playback copy keeps every frame at the source's time and has audio",
  { timeout: 120_000 },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "proxy-")));
    try {
      const input = await lossless(directory);
      const encoder = await proxyEncoder("ffmpeg");
      const output = join(
        directory,
        `copy.${encoder === "h264" ? "mp4" : "webm"}`,
      );
      const progress: number[] = [];
      await createPlaybackProxy({
        ffmpeg: "ffmpeg",
        input,
        output,
        encoder,
        hasAudio: true,
        durationUs: 2_000_000,
        onProgress: (value) => progress.push(value),
      });
      assert.equal(progress.at(-1), 1);
      const result = await probe(output);
      const streams = result.streams as Record<string, unknown>[];
      const video = streams.find((item) => item.codec_type === "video")!;
      assert.equal(video.codec_name, encoder);
      assert.equal(video.pix_fmt, "yuv420p");
      assert.ok(streams.some((item) => item.codec_type === "audio"));
      assert.equal(needsPlaybackProxy(result), false);
      assert.deepEqual(await frameTimes(output), await frameTimes(input));
      assert.deepEqual(
        (await readdir(directory)).filter((name) => name.endsWith(".partial")),
        [],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "the service prepares copies in the background and serves them when ready",
  { timeout: 120_000 },
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "proxy-")));
    try {
      const input = await lossless(directory);
      const service = new DesktopPlaybackProxies({
        root: join(directory, "proxies"),
      });
      const source = {
        sha256: "a".repeat(64),
        path: input,
        probe: await probe(input),
      };
      assert.equal(await service.resolve(source, "video/x-matroska"), null);
      const first = await service.view([source]);
      assert.equal(first.status, "preparing");
      let view = first;
      const deadline = Date.now() + 60_000;
      while (view.status === "preparing" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        view = await service.view([source]);
      }
      assert.deepEqual(view, {
        status: "ready",
        progress: null,
        message: null,
      });
      const served = await service.resolve(source, "video/x-matroska");
      assert.ok(served && /video\/(mp4|webm)/u.test(served.mime));
      assert.ok(served.path.startsWith(join(directory, "proxies")));
      // A playable source is served as itself.
      const native = {
        ...source,
        probe: { streams: [{ codec_type: "video", codec_name: "h264" }] },
      };
      assert.deepEqual(await service.resolve(native, "video/mp4"), {
        path: input,
        mime: "video/mp4",
      });
      // A new service finds the finished copy without making another.
      const reopened = new DesktopPlaybackProxies({
        root: join(directory, "proxies"),
      });
      assert.equal((await reopened.view([source])).status, "ready");
      service.close();
      reopened.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

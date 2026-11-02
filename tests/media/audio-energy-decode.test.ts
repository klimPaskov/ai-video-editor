import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isQuietSpan,
  meanEnergy,
  speechLevel,
} from "../../packages/domain/src/audio-energy.ts";
import {
  decodeEnergyTrack,
  energyFrameUs,
  parseEnergyLevels,
} from "../../packages/media-engine/src/audio-energy.ts";
import { runProcess } from "../../packages/media-engine/src/process.ts";

test("FFmpeg's printed levels become linear loudness, with silence as zero", () => {
  const levels = parseEnergyLevels(
    [
      "frame:0    pts:0       pts_time:0",
      "lavfi.astats.Overall.RMS_level=-20.000000",
      "frame:1    pts:160     pts_time:0.01",
      "lavfi.astats.Overall.RMS_level=-inf",
      "frame:2    pts:320     pts_time:0.02",
      "lavfi.astats.Overall.RMS_level=-40",
    ].join("\n"),
  );
  assert.equal(levels.length, 3);
  assert.ok(Math.abs(levels[0]! - 0.1) < 1e-6);
  assert.equal(levels[1], 0);
  assert.ok(Math.abs(levels[2]! - 0.01) < 1e-6);
  assert.deepEqual(parseEnergyLevels("nothing useful"), []);
});

test("a real file's tone is loud and its silence is quiet, frame by frame", async () => {
  const folder = await mkdtemp(join(tmpdir(), "energy-"));
  try {
    const file = join(folder, "tone-silence-tone.wav");
    // 1 s tone, 1 s silence, 1 s tone.
    await runProcess({
      executable: "ffmpeg",
      args: [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=1",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=mono:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330:sample_rate=48000:duration=1",
        "-filter_complex",
        "[0][1][2]concat=n=3:v=0:a=1",
        file,
      ],
      timeoutMs: 60_000,
    });
    const track = await decodeEnergyTrack({ ffmpeg: "ffmpeg", path: file });
    assert.equal(track.frameUs, energyFrameUs);
    // About 3 s of 10 ms frames.
    assert.ok(
      track.rms.length >= 295 && track.rms.length <= 305,
      `frames: ${track.rms.length}`,
    );
    assert.ok(meanEnergy(track, 100_000, 900_000) > 0.05);
    assert.ok(meanEnergy(track, 1_100_000, 1_900_000) < 0.005);
    assert.ok(meanEnergy(track, 2_100_000, 2_900_000) > 0.05);
    const level = speechLevel(track);
    assert.ok(isQuietSpan(track, 1_100_000, 1_900_000, level));
    assert.ok(!isQuietSpan(track, 100_000, 900_000, level));
    // A file with no audio is refused in plain terms.
    const silentVideo = join(folder, "video-only.mkv");
    await runProcess({
      executable: "ffmpeg",
      args: [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:d=1:r=10",
        silentVideo,
      ],
      timeoutMs: 60_000,
    });
    await assert.rejects(() =>
      decodeEnergyTrack({ ffmpeg: "ffmpeg", path: silentVideo }),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

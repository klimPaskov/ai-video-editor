import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryVideoArguments,
  openH264Bitrate,
  pickDeliveryEncoder,
} from "../../packages/media-engine/src/delivery-encoder.ts";
import { MediaError } from "../../packages/media-engine/src/process.ts";

const gplList = ` V....D libx264              libx264 H.264 / AVC (codec h264)
 V....D libx264rgb           libx264 H.264 RGB (codec h264)
 V....D libopenh264          OpenH264 H.264 (codec h264)
 A....D aac                  AAC
`;
const lgplList = ` V....D h264_mf              H264 via MediaFoundation (codec h264)
 V....D libopenh264          OpenH264 H.264 / AVC (codec h264)
 V....D libvpx-vp9           libvpx VP9
`;

test("libx264 is preferred, OpenH264 is the LGPL-build fallback", () => {
  assert.equal(pickDeliveryEncoder(gplList), "libx264");
  assert.equal(pickDeliveryEncoder(lgplList), "libopenh264");
  // libx264rgb alone is not a usable yuv420p H.264 encoder.
  assert.throws(
    () =>
      pickDeliveryEncoder(
        " V....D libx264rgb  libx264 RGB\n A....D aac  AAC\n",
      ),
    (error: unknown) =>
      error instanceof MediaError && error.code === "UNSUPPORTED_PROFILE",
  );
});

test("a build with no H.264 encoder gives a plain actionable error", () => {
  assert.throws(
    () => pickDeliveryEncoder(" A....D aac AAC\n"),
    (error: unknown) =>
      error instanceof MediaError &&
      /lossless master/u.test(error.message) &&
      !/ffmpeg|libx264|exe/iu.test(error.message),
  );
});

test("encoder arguments keep libx264 unchanged and give OpenH264 a bounded bitrate", () => {
  const size = {
    width: 1920,
    height: 1080,
    frameRate: { numerator: 30, denominator: 1 },
  };
  assert.deepEqual(deliveryVideoArguments("libx264", size), [
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
  ]);
  const args = deliveryVideoArguments("libopenh264", size);
  assert.deepEqual(args.slice(0, 4), [
    "-c:v",
    "libopenh264",
    "-rc_mode",
    "bitrate",
  ]);
  assert.equal(args[args.indexOf("-b:v") + 1], "7464960");
  assert.equal(args[args.indexOf("-profile:v") + 1], "high");
  assert.equal(
    openH264Bitrate({
      width: 16,
      height: 16,
      frameRate: { numerator: 24, denominator: 1 },
    }),
    1_000_000,
  );
  assert.equal(
    openH264Bitrate({
      width: 15360,
      height: 8640,
      frameRate: { numerator: 120, denominator: 1 },
    }),
    80_000_000,
  );
});

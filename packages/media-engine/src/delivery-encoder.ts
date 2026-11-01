import { MediaError, runProcess } from "./process.ts";

/**
 * H.264 encoder for the explicit "Smaller file" MP4 (never the master).
 * libx264 is GPL, so the Windows release bundles an LGPL FFmpeg without it
 * (docs/adr/0022-windows-release.md); that build carries OpenH264 instead.
 * libx264 stays preferred wherever the FFmpeg in use has it.
 */
export type DeliveryEncoder = "libx264" | "libopenh264";

const cache = new Map<string, Promise<DeliveryEncoder>>();

export function pickDeliveryEncoder(encoderList: string): DeliveryEncoder {
  if (/^\s*V\S*\s+libx264\s/mu.test(encoderList)) return "libx264";
  if (/^\s*V\S*\s+libopenh264\s/mu.test(encoderList)) return "libopenh264";
  throw new MediaError(
    "UNSUPPORTED_PROFILE",
    "This copy of the video tools has no H.264 encoder, so a smaller MP4 cannot be made. Export the lossless master instead.",
  );
}

/** Asks the FFmpeg that will do the work, once per executable. */
export function selectDeliveryEncoder(
  ffmpeg: string,
): Promise<DeliveryEncoder> {
  let pending = cache.get(ffmpeg);
  if (!pending) {
    pending = runProcess({
      executable: ffmpeg,
      args: ["-hide_banner", "-encoders"],
    }).then(({ stdout }) => pickDeliveryEncoder(stdout.toString()));
    // A failed probe must not be remembered.
    pending.catch(() => cache.delete(ffmpeg));
    cache.set(ffmpeg, pending);
  }
  return pending;
}

export interface DeliveryFrameSize {
  width: number;
  height: number;
  frameRate: { numerator: number; denominator: number };
}

/**
 * OpenH264 has no constant-quality mode, so the smaller file targets a bitrate
 * from the frame size and rate: about 0.12 bits per pixel, clamped. This is
 * an explicitly lossy share copy; the master is unaffected.
 */
export function openH264Bitrate(size: DeliveryFrameSize): number {
  const rate = size.frameRate.numerator / size.frameRate.denominator;
  const bits = size.width * size.height * rate * 0.12;
  return Math.min(80_000_000, Math.max(1_000_000, Math.round(bits)));
}

export function deliveryVideoArguments(
  encoder: DeliveryEncoder,
  size: DeliveryFrameSize,
): string[] {
  if (encoder === "libx264")
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "18"];
  return [
    "-c:v",
    "libopenh264",
    "-rc_mode",
    "bitrate",
    "-b:v",
    String(openH264Bitrate(size)),
    "-profile:v",
    "high",
  ];
}

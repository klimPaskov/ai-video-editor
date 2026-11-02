import type { WorkingAudioFormat } from "./render.ts";

const widths: Record<WorkingAudioFormat["raw"], number> = {
  s16le: 2,
  s32le: 4,
  f32le: 4,
  f64le: 8,
};

/** How many frames a join fade covers: the time, capped to a third of a clip. */
export function joinFadeFrames(
  sampleRate: number,
  fadeMs: number,
  clipFrames: number,
): number {
  return Math.max(
    0,
    Math.min(
      Math.round((sampleRate * fadeMs) / 1000),
      Math.floor(clipFrames / 3),
    ),
  );
}

/**
 * Applies a short fade to the part of `buffer` that lies in the first
 * `inFrames` or last `outFrames` frames of a clip, in place. `startByte` is
 * where the buffer begins inside the clip's raw audio, which has
 * `totalFrames` frames. A cut makes an abrupt jump in the waveform; fading
 * each side of it to zero removes the click. The curve is a raised sine, so
 * the two sides of a join sum to constant power.
 */
export function fadeClipEdges(
  buffer: Buffer,
  startByte: number,
  options: {
    raw: WorkingAudioFormat["raw"];
    channels: number;
    totalFrames: number;
    inFrames: number;
    outFrames: number;
  },
): void {
  const width = widths[options.raw];
  const count = Math.floor(buffer.length / width);
  const first = Math.floor(startByte / width);
  for (let index = 0; index < count; index++) {
    const frame = Math.floor((first + index) / options.channels);
    let gain = 1;
    if (frame < options.inFrames)
      gain = Math.sin(((frame + 0.5) / options.inFrames) * (Math.PI / 2));
    const tail = options.totalFrames - 1 - frame;
    if (tail < options.outFrames)
      gain *= Math.sin(((tail + 0.5) / options.outFrames) * (Math.PI / 2));
    if (gain === 1) continue;
    const at = index * width;
    switch (options.raw) {
      case "s16le":
        buffer.writeInt16LE(Math.round(buffer.readInt16LE(at) * gain), at);
        break;
      case "s32le":
        buffer.writeInt32LE(Math.round(buffer.readInt32LE(at) * gain), at);
        break;
      case "f32le":
        buffer.writeFloatLE(buffer.readFloatLE(at) * gain, at);
        break;
      case "f64le":
        buffer.writeDoubleLE(buffer.readDoubleLE(at) * gain, at);
        break;
    }
  }
}

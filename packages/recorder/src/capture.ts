/**
 * Native capture adapter: FFmpeg command lines and parsers for lossless
 * screen and microphone capture. Video is captured at a constant frame rate
 * into FFV1 and audio into 16-bit PCM; FFmpeg's duplicate/drop counters are
 * the dropped-frame evidence. No browser MediaRecorder path is used, because
 * it cannot provide lossless samples.
 */

export type CapturePlatform = "linux" | "win32" | "darwin" | "test";

export interface DisplayTarget {
  id: string;
  label: string;
  /** Physical-pixel bounds of the display. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AudioInput {
  /** Opaque id the renderer may send back; never a device path. */
  id: string;
  label: string;
  /** FFmpeg input format and device name; main only. */
  format: "pulse" | "alsa" | "dshow" | "avfoundation" | "test_tone";
  device: string;
}

export interface SegmentRequest {
  platform: CapturePlatform;
  /** X11 display name on Linux, e.g. ":0". */
  x11Display?: string;
  display: DisplayTarget;
  microphone: AudioInput | null;
  frameRate: 30 | 60;
  outputPath: string;
}

export const captureSampleRate = 48_000;

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/** Capture size: FFV1 accepts odd sizes, but 4:2:0 sharing exports do not. */
export function captureSize(display: DisplayTarget): {
  width: number;
  height: number;
} {
  return { width: even(display.width), height: even(display.height) };
}

/** FFmpeg arguments for one capture segment (video + optional microphone). */
export function segmentArguments(request: SegmentRequest): string[] {
  const { width, height } = captureSize(request.display);
  const rate = String(request.frameRate);
  let video: string[];
  switch (request.platform) {
    case "linux":
      if (
        !request.x11Display ||
        !/^[A-Za-z0-9.:_-]{1,64}$/u.test(request.x11Display)
      )
        throw new Error("Screen recording needs an X11 display.");
      video = [
        "-f",
        "x11grab",
        "-framerate",
        rate,
        "-video_size",
        `${width}x${height}`,
        "-draw_mouse",
        "1",
        "-i",
        `${request.x11Display}+${request.display.x},${request.display.y}`,
      ];
      break;
    case "win32":
      video = [
        "-f",
        "gdigrab",
        "-framerate",
        rate,
        "-offset_x",
        String(request.display.x),
        "-offset_y",
        String(request.display.y),
        "-video_size",
        `${width}x${height}`,
        "-draw_mouse",
        "1",
        "-i",
        "desktop",
      ];
      break;
    case "test":
      // Labelled synthetic display for repeatable tests; never a real screen.
      video = [
        "-re",
        "-use_wallclock_as_timestamps",
        "1",
        "-f",
        "lavfi",
        "-i",
        `testsrc2=size=${width}x${height}:rate=${rate}`,
      ];
      break;
    case "darwin":
      video = [
        "-f",
        "avfoundation",
        "-framerate",
        rate,
        "-capture_cursor",
        "1",
        "-i",
        `${request.display.id}:none`,
      ];
      break;
  }
  const audio: string[] = [];
  const microphone = request.microphone;
  if (microphone) {
    if (microphone.format === "test_tone")
      audio.push(
        "-re",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:sample_rate=${captureSampleRate}`,
      );
    else if (microphone.format === "dshow")
      audio.push("-f", "dshow", "-i", `audio=${microphone.device}`);
    else if (microphone.format === "avfoundation")
      audio.push("-f", "avfoundation", "-i", `:${microphone.device}`);
    else audio.push("-f", microphone.format, "-i", microphone.device);
  }
  return [
    "-hide_banner",
    // Input headers (with each input's wall-clock start) go to stderr; stop
    // is a "q" on stdin so FFmpeg finalises the file on every platform.
    "-loglevel",
    "info",
    // Progress (frame, dup_frames, drop_frames) on stdout for evidence.
    "-progress",
    "pipe:1",
    "-stats_period",
    "0.5",
    "-thread_queue_size",
    "1024",
    ...video,
    ...(microphone
      ? [
          "-thread_queue_size",
          "1024",
          // Every input gets wall-clock timestamps so their offsets are real.
          "-use_wallclock_as_timestamps",
          "1",
          ...audio,
        ]
      : []),
    "-map",
    "0:v:0",
    ...(microphone ? ["-map", "1:a:0"] : []),
    "-fps_mode",
    "cfr",
    "-r",
    rate,
    "-c:v",
    "ffv1",
    "-level",
    "3",
    "-g",
    "1",
    "-slices",
    "16",
    "-slicecrc",
    "1",
    "-threads",
    "8",
    "-pix_fmt",
    request.platform === "linux" || request.platform === "test"
      ? "bgr0"
      : "bgra",
    "-color_range",
    "pc",
    "-colorspace",
    "rgb",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "iec61966-2-1",
    ...(microphone
      ? ["-c:a", "pcm_s16le", "-ar", String(captureSampleRate)]
      : []),
    "-f",
    "matroska",
    request.outputPath,
  ];
}

export interface CaptureCounters {
  frames: number;
  duplicated: number;
  dropped: number;
}

/** Folds FFmpeg `-progress` key=value lines into the latest counters. */
export function parseProgress(
  text: string,
  previous: CaptureCounters,
): CaptureCounters {
  const next = { ...previous };
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(frame|dup_frames|drop_frames)=(\d+)$/u.exec(line.trim());
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value)) continue;
    if (match[1] === "frame") next.frames = value;
    else if (match[1] === "dup_frames") next.duplicated = value;
    else next.dropped = value;
  }
  return next;
}

/** Linux PulseAudio sources from `pactl list short sources`. */
export function parsePulseSources(text: string): AudioInput[] {
  const inputs: AudioInput[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const fields = line.split("\t");
    const name = fields[1];
    if (!name || name.endsWith(".monitor") || !/^[\w.:@-]{1,200}$/u.test(name))
      continue;
    inputs.push({
      id: `pulse-${inputs.length + 1}`,
      label: name.replace(/^alsa_input\./u, "").replace(/[._-]+/gu, " "),
      format: "pulse",
      device: name,
    });
  }
  return inputs;
}

/** Windows DirectShow audio devices from `ffmpeg -list_devices true -f dshow`. */
export function parseDshowAudio(text: string): AudioInput[] {
  const inputs: AudioInput[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /\]\s+"([^"]{1,200})"\s+\(audio\)/u.exec(line);
    if (!match) continue;
    inputs.push({
      id: `dshow-${inputs.length + 1}`,
      label: match[1]!,
      format: "dshow",
      device: match[1]!,
    });
  }
  return inputs;
}

/** Labelled synthetic microphone for repeatable tests; never a real device. */
export const testToneInput: AudioInput = Object.freeze({
  id: "test-tone",
  label: "Test tone (not a microphone)",
  format: "test_tone",
  device: "sine",
});

export interface StreamStart {
  videoStartSeconds: number;
  audioStartSeconds: number | null;
}

/**
 * FFmpeg filter that aligns captured audio to the first video frame with
 * exact samples: leading audio is trimmed, missing audio is zero-padded.
 */
export function audioAlignmentFilter(start: StreamStart): string {
  if (start.audioStartSeconds === null) return "anull";
  const offset = Math.round(
    (start.audioStartSeconds - start.videoStartSeconds) * captureSampleRate,
  );
  if (offset > 0) return `adelay=delays=${offset}S:all=1,asetpts=N/SR/TB`;
  if (offset < 0) return `atrim=start_sample=${-offset},asetpts=N/SR/TB`;
  return "asetpts=N/SR/TB";
}

/**
 * Wall-clock start of each input from FFmpeg's input headers
 * ("Input #0, x11grab ..." followed by "Duration: N/A, start: 1791...").
 * Each input's timestamps are rebased to zero in the output, so these starts
 * are the only record of how far apart the sources began.
 */
export function parseInputStarts(stderr: string): number[] {
  const starts: number[] = [];
  let current = -1;
  for (const line of stderr.split(/\r?\n/u)) {
    const input = /^Input #(\d+),/u.exec(line);
    if (input) {
      current = Number(input[1]);
      continue;
    }
    const start = /start: (-?\d+(?:\.\d+)?)/u.exec(line);
    if (start && current >= 0 && starts[current] === undefined)
      starts[current] = Number(start[1]);
  }
  return starts;
}

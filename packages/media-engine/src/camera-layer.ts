import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  cameraPieces,
  pipRect,
  type CameraPiece,
  type LayoutGeometry,
  type LayoutInterval,
  type LayoutShape,
  type LayoutState,
} from "../../domain/src/layouts.ts";
import { MediaError } from "./process.ts";

/**
 * The camera drawn over the screen. For every stretch where the camera is
 * visible (a steady arrangement, or a change between two), the camera
 * recording is cut to the output frames, laid out on a transparent picture of
 * the screen's size and written as a lossless file with alpha. The compositor
 * draws these files over the screen's frames exactly like motion graphics, so
 * frames where the camera is not shown stay untouched.
 */

export interface CameraSource {
  path: string;
  width: number;
  height: number;
  /** Camera time = recording time + offset. */
  offsetUs: number;
}

export interface CameraTrackOptions {
  ffmpeg: string;
  directory: string;
  signal?: AbortSignal;
  camera: CameraSource;
  /** The size of the screen's frames. */
  canvas: { width: number; height: number };
  frameRate: { numerator: number; denominator: number };
  /** For each planned clip: the first screen frame it shows and its output. */
  clips: readonly {
    /** The recording the clip is from; the camera belongs to one recording. */
    sourceId?: string;
    firstFrame: number;
    outputFrames: number;
    speed: number;
  }[];
  /** Only clips of this recording show the camera (all, when unset). */
  cameraSourceId?: string;
  frameCount: number;
  intervals: readonly LayoutInterval[];
  onProgress?: (fraction: number) => void;
}

export interface CameraSegment {
  path: string;
  startFrame: number;
  frameCount: number;
}

function even(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function seconds(value: number): string {
  return value.toFixed(6);
}

/**
 * Crops the camera picture to the zoomed window around the focus point, so a
 * face can be framed. Magnification 1 leaves the picture whole.
 */
function zoomCrop(zoom: number, focusX: number, focusY: number): string {
  if (zoom <= 1.0001) return "";
  const size = 1 / zoom;
  const x = Math.min(1 - size, Math.max(0, focusX - size / 2));
  const y = Math.min(1 - size, Math.max(0, focusY - size / 2));
  return `crop=w=iw*${size.toFixed(6)}:h=ih*${size.toFixed(6)}:x=iw*${x.toFixed(6)}:y=ih*${y.toFixed(6)},`;
}

/** An alpha mask for a corner camera, soft by one pixel at the edge. */
function shapeMask(shape: LayoutShape, width: number, height: number): string {
  if (shape === "rect") return "";
  const radius =
    shape === "circle"
      ? Math.min(width, height) / 2
      : Math.min(width, height) * 0.12;
  const halfW = width / 2;
  const halfH = height / 2;
  // Signed distance to a rounded rectangle (a circle when the radius is half).
  const qx = `(abs(X+0.5-${halfW})-(${halfW}-${radius}))`;
  const qy = `(abs(Y+0.5-${halfH})-(${halfH}-${radius}))`;
  const distance = `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${radius})`;
  return `format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(0.5-${distance},0,1)',format=rgba,`;
}

interface Layout {
  canvas: { width: number; height: number };
  geometry: LayoutGeometry;
}

/** The camera picture of a corner arrangement, as an alpha picture. */
function pipPicture(
  state: LayoutState,
  layout: Layout,
): {
  chain: string;
  x: number;
  y: number;
} {
  const rect = pipRect(state, layout.geometry);
  const width = even(rect.width * layout.canvas.width);
  const height = even(rect.height * layout.canvas.height);
  return {
    chain:
      zoomCrop(state.faceZoom, state.focusX, state.focusY) +
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=rgba,` +
      shapeMask(state.shape, width, height),
    x: Math.round(rect.x * layout.canvas.width),
    y: Math.round(rect.y * layout.canvas.height),
  };
}

/** The camera picture filling the screen. */
function fullPicture(state: LayoutState, layout: Layout): string {
  const { width, height } = layout.canvas;
  return (
    zoomCrop(state.faceZoom, state.focusX, state.focusY) +
    `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=rgba`
  );
}

/**
 * The filter graph for one stretch of the camera input. `[cam]` is the
 * camera already retimed to the output frames, with timestamps counted from
 * the start of the piece. The result is `[out]`, a BGRA picture of the
 * screen's size with the camera drawn where it belongs.
 */
export function cameraPieceGraph(
  piece: CameraPiece,
  layout: Layout,
  frameRate: { numerator: number; denominator: number },
  /** Seconds from the start of the piece to the first frame of this stretch. */
  offset = 0,
): string {
  const { width, height } = layout.canvas;
  const rate = `${frameRate.numerator}/${frameRate.denominator}`;
  // The empty picture the camera is drawn on shares the stretch's clock, so
  // a glide keeps its place when a piece is made of several stretches.
  const transparent = `color=c=black@0:s=${width}x${height}:r=${rate},format=rgba,setpts=PTS+${seconds(offset)}/TB`;
  const length = (piece.endUs - piece.startUs) / 1_000_000;
  const steadyPip = (state: LayoutState, label: string, source: string) => {
    const picture = pipPicture(state, layout);
    return [
      `${source}${picture.chain.replace(/,$/u, "")}[${label}pic]`,
      `${transparent}[${label}bg]`,
      `[${label}bg][${label}pic]overlay=${picture.x}:${picture.y}:format=auto[${label}]`,
    ];
  };
  const parts: string[] = [];
  if (piece.kind === "steady") {
    if (piece.state.kind === "camera")
      parts.push(`[cam]${fullPicture(piece.state, layout)},format=bgra[out]`);
    else
      parts.push(
        ...steadyPip(piece.state, "p", "[cam]"),
        `[p]format=bgra[out]`,
      );
    return parts.join(";");
  }
  const { from, to } = piece;
  const fade = (direction: "in" | "out") =>
    `fade=t=${direction}:st=0:d=${seconds(length)}:alpha=1`;
  if (from.kind === "screen" && to.kind === "pip") {
    const picture = pipPicture(to, layout);
    return [
      `[cam]${picture.chain}${fade("in")}[pic]`,
      `${transparent}[bg]`,
      `[bg][pic]overlay=${picture.x}:${picture.y}:format=auto,format=bgra[out]`,
    ].join(";");
  }
  if (from.kind === "pip" && to.kind === "screen") {
    const picture = pipPicture(from, layout);
    return [
      `[cam]${picture.chain}${fade("out")}[pic]`,
      `${transparent}[bg]`,
      `[bg][pic]overlay=${picture.x}:${picture.y}:format=auto,format=bgra[out]`,
    ].join(";");
  }
  if (from.kind === "screen" && to.kind === "camera")
    return `[cam]${fullPicture(to, layout)},${fade("in")},format=bgra[out]`;
  if (from.kind === "camera" && to.kind === "screen")
    return `[cam]${fullPicture(from, layout)},${fade("out")},format=bgra[out]`;
  if (from.kind === "pip" && to.kind === "pip") {
    // The camera glides to its new place on an eased path.
    const a = pipPicture(from, layout);
    const b = pipPicture(to, layout);
    const p = `clip(t/${seconds(length)},0,1)`;
    const eased = `(${p}*${p}*(3-2*${p}))`;
    return [
      `[cam]${b.chain.replace(/,$/u, "")}[pic]`,
      `${transparent}[bg]`,
      `[bg][pic]overlay=x='${a.x}+(${b.x - a.x})*${eased}':y='${a.y}+(${b.y - a.y})*${eased}':eval=frame:format=auto,format=bgra[out]`,
    ].join(";");
  }
  if (from.kind === "pip" && to.kind === "camera") {
    const picture = pipPicture(from, layout);
    return [
      `[cam]split[a][b]`,
      `[a]${picture.chain.replace(/,$/u, "")}[pic]`,
      `${transparent}[bg]`,
      `[bg][pic]overlay=${picture.x}:${picture.y}:format=auto[base]`,
      `[b]${fullPicture(to, layout)},${fade("in")}[full]`,
      `[base][full]overlay=0:0:format=auto,format=bgra[out]`,
    ].join(";");
  }
  if (from.kind === "camera" && to.kind === "pip") {
    const picture = pipPicture(to, layout);
    return [
      `[cam]split[a][b]`,
      `[a]${picture.chain.replace(/,$/u, "")}[pic]`,
      `${transparent}[bg]`,
      `[bg][pic]overlay=${picture.x}:${picture.y}:format=auto[base]`,
      `[b]${fullPicture(from, layout)},${fade("out")}[full]`,
      `[base][full]overlay=0:0:format=auto,format=bgra[out]`,
    ].join(";");
  }
  // Camera to camera (a new framing): the new picture, without a dissolve.
  return `[cam]${fullPicture(to, layout)},format=bgra[out]`;
}

function startProcess(
  executable: string,
  args: string[],
  stdin: "pipe" | "ignore",
): ChildProcess {
  return spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: [stdin, "pipe", "pipe"],
  });
}

function exited(child: ChildProcess): Promise<void> {
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-2000);
  });
  return new Promise<void>((resolve, reject) => {
    child.once("error", () =>
      reject(
        new MediaError(
          "PROCESS_UNAVAILABLE",
          "Media executable could not be started.",
        ),
      ),
    );
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new MediaError("PROCESS_FAILED", "Media executable failed.", {
              detail: `exit ${code}: ${tail}`,
            }),
          ),
    );
  });
}

const quiet = ["-hide_banner", "-loglevel", "error", "-nostdin"];

/**
 * Renders the camera's pieces for an export. Returns the files to draw over
 * the screen's frames, in order; empty when the camera is never shown.
 */
export async function renderCameraTrack(
  options: CameraTrackOptions,
): Promise<{ segments: CameraSegment[] }> {
  const { canvas, frameRate, camera } = options;
  const frameUs = (frameRate.denominator * 1_000_000) / frameRate.numerator;
  const layout: Layout = {
    canvas,
    geometry: {
      canvasAspect: canvas.width / canvas.height,
      cameraAspect: camera.width / camera.height,
    },
  };
  const totalUs = options.frameCount * frameUs;
  const pieces = cameraPieces(options.intervals, totalUs);
  // Output frame where each planned clip starts.
  const starts: number[] = [];
  let at = 0;
  for (const clip of options.clips) {
    starts.push(at);
    at += clip.outputFrames;
  }
  const segments: CameraSegment[] = [];
  let doneFrames = 0;
  const wanted = pieces.reduce(
    (sum, piece) =>
      sum +
      Math.max(
        0,
        Math.ceil(piece.endUs / frameUs) - Math.ceil(piece.startUs / frameUs),
      ),
    0,
  );
  for (const [index, piece] of pieces.entries()) {
    const first = Math.ceil(piece.startUs / frameUs);
    const end = Math.min(options.frameCount, Math.ceil(piece.endUs / frameUs));
    if (end <= first) continue;
    const path = join(options.directory, `camera-${index}.mkv`);
    // Frame-aligned times, so a fade or glide spans whole frames.
    const aligned = {
      ...piece,
      startUs: first * frameUs,
      endUs: end * frameUs,
    };
    const encoder = startProcess(
      options.ffmpeg,
      [
        ...quiet,
        "-f",
        "rawvideo",
        "-pixel_format",
        "bgra",
        "-video_size",
        `${canvas.width}x${canvas.height}`,
        "-framerate",
        `${frameRate.numerator}/${frameRate.denominator}`,
        "-i",
        "pipe:0",
        "-c:v",
        "ffv1",
        "-level",
        "3",
        "-g",
        "1",
        "-pix_fmt",
        "bgra",
        "-f",
        "matroska",
        path,
      ],
      "pipe",
    );
    encoder.stdout?.resume();
    encoder.stdin!.on("error", () => undefined);
    const encoded = exited(encoder);
    encoded.catch(() => undefined);
    try {
      for (const [clipIndex, clip] of options.clips.entries()) {
        if (
          options.cameraSourceId !== undefined &&
          clip.sourceId !== options.cameraSourceId
        )
          continue;
        const clipStart = starts[clipIndex]!;
        const from = Math.max(first, clipStart);
        const to = Math.min(end, clipStart + clip.outputFrames);
        if (to <= from) continue;
        if (options.signal?.aborted)
          throw new MediaError("CANCELLED", "Export cancelled.");
        const count = to - from;
        // Screen frame (and so recording time) of the first output frame.
        const slot = clip.firstFrame + (from - clipStart) * clip.speed;
        const recordingSeconds =
          (slot * frameRate.denominator) / frameRate.numerator;
        const cameraStart = recordingSeconds + camera.offsetUs / 1_000_000;
        const sourceSeconds =
          (count * clip.speed * frameRate.denominator) / frameRate.numerator;
        const localStart =
          ((from - first) * frameRate.denominator) / frameRate.numerator;
        const graph = cameraPieceGraph(aligned, layout, frameRate, localStart);
        const decoder = startProcess(
          options.ffmpeg,
          [
            ...quiet,
            "-ss",
            seconds(Math.max(0, cameraStart)),
            "-t",
            seconds(sourceSeconds + 1),
            "-i",
            camera.path,
            "-an",
            "-filter_complex",
            [
              `[0:v]setpts=(PTS-STARTPTS)/${clip.speed}+${seconds(localStart)}/TB,` +
                `fps=${frameRate.numerator}/${frameRate.denominator}:start_time=${seconds(localStart)},` +
                `tpad=stop_mode=clone:stop_duration=${seconds(sourceSeconds + 2)}[cam]`,
              graph,
            ].join(";"),
            "-map",
            "[out]",
            "-frames:v",
            String(count),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgra",
            "pipe:1",
          ],
          "ignore",
        );
        const decoded = exited(decoder);
        decoded.catch(() => undefined);
        for await (const chunk of decoder.stdout!) {
          if (!encoder.stdin!.write(chunk as Buffer))
            await new Promise<void>((resolve) =>
              encoder.stdin!.once("drain", () => resolve()),
            );
        }
        await decoded;
        doneFrames += count;
        options.onProgress?.(wanted > 0 ? doneFrames / wanted : 1);
      }
      encoder.stdin!.end();
      await encoded;
    } catch (error) {
      encoder.kill();
      throw error;
    }
    segments.push({ path, startFrame: first, frameCount: end - first });
  }
  return { segments };
}

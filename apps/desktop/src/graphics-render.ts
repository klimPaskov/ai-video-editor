import { BrowserWindow } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { syncStage } from "../renderer/stage-control.ts";
import {
  graphicsSegments,
  type GraphicsRenderRequest,
  type GraphicsTrack,
} from "./graphics-track.ts";

/**
 * Renders the graphics of an export with the stage page in an offscreen
 * window, frame by frame, into a lossless track. Frames that cannot have
 * changed since the previous one reuse it.
 */
export async function renderGraphicsTrack(
  request: GraphicsRenderRequest,
  stageUrl: string,
): Promise<GraphicsTrack | null> {
  const segments = graphicsSegments(
    request.intervals,
    request.frameRate,
    request.frameCount,
  );
  if (segments.length === 0) return null;
  const total = segments.reduce((sum, segment) => sum + segment.frameCount, 0);
  const { width, height } = request;
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  let encoder: ChildProcessWithoutNullStreams | null = null;
  try {
    window.setContentSize(width, height);
    window.webContents.setFrameRate(240);
    await window.loadURL(stageUrl);
    const state = {
      width,
      height,
      scale: 1,
      graphics: request.intervals.map((interval) => ({
        id: interval.graphicId,
        startUs: interval.startUs,
        endUs: interval.endUs,
        layer: interval.layer,
        html: interval.html,
        css: interval.css,
      })),
    };
    await window.webContents.executeJavaScript(
      `window.__sync = ${syncStage.toString()}; window.__state = ${JSON.stringify(state)}; 0`,
    );
    const rendered: GraphicsTrack["segments"] = [];
    let previous: Buffer | null = null;
    let done = 0;
    for (const [index, segment] of segments.entries()) {
      const path = join(
        request.directory,
        `graphics-${String(index).padStart(3, "0")}.mkv`,
      );
      encoder = startEncoder(request, path);
      const finished = exited(encoder);
      for (
        let frame = segment.startFrame;
        frame < segment.startFrame + segment.frameCount;
        frame++
      ) {
        if (request.signal?.aborted) throw new Error("Export cancelled.");
        const us = Math.round(
          (frame * request.frameRate.denominator * 1_000_000) /
            request.frameRate.numerator,
        );
        const changed = (await window.webContents.executeJavaScript(
          `__sync(document, __state, ${us})`,
        )) as boolean;
        if (changed || !previous) {
          window.webContents.invalidate();
          const image = await window.webContents.capturePage();
          const size = image.getSize();
          const bitmap = image.toBitmap();
          if (
            size.width !== width ||
            size.height !== height ||
            bitmap.length !== width * height * 4
          )
            throw new Error("The graphics could not be rendered at full size.");
          previous = bitmap;
        }
        await write(encoder, previous);
        done++;
        request.onProgress?.(done / total);
      }
      encoder.stdin.end();
      const code = await finished;
      encoder = null;
      if (code !== 0) throw new Error("The graphics could not be encoded.");
      rendered.push({ ...segment, path });
    }
    return { segments: rendered };
  } catch (error) {
    encoder?.stdin.destroy();
    encoder?.kill("SIGKILL");
    throw error;
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

function startEncoder(
  request: GraphicsRenderRequest,
  path: string,
): ChildProcessWithoutNullStreams {
  return spawn(
    request.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "rawvideo",
      "-pixel_format",
      "bgra",
      "-video_size",
      `${request.width}x${request.height}`,
      "-framerate",
      `${request.frameRate.numerator}/${request.frameRate.denominator}`,
      "-i",
      "pipe:0",
      "-c:v",
      "ffv1",
      "-level",
      "3",
      "-pix_fmt",
      "bgra",
      "-f",
      "matroska",
      path,
    ],
    { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
}

function exited(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  child.stdout.resume();
  child.stderr.resume();
  return new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });
}

function write(
  child: ChildProcessWithoutNullStreams,
  chunk: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.stdin.write(chunk)) resolve();
    else {
      child.stdin.once("drain", resolve);
      child.stdin.once("error", reject);
    }
  });
}

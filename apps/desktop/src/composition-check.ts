import { BrowserWindow } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  settleStage,
  stageReport,
  syncStage,
} from "../renderer/stage-control.ts";
import {
  auditTimes,
  compositionCheckReport,
  type CompositionSample,
  type StageTextFinding,
} from "./composition-check-report.ts";
import { tileSheet } from "./frame-render.ts";

export interface CompositionCheckOptions {
  /** The stage page, e.g. "app-scheme://app/stage.html". */
  stageUrl: string;
  /** A stored, sealed composition. */
  sha256: string;
  /** The video's frame: compositions play at this size. */
  width: number;
  height: number;
  /** Composition times to audit; evenly spread when null. */
  timesUs: number[] | null;
  /** Width of each contact-sheet cell. */
  cellWidth: number;
  ffmpeg: string;
  signal?: AbortSignal;
}

/** A large span, so the stage shows the composition at every audited time. */
const openEndedUs = 24 * 60 * 60 * 1_000_000;

/**
 * Loads one sealed composition in the stage page in an offscreen window, as
 * export does, seeks it to each audited time, collects the stage bridge's
 * audit and a picture of each moment, and returns the report and a contact
 * sheet over a checkerboard (so transparent areas show).
 */
export async function checkComposition(
  options: CompositionCheckOptions,
): Promise<{
  report: Record<string, unknown>;
  sheet: Awaited<ReturnType<typeof tileSheet>> | null;
}> {
  const { width, height } = options;
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: "#1f1f1f",
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
  const scratch = await mkdtemp(path.join(tmpdir(), "ai-video-editor-check-"));
  try {
    window.setContentSize(width, height);
    window.webContents.setFrameRate(60);
    await window.loadURL(options.stageUrl);
    const state = {
      width,
      height,
      scale: 1,
      compositionBase: `${new URL(options.stageUrl).protocol}//composition/`,
      inspect: true,
      graphics: [
        {
          id: "composition-check",
          startUs: 0,
          endUs: openEndedUs,
          layer: 1,
          html: "",
          css: "",
          composition: options.sha256,
        },
      ],
    };
    await window.webContents.executeJavaScript(
      `window.__sync = ${syncStage.toString()}; window.__settle = ${settleStage.toString()}; window.__report = ${stageReport.toString()}; window.__state = ${JSON.stringify(state)}; document.documentElement.style.background = "repeating-conic-gradient(#2a2a2a 0 25%, #1f1f1f 0 50%) 0 0 / 32px 32px"; 0`,
    );
    type Answer = {
      ready: boolean;
      error: string | null;
      duration: number | null;
      report: {
        findings?: StageTextFinding[];
        animations?: number;
        seek?: boolean;
        timelines?: string[];
        declared_size?: { width: number; height: number } | null;
      } | null;
    } | null;
    const seek = async (us: number): Promise<Answer> => {
      if (options.signal?.aborted) throw new Error("Cancelled.");
      await window.webContents.executeJavaScript(
        `__sync(document, __state, ${us})`,
      );
      const problem = (await window.webContents.executeJavaScript(
        "__settle(document, 20000)",
      )) as string | null;
      const answer = (await window.webContents.executeJavaScript(
        "__report(document)",
      )) as Answer;
      // A seek the composition never confirmed is its own problem.
      return problem && answer
        ? { ...answer, ready: false, error: answer.error ?? problem }
        : answer;
    };
    const first = await seek(0);
    const ready = first?.ready === true;
    const durationSeconds = first?.duration ?? null;
    const times = options.timesUs ?? auditTimes(durationSeconds);
    const samples: CompositionSample[] = [];
    let error = first?.error ?? null;
    let timelines = first?.report?.timelines ?? [];
    let animations = first?.report?.animations ?? 0;
    let hasSeek = first?.report?.seek === true;
    let declaredSize = first?.report?.declared_size ?? null;
    let cell: { width: number; height: number } | null = null;
    if (ready)
      for (const [index, us] of times.entries()) {
        const answer = us === 0 && index === 0 ? first : await seek(us);
        error ??= answer?.error ?? null;
        if (answer?.report?.timelines?.length)
          timelines = answer.report.timelines;
        animations = Math.max(animations, answer?.report?.animations ?? 0);
        hasSeek ||= answer?.report?.seek === true;
        declaredSize ??= answer?.report?.declared_size ?? null;
        await window.webContents.executeJavaScript(
          "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(0))))",
        );
        window.webContents.invalidate();
        const image = await window.webContents.capturePage();
        // Even cell sizes keep the sheet's chroma layout simple.
        const cellWidth = Math.round(options.cellWidth / 2) * 2;
        const cellImage = image.resize({
          width: cellWidth,
          height: Math.max(2, Math.round((cellWidth * height) / width / 2) * 2),
          quality: "best",
        });
        cell = cellImage.getSize();
        await writeFile(
          path.join(scratch, `cell-${String(index).padStart(2, "0")}.png`),
          cellImage.toPNG(),
        );
        samples.push({
          timeUs: us,
          findings: answer?.report?.findings ?? [],
          fingerprint: new Uint8Array(
            image.resize({ width: 64, height: 36 }).toBitmap(),
          ),
        });
      }
    const report = compositionCheckReport({
      ready,
      error,
      durationSeconds,
      canvas: { width, height },
      declaredSize,
      timelines,
      animations,
      seek: hasSeek,
      samples,
    });
    const sheet =
      cell && samples.length
        ? await tileSheet({
            ffmpeg: options.ffmpeg,
            directory: scratch,
            count: samples.length,
            cell,
            ...(options.signal ? { signal: options.signal } : {}),
          })
        : null;
    return { report, sheet };
  } finally {
    if (!window.isDestroyed()) window.destroy();
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

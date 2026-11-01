import { DesktopCodex } from "./codex.ts";
import {
  MediaToolsError,
  pathWithMediaTools,
  resolveMediaTools,
} from "./media-tools.ts";
import { ClaudeUserError, DesktopClaude } from "./claude.ts";
import {
  assertClaudeFullEditRequest,
  assertClaudeThreadProjectRequest,
  assertClaudeThreadSendRequest,
  assertClaudeThreadView,
  assertClaudeView,
  claudeThreadIssues,
  type ClaudeThreadView,
} from "../../../packages/domain/src/claude-view.ts";
import { DesktopApiProviders } from "./api-providers.ts";
import { ApiProviderThreads } from "./api-thread.ts";
import { ProviderKeyStore } from "./provider-keys.ts";
import { ApiProviderClient } from "../../../packages/api-providers/src/client.ts";
import { appIdentity } from "../../../packages/domain/src/app-identity.ts";
import {
  assertApiProviderConnectRequest,
  assertApiProviderModelRequest,
  assertApiProviderRequest,
  assertApiProvidersView,
  apiProviderIds,
} from "../../../packages/domain/src/api-providers.ts";
import { assertCodexView } from "../../../packages/domain/src/codex-view.ts";
import {
  assertApiThreadProjectRequest,
  assertApiThreadSendRequest,
  assertApiThreadView,
} from "../../../packages/domain/src/api-thread-view.ts";
import {
  assertDeviceLoginDetails,
  CODEX_DEVICE_VERIFICATION_URL,
} from "../../../packages/domain/src/codex-device-login.ts";
import type { DraftEditIntent } from "../../../packages/domain/src/draft-transaction.ts";
import { PreferencesStore } from "./preferences.ts";
import { DesktopTranscriptionManager } from "./transcription.ts";
import { ProjectStore } from "../../../packages/project-store/src/store.ts";
import {
  DraftTransactionError,
  DraftTransactionStore,
} from "../../../packages/project-store/src/transactions.ts";
import {
  CodexMcpBroker,
  resolveCodexMcpScript,
} from "../../../packages/codex-tools/src/broker.ts";
import {
  CodexVideoEditToolError,
  CodexVideoEditToolService,
  type CameraCatalog,
  type LayoutPlanner,
  type CodexVideoEditToolName,
  type ZoomTargeter,
} from "../../../packages/codex-tools/src/service.ts";
import {
  nativeChildReadOnlyToolNames,
  type DynamicToolAccess,
} from "../../../packages/codex-bridge/src/dynamic-tools.ts";
import {
  assertProjectFrameRequest,
  assertProjectStripRequest,
  assertProjectRequest,
  assertProjectNavigation,
  assertProjectRename,
  assertProjectList,
  assertTwoSourceProjectRequest,
  assertManualTrimRequest,
  assertManualSplitRequest,
  assertManualRangeCutRequest,
  assertManualZoomRequest,
  assertManualZoomRemoveRequest,
  assertManualSpeedRequest,
  assertManualGraphicRequest,
  assertManualGraphicRemoveRequest,
  assertManualLayoutRemoveRequest,
  assertManualLayoutRequest,
  assertManualTransitionRequest,
  assertManualTransitionRemoveRequest,
  assertManualRestoreRangeRequest,
  assertManualTranscriptCorrectionRequest,
  assertManualTranscriptCutRequest,
  assertManualUndoRequest,
  assertManualRedoRequest,
  type ProjectView,
} from "../../../packages/domain/src/project-view.ts";
import { assertPreferences } from "../../../packages/domain/src/preferences.ts";
import {
  assertTranscriptionJobRequest,
  assertTranscriptionProjectRequest,
  assertTranscriptionStopRequest,
} from "../../../packages/domain/src/transcription.ts";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
} from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { channels, assertEmptyRequest } from "./bridge.ts";
import {
  assertFrameRequest,
  assertThumbnail,
  assertThumbnailRequest,
  assertMediaFrame,
  assertMediaList,
  assertMediaSummary,
} from "../../../packages/domain/src/library.ts";
import {
  assertCodexThreadProjectRequest,
  assertCodexThreadSendRequest,
  assertCodexThreadView,
} from "../../../packages/domain/src/codex-thread-view.ts";
import { MediaLibrary } from "../../../packages/media-engine/src/library.ts";
import { MediaError } from "../../../packages/media-engine/src/process.ts";
import {
  assertExportProjectRequest,
  assertExportStartRequest,
  assertExportView,
} from "../../../packages/domain/src/export-view.ts";
import { DesktopExports, planDraft } from "./export.ts";
import {
  DesktopMagicWand,
  type RoughCutEditor,
  type RoughCutOutcome,
} from "./magic-wand.ts";
import { DesktopRecorder, RecordingError } from "./recording.ts";
import { DesktopPlaybackProxies } from "./playback-proxies.ts";
import { CaptionSettingsStore } from "./caption-settings.ts";
import { ProjectSettingsStore } from "./project-settings.ts";
import { removeProjectSideFiles } from "./project-removal.ts";
import {
  assertSoundAddRequest,
  assertSoundRemoveRequest,
  assertSoundUpdateRequest,
  assertSoundsRequest,
  assertSoundsView,
  type SoundsView,
} from "../../../packages/domain/src/sound-view.ts";
import {
  assertCameraOffsetRequest,
  assertCameraRequest,
  assertCameraView,
  idleCameraView,
  type CameraView,
} from "../../../packages/domain/src/camera-view.ts";
import {
  buildSoundLayer,
  SoundBuildError,
  soundIntervals,
} from "../../../packages/domain/src/sounds.ts";
import {
  SoundAssetError,
  SoundAssetStore,
} from "../../../packages/project-store/src/sounds.ts";
import { CameraLinks } from "./camera-links.ts";
import { planLayouts } from "../../../packages/domain/src/layout-plan.ts";
import type { CameraSource } from "../../../packages/media-engine/src/camera-layer.ts";
import { type LayoutChange } from "../../../packages/domain/src/layouts.ts";
import { analyzeScreenActivity } from "../../../packages/media-engine/src/screen-activity.ts";
import { zoomForTarget } from "../../../packages/domain/src/screen-activity.ts";
import { sourceAt, timelineAt } from "../../../packages/domain/src/speed.ts";
import type { ActivityTarget } from "../../../packages/domain/src/screen-activity.ts";
import { decodeEnergyTrack } from "../../../packages/media-engine/src/audio-energy.ts";
import { probeSoundFile } from "../../../packages/media-engine/src/sound-probe.ts";
import { sweepPartialExports, sweepTemporaryFolders } from "./private-notes.ts";
import { roughCutTools } from "./rough-cut-playbook.ts";
import { shortsPickTools } from "./shorts-pick-playbook.ts";
import {
  writeClaudeWorkspace,
  type WorkspaceTimeline,
} from "./claude-workspace.ts";
import { claudeGuides } from "./claude-guides.ts";
import { effectiveAssetPolicy } from "../../../packages/domain/src/preferences.ts";
import {
  cachedPackageFile,
  serveComposition,
  storeComposition,
} from "./composition-server.ts";
import { importComposition, packageFile } from "./composition-import.ts";
import { mirrorUserSkills, userSkillsDirectory } from "./claude-skills.ts";
import type { LocalTranscript } from "../../../packages/domain/src/transcription.ts";
import {
  assertAudioSettings,
  assertAudioSettingsRequest,
  assertAudioSettingsUpdate,
  defaultAudioSettings,
} from "../../../packages/domain/src/audio-settings.ts";
import { DesktopShortClips, ShortClipError } from "./short-clips.ts";
import {
  assertShortClipRequest,
  assertShortClipsView,
  assertShortExportRequest,
  assertShortExportAllRequest,
  assertShortLibraryRequest,
  shortIssues,
  assertShortProjectRequest,
} from "../../../packages/domain/src/short-clips-view.ts";
import {
  assertCaptionSettingsRequest,
  assertCaptionSettingsUpdate,
  buildCaptionCues,
  captionSourceWords,
  captionWordsForDraft,
} from "../../../packages/domain/src/captions.ts";
import {
  assertPlaybackProjectRequest,
  assertPlaybackView,
} from "../../../packages/domain/src/playback-view.ts";
import {
  assertRecordingStartRequest,
  assertRecordingRegionRequest,
  assertInterruptedTakeRequest,
  assertRecordingRegionResult,
  assertRecordingView,
} from "../../../packages/domain/src/recording-view.ts";
import {
  assertMagicWandProjectRequest,
  assertMagicWandStartRequest,
  assertMagicWandView,
} from "../../../packages/domain/src/magic-wand-view.ts";
import {
  DesktopProjectRuntime,
  committedDraftView,
  invokeWithProjectDraftRefresh,
} from "./project-runtime.ts";
import type { ProjectDraftNotice } from "./project-runtime.ts";
import type { ClipSpeed } from "../../../packages/domain/src/speed.ts";
import { zoomSourceRange } from "../../../packages/domain/src/zoom.ts";
import { graphicAnchor } from "../../../packages/domain/src/graphics.ts";
import { cutAt } from "../../../packages/domain/src/transitions.ts";
import { renderGraphicsTrack } from "./graphics-render.ts";
import { renderDraftFrames } from "./frame-render.ts";
import { checkComposition } from "./composition-check.ts";
import { toolCallTimeoutMs } from "../../../packages/codex-tools/src/frames.ts";

const origin = `${appIdentity.urlScheme}://app`;
/** The only page a sealed composition frame may load: a sealed page by hash. */
const compositionFrameUrl = new RegExp(
  `^${appIdentity.urlScheme}://composition/[a-f0-9]{64}[.]html$`,
  "u",
);

/**
 * Downloads one exact pinned jsDelivr file (a composition library or a
 * Fontsource font); callers validate the URL and cache the bytes.
 */
async function fetchPinnedFile(address: string): Promise<Buffer> {
  const limit = 8 * 1024 * 1024;
  const response = await net.fetch(address, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get("content-length") ?? 0) > limit
  )
    throw new Error("File unavailable");
  // Read the body as it arrives and stop at the limit, whatever the headers
  // claim.
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > limit) throw new Error("File too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Sealed HyperFrames compositions, stored by hash (ADR 0021). */
const compositionsRoot = () =>
  path.join(app.getPath("userData"), "compositions");
const page = `${origin}/index.html`;
class UserFacingError extends Error {}
let window: BrowserWindow | undefined;
let importing: AbortController | undefined;
const frameRequests = new Set<AbortController>();
let quitting = false;
let codex: DesktopCodex | undefined;
let mcpBroker: CodexMcpBroker | undefined;
let claude: DesktopClaude | undefined;
let claudeBroker: CodexMcpBroker | undefined;
let transcription: DesktopTranscriptionManager | undefined;
let exports: DesktopExports | undefined;
let magicWandBusy: (projectId: string) => boolean = () => false;
/** Resolves a playable source of the active project; set once services start. */
let resolvePlaybackSource:
  | ((
      projectId: string,
      sourceId: string,
    ) => Promise<{ path: string; mime: string } | null>)
  | undefined;
/** Resolves a project audio file for the preview; set once services start. */
let resolveSoundPreview:
  | ((
      projectId: string,
      assetId: string,
    ) => Promise<{ path: string; mime: string } | null>)
  | undefined;
let servicesClosed = false;
let recorder: DesktopRecorder | undefined;
let playbackProxies: DesktopPlaybackProxies | undefined;
let shortClips: DesktopShortClips | undefined;
app.on("before-quit", (event) => {
  quitting = true;
  if (
    !servicesClosed &&
    (codex ||
      mcpBroker ||
      claude ||
      claudeBroker ||
      transcription ||
      exports ||
      recorder)
  ) {
    event.preventDefault();
    void Promise.allSettled([
      Promise.resolve().then(() => codex?.close()),
      Promise.resolve().then(() => mcpBroker?.close()),
      Promise.resolve()
        .then(() => claude?.close())
        .then(() => claudeBroker?.close()),
      Promise.resolve().then(() => transcription?.close()),
      Promise.resolve().then(() => exports?.close()),
      Promise.resolve().then(() => recorder?.cancel()),
      Promise.resolve().then(() => playbackProxies?.close()),
      Promise.resolve().then(() => shortClips?.close()),
    ]).then(() => {
      servicesClosed = true;
      app.quit();
    });
  }
});
app.setName(appIdentity.slug);
// Reopen prior installs from their existing data directory; new installs use
// the new product slug. This avoids moving or duplicating private project data.
const appDataPath = app.getPath("appData");
const legacyUserDataPath = path.join(
  appDataPath,
  appIdentity.legacyUserDataDirectory,
);
const userDataPath = existsSync(legacyUserDataPath)
  ? legacyUserDataPath
  : path.join(appDataPath, appIdentity.slug);
mkdirSync(userDataPath, { recursive: true });
app.setPath("userData", userDataPath);
app.enableSandbox();
// Compositions may draw with WebGL (three.js, shaders). A machine without a
// usable GPU (or with a blocked driver) gets Chromium's software renderer
// instead of no WebGL at all, so previews and exports still work.
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
protocol.registerSchemesAsPrivileged([
  {
    scheme: appIdentity.urlScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      // Sealed compositions (opaque-origin frames) load ES modules and fetch
      // pinned package files from the composition host: cross-origin
      // requests, which the host answers with CORS headers.
      corsEnabled: true,
      // Range requests let the preview <video> seek inside a source.
      stream: true,
    },
  },
]);

function assertSender(event: IpcMainInvokeEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== page
  ) {
    throw new Error("Untrusted request");
  }
}
function register(
  channel: string,
  work: (request: unknown) => Promise<unknown>,
): void {
  ipcMain.handle(channel, async (event, request: unknown) => {
    assertSender(event);
    try {
      return { ok: true, value: await work(request) };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof UserFacingError || error instanceof ClaudeUserError
            ? error.message
            : "This operation could not finish. Check the file is available and try again.",
      };
    }
  });
}

/**
 * Streams an immutable source of the active project to the preview player,
 * with byte ranges. Nothing outside the project's managed sources is served.
 */
async function servePlaybackSource(
  projectId: string,
  sourceId: string,
  request: Request,
  resolve = resolvePlaybackSource,
): Promise<Response> {
  const notFound = () => new Response("Not found", { status: 404 });
  const resolved = await resolve?.(projectId, sourceId).catch(() => null);
  if (!resolved) return notFound();
  let size: number;
  try {
    const info = await stat(resolved.path);
    if (!info.isFile()) return notFound();
    size = info.size;
  } catch {
    return notFound();
  }
  const range = /^bytes=(\d*)-(\d*)$/u.exec(request.headers.get("range") ?? "");
  let start = 0;
  let end = size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(size - 1, Number(range[2]));
    } else start = Math.max(0, size - Number(range[2]));
    if (!Number.isSafeInteger(start) || start > end || start >= size)
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
  }
  const stream = createReadStream(resolved.path, { start, end });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers: {
      "Content-Type": resolved.mime,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    },
  });
}

/**
 * Shows the area picker over one display and resolves to the dragged area
 * as fractions of the display, or null. Only one picker is open at a time.
 */
let picking: Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
} | null> | null = null;
function pickArea(display: Electron.Display) {
  if (picking) return picking;
  const overlay = new BrowserWindow({
    ...display.bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    show: false,
    title: "Choose an area",
    webPreferences: {
      preload: path.join(app.getAppPath(), "region-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.removeMenu();
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.webContents.on("will-navigate", (event) => event.preventDefault());
  const regionPage = `${origin}/region.html`;
  picking = new Promise((resolve) => {
    let settled = false;
    const settle = (
      value: {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null,
    ) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("region:done", done);
      picking = null;
      if (!overlay.isDestroyed()) overlay.destroy();
      resolve(value);
    };
    const done = (event: Electron.IpcMainEvent, value: unknown) => {
      if (
        event.sender !== overlay.webContents ||
        event.senderFrame?.url !== regionPage
      )
        return;
      const area = value as Record<string, unknown> | null;
      const valid =
        area !== null &&
        typeof area === "object" &&
        ["x", "y", "width", "height"].every(
          (key) =>
            typeof area[key] === "number" &&
            Number.isFinite(area[key]) &&
            (area[key] as number) >= 0 &&
            (area[key] as number) <= 1,
        );
      settle(
        valid
          ? {
              x: area.x as number,
              y: area.y as number,
              width: area.width as number,
              height: area.height as number,
            }
          : null,
      );
    };
    ipcMain.on("region:done", done);
    overlay.on("closed", () => settle(null));
    overlay.once("ready-to-show", () => {
      overlay.show();
      overlay.focus();
    });
    void overlay.loadURL(regionPage).catch(() => settle(null));
  });
  return picking;
}

async function start(): Promise<void> {
  // The verified bundled FFmpeg/ffprobe (Windows installs) or the system pair.
  const mediaTools = await resolveMediaTools(process.resourcesPath);
  const toolsPath = pathWithMediaTools(mediaTools, process.env.PATH);
  if (toolsPath !== undefined) process.env.PATH = toolsPath;
  const mediaExecutables = {
    ffmpeg: mediaTools.ffmpeg,
    ffprobe: mediaTools.ffprobe,
  };
  const files = new Map([
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/renderer.js", ["renderer.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]],
    ["/region.html", ["region.html", "text/html; charset=utf-8"]],
    ["/region.js", ["region.js", "text/javascript; charset=utf-8"]],
    ["/region.css", ["region.css", "text/css; charset=utf-8"]],
    ["/stage.html", ["stage.html", "text/html; charset=utf-8"]],
    ["/stage.css", ["stage.css", "text/css; charset=utf-8"]],
  ]);
  // Fail before opening a product window if any required packaged resource is absent.
  const preload = await readFile(path.join(app.getAppPath(), "preload.cjs"));
  if (!preload.length) throw new Error("Required preload is empty");
  const assets = new Map<string, { bytes: Buffer; mime: string }>();
  for (const [route, [filename, mime]] of files) {
    const bytes = await readFile(
      path.join(app.getAppPath(), "renderer", filename!),
    );
    if (!bytes.length) throw new Error("Required renderer resource is empty");
    assets.set(route, { bytes, mime: mime! });
  }
  // Sealed HyperFrames compositions and their pinned libraries (ADR 0021).
  const compositionPackaged = {
    runtime: await readFile(
      path.join(
        app.getAppPath(),
        "renderer",
        "vendor",
        "hyperframes-runtime.js",
      ),
    ),
    bridge: await readFile(
      path.join(app.getAppPath(), "renderer", "stage-bridge.js"),
    ),
  };
  protocol.handle(appIdentity.urlScheme, async (request) => {
    const url = new URL(request.url);
    if (url.host === "composition") {
      if (request.method !== "GET" || url.search)
        return new Response("Not found", { status: 404 });
      return serveComposition(url.pathname, {
        scheme: appIdentity.urlScheme,
        compositions: compositionsRoot(),
        libraryCache: path.join(app.getPath("userData"), "library-cache"),
        packaged: compositionPackaged,
        fetchLibrary: fetchPinnedFile,
      });
    }
    const media =
      /^\/media\/([A-Za-z0-9][A-Za-z0-9._-]{1,127})\/([A-Za-z0-9][A-Za-z0-9._-]{1,127})$/u.exec(
        url.pathname,
      );
    if (media && url.host === "app" && !url.search && request.method === "GET")
      return servePlaybackSource(media[1]!, media[2]!, request);
    const sound =
      /^\/sounds\/([A-Za-z0-9][A-Za-z0-9._-]{1,127})\/([A-Za-z0-9][A-Za-z0-9._-]{1,127})$/u.exec(
        url.pathname,
      );
    if (sound && url.host === "app" && !url.search && request.method === "GET")
      return servePlaybackSource(
        sound[1]!,
        sound[2]!,
        request,
        resolveSoundPreview,
      );
    const asset = assets.get(url.pathname);
    if (request.method !== "GET" || url.host !== "app" || url.search || !asset)
      return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(asset.bytes), {
      headers: {
        "Content-Type": asset.mime,
        "Content-Security-Policy":
          url.pathname === "/stage.html"
            ? // Graphics: their own inline styles and data: images; no
              // scripts, network, forms or navigation. The only frames are
              // sealed compositions, which run in their own opaque origin.
              `default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src data:; font-src 'self'; frame-src ${appIdentity.urlScheme}://composition; base-uri 'none'; form-action 'none'`
            : "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'",
      },
    });
  });
  // Only the player's full-screen button is allowed, and only for the app's
  // own pages; every other permission stays denied.
  const ownPage = (url: string | undefined) =>
    !!url && url.startsWith(`${appIdentity.urlScheme}://`);
  session.defaultSession.setPermissionRequestHandler(
    (_contents, permission, callback, details) =>
      callback(permission === "fullscreen" && ownPage(details.requestingUrl)),
  );
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      permission === "fullscreen" && ownPage(requestingOrigin),
  );
  session.defaultSession.on("will-download", (event) => event.preventDefault());
  // The app's pages (and the sealed compositions in them) never reach the
  // network: they load packaged content over the app scheme only. This
  // default-deny filter sits under each page's Content Security Policy as a
  // second layer, for channels a policy may not cover (preconnect, WebSocket,
  // WebRTC signalling). The main process's own downloads of pinned package
  // files (net.fetch) belong to no page and pass.
  session.defaultSession.webRequest.onBeforeRequest(
    {
      urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*", "ftp://*/*"],
    },
    (details, callback) =>
      callback({ cancel: details.webContentsId !== undefined }),
  );
  app.on("web-contents-created", (_event, contents) => {
    // No WebRTC connection can be made, so no address can leak through ICE.
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    // Nothing in any window, the hidden export and check windows included,
    // navigates a frame away from the app's own pages.
    contents.on("will-frame-navigate", (event) => {
      if (!event.url.startsWith(`${appIdentity.urlScheme}://`))
        event.preventDefault();
    });
  });
  const preferences = new PreferencesStore(
    path.join(app.getPath("userData"), "preferences"),
  );
  let committedScale = 1;
  try {
    committedScale = (await preferences.read()).interfaceScale;
  } catch {
    /* Renderer reports the read failure through validated IPC. */
  }
  register(channels.preferencesGet, async (request) => {
    assertEmptyRequest(request);
    return preferences.read();
  });
  register(channels.preferencesSet, async (request) => {
    assertPreferences(request);
    const value = await preferences.write(request);
    committedScale = value.interfaceScale;
    window?.webContents.setZoomFactor(value.interfaceScale);
    return value;
  });
  const userData = app.getPath("userData");
  const cameraLinks = new CameraLinks(path.join(userData, "camera-links"));
  const library = new MediaLibrary(
    path.join(userData, "media-library"),
    mediaExecutables,
  );
  const projectRoot = path.join(userData, "project-store");
  const projects = new ProjectStore(projectRoot, library);
  const drafts = new DraftTransactionStore(projectRoot, projects);
  // The project's music and sound effects: copied in, hashed, never changed.
  const soundAssets = new SoundAssetStore(projectRoot, (file, signal) =>
    probeSoundFile(file, {
      ...(signal ? { signal } : {}),
    }),
  );
  const projectRuntime = new DesktopProjectRuntime(drafts, library);
  const captionSettings = new CaptionSettingsStore(
    path.join(userData, "caption-settings"),
  );
  const audioSettings = new ProjectSettingsStore(
    path.join(userData, "audio-settings"),
    assertAudioSettings,
    defaultAudioSettings,
  );
  // Caption and audio choices are part of the draft, so they share Undo with
  // every other edit. Projects whose draft has none yet keep the per-project
  // choice saved by earlier versions (read only) until the first change.
  const sameSettings = (a: object, b: object) =>
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(
      ([key, value]) => (b as Record<string, unknown>)[key] === value,
    );
  const effectiveCaptions = async (projectId: string) =>
    (await drafts.snapshot(projectId)).draft.timeline.captions ??
    (await captionSettings.get(projectId));
  const effectiveAudio = async (projectId: string) =>
    (await drafts.snapshot(projectId)).draft.timeline.audio ??
    (await audioSettings.get(projectId));
  const setDraftPresentation = async <T extends object>(
    projectId: string,
    kind: "captions" | "audio",
    settings: T,
  ): Promise<T> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { draft } = await drafts.snapshot(projectId);
      const current =
        kind === "captions"
          ? await effectiveCaptions(projectId)
          : await effectiveAudio(projectId);
      if (sameSettings(current, settings)) return settings;
      try {
        await invokeWithProjectDraftRefresh({
          toolName:
            kind === "captions" ? "captions.configure" : "audio.configure",
          projectId,
          activeProjectId: () => activeProjectId,
          drafts,
          notify: publishDraftNotice,
          work: () =>
            drafts.applyManual({
              schema_version: "1.0",
              request_id: randomUUID(),
              project_id: projectId,
              draft_id: draft.draft_id,
              base_revision_id: draft.base_revision_id,
              expected_sequence: draft.draft_sequence,
              expected_timeline_sha256: draft.timeline_sha256,
              pass_group: { pass_group_id: randomUUID(), kind },
              reason:
                kind === "captions" ? "Change captions." : "Change audio.",
              operations: [
                kind === "captions"
                  ? { type: "set_captions", captions: settings as never }
                  : { type: "set_audio", audio: settings as never },
              ],
            }),
        });
        return settings;
      } catch (error) {
        if (error instanceof DraftTransactionError && error.code === "stale")
          continue;
        if (error instanceof DraftTransactionError)
          throw new UserFacingError(error.message);
        throw error;
      }
    }
    throw new UserFacingError("The draft changed. Try again.");
  };
  register(channels.audioGet, async (request) => {
    assertAudioSettingsRequest(request);
    return effectiveAudio(request.project_id);
  });
  register(channels.audioSet, async (request) => {
    assertAudioSettingsUpdate(request);
    if (activeProjectId !== request.project_id)
      throw new UserFacingError("Open this project before changing audio.");
    return setDraftPresentation(request.project_id, "audio", request.settings);
  });
  /** The Sound card: the draft's layers, where they play and their files. */
  const soundsView = async (projectId: string): Promise<SoundsView> => {
    const { draft } = await drafts.snapshot(projectId);
    const sounds = draft.timeline.sounds ?? [];
    const assets = new Map(
      (await soundAssets.list(projectId)).map((asset) => [
        asset.asset_id,
        asset,
      ]),
    );
    const placed = soundIntervals(
      sounds,
      draft.timeline.clips.map((clip) => ({
        sourceId: clip.source_id,
        timelineStartUs: clip.timeline_start_us,
        timelineEndUs: clip.timeline_end_us,
        sourceStartUs: clip.source_start_us,
        sourceEndUs: clip.source_end_us,
        ...(clip.speed ? { speed: clip.speed } : {}),
      })),
      draft.timeline.duration_us,
    );
    const view: SoundsView = {
      schema_version: "1.0",
      project_id: projectId,
      layers: sounds.map((sound) => {
        const interval = placed.find((item) => item.soundId === sound.sound_id);
        return {
          sound_id: sound.sound_id,
          name: sound.name,
          kind: sound.kind,
          file_name: assets.get(sound.asset_id)?.name ?? sound.name,
          asset_id: sound.asset_id,
          asset_start_us: sound.asset_start_us,
          fade_in_us: interval?.fadeInUs ?? sound.fade_in_us,
          fade_out_us: interval?.fadeOutUs ?? sound.fade_out_us,
          gain_db: sound.gain_db,
          duck_db: sound.duck_db,
          loop: sound.loop,
          timeline_range: interval
            ? { start_us: interval.startUs, end_us: interval.endUs }
            : null,
        };
      }),
    };
    assertSoundsView(view);
    return view;
  };
  /** One undoable manual change to the draft's sound layers. */
  const changeSounds = async (
    projectId: string,
    reason: string,
    operation: (
      draft: Awaited<ReturnType<typeof drafts.snapshot>>["draft"],
    ) => DraftEditIntent | null,
  ): Promise<void> => {
    if (activeProjectId !== projectId)
      throw new UserFacingError("Open this project before changing sound.");
    for (let attempt = 0; attempt < 3; attempt++) {
      const { draft } = await drafts.snapshot(projectId);
      const next = operation(draft);
      if (!next) return;
      try {
        await invokeWithProjectDraftRefresh({
          toolName: "sound.set",
          projectId,
          activeProjectId: () => activeProjectId,
          drafts,
          notify: publishDraftNotice,
          work: () =>
            drafts.applyManual({
              schema_version: "1.0",
              request_id: randomUUID(),
              project_id: projectId,
              draft_id: draft.draft_id,
              base_revision_id: draft.base_revision_id,
              expected_sequence: draft.draft_sequence,
              expected_timeline_sha256: draft.timeline_sha256,
              pass_group: { pass_group_id: randomUUID(), kind: "audio" },
              reason,
              operations: [next],
            }),
        });
        return;
      } catch (error) {
        if (error instanceof DraftTransactionError && error.code === "stale")
          continue;
        if (error instanceof DraftTransactionError)
          throw new UserFacingError(error.message);
        throw error;
      }
    }
    throw new UserFacingError("The draft changed. Try again.");
  };
  register(channels.soundsGet, async (request) => {
    assertSoundsRequest(request);
    return soundsView(request.project_id);
  });
  let addingSound = false;
  register(channels.soundsAdd, async (request) => {
    assertSoundAddRequest(request);
    if (activeProjectId !== request.project_id)
      throw new UserFacingError("Open this project before adding sound.");
    if (addingSound || !window)
      throw new UserFacingError("A sound is already being added.");
    addingSound = true;
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: request.kind === "music" ? "Add music" : "Add sound effect",
        properties: ["openFile"],
        filters: [
          {
            name: "Audio",
            extensions: ["mp3", "wav", "flac", "ogg", "m4a", "aac", "opus"],
          },
        ],
      });
      const file = selected.filePaths[0];
      if (selected.canceled || !file) return soundsView(request.project_id);
      let asset;
      try {
        asset = await soundAssets.import(request.project_id, file);
      } catch (error) {
        if (error instanceof SoundAssetError)
          throw new UserFacingError(error.message);
        throw error;
      }
      await changeSounds(request.project_id, "Add sound.", (draft) => {
        try {
          return {
            type: "set_sound",
            sound: buildSoundLayer(
              {
                name: asset.name,
                kind: request.kind,
                asset,
                startUs: Math.min(
                  request.start_us,
                  Math.max(0, draft.timeline.duration_us - 1),
                ),
              },
              draft.timeline,
              () => `sound-${randomUUID().replaceAll("-", "")}`,
            ),
          };
        } catch (error) {
          if (error instanceof SoundBuildError)
            throw new UserFacingError(error.message);
          throw error;
        }
      });
      return soundsView(request.project_id);
    } finally {
      addingSound = false;
    }
  });
  register(channels.soundsUpdate, async (request) => {
    assertSoundUpdateRequest(request);
    await changeSounds(request.project_id, "Change sound.", (draft) => {
      const current = draft.timeline.sounds?.find(
        (item) => item.sound_id === request.sound_id,
      );
      if (!current) throw new UserFacingError("That sound was removed.");
      if (
        current.gain_db === request.gain_db &&
        current.duck_db === request.duck_db
      )
        return null;
      return {
        type: "set_sound",
        sound: {
          ...current,
          gain_db: request.gain_db,
          duck_db: request.duck_db,
        },
      };
    });
    return soundsView(request.project_id);
  });
  register(channels.soundsRemove, async (request) => {
    assertSoundRemoveRequest(request);
    await changeSounds(request.project_id, "Remove sound.", (draft) =>
      draft.timeline.sounds?.some((item) => item.sound_id === request.sound_id)
        ? { type: "remove_sound", sound_id: request.sound_id }
        : null,
    );
    return soundsView(request.project_id);
  });
  /** Captions for the current draft when they are on and a transcript exists. */
  const draftCaptions = async (projectId: string) => {
    const settings = await effectiveCaptions(projectId);
    if (!settings.enabled) return null;
    const view = await transcription!.get({
      schema_version: "1.0",
      project_id: projectId,
      job_id: null,
    });
    if (view.results.length === 0) return null;
    const project = await projectRuntime.view(projectId);
    const cues = buildCaptionCues(
      captionWordsForDraft(
        captionSourceWords(view.results, project.transcriptEdits ?? []),
        project.clips ?? [],
      ),
    );
    return cues.length ? { cues, settings } : null;
  };
  shortClips = new DesktopShortClips({
    ...mediaExecutables,
    root: path.join(userData, "short-clips"),
    renderGraphics: (request) =>
      renderGraphicsTrack(request, `${origin}/stage.html`),
    drafts,
    draftWords: async (projectId) => {
      const project = await projectRuntime.view(projectId);
      const view = await transcription!.get({
        schema_version: "1.0",
        project_id: projectId,
        job_id: null,
      });
      return {
        words:
          view.results.length === 0
            ? null
            : captionWordsForDraft(
                captionSourceWords(view.results, project.transcriptEdits ?? []),
                project.clips ?? [],
              ),
        sequence: project.draft.sequence,
        timelineSha256: project.draft.timelineSha256,
      };
    },
    captionSettings: effectiveCaptions,
    audioSettings: effectiveAudio,
    defaultDirectory: () => app.getPath("videos"),
    chooseFolder: async (defaultPath) => {
      if (!window) return null;
      const chosen = await dialog.showOpenDialog(window, {
        title: "Export all clips to a folder",
        defaultPath,
        properties: ["openDirectory", "createDirectory"],
      });
      return chosen.canceled || !chosen.filePaths[0]
        ? null
        : chosen.filePaths[0];
    },
    reveal: (file) => shell.showItemInFolder(file),
    pickRunning: (projectId) => claude?.runKind(projectId) === "shorts_pick",
    startPick: async (projectId) => {
      if (!claude || (await claude.settled()).status !== "signed_in")
        throw new ShortClipError(shortIssues.pickSignIn);
      if (claude.runKind(projectId))
        throw new ShortClipError(shortIssues.pickBusy);
      try {
        await claude.startShortsPick(projectId);
      } catch (error) {
        throw new ShortClipError(
          error instanceof ClaudeUserError
            ? error.message
            : shortIssues.pickFailed,
        );
      }
    },
    chooseDestination: async (defaultPath) => {
      if (!window) return null;
      const chosen = await dialog.showSaveDialog(window, {
        title: "Export short clip",
        defaultPath,
        filters: [{ name: "MP4 video", extensions: ["mp4"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
    },
  });
  const shorts = async (projectId: string, work: () => Promise<unknown>) => {
    if (activeProjectId !== projectId)
      throw new UserFacingError("Open this project before making clips.");
    try {
      const value = await work();
      assertShortClipsView(value);
      return value;
    } catch (error) {
      if (error instanceof ShortClipError)
        throw new UserFacingError(error.message);
      throw error;
    }
  };
  register(channels.shortsGet, async (request) => {
    assertShortProjectRequest(request);
    return shorts(request.project_id, () =>
      shortClips!.view(request.project_id),
    );
  });
  register(channels.shortsFind, async (request) => {
    assertShortProjectRequest(request);
    return shorts(request.project_id, () =>
      shortClips!.find(request.project_id),
    );
  });
  register(channels.shortsDiscard, async (request) => {
    assertShortClipRequest(request);
    return shorts(request.project_id, () =>
      shortClips!.discard(request.project_id, request.clip_id),
    );
  });
  register(channels.shortsExport, async (request) => {
    assertShortExportRequest(request);
    return shorts(request.project_id, () => shortClips!.export(request));
  });
  register(channels.shortsExportAll, async (request) => {
    assertShortExportAllRequest(request);
    return shorts(request.project_id, () => shortClips!.exportAll(request));
  });
  register(channels.shortsReveal, async (request) => {
    assertShortLibraryRequest(request);
    return shorts(request.project_id, () =>
      shortClips!.reveal(request.project_id, request.export_id),
    );
  });
  register(channels.shortsForget, async (request) => {
    assertShortLibraryRequest(request);
    return shorts(request.project_id, () =>
      shortClips!.forget(request.project_id, request.export_id),
    );
  });
  register(channels.shortsPick, async (request) => {
    assertShortProjectRequest(request);
    return shorts(request.project_id, () =>
      shortClips!.pick(request.project_id),
    );
  });
  register(channels.shortsCancel, async (request) => {
    assertShortProjectRequest(request);
    return shorts(request.project_id, () =>
      shortClips!.cancel(request.project_id),
    );
  });
  register(channels.captionsGet, async (request) => {
    assertCaptionSettingsRequest(request);
    return effectiveCaptions(request.project_id);
  });
  register(channels.captionsSet, async (request) => {
    assertCaptionSettingsUpdate(request);
    if (activeProjectId !== request.project_id)
      throw new UserFacingError("Open this project before changing captions.");
    return setDraftPresentation(
      request.project_id,
      "captions",
      request.settings,
    );
  });
  recorder = new DesktopRecorder({
    ...mediaExecutables,
    root: path.join(userData, "recordings"),
    platform: process.platform,
    env: process.env,
    importFile: (file) => library.importFile(file),
    onCamera: (screenMediaId, cameraMediaId) =>
      cameraLinks.rememberPending(screenMediaId, cameraMediaId),
    displays: () =>
      screen.getAllDisplays().map((display, index) => {
        // Capture uses physical pixels; Windows maps per-monitor DPI itself.
        const bounds =
          process.platform === "win32"
            ? screen.dipToScreenRect(null, display.bounds)
            : {
                x: Math.round(display.bounds.x * display.scaleFactor),
                y: Math.round(display.bounds.y * display.scaleFactor),
                width: Math.round(display.bounds.width * display.scaleFactor),
                height: Math.round(display.bounds.height * display.scaleFactor),
              };
        return {
          id: `display-${index + 1}`,
          label:
            display.label && display.label.length <= 200
              ? display.label
              : `Display ${index + 1}`,
          ...bounds,
          primary: display.id === screen.getPrimaryDisplay().id,
        };
      }),
    // Captures stop by themselves if this app quits or crashes.
    supervisor: {
      executable: process.execPath,
      script: path.join(
        process.resourcesPath,
        "capture",
        "capture-supervisor.cjs",
      ),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
    pickArea: (displayId) => {
      const displays = screen.getAllDisplays();
      const index = /^display-(\d{1,2})$/u.exec(displayId);
      // The synthetic test display is shown over the primary display.
      const display = index
        ? displays[Number(index[1]) - 1]
        : screen.getPrimaryDisplay();
      return display ? pickArea(display) : Promise.resolve(null);
    },
  });
  const recording = async (work: () => Promise<unknown>) => {
    try {
      const value = await work();
      assertRecordingView(value);
      return value;
    } catch (error) {
      if (error instanceof RecordingError)
        throw new UserFacingError(error.message);
      throw error;
    }
  };
  register(channels.recordingDevices, async (request) => {
    assertEmptyRequest(request);
    return recorder!.devices();
  });
  register(channels.recordingGet, async (request) => {
    assertEmptyRequest(request);
    return recording(async () => recorder!.get());
  });
  register(channels.recordingInterrupted, async (request) => {
    assertEmptyRequest(request);
    return recorder!.interrupted();
  });
  register(channels.recordingRecover, async (request) => {
    assertInterruptedTakeRequest(request);
    return recording(() => recorder!.recover(request.take_id));
  });
  register(channels.recordingDiscardInterrupted, async (request) => {
    assertInterruptedTakeRequest(request);
    return recorder!.discardInterrupted(request.take_id);
  });
  register(channels.recordingPickRegion, async (request) => {
    assertRecordingRegionRequest(request);
    try {
      const value = { region: await recorder!.pickRegion(request.display_id) };
      assertRecordingRegionResult(value);
      return value;
    } catch (error) {
      if (error instanceof RecordingError)
        throw new UserFacingError(error.message);
      throw error;
    } finally {
      window?.focus();
    }
  });
  // During a take the window shrinks to a small bar in a corner and is kept
  // out of the capture, so the controls are never in the middle of the
  // recorded screen. Everything is put back when the take ends.
  let beforeRecording: {
    bounds: Electron.Rectangle;
    maximized: boolean;
    minimum: [number, number];
  } | null = null;
  const collapseForRecording = () => {
    if (!window || beforeRecording) return;
    beforeRecording = {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      minimum: window.getMinimumSize() as [number, number],
    };
    if (window.isMaximized()) window.unmaximize();
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const width = Math.round(380 * committedScale);
    const height = Math.round(96 * committedScale);
    window.setMinimumSize(1, 1);
    window.setResizable(false);
    window.setContentProtection(true);
    window.setAlwaysOnTop(true, "screen-saver");
    window.setBounds({
      width,
      height,
      x: area.x + area.width - width - 16,
      y: area.y + area.height - height - 16,
    });
  };
  const restoreAfterRecording = () => {
    const saved = beforeRecording;
    beforeRecording = null;
    if (!window || !saved) return;
    window.setAlwaysOnTop(false);
    window.setContentProtection(false);
    window.setResizable(true);
    window.setMinimumSize(...saved.minimum);
    window.setBounds(saved.bounds);
    if (saved.maximized) window.maximize();
    window.focus();
  };
  register(channels.recordingStart, async (request) => {
    assertRecordingStartRequest(request);
    collapseForRecording();
    // Let the bar settle on screen before the first frame is captured.
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      return await recording(() => recorder!.start(request));
    } catch (error) {
      restoreAfterRecording();
      throw error;
    }
  });
  register(channels.recordingPause, async (request) => {
    assertEmptyRequest(request);
    return recording(() => recorder!.pause());
  });
  register(channels.recordingResume, async (request) => {
    assertEmptyRequest(request);
    return recording(() => recorder!.resume());
  });
  register(channels.recordingStop, async (request) => {
    assertEmptyRequest(request);
    try {
      return await recording(() => recorder!.stop());
    } finally {
      restoreAfterRecording();
    }
  });
  register(channels.recordingCancel, async (request) => {
    assertEmptyRequest(request);
    try {
      return await recording(() => recorder!.cancel());
    } finally {
      restoreAfterRecording();
    }
  });
  // Leftovers of an export or picture render that was interrupted last time.
  void sweepTemporaryFolders().catch(() => undefined);
  void sweepPartialExports(path.join(userData, "exports")).catch(
    () => undefined,
  );
  exports = new DesktopExports({
    ...mediaExecutables,
    camera: (projectId, sourceId) => cameraSourceFor(projectId, sourceId),
    renderGraphics: (request) =>
      renderGraphicsTrack(request, `${origin}/stage.html`),
    captions: draftCaptions,
    audio: effectiveAudio,
    soundFile: async (projectId, assetId, sha256) =>
      (await soundAssets.resolve(projectId, assetId, sha256)).path,
    drafts,
    recordRoot: path.join(userData, "exports"),
    defaultDirectory: () => app.getPath("videos"),
    chooseDestination: async ({ defaultPath, profile }) => {
      if (!window) return null;
      const lossless = profile === "lossless_master";
      const chosen = await dialog.showSaveDialog(window, {
        title: lossless ? "Export lossless master" : "Export smaller file",
        defaultPath,
        filters: lossless
          ? [{ name: "Matroska video (lossless)", extensions: ["mkv"] }]
          : [{ name: "MP4 video", extensions: ["mp4"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
      return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
    },
    showInFolder: (file) => shell.showItemInFolder(file),
    openFile: async (file) => {
      const failure = await shell.openPath(file);
      if (failure) throw new UserFacingError("The video could not be opened.");
    },
  });
  playbackProxies = new DesktopPlaybackProxies({
    ffmpeg: mediaExecutables.ffmpeg,
    root: path.join(userData, "playback-proxies"),
  });
  const playbackSources = async (projectId: string) => {
    const { project } = await drafts.snapshotWithProject(projectId);
    const sources =
      project.schema_version === "1.1" ? project.sources : [project.source];
    const probes =
      project.schema_version === "1.1"
        ? project.source_probes
        : [project.source_probe];
    const found = sources.map((source, index) => ({
      id: source.source_id,
      sha256: source.sha256,
      path: source.managed_path,
      probe: probes[index] as unknown,
    }));
    // The camera of the project plays from its own copy like any source.
    const link = await cameraLinks.forSource(projectId, sources[0]!.source_id);
    if (link) {
      const media = await library.verifiedSource(link.mediaId);
      found.push({
        id: "camera",
        sha256: media.sha256,
        path: media.managedPath,
        probe: media.probe as unknown,
      });
    }
    return found;
  };
  register(channels.playbackGet, async (request) => {
    assertPlaybackProjectRequest(request);
    if (activeProjectId !== request.project_id)
      throw new UserFacingError("Open this project before playing it.");
    const value = await playbackProxies!.view(
      await playbackSources(request.project_id),
    );
    assertPlaybackView(value);
    return value;
  });
  const verifiedSoundPreviews = new Map<
    string,
    { path: string; size: number; mtimeMs: number }
  >();
  resolveSoundPreview = async (projectId, assetId) => {
    if (activeProjectId !== projectId) return null;
    // Hashing a long file for every byte-range request would stall playback:
    // verify once, and again only when the file's size or time changes.
    const key = `${projectId}/${assetId}`;
    const known = verifiedSoundPreviews.get(key);
    let file: { path: string };
    const info = known ? await stat(known.path).catch(() => null) : null;
    if (known && info?.size === known.size && info.mtimeMs === known.mtimeMs)
      file = known;
    else {
      file = await soundAssets.resolve(projectId, assetId);
      const after = await stat(file.path);
      verifiedSoundPreviews.set(key, {
        path: file.path,
        size: after.size,
        mtimeMs: after.mtimeMs,
      });
    }
    const extension = path.extname(file.path).toLowerCase();
    const mime =
      {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".opus": "audio/ogg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
      }[extension] ?? "application/octet-stream";
    return { path: file.path, mime };
  };
  resolvePlaybackSource = async (projectId, sourceId) => {
    if (activeProjectId !== projectId) return null;
    const { project } = await drafts.snapshotWithProject(projectId);
    if (sourceId === "camera") {
      const first =
        project.schema_version === "1.1" ? project.sources[0]! : project.source;
      const link = await cameraLinks.forSource(projectId, first.source_id);
      if (!link) return null;
      const media = await library.verifiedSource(link.mediaId);
      const format = (media.probe as { format?: { format_name?: unknown } })
        .format?.format_name;
      const name = typeof format === "string" ? format : "";
      return playbackProxies!.resolve(
        {
          sha256: media.sha256,
          path: media.managedPath,
          probe: media.probe as unknown,
        },
        name.includes("mp4")
          ? "video/mp4"
          : name.includes("matroska")
            ? "video/x-matroska"
            : "application/octet-stream",
      );
    }
    const sources =
      project.schema_version === "1.1" ? project.sources : [project.source];
    const probes =
      project.schema_version === "1.1"
        ? project.source_probes
        : [project.source_probe];
    const index = sources.findIndex((source) => source.source_id === sourceId);
    if (index < 0) return null;
    const format = (probes[index] as { format?: { format_name?: unknown } })
      .format?.format_name;
    const name = typeof format === "string" ? format : "";
    const mime = name.includes("mp4")
      ? "video/mp4"
      : name.includes("webm")
        ? "video/webm"
        : name.includes("matroska")
          ? "video/x-matroska"
          : "application/octet-stream";
    // Sources Chromium cannot decode are served through their playback copy.
    return playbackProxies!.resolve(
      {
        sha256: sources[index]!.sha256,
        path: sources[index]!.managed_path,
        probe: probes[index] as unknown,
      },
      mime,
    );
  };
  const activeExportProject = (projectId: string) => {
    if (activeProjectId !== projectId)
      throw new UserFacingError("Open this project before exporting.");
  };
  register(channels.exportGet, async (request) => {
    assertExportProjectRequest(request);
    activeExportProject(request.project_id);
    const value = exports!.get(request.project_id);
    assertExportView(value);
    return value;
  });
  register(channels.exportStart, async (request) => {
    assertExportStartRequest(request);
    activeExportProject(request.project_id);
    try {
      const value = await exports!.start(request.project_id, request.profile);
      assertExportView(value);
      return value;
    } catch (error) {
      if (error instanceof MediaError) throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.exportCancel, async (request) => {
    assertExportProjectRequest(request);
    const value = exports!.cancel(request.project_id);
    assertExportView(value);
    return value;
  });
  register(channels.exportReset, async (request) => {
    assertExportProjectRequest(request);
    const value = exports!.reset(request.project_id);
    assertExportView(value);
    return value;
  });
  register(channels.exportReveal, async (request) => {
    assertExportProjectRequest(request);
    exports!.reveal(request.project_id);
    return null;
  });
  register(channels.exportOpen, async (request) => {
    assertExportProjectRequest(request);
    await exports!.openResult(request.project_id);
    return null;
  });
  transcription = new DesktopTranscriptionManager({
    projects,
    library,
    userData,
    workerPath: path.join(app.getAppPath(), "transcription-worker.mjs"),
  });
  let activeProjectId: string | undefined;
  const activeAutoEditProject = async (projectId: string): Promise<void> => {
    if (activeProjectId !== projectId)
      throw new UserFacingError("Open this project before transcribing.");
    const project = await projectRuntime.view(projectId);
    if (activeProjectId !== projectId)
      throw new UserFacingError("The active project changed. Try again.");
    if (project.stage !== "auto_edit")
      throw new UserFacingError("Switch to Magic Edit to transcribe locally.");
  };
  const activeTranscriptProject = async (projectId: string): Promise<void> => {
    if (activeProjectId !== projectId)
      throw new UserFacingError(
        "Open this project before reading its transcript.",
      );
    const project = await projectRuntime.view(projectId);
    if (activeProjectId !== projectId)
      throw new UserFacingError("The active project changed. Try again.");
    if (project.stage !== "auto_edit" && project.stage !== "edit")
      throw new UserFacingError(
        "Switch to Magic Edit or Refine to view the transcript.",
      );
  };
  const readTranscriptForTool = async (projectId: string) => {
    await activeTranscriptProject(projectId);
    const value = await transcription!.get({
      schema_version: "1.0",
      project_id: projectId,
      job_id: null,
    });
    if (activeProjectId !== projectId)
      throw new UserFacingError(
        "The active project changed. Refresh the transcript.",
      );
    return value;
  };
  const publishDraftNotice = (notice: ProjectDraftNotice): void => {
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channels.projectDraftChanged, notice);
  };
  // Rendered pictures for media.get_frames, through the export compositor.
  // One render at a time keeps offscreen graphics and FFmpeg work bounded.
  let frameQueue: Promise<unknown> = Promise.resolve();
  const renderFramesForTool = (
    projectId: string,
    timesUs: number[],
    maxWidth: number,
    layout: "frames" | "sheet" = "frames",
  ) => {
    // The assistant stops waiting after the tool-call limit; a render it
    // gave up on stops too instead of holding up the next request.
    const signal = AbortSignal.timeout(toolCallTimeoutMs);
    const work = frameQueue.then(() =>
      renderDraftFrames({
        ...mediaExecutables,
        drafts,
        projectId,
        timesUs,
        maxWidth,
        signal,
        sheet: layout === "sheet",
        captions: () => draftCaptions(projectId),
        renderGraphics: (request) =>
          renderGraphicsTrack(request, `${origin}/stage.html`),
        camera: (project, source) => cameraSourceFor(project, source),
      }),
    );
    frameQueue = work.catch(() => undefined);
    return work;
  };
  const invokeCodexTool = async (
    name: unknown,
    input: unknown,
    access: DynamicToolAccess = "project_editor",
  ) => {
    if (!activeProjectId) throw new CodexVideoEditToolError("inactive_project");
    if (
      access === "native_child_read_only" &&
      !nativeChildReadOnlyToolNames.has(name as CodexVideoEditToolName)
    ) {
      throw new CodexVideoEditToolError("tool_not_available");
    }
    const projectId = activeProjectId;
    return invokeWithProjectDraftRefresh({
      toolName: name,
      projectId,
      activeProjectId: () => activeProjectId,
      work: () =>
        new CodexVideoEditToolService(
          projectId,
          drafts,
          "codex",
          readTranscriptForTool,
          renderFramesForTool,
        ).invoke(name, input),
      drafts,
      notify: publishDraftNotice,
    });
  };
  mcpBroker = await CodexMcpBroker.open(
    path.join(userData, "mcp-runtime"),
    invokeCodexTool,
  );
  const mcpRuntime = mcpBroker.runtime(
    process.execPath,
    await resolveCodexMcpScript(process.resourcesPath),
  );
  codex = new DesktopCodex(
    process.resourcesPath,
    userData,
    (url) => shell.openExternal(url),
    { mcpRuntime, dynamicToolInvoker: invokeCodexTool },
  );
  // Claude reaches the same guarded tool service through its own broker, so
  // every Claude transaction is attributed to the Claude origin.
  // Magic Edit reads the draft through the guarded tools as its own origin;
  // the rough cut itself is Claude's story edit (claude origin, shared Undo).
  const roughCutOutcome = (view: ClaudeThreadView): RoughCutOutcome | null =>
    view.status === "running" || view.status === "interrupting"
      ? null
      : view.status === "ready"
        ? "completed"
        : view.message === claudeThreadIssues.stopped
          ? "stopped"
          : view.message === claudeThreadIssues.signIn ||
              view.message === claudeThreadIssues.model
            ? "signIn"
            : view.message === claudeThreadIssues.limit
              ? "limit"
              : "failed";
  const roughCutEditor: RoughCutEditor = {
    async start(projectId, preset, request) {
      if (!claude || activeProjectId !== projectId) return "failed";
      if ((await claude.get()).status !== "signed_in") return "signIn";
      try {
        return roughCutOutcome(
          await claude.startRoughCut(projectId, preset, request),
        );
      } catch {
        return "failed";
      }
    },
    outcome: (projectId) =>
      claude ? roughCutOutcome(claude.getThread(projectId)) : "failed",
    async stop(projectId) {
      if (claude?.runKind(projectId) === "rough_cut")
        await claude.interruptThread(projectId);
    },
  };
  const magicWand = new DesktopMagicWand(
    transcription!,
    async (projectId, name, input) => {
      if (activeProjectId !== projectId)
        throw new CodexVideoEditToolError("inactive_project");
      return invokeWithProjectDraftRefresh({
        toolName: name,
        projectId,
        activeProjectId: () => activeProjectId,
        work: () =>
          new CodexVideoEditToolService(
            projectId,
            drafts,
            "magic_wand",
            readTranscriptForTool,
          ).invoke(name, input),
        drafts,
        notify: publishDraftNotice,
      });
    },
    roughCutEditor,
    {
      tightener: {
        async energy(projectId, sourceId) {
          const { project } = await drafts.snapshotWithProject(projectId);
          const sources =
            project.schema_version === "1.1"
              ? project.sources
              : [project.source];
          const source = sources.find((item) => item.source_id === sourceId);
          if (!source) return null;
          return decodeEnergyTrack({
            ffmpeg: mediaExecutables.ffmpeg,
            path: source.managed_path,
          });
        },
        async applyRanges(projectId, draft, ranges) {
          if (activeProjectId !== projectId)
            throw new CodexVideoEditToolError("inactive_project");
          await invokeWithProjectDraftRefresh({
            toolName: "cut.delete_ranges",
            projectId,
            activeProjectId: () => activeProjectId,
            drafts,
            notify: publishDraftNotice,
            work: () =>
              drafts.applyMagicWand({
                schema_version: "1.0",
                request_id: randomUUID(),
                project_id: projectId,
                draft_id: draft.draft_id,
                base_revision_id: draft.base_revision_id,
                expected_sequence: draft.draft_sequence,
                expected_timeline_sha256: draft.timeline_sha256,
                pass_group: {
                  pass_group_id: randomUUID(),
                  kind: "spoken_cut",
                },
                reason: "Tighten pauses and fillers.",
                operations: ranges.map((range) => ({
                  type: "ripple_delete" as const,
                  start_us: range.start_us,
                  end_us: range.end_us,
                })),
              }),
          });
        },
      },
    },
  );
  magicWandBusy = (projectId) => magicWand.busy(projectId);
  register(channels.magicGet, async (request) => {
    assertMagicWandProjectRequest(request);
    if (activeProjectId !== request.project_id)
      throw new UserFacingError("Open this project before using Magic Edit.");
    const value = magicWand.get(request.project_id);
    assertMagicWandView(value);
    return value;
  });
  register(channels.magicStart, async (request) => {
    assertMagicWandStartRequest(request);
    if (activeProjectId !== request.project_id)
      throw new UserFacingError("Open this project before using Magic Edit.");
    const value = magicWand.start(request.project_id, request.preset);
    assertMagicWandView(value);
    return value;
  });
  register(channels.magicStop, async (request) => {
    assertMagicWandProjectRequest(request);
    const value = magicWand.stop(request.project_id);
    assertMagicWandView(value);
    return value;
  });
  // A HyperFrames composition from Claude's workspace, sealed and stored by
  // hash so the stage can play it (ADR 0021).
  const importCompositionForClaude = async (
    projectId: string,
    relativePath: string,
  ) => {
    if (!claude) throw new Error("Claude is unavailable");
    const imported = await importComposition(
      claude.workspaceFor(projectId),
      relativePath,
      {
        // Pinned package files (fonts, stylesheets), cached with the libraries.
        fetchPackage: (url) => {
          const pinned = packageFile(url);
          if (!pinned) throw new Error("Not a pinned package file");
          return cachedPackageFile(
            path.join(app.getPath("userData"), "library-cache"),
            pinned,
            fetchPinnedFile,
          );
        },
      },
    );
    await storeComposition(compositionsRoot(), imported.sha256, imported.html);
    return { sha256: imported.sha256 };
  };
  // composition.check: the sealed composition in the stage at the video's
  // size, audited and pictured; it shares the picture queue.
  const checkCompositionForClaude = async (
    projectId: string,
    relativePath: string,
    timesUs: number[] | null,
    cellWidth: number,
  ) => {
    const { sha256 } = await importCompositionForClaude(
      projectId,
      relativePath,
    );
    const signal = AbortSignal.timeout(toolCallTimeoutMs);
    const work = frameQueue.then(async () => {
      if (signal.aborted) throw new Error("Cancelled.");
      const snapshot = await drafts.snapshot(projectId);
      const frameUs = Math.ceil(
        (snapshot.draft.timeline.frame_rate.denominator * 1_000_000) /
          snapshot.draft.timeline.frame_rate.numerator,
      );
      const { plan } = await planDraft(
        drafts,
        mediaExecutables.ffprobe,
        projectId,
        {
          startUs: 0,
          endUs: Math.min(snapshot.draft.timeline.duration_us, frameUs),
        },
      );
      return checkComposition({
        stageUrl: `${origin}/stage.html`,
        sha256,
        width: plan.format.video.width,
        height: plan.format.video.height,
        timesUs,
        cellWidth,
        ffmpeg: mediaExecutables.ffmpeg,
        signal,
      });
    });
    frameQueue = work.catch(() => undefined);
    return work;
  };
  // Where things happen on screen, per recording (by hash): the evidence for
  // zooms. A recording is analysed once per app run.
  const cameraSourceFor = async (
    projectId: string,
    sourceId: string,
  ): Promise<CameraSource | null> => {
    const link = await cameraLinks.forSource(projectId, sourceId);
    if (!link) return null;
    const media = await library.verifiedSource(link.mediaId);
    const streams = media.probe.streams as Record<string, unknown>[];
    const video = streams.find((stream) => stream.codec_type === "video");
    if (!video) return null;
    return {
      path: media.managedPath,
      width: Number(video.width),
      height: Number(video.height),
      offsetUs: link.offsetUs,
    };
  };
  const layoutPlanner: LayoutPlanner = {
    async plan(projectId) {
      const service = new CodexVideoEditToolService(
        projectId,
        drafts,
        "claude",
      );
      const summary = (await service.invoke("timeline.get_summary", {
        schema_version: "1.0",
        project_id: projectId,
      })) as {
        duration_us: number;
        clips: {
          source_id: string;
          source_start_us: number;
          source_end_us: number;
          timeline_start_us: number;
          timeline_end_us: number;
          speed?: number;
        }[];
      };
      const events = await zoomTargeter.targets(
        projectId,
        0,
        Number.MAX_SAFE_INTEGER,
        400,
      );
      // The speech, in edit time: where each sentence starts and the span.
      const view = await transcription!
        .get({ schema_version: "1.0", project_id: projectId, job_id: null })
        .catch(() => null);
      const sentenceStarts: number[] = [];
      let first = Infinity;
      let last = -Infinity;
      for (const result of view?.results ?? [])
        for (const segment of result.transcript.segments) {
          for (const clip of summary.clips) {
            if (clip.source_id !== result.source_id) continue;
            const at = (us: number) =>
              us >= clip.source_start_us && us < clip.source_end_us
                ? timelineAt(clip, us)
                : null;
            const start = at(segment.start_us);
            if (start !== null) sentenceStarts.push(start);
            const spokenStart = at(segment.start_us);
            const spokenEnd = at(
              Math.max(segment.start_us, segment.end_us - 1),
            );
            if (spokenStart !== null) first = Math.min(first, spokenStart);
            if (spokenEnd !== null) last = Math.max(last, spokenEnd);
          }
        }
      sentenceStarts.sort((a, b) => a - b);
      const sources = (await drafts.snapshotWithProject(projectId)).project;
      const screen =
        sources.schema_version === "1.1" ? sources.sources[0]! : sources.source;
      const camera = await cameraSourceFor(projectId, screen.source_id);
      const planned = planLayouts({
        durationUs: summary.duration_us,
        activity: events.map((item) => ({
          startUs: item.start_us,
          endUs: item.end_us,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          score: item.score,
        })),
        sentenceStarts,
        speech:
          Number.isFinite(first) && last > first
            ? { startUs: first, endUs: last }
            : null,
        geometry: {
          canvasAspect:
            Number((screen as { width?: number }).width ?? 16) /
            Number((screen as { height?: number }).height ?? 9),
          cameraAspect: camera ? camera.width / camera.height : 16 / 9,
        },
      });
      return {
        changes: planned.map((item) => ({
          at_us: item.atUs,
          kind: item.kind,
          ...(item.corner ? { corner: item.corner } : {}),
          ...(item.size ? { size: item.size } : {}),
          ...(item.shape ? { shape: item.shape } : {}),
          reason: item.reason,
        })),
        activity_places: events.length,
      };
    },
  };
  const cameraCatalog: CameraCatalog = {
    has: async (projectId, sourceId) =>
      (await cameraLinks.forSource(projectId, sourceId)) !== null,
  };
  const activityBySource = new Map<string, Promise<ActivityTarget[]>>();
  const zoomTargeter: ZoomTargeter = {
    async targets(projectId, startUs, endUs, limit = 40) {
      const { project } = await drafts.snapshotWithProject(projectId);
      const sources =
        project.schema_version === "1.1" ? project.sources : [project.source];
      const summary = (await new CodexVideoEditToolService(
        projectId,
        drafts,
        "claude",
      ).invoke("timeline.get_summary", {
        schema_version: "1.0",
        project_id: projectId,
      })) as {
        clips: {
          source_id: string;
          source_start_us: number;
          source_end_us: number;
          timeline_start_us: number;
          timeline_end_us: number;
          speed?: number;
        }[];
      };
      const found: Awaited<ReturnType<ZoomTargeter["targets"]>> = [];
      for (const source of sources) {
        const clips = summary.clips.filter(
          (clip) => clip.source_id === source.source_id,
        );
        if (clips.length === 0) continue;
        let analysis = activityBySource.get(source.sha256);
        if (!analysis) {
          analysis = analyzeScreenActivity({
            ffmpeg: mediaExecutables.ffmpeg,
            path: source.managed_path,
          });
          activityBySource.set(source.sha256, analysis);
          analysis.catch(() => activityBySource.delete(source.sha256));
        }
        for (const target of await analysis) {
          const zoom = zoomForTarget(target);
          for (const clip of clips) {
            const from = Math.max(target.startUs, clip.source_start_us);
            const to = Math.min(target.endUs, clip.source_end_us);
            if (to <= from) continue;
            const start = timelineAt(clip, from);
            const end = Math.min(clip.timeline_end_us, timelineAt(clip, to));
            if (end <= startUs || start >= endUs) continue;
            found.push({
              start_us: start,
              end_us: end,
              x: Math.round(target.x * 1000) / 1000,
              y: Math.round(target.y * 1000) / 1000,
              width: Math.round(target.width * 1000) / 1000,
              height: Math.round(target.height * 1000) / 1000,
              center_x: zoom.centerX,
              center_y: zoom.centerY,
              suggested_scale: zoom.scale,
              score: target.score,
            });
          }
        }
      }
      return found
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .sort((a, b) => a.start_us - b.start_us);
    },
  };
  // The project workspace Claude works in (ADR 0021): the committed edit as
  // files. Writes for one project run one at a time, newest last.
  const workspaceWrites = new Map<string, Promise<void>>();
  const writeWorkspace = async (projectId: string, directory: string) => {
    const service = new CodexVideoEditToolService(projectId, drafts, "claude");
    const request = { schema_version: "1.0" as const, project_id: projectId };
    const timeline = (await service.invoke(
      "timeline.get_summary",
      request,
    )) as WorkspaceTimeline;
    const project = (await service.invoke("project.get_summary", request)) as {
      sources: Array<{ source_id: string }>;
    };
    // The frame compositions play in: the exported video's size and rate.
    let frame: { width: number; height: number; frame_rate: string } | null =
      null;
    try {
      const rate = (await drafts.snapshot(projectId)).draft.timeline.frame_rate;
      const { plan } = await planDraft(
        drafts,
        mediaExecutables.ffprobe,
        projectId,
        {
          startUs: 0,
          endUs: Math.min(
            timeline.duration_us,
            Math.ceil((rate.denominator * 1_000_000) / rate.numerator),
          ),
        },
      );
      const video = plan.format.video;
      frame = {
        width: video.width,
        height: video.height,
        frame_rate: `${video.frameRate.numerator}/${video.frameRate.denominator}`,
      };
    } catch {
      // Left out when the sources cannot be probed.
    }
    let transcripts: LocalTranscript[] = [];
    try {
      const view = await transcription!.get({ ...request, job_id: null });
      if (view.job.status === "completed")
        transcripts = view.results.map((result) => result.transcript);
    } catch {
      // No transcript yet: edit.md says so.
    }
    await writeClaudeWorkspace(directory, {
      timeline,
      project: frame ? { ...project, frame } : project,
      transcripts,
      sourceNames: new Map(
        project.sources.map((source, index) => [
          source.source_id,
          `recording ${index + 1}`,
        ]),
      ),
      guides: claudeGuides,
    });
  };
  const refreshClaudeWorkspace = (
    projectId: string,
    directory: string,
    required = false,
  ): Promise<void> => {
    const next = (workspaceWrites.get(projectId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => writeWorkspace(projectId, directory));
    workspaceWrites.set(projectId, next);
    return required ? next : next.catch(() => undefined);
  };
  const invokeClaudeTool = async (name: unknown, input: unknown) => {
    if (!activeProjectId) throw new CodexVideoEditToolError("inactive_project");
    const projectId = activeProjectId;
    // Captured before the call so an edit that lands after Stop still
    // belongs to its full edit.
    const run = claude?.fullEditRun(projectId) ?? null;
    // A rough cut only reads, cuts and looks; it never decorates.
    if (
      claude?.runKind(projectId) === "rough_cut" &&
      !roughCutTools.has(name as string)
    )
      throw new CodexVideoEditToolError("tool_not_available");
    // Choosing clips only reads, looks and proposes; it never edits.
    if (
      claude?.runKind(projectId) === "shorts_pick" &&
      !shortsPickTools.has(name as string)
    )
      throw new CodexVideoEditToolError("tool_not_available");
    const target =
      input && typeof input === "object"
        ? (input as { target_transaction_id?: unknown }).target_transaction_id
        : undefined;
    // During a full edit Claude may only undo its own edits, so Undo all can
    // always restore what was there before the run.
    if (
      run &&
      name === "timeline.undo" &&
      !claude!.fullEditIncludes(projectId, target)
    )
      throw new CodexVideoEditToolError("edit_conflict");
    const value = await invokeWithProjectDraftRefresh({
      toolName: name,
      projectId,
      activeProjectId: () => activeProjectId,
      work: () =>
        new CodexVideoEditToolService(
          projectId,
          drafts,
          "claude",
          readTranscriptForTool,
          renderFramesForTool,
          importCompositionForClaude,
          checkCompositionForClaude,
          soundAssets,
          {
            propose: (id, proposals) => shortClips!.propose(id, proposals),
          },
          zoomTargeter,
          cameraCatalog,
          layoutPlanner,
        ).invoke(name, input),
      drafts,
      notify: publishDraftNotice,
    });
    // A full edit's Undo all needs every edit its tools applied.
    if (
      run &&
      value &&
      typeof value === "object" &&
      (value as { status?: unknown }).status === "committed"
    ) {
      if (name === "timeline.undo") claude?.recordUndo(projectId, target, run);
      else
        claude?.recordCommit(
          projectId,
          (value as { transaction_id?: unknown }).transaction_id,
          run,
        );
    }
    // Claude reads the edit from its workspace; keep it current.
    if (
      claude &&
      value &&
      typeof value === "object" &&
      (value as { status?: unknown }).status === "committed"
    )
      void refreshClaudeWorkspace(projectId, claude.workspaceFor(projectId));
    return value;
  };
  claudeBroker = await CodexMcpBroker.open(
    path.join(userData, "claude-mcp-runtime"),
    invokeClaudeTool,
  );
  const claudeMcpRuntime = claudeBroker.runtime(
    process.execPath,
    await resolveCodexMcpScript(process.resourcesPath),
  );
  claude = new DesktopClaude(userData, {
    platform: process.platform,
    env: process.env,
    prepareWorkspace: (projectId, directory) =>
      refreshClaudeWorkspace(projectId, directory, true),
    assetPolicy: async () =>
      effectiveAssetPolicy(
        await new PreferencesStore(
          path.join(app.getPath("userData"), "preferences"),
        ).read(),
      ),
    // The user's own Claude Code skills, mirrored into the app's profile.
    userSkills: async () =>
      (
        await mirrorUserSkills(
          userSkillsDirectory(process.env, app.getPath("home")),
          path.join(userData, "claude", "skills-plugin"),
        )
      )?.directory ?? null,
    openExternal: (url) => shell.openExternal(url),
    mcpRuntime: () => claudeMcpRuntime,
    history: {
      newest: async (projectId) =>
        (await drafts.snapshot(projectId)).undo_transaction_id,
      undo: async (projectId, transactionId) => {
        const { draft } = await drafts.snapshot(projectId);
        await invokeWithProjectDraftRefresh({
          toolName: "timeline.undo",
          projectId,
          activeProjectId: () => activeProjectId,
          drafts,
          notify: publishDraftNotice,
          work: () =>
            drafts.undoManual({
              schema_version: "1.0",
              request_id: randomUUID(),
              project_id: projectId,
              draft_id: draft.draft_id,
              base_revision_id: draft.base_revision_id,
              expected_sequence: draft.draft_sequence,
              expected_timeline_sha256: draft.timeline_sha256,
              target_transaction_id: transactionId,
              reason: "Undo the full AI edit.",
            }),
        });
      },
    },
  });
  const apiClient = new ApiProviderClient();
  const apiProviders = new DesktopApiProviders(
    new ProviderKeyStore(path.join(userData, "api-provider-keys"), safeStorage),
    apiClient,
  );
  const apiThreads = new ApiProviderThreads(
    userData,
    apiProviders,
    apiClient,
    async (projectId, name, input) => {
      if (activeProjectId !== projectId)
        throw new CodexVideoEditToolError("inactive_project");
      return invokeWithProjectDraftRefresh({
        toolName: name,
        projectId,
        activeProjectId: () => activeProjectId,
        work: () =>
          new CodexVideoEditToolService(
            projectId,
            drafts,
            "api_provider",
            readTranscriptForTool,
          ).invoke(name, input),
        drafts,
        notify: publishDraftNotice,
      });
    },
  );
  register(channels.apiProvidersGet, async (request) => {
    assertEmptyRequest(request);
    const value = await apiProviders.get();
    assertApiProvidersView(value);
    return value;
  });
  register(channels.apiProvidersConnect, async (request) => {
    assertApiProviderConnectRequest(request);
    const value = await apiProviders.connect(request);
    assertApiProvidersView(value);
    return value;
  });
  register(channels.apiProvidersRemove, async (request) => {
    assertApiProviderRequest(request);
    if (activeProjectId) {
      const turn = await apiThreads.get(activeProjectId, request.provider);
      if (turn.status === "running")
        await apiThreads.interrupt(activeProjectId, request.provider);
    }
    const value = await apiProviders.remove(request);
    assertApiProvidersView(value);
    return value;
  });
  register(channels.apiProvidersSelectModel, async (request) => {
    assertApiProviderModelRequest(request);
    const value = await apiProviders.selectModel(request);
    assertApiProvidersView(value);
    return value;
  });
  for (const [channel, operation] of [
    [channels.codexGet, () => codex!.get()],
    [channels.codexReconnect, () => codex!.reconnect()],
    [channels.codexLogin, () => codex!.login()],
    [channels.codexCancelLogin, () => codex!.cancelLogin()],
    [channels.codexLogout, () => codex!.logout()],
  ] as const)
    register(channel, async (request) => {
      assertEmptyRequest(request);
      const value = await operation();
      assertCodexView(value);
      return value;
    });
  register(channels.codexDeviceLogin, async (request) => {
    assertEmptyRequest(request);
    const value = await codex!.loginDevice();
    assertDeviceLoginDetails(value);
    return value;
  });
  register(channels.codexDeviceVerification, async (request) => {
    assertEmptyRequest(request);
    if (!codex!.deviceLoginPending())
      throw new UserFacingError("Start device sign-in first.");
    await shell.openExternal(CODEX_DEVICE_VERIFICATION_URL);
    return null;
  });
  register(channels.codexSelect, async (request) => {
    const value = await codex!.select(request);
    assertCodexView(value);
    return value;
  });
  const claudeView = async (work: () => Promise<unknown>) => {
    const value = await work();
    assertClaudeView(value);
    return value;
  };
  register(channels.claudeGet, async (request) => {
    assertEmptyRequest(request);
    return claudeView(() => claude!.get());
  });
  register(channels.claudeCheck, async (request) => {
    assertEmptyRequest(request);
    return claudeView(() => claude!.check());
  });
  register(channels.claudeSignIn, async (request) => {
    assertEmptyRequest(request);
    return claudeView(() => claude!.signIn());
  });
  register(channels.claudeCancelSignIn, async (request) => {
    assertEmptyRequest(request);
    return claudeView(() => claude!.cancelSignIn());
  });
  register(channels.claudeSignOut, async (request) => {
    assertEmptyRequest(request);
    return claudeView(() => claude!.signOut());
  });
  register(channels.claudeSelect, async (request) =>
    claudeView(() => claude!.select(request as never)),
  );
  register(channels.claudeSelectRoughCut, async (request) =>
    claudeView(() => claude!.selectRoughCut(request as never)),
  );
  register(channels.claudeInstallGuide, async (request) => {
    assertEmptyRequest(request);
    await claude!.openInstallGuide();
    return null;
  });
  register(channels.projectList, async (request) => {
    assertEmptyRequest(request);
    const value = await Promise.all(
      (await projects.list()).map((snapshot) =>
        projectRuntime.view(snapshot.project.project_id),
      ),
    );
    assertProjectList(value);
    return value;
  });
  // A project with running work cannot lose focus: its turn's tools would
  // otherwise resolve against another project's draft.
  const assertProjectIdle = async (projectId: string): Promise<void> => {
    if (magicWandBusy(projectId))
      throw new UserFacingError("Stop Magic Edit before leaving this project.");
    if (shortClips?.busy(projectId))
      throw new UserFacingError(
        "Wait for the clip to finish exporting or cancel it before leaving this project.",
      );
    if (exports!.busy(projectId))
      throw new UserFacingError(
        "Wait for the export to finish or cancel it before leaving this project.",
      );
    if (transcription!.isRunning(projectId))
      throw new UserFacingError(
        "Stop local transcription before closing this project.",
      );
    if (
      ["opening", "starting", "running", "interrupting"].includes(
        codex!.getThread(projectId).status,
      )
    )
      throw new UserFacingError(
        "Stop the running Codex turn before leaving this project.",
      );
    if (claude!.busy(projectId))
      throw new UserFacingError(
        "Stop the running Claude turn before leaving this project.",
      );
    for (const provider of apiProviderIds) {
      const turn = await apiThreads.get(projectId, provider);
      if (turn.status === "running" || turn.status === "interrupting")
        throw new UserFacingError(
          "Stop the running provider turn before leaving this project.",
        );
    }
  };
  const assertCanLeaveActive = async (nextId?: string): Promise<void> => {
    if (activeProjectId !== undefined && activeProjectId !== nextId)
      await assertProjectIdle(activeProjectId);
  };
  register(channels.projectCreate, async (request) => {
    assertProjectRequest(request);
    await assertCanLeaveActive();
    const created = await projects.createFromMedia(request.id);
    // A recording made with a camera brings its camera along.
    const camera = await cameraLinks.takePending(request.id);
    if (camera)
      await cameraLinks.set(created.project.project_id, {
        sourceId: request.id,
        mediaId: camera,
        offsetUs: 0,
      });
    const value = await projectRuntime.view(created.project.project_id);
    activeProjectId = value.id;
    return value;
  });
  register(channels.projectCreateTwo, async (request) => {
    assertTwoSourceProjectRequest(request);
    await assertCanLeaveActive();
    const created = await projects.createFromTwoMedia(
      request.firstId,
      request.secondId,
    );
    const value = await projectRuntime.view(created.project.project_id);
    activeProjectId = value.id;
    return value;
  });
  register(channels.projectOpen, async (request) => {
    assertProjectRequest(request);
    await assertCanLeaveActive(request.id);
    await projects.open(request.id);
    const value = await projectRuntime.view(request.id);
    activeProjectId = value.id;
    return value;
  });
  register(channels.projectClose, async (request) => {
    assertProjectRequest(request);
    if (activeProjectId === request.id) {
      await assertProjectIdle(request.id);
      await codex!.closeThread(request.id);
      await claude!.closeThread(request.id);
      await Promise.all(
        apiProviderIds.map((provider) =>
          apiThreads.close(request.id, provider),
        ),
      );
      await transcription!.closeProject(request.id);
      activeProjectId = undefined;
    }
    return null;
  });
  register(channels.projectRename, async (request) => {
    assertProjectRename(request);
    await projects.rename(request.id, request.name);
    return projectRuntime.view(request.id);
  });
  // Deleting is an explicit Home action on a closed project. Its sources
  // stay in Media; conversations and per-project choices go with it.
  register(channels.projectDelete, async (request) => {
    assertProjectRequest(request);
    if (activeProjectId === request.id)
      throw new UserFacingError("Close the project before deleting it.");
    await projects.open(request.id);
    await removeProjectSideFiles(userData, request.id);
    await projects.remove(request.id);
    return null;
  });
  register(channels.projectNavigate, async (request) => {
    assertProjectNavigation(request);
    if (activeProjectId !== request.id) throw new Error("Inactive project");
    if (request.stage !== "auto_edit" && transcription!.isRunning(request.id))
      throw new UserFacingError(
        "Stop local transcription before leaving Magic Edit.",
      );
    await projects.navigate(request.id, request.stage);
    return projectRuntime.view(request.id);
  });
  register(channels.transcriptionGet, async (request) => {
    assertTranscriptionJobRequest(request);
    await activeTranscriptProject(request.project_id);
    return transcription!.get(request);
  });
  register(channels.transcriptionStart, async (request) => {
    assertTranscriptionProjectRequest(request);
    await activeAutoEditProject(request.project_id);
    return transcription!.start(request);
  });
  register(channels.transcriptionStop, async (request) => {
    assertTranscriptionStopRequest(request);
    await activeAutoEditProject(request.project_id);
    return transcription!.stop(request);
  });
  register(channels.projectIntegrityCheck, async (request) => {
    assertProjectRequest(request);
    if (activeProjectId !== request.id)
      throw new UserFacingError(
        "Open the active project in Review to check draft integrity.",
      );
    try {
      const value = await projectRuntime.verifyDraftIntegrity(request.id);
      if (activeProjectId !== request.id)
        throw new UserFacingError(
          "The active project changed. Run the check again.",
        );
      return value;
    } catch (error) {
      if (error instanceof UserFacingError) throw error;
      throw new UserFacingError(
        "Draft integrity could not be checked. Reopen the project and try again.",
      );
    }
  });
  const activeCodexProject = async (projectId: string) => {
    if (activeProjectId !== projectId) throw new Error("Inactive project");
    await drafts.snapshotWithProject(projectId);
  };
  register(channels.codexThreadGet, async (request) => {
    assertCodexThreadProjectRequest(request);
    await activeCodexProject(request.project_id);
    const value = codex!.getThread(request.project_id);
    assertCodexThreadView(value);
    return value;
  });
  register(channels.codexThreadOpen, async (request) => {
    assertCodexThreadProjectRequest(request);
    await activeCodexProject(request.project_id);
    const state = await codex!.get();
    if (state.account !== "signed_in")
      throw new UserFacingError("Sign in to Codex in Settings to continue.");
    if (!state.selection)
      throw new UserFacingError(
        "Choose a Codex model and reasoning level in Settings to continue.",
      );
    const value = await codex!.openThread(request.project_id);
    assertCodexThreadView(value);
    return value;
  });
  register(channels.codexThreadSend, async (request) => {
    assertCodexThreadSendRequest(request);
    await activeCodexProject(request.project_id);
    const value = await codex!.sendThread(request.project_id, request.text);
    assertCodexThreadView(value);
    return value;
  });
  register(channels.codexThreadInterrupt, async (request) => {
    assertCodexThreadProjectRequest(request);
    await activeCodexProject(request.project_id);
    const value = await codex!.interruptThread(request.project_id);
    assertCodexThreadView(value);
    return value;
  });
  register(channels.claudeThreadGet, async (request) => {
    assertClaudeThreadProjectRequest(request);
    await activeCodexProject(request.project_id);
    const value = await claude!.getThreadWithHistory(request.project_id);
    assertClaudeThreadView(value);
    return value;
  });
  register(channels.claudeFullEditStart, async (request) => {
    assertClaudeFullEditRequest(request);
    await activeCodexProject(request.project_id);
    const value = await claude!.startFullEdit(
      request.project_id,
      request.brief,
    );
    assertClaudeThreadView(value);
    return value;
  });
  register(channels.claudeFullEditUndo, async (request) => {
    assertClaudeThreadProjectRequest(request);
    await activeCodexProject(request.project_id);
    try {
      const value = await claude!.undoFullEdit(request.project_id);
      assertClaudeThreadView(value);
      return value;
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.claudeThreadOpen, async (request) => {
    assertClaudeThreadProjectRequest(request);
    await activeCodexProject(request.project_id);
    const state = await claude!.settled();
    if (state.status === "signed_out" || state.status === "signing_in")
      throw new UserFacingError("Sign in to Claude in Settings to continue.");
    if (state.status !== "signed_in")
      throw new UserFacingError("Set up Claude in Settings to continue.");
    if (!state.selection)
      throw new UserFacingError(
        "Choose a Claude model in Settings to continue.",
      );
    const value = await claude!.openThread(request.project_id);
    assertClaudeThreadView(value);
    return value;
  });
  register(channels.claudeThreadSend, async (request) => {
    assertClaudeThreadSendRequest(request);
    await activeCodexProject(request.project_id);
    const value = await claude!.sendThread(request.project_id, request.text);
    assertClaudeThreadView(value);
    return value;
  });
  register(channels.claudeThreadInterrupt, async (request) => {
    assertClaudeThreadProjectRequest(request);
    await activeCodexProject(request.project_id);
    const value = await claude!.interruptThread(request.project_id);
    assertClaudeThreadView(value);
    return value;
  });
  register(channels.apiThreadGet, async (request) => {
    assertApiThreadProjectRequest(request);
    await activeCodexProject(request.project_id);
    const value = await apiThreads.get(request.project_id, request.provider);
    assertApiThreadView(value);
    return value;
  });
  register(channels.apiThreadOpen, async (request) => {
    assertApiThreadProjectRequest(request);
    await activeCodexProject(request.project_id);
    if (!(await apiProviders.selected(request.provider)))
      throw new UserFacingError(
        "Connect and choose a provider model in Settings to continue.",
      );
    const value = await apiThreads.open(request.project_id, request.provider);
    assertApiThreadView(value);
    return value;
  });
  register(channels.apiThreadSend, async (request) => {
    assertApiThreadSendRequest(request);
    await activeCodexProject(request.project_id);
    const value = await apiThreads.send(
      request.project_id,
      request.provider,
      request.text,
    );
    assertApiThreadView(value);
    return value;
  });
  register(channels.apiThreadInterrupt, async (request) => {
    assertApiThreadProjectRequest(request);
    await activeCodexProject(request.project_id);
    const value = await apiThreads.interrupt(
      request.project_id,
      request.provider,
    );
    assertApiThreadView(value);
    return value;
  });
  register(channels.list, async (request) => {
    assertEmptyRequest(request);
    const value = await library.list();
    assertMediaList(value);
    return value;
  });
  register(channels.import, async (request) => {
    assertEmptyRequest(request);
    if (importing || !window) throw new Error("Import is already running");
    const controller = new AbortController();
    importing = controller;
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: "Import video",
        properties: ["openFile"],
        filters: [
          { name: "Video", extensions: ["mkv", "mp4", "mov", "webm", "avi"] },
        ],
      });
      if (
        selected.canceled ||
        !selected.filePaths[0] ||
        controller.signal.aborted
      )
        return null;
      const value = await library.importFile(
        selected.filePaths[0],
        controller.signal,
      );
      assertMediaSummary(value);
      return value;
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      importing = undefined;
    }
  });
  register(channels.frame, async (request) => {
    assertFrameRequest(request);
    if (frameRequests.size >= 2)
      throw new Error("Frame request already running");
    const controller = new AbortController();
    frameRequests.add(controller);
    try {
      const value = await library.frame(
        request.id,
        request.timeUs,
        controller.signal,
      );
      assertMediaFrame(value);
      return value;
    } finally {
      frameRequests.delete(controller);
    }
  });
  let thumbnailRequests = 0;
  register(channels.thumbnail, async (request) => {
    assertThumbnailRequest(request);
    // Cards ask for one picture each; a small bound keeps FFmpeg use modest.
    if (thumbnailRequests >= 4) throw new Error("Thumbnail queue is full");
    thumbnailRequests++;
    try {
      const value = await library.thumbnail(request.id);
      assertThumbnail(value);
      return value;
    } finally {
      thumbnailRequests--;
    }
  });
  register(channels.projectFrame, async (request) => {
    assertProjectFrameRequest(request);
    if (activeProjectId !== request.projectId)
      throw new Error("Inactive project");
    if (frameRequests.size >= 2)
      throw new Error("Frame request already running");
    const controller = new AbortController();
    frameRequests.add(controller);
    try {
      const value = await projectRuntime.frame(request, controller.signal);
      if (activeProjectId !== request.projectId)
        throw new Error("Inactive project");
      return value;
    } finally {
      frameRequests.delete(controller);
    }
  });
  // The filmstrip: one request at a time; a newer one replaces a running one,
  // so editing never queues pictures of a draft that no longer exists.
  let stripRequest: AbortController | undefined;
  register(channels.projectStrip, async (request) => {
    assertProjectStripRequest(request);
    if (activeProjectId !== request.projectId)
      throw new Error("Inactive project");
    stripRequest?.abort();
    const controller = new AbortController();
    stripRequest = controller;
    try {
      const value = await projectRuntime.strip(request, controller.signal);
      if (activeProjectId !== request.projectId)
        throw new Error("Inactive project");
      return value;
    } finally {
      if (stripRequest === controller) stripRequest = undefined;
    }
  });
  register(channels.projectManualTrim, async (request) => {
    assertManualTrimRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "cut.trim_edge",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "manual" },
            reason: "Manual trim.",
            operations: [
              {
                type: "trim",
                clip_id: request.clipId,
                edge: request.edge,
                timeline_position_us: request.timelinePositionUs,
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectManualSplit, async (request) => {
    assertManualSplitRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "timeline.split",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "manual" },
            reason: "Manual split.",
            operations: [
              {
                type: "split",
                clip_id: request.clipId,
                timeline_position_us: request.timelinePositionUs,
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectManualRangeCut, async (request) => {
    assertManualRangeCutRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "timeline.ripple_delete",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "manual" },
            reason: "Manual range cut.",
            operations: [
              {
                type: "ripple_delete",
                start_us: request.startUs,
                end_us: request.endUs,
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectManualZoom, async (request) => {
    assertManualZoomRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    const { draft } = await drafts.snapshotWithProject(request.projectId);
    if (
      draft.draft_sequence !== request.expectedSequence ||
      draft.timeline_sha256 !== request.expectedTimelineSha256
    )
      throw new UserFacingError(
        "The draft changed. Check the zoom range and try again.",
      );
    // Map the output range to one source's time through the clip map. An
    // existing zoom keeps its own source range, including parts under cuts.
    const existing = request.zoomId
      ? draft.timeline.zooms?.find((zoom) => zoom.zoom_id === request.zoomId)
      : undefined;
    if (request.zoomId && !existing)
      throw new UserFacingError("That zoom was removed. Add it again.");
    const range =
      existing ??
      zoomSourceRange(draft.timeline.clips, request.startUs, request.endUs);
    if (!range)
      throw new UserFacingError(
        "A zoom must stay within footage from one recording.",
      );
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "zoom.set",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "zoom" },
            reason: request.zoomId ? "Manual zoom change." : "Manual zoom.",
            operations: [
              {
                type: "set_zoom",
                zoom: {
                  zoom_id:
                    request.zoomId ??
                    `zoom-${randomUUID().replaceAll("-", "")}`,
                  source_id: range.source_id,
                  source_start_us: range.source_start_us,
                  source_end_us: range.source_end_us,
                  center_x: request.centerX,
                  center_y: request.centerY,
                  scale: request.scale,
                },
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(
          error.code === "conflict"
            ? "Zooms cannot overlap. Choose a range outside the other zoom."
            : error.message,
        );
      throw error;
    }
  });
  register(channels.projectManualGraphic, async (request) => {
    assertManualGraphicRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    const { draft } = await drafts.snapshotWithProject(request.projectId);
    if (
      draft.draft_sequence !== request.expectedSequence ||
      draft.timeline_sha256 !== request.expectedTimelineSha256
    )
      throw new UserFacingError("The draft changed. Try again.");
    const anchor = graphicAnchor(draft.timeline.clips, request.startUs);
    if (!anchor)
      throw new UserFacingError(
        "Choose a time inside the edit for the graphic.",
      );
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "graphics.set",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "graphics" },
            reason: request.graphicId ? "Change a graphic." : "Add a graphic.",
            operations: [
              {
                type: "set_graphic",
                graphic: {
                  graphic_id:
                    request.graphicId ??
                    `graphic-${randomUUID().replaceAll("-", "")}`,
                  name: request.name,
                  source_id: anchor.source_id,
                  source_us: anchor.source_us,
                  duration_us: request.durationUs,
                  layer: request.layer,
                  html: request.html,
                  css: request.css,
                },
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectManualGraphicRemove, async (request) => {
    assertManualGraphicRemoveRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "graphics.remove",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "graphics" },
            reason: "Remove a graphic.",
            operations: [
              { type: "remove_graphic", graphic_id: request.graphicId },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectManualLayout, async (request) => {
    assertManualLayoutRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    const { draft } = await drafts.snapshotWithProject(request.projectId);
    if (
      draft.draft_sequence !== request.expectedSequence ||
      draft.timeline_sha256 !== request.expectedTimelineSha256
    )
      throw new UserFacingError("The draft changed. Try again.");
    const clip = draft.timeline.clips.find(
      (item) =>
        request.atUs >= item.timeline_start_us &&
        request.atUs < item.timeline_end_us,
    );
    if (!clip) throw new UserFacingError("There is no video at that point.");
    if (
      request.kind !== "screen" &&
      !(await cameraLinks.forSource(request.projectId, clip.source_id))
    )
      throw new UserFacingError(
        "Add a camera video first (Camera in More tools).",
      );
    const existing = request.layoutId
      ? draft.timeline.layouts?.find(
          (item) => item.layout_id === request.layoutId,
        )
      : undefined;
    if (request.layoutId && !existing)
      throw new UserFacingError("That layout change was removed.");
    const layout: LayoutChange = {
      layout_id:
        request.layoutId ?? `layout-${randomUUID().replaceAll("-", "")}`,
      // A change being edited keeps its moment.
      source_id: existing?.source_id ?? clip.source_id,
      source_us: existing?.source_us ?? sourceAt(clip, request.atUs),
      kind: request.kind,
      move_us: request.moveUs,
      ...(request.kind === "pip"
        ? {
            corner: request.corner,
            size: request.size,
            shape: request.shape,
          }
        : {}),
      ...(request.kind !== "screen"
        ? {
            face_zoom: request.faceZoom,
            focus_x: request.focusX,
            focus_y: request.focusY,
          }
        : {}),
    };
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "layout.set",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "layout" },
            reason: request.layoutId
              ? "Change a layout."
              : "Change the camera layout.",
            operations: [{ type: "set_layout", layout }],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(
          error.code === "conflict"
            ? "That is already the layout there."
            : error.message,
        );
      throw error;
    }
  });
  register(channels.projectManualLayoutRemove, async (request) => {
    assertManualLayoutRemoveRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "layout.remove",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "layout" },
            reason: "Remove a layout change.",
            operations: [
              { type: "remove_layout", layout_id: request.layoutId },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  /** The first recording of the project: the one a camera goes with. */
  const cameraScreenSource = async (projectId: string) => {
    const { project } = await drafts.snapshotWithProject(projectId);
    const sources =
      project.schema_version === "1.1" ? project.sources : [project.source];
    return sources[0]!.source_id;
  };
  const cameraView = async (projectId: string): Promise<CameraView> => {
    const link = await cameraLinks.forSource(
      projectId,
      await cameraScreenSource(projectId),
    );
    if (!link) return idleCameraView(projectId);
    const media = await library.verifiedSource(link.mediaId);
    const video = (media.probe.streams as Record<string, unknown>[]).find(
      (stream) => stream.codec_type === "video",
    );
    const view: CameraView = {
      schema_version: "1.0",
      project_id: projectId,
      linked: true,
      file_name: media.summary.name.slice(0, 255),
      offset_us: link.offsetUs,
      width: Number(video?.width ?? 1),
      height: Number(video?.height ?? 1),
    };
    assertCameraView(view);
    return view;
  };
  register(channels.cameraGet, async (request) => {
    assertCameraRequest(request);
    return cameraView(request.project_id);
  });
  let choosingCamera = false;
  register(channels.cameraChoose, async (request) => {
    assertCameraRequest(request);
    if (activeProjectId !== request.project_id)
      throw new UserFacingError("Open this project before adding a camera.");
    if (choosingCamera || !window)
      throw new UserFacingError("A camera video is already being added.");
    choosingCamera = true;
    try {
      const selected = await dialog.showOpenDialog(window, {
        title: "Add camera video",
        properties: ["openFile"],
        filters: [
          { name: "Video", extensions: ["mkv", "mp4", "mov", "webm", "avi"] },
        ],
      });
      const file = selected.filePaths[0];
      if (selected.canceled || !file) return cameraView(request.project_id);
      const media = await library.importFile(file);
      const sourceId = await cameraScreenSource(request.project_id);
      if (media.id === sourceId)
        throw new UserFacingError(
          "Choose the camera recording, not the screen recording.",
        );
      await cameraLinks.set(request.project_id, {
        sourceId,
        mediaId: media.id,
        offsetUs: 0,
      });
      return cameraView(request.project_id);
    } finally {
      choosingCamera = false;
    }
  });
  register(channels.cameraOffset, async (request) => {
    assertCameraOffsetRequest(request);
    const sourceId = await cameraScreenSource(request.project_id);
    const link = await cameraLinks.forSource(request.project_id, sourceId);
    if (!link) throw new UserFacingError("Add a camera video first.");
    await cameraLinks.set(request.project_id, {
      ...link,
      offsetUs: request.offset_us,
    });
    return cameraView(request.project_id);
  });
  register(channels.cameraRemove, async (request) => {
    assertCameraRequest(request);
    const sourceId = await cameraScreenSource(request.project_id);
    const { draft } = await drafts.snapshotWithProject(request.project_id);
    if (
      (draft.timeline.layouts ?? []).some(
        (item) => item.source_id === sourceId && item.kind !== "screen",
      )
    )
      throw new UserFacingError(
        "Remove the camera layout changes first, or undo them.",
      );
    await cameraLinks.remove(request.project_id, sourceId);
    return cameraView(request.project_id);
  });
  register(channels.projectManualTransition, async (request) => {
    assertManualTransitionRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    const { draft } = await drafts.snapshotWithProject(request.projectId);
    if (
      draft.draft_sequence !== request.expectedSequence ||
      draft.timeline_sha256 !== request.expectedTimelineSha256
    )
      throw new UserFacingError("The draft changed. Try again.");
    // A transition belongs to a cut: the first frame of an incoming clip
    // that does not continue the clip before it.
    const cut = cutAt(
      draft.timeline.clips.map((clip) => ({
        sourceId: clip.source_id,
        timelineStartUs: clip.timeline_start_us,
        timelineEndUs: clip.timeline_end_us,
        sourceStartUs: clip.source_start_us,
        sourceEndUs: clip.source_end_us,
      })),
      request.atUs,
    );
    if (!cut) throw new UserFacingError("There is no cut at that point.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "transition.set",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "graphics" },
            reason: request.transitionId
              ? "Change a transition."
              : "Add a transition.",
            operations: [
              {
                type: "set_transition",
                transition: {
                  transition_id:
                    request.transitionId ??
                    `transition-${randomUUID().replaceAll("-", "")}`,
                  source_id: cut.sourceId,
                  source_us: cut.sourceUs,
                  kind: request.kind,
                  duration_us: request.durationUs,
                  color: request.color.toLowerCase(),
                },
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(
          error.code === "conflict"
            ? "That cut already has this transition."
            : error.message,
        );
      throw error;
    }
  });
  register(channels.projectManualTransitionRemove, async (request) => {
    assertManualTransitionRemoveRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "transition.remove",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "graphics" },
            reason: "Remove a transition.",
            operations: [
              {
                type: "remove_transition",
                transition_id: request.transitionId,
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectManualSpeed, async (request) => {
    assertManualSpeedRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "speed.set",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "speed" },
            reason:
              request.speed === 1
                ? "Manual normal speed."
                : `Manual ${request.speed}x speed.`,
            operations: [
              {
                type: "set_speed",
                start_us: request.startUs,
                end_us: request.endUs,
                speed: request.speed as ClipSpeed,
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(
          error.code === "conflict"
            ? "That part already plays at this speed."
            : error.message,
        );
      throw error;
    }
  });
  register(channels.projectManualZoomRemove, async (request) => {
    assertManualZoomRemoveRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "zoom.remove",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "zoom" },
            reason: "Remove zoom.",
            operations: [{ type: "remove_zoom", zoom_id: request.zoomId }],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectManualRestoreRange, async (request) => {
    assertManualRestoreRangeRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    let project: ProjectView;
    try {
      project = await projectRuntime.view(request.projectId);
    } catch {
      throw new UserFacingError("Reopen the project before restoring footage.");
    }
    if (project.stage !== "edit")
      throw new UserFacingError("Switch to Refine to restore a source range.");
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("The active project changed. Try again.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "cut.restore_range",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "manual" },
            reason: "Manual source-range restore.",
            operations: [
              {
                type: "restore_range",
                source_id: request.sourceId,
                source_start_us: request.sourceStartUs,
                source_end_us: request.sourceEndUs,
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectTranscriptCorrection, async (request) => {
    assertManualTranscriptCorrectionRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError(
        "Open this project before correcting its transcript.",
      );
    let project: ProjectView;
    try {
      project = await projectRuntime.view(request.projectId);
    } catch {
      throw new UserFacingError(
        "Reopen the project before correcting its transcript.",
      );
    }
    if (project.stage !== "edit")
      throw new UserFacingError(
        "Switch to Refine to correct transcript wording.",
      );
    if (activeProjectId !== request.projectId)
      throw new UserFacingError(
        "The active project changed. Select the word again.",
      );
    const transcriptView = await transcription!.get({
      schema_version: "1.0",
      project_id: request.projectId,
      job_id: null,
    });
    const sourceResult = transcriptView.results.find(
      (result) =>
        result.source_id === request.sourceId &&
        result.transcript.transcript_id === request.transcriptId,
    );
    const sourceWord = sourceResult?.transcript.segments
      .flatMap((segment) => segment.words)
      .find((word) => word.word_id === request.wordId);
    if (!sourceWord)
      throw new UserFacingError(
        "That transcript word is no longer available. Refresh the transcript.",
      );
    const draft = await drafts.snapshot(request.projectId);
    const currentOverride = draft.draft.timeline.transcript_edits?.find(
      (edit) =>
        edit.source_id === request.sourceId &&
        edit.transcript_id === request.transcriptId &&
        edit.word_id === request.wordId,
    );
    const currentText = currentOverride?.replacement_text ?? sourceWord.text;
    if (currentText !== request.expectedText)
      throw new UserFacingError(
        "The transcript changed. Select the word again.",
      );
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "transcript.correct_word",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "manual" },
            reason: "Correct transcript wording; recorded audio is unchanged.",
            operations: [
              {
                type: "transcript_edit",
                source_id: request.sourceId,
                transcript_id: request.transcriptId,
                word_id: request.wordId,
                original_text: sourceWord.text,
                expected_text: request.expectedText,
                replacement_text: request.replacementText,
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectTranscriptCut, async (request) => {
    assertManualTranscriptCutRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError(
        "Open this project before cutting transcript words.",
      );
    let project: ProjectView;
    try {
      project = await projectRuntime.view(request.projectId);
    } catch {
      throw new UserFacingError(
        "Reopen the project before cutting transcript words.",
      );
    }
    if (project.stage !== "edit")
      throw new UserFacingError(
        "Switch to Refine to cut selected transcript words.",
      );
    if (activeProjectId !== request.projectId)
      throw new UserFacingError(
        "The active project changed. Select the words again.",
      );
    const transcriptView = await transcription!.get({
      schema_version: "1.0",
      project_id: request.projectId,
      job_id: null,
    });
    const sourceResult = transcriptView.results.find(
      (result) =>
        result.source_id === request.sourceId &&
        result.transcript.transcript_id === request.transcriptId,
    );
    const words = sourceResult?.transcript.segments.flatMap(
      (segment) => segment.words,
    );
    const startIndex = words?.findIndex(
      (word) => word.word_id === request.startWordId,
    );
    const endIndex = words?.findIndex(
      (word) => word.word_id === request.endWordId,
    );
    if (
      !words ||
      startIndex === undefined ||
      endIndex === undefined ||
      startIndex < 0 ||
      endIndex < startIndex
    )
      throw new UserFacingError(
        "The selected transcript range is unavailable. Refresh it and try again.",
      );
    const firstWord = words[startIndex]!;
    const lastWord = words[endIndex]!;
    if (firstWord.start_us >= lastWord.end_us)
      throw new UserFacingError(
        "The selected transcript range has invalid timing.",
      );
    const draft = await drafts.snapshot(request.projectId);
    const clip = draft.draft.timeline.clips.find(
      (candidate) =>
        candidate.source_id === request.sourceId &&
        candidate.source_start_us <= firstWord.start_us &&
        candidate.source_end_us >= lastWord.end_us,
    );
    if (!clip)
      throw new UserFacingError(
        "The selected words are not one continuous visible source range. Choose a smaller range.",
      );
    if (clip.speed)
      throw new UserFacingError(
        "These words are in a sped-up part. Set it back to normal speed before cutting words.",
      );
    const startUs =
        clip.timeline_start_us + (firstWord.start_us - clip.source_start_us),
      endUs = clip.timeline_start_us + (lastWord.end_us - clip.source_start_us);
    if (startUs >= endUs || endUs > draft.draft.timeline.duration_us)
      throw new UserFacingError(
        "The selected transcript range is outside the current draft.",
      );
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "transcript.cut_words",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.applyManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            pass_group: { pass_group_id: randomUUID(), kind: "spoken_cut" },
            reason:
              "Remove the explicitly selected transcript words from the draft.",
            operations: [
              {
                type: "transcript_cut",
                source_id: request.sourceId,
                transcript_id: request.transcriptId,
                start_word_id: request.startWordId,
                end_word_id: request.endWordId,
                source_start_us: firstWord.start_us,
                source_end_us: lastWord.end_us,
                start_us: startUs,
                end_us: endUs,
              },
            ],
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectManualUndo, async (request) => {
    assertManualUndoRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "timeline.undo",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.undoManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            target_transaction_id: request.targetTransactionId,
            reason: "Undo last edit.",
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.projectManualRedo, async (request) => {
    assertManualRedoRequest(request);
    if (activeProjectId !== request.projectId)
      throw new UserFacingError("Open this project before editing it.");
    try {
      const committed = await invokeWithProjectDraftRefresh({
        toolName: "timeline.redo",
        projectId: request.projectId,
        activeProjectId: () => activeProjectId,
        drafts,
        notify: publishDraftNotice,
        work: () =>
          drafts.redoManual({
            schema_version: "1.0",
            request_id: randomUUID(),
            project_id: request.projectId,
            draft_id: request.draftId,
            base_revision_id: request.baseRevisionId,
            expected_sequence: request.expectedSequence,
            expected_timeline_sha256: request.expectedTimelineSha256,
            target_transaction_id: request.targetTransactionId,
            reason: "Redo last undone edit.",
            kind: "redo",
          }),
      });
      return committedDraftView(committed);
    } catch (error) {
      if (error instanceof DraftTransactionError)
        throw new UserFacingError(error.message);
      throw error;
    }
  });
  register(channels.cancel, async (request) => {
    assertEmptyRequest(request);
    importing?.abort();
    return null;
  });
  window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: appIdentity.displayName,
    backgroundColor: "#11131a",
    webPreferences: {
      preload: path.join(app.getAppPath(), "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      zoomFactor: committedScale,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  // The only frames are the graphics stage and the sealed compositions in
  // it; nothing may navigate them elsewhere.
  window.webContents.on("will-frame-navigate", (event) => {
    if (
      !event.isMainFrame &&
      event.url !== `${origin}/stage.html` &&
      !compositionFrameUrl.test(event.url)
    )
      event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.on("closed", () => {
    importing?.abort();
    for (const request of frameRequests) request.abort();
    window = undefined;
  });
  const startupWindow = window;
  let startupComplete = false;
  let rejectInitialRender: (error: Error) => void = () => undefined;
  const initialRenderFailure = new Promise<never>((_resolve, reject) => {
    rejectInitialRender = reject;
  });
  let recoveryOffered = false;
  let recovering = false;
  let rejectRecovery: ((error: Error) => void) | undefined;
  startupWindow.webContents.on("render-process-gone", (_event, details) => {
    if (
      quitting ||
      details.reason === "clean-exit" ||
      startupWindow.isDestroyed()
    )
      return;
    if (!startupComplete) {
      rejectInitialRender(new Error("Initial renderer failed"));
      return;
    }
    importing?.abort();
    for (const request of frameRequests) request.abort();
    if (recovering) {
      quitting = true;
      rejectRecovery?.(new Error("Recovery renderer failed"));
      app.quit();
      return;
    }
    recovering = true;
    const canReopen = !recoveryOffered;
    recoveryOffered = true;
    void (async () => {
      const choice = await dialog.showMessageBox(startupWindow, {
        type: "error",
        title: "Editor window stopped",
        message: canReopen
          ? "The editor window stopped unexpectedly."
          : "The editor window stopped again.",
        detail: canReopen
          ? "Reopen to load saved work. Changes still being saved may be unavailable."
          : "Close the app and restart it to try again.",
        buttons: canReopen ? ["Reopen window", "Close app"] : ["Close app"],
        defaultId: 0,
        cancelId: canReopen ? 1 : 0,
        noLink: true,
      });
      if (quitting || startupWindow.isDestroyed()) return;
      if (!canReopen || choice.response !== 0) {
        quitting = true;
        app.quit();
        return;
      }
      const recoveryFailed = new Promise<never>((_resolve, reject) => {
        rejectRecovery = reject;
      });
      await Promise.race([startupWindow.loadURL(page), recoveryFailed]);
      if (!startupWindow.isDestroyed()) {
        startupWindow.webContents.setZoomFactor(committedScale);
        startupWindow.show();
      }
    })()
      .catch(async () => {
        if (!quitting && !startupWindow.isDestroyed())
          await showStartupFailure();
      })
      .finally(() => {
        rejectRecovery = undefined;
        recovering = false;
      });
  });
  const rendered = new Promise<void>((resolve) => {
    startupWindow.once("ready-to-show", () => resolve());
  });
  await Promise.race([
    Promise.all([startupWindow.loadURL(page), rendered]),
    initialRenderFailure,
  ]);
  startupComplete = true;
  if (!startupWindow.isDestroyed()) {
    // Chromium may restore an origin zoom while loading. Apply the latest committed
    // preference (or the explicit 100% read-failure fallback) before showing it.
    startupWindow.webContents.setZoomFactor(committedScale);
    startupWindow.show();
  }
}
async function showStartupFailure(error?: unknown): Promise<void> {
  if (quitting) return;
  const message =
    error instanceof MediaToolsError
      ? error.message
      : "The local application files could not be loaded. Reinstall the application and try again.";
  // Generic diagnostics contain no source paths, credentials or project details.
  console.error(`ai-video-editor: ${message}`);
  try {
    await dialog.showMessageBox({
      type: "error",
      title: `Could not open ${appIdentity.displayName}`,
      message,
      buttons: ["Close app"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  } finally {
    quitting = true;
    await Promise.all([
      codex?.close(),
      mcpBroker?.close(),
      claude?.close().then(() => claudeBroker?.close()),
    ]);
    servicesClosed = true;
    app.exit(1);
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.whenReady().then(start).catch(showStartupFailure);
}
app.on("window-all-closed", () => app.quit());

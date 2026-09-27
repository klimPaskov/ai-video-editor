import { DesktopCodex } from "./codex.ts";
import { DesktopApiProviders } from "./api-providers.ts";
import { ApiProviderThreads } from "./api-thread.ts";
import { ProviderKeyStore } from "./provider-keys.ts";
import { ApiProviderClient } from "../../../packages/api-providers/src/client.ts";
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
  type CodexVideoEditToolName,
} from "../../../packages/codex-tools/src/service.ts";
import {
  nativeChildReadOnlyToolNames,
  type DynamicToolAccess,
} from "../../../packages/codex-bridge/src/dynamic-tools.ts";
import {
  assertProjectFrameRequest,
  assertProjectRequest,
  assertProjectNavigation,
  assertProjectList,
  assertTwoSourceProjectRequest,
  assertManualTrimRequest,
  assertManualSplitRequest,
  assertManualRangeCutRequest,
  assertManualRestoreRangeRequest,
  assertManualTranscriptCorrectionRequest,
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
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { channels, assertEmptyRequest } from "./bridge.ts";
import {
  assertFrameRequest,
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
import {
  DesktopProjectRuntime,
  committedDraftView,
  invokeWithProjectDraftRefresh,
} from "./project-runtime.ts";
import type { ProjectDraftNotice } from "./project-runtime.ts";

const origin = "codex-video-edit://app";
const page = `${origin}/index.html`;
class UserFacingError extends Error {}
let window: BrowserWindow | undefined;
let importing: AbortController | undefined;
const frameRequests = new Set<AbortController>();
let quitting = false;
let codex: DesktopCodex | undefined;
let mcpBroker: CodexMcpBroker | undefined;
let transcription: DesktopTranscriptionManager | undefined;
let servicesClosed = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (!servicesClosed && (codex || mcpBroker || transcription)) {
    event.preventDefault();
    void Promise.allSettled([
      Promise.resolve().then(() => codex?.close()),
      Promise.resolve().then(() => mcpBroker?.close()),
      Promise.resolve().then(() => transcription?.close()),
    ]).then(() => {
      servicesClosed = true;
      app.quit();
    });
  }
});
app.setName("codex-video-edit");
app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: "codex-video-edit",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
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
          error instanceof UserFacingError
            ? error.message
            : "This operation could not finish. Check the file is available and try again.",
      };
    }
  });
}

async function start(): Promise<void> {
  const files = new Map([
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/renderer.js", ["renderer.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]],
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
  protocol.handle("codex-video-edit", async (request) => {
    const url = new URL(request.url);
    const asset = assets.get(url.pathname);
    if (request.method !== "GET" || url.host !== "app" || url.search || !asset)
      return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(asset.bytes), {
      headers: {
        "Content-Type": asset.mime,
        "Content-Security-Policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'",
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (event) => event.preventDefault());
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
  const library = new MediaLibrary(path.join(userData, "media-library"));
  const projectRoot = path.join(userData, "project-store");
  const projects = new ProjectStore(projectRoot, library);
  const drafts = new DraftTransactionStore(projectRoot, projects);
  const projectRuntime = new DesktopProjectRuntime(drafts, library);
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
      throw new UserFacingError("Switch to Auto Edit to transcribe locally.");
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
        "Switch to Auto Edit or Edit to view the transcript.",
      );
  };
  const publishDraftNotice = (notice: ProjectDraftNotice): void => {
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channels.projectDraftChanged, notice);
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
        new CodexVideoEditToolService(projectId, drafts).invoke(name, input),
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
  register(channels.projectCreate, async (request) => {
    assertProjectRequest(request);
    const created = await projects.createFromMedia(request.id),
      value = await projectRuntime.view(created.project.project_id);
    activeProjectId = value.id;
    return value;
  });
  register(channels.projectCreateTwo, async (request) => {
    assertTwoSourceProjectRequest(request);
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
    await projects.open(request.id);
    const value = await projectRuntime.view(request.id);
    activeProjectId = value.id;
    return value;
  });
  register(channels.projectClose, async (request) => {
    assertProjectRequest(request);
    if (activeProjectId === request.id) {
      if (transcription!.isRunning(request.id))
        throw new UserFacingError(
          "Stop local transcription before closing this project.",
        );
      if (
        ["opening", "starting", "running", "interrupting"].includes(
          codex!.getThread(request.id).status,
        )
      )
        throw new UserFacingError(
          "Stop the running Codex turn before leaving this project.",
        );
      for (const provider of apiProviderIds) {
        const turn = await apiThreads.get(request.id, provider);
        if (turn.status === "running" || turn.status === "interrupting")
          throw new UserFacingError(
            "Stop the running provider turn before leaving this project.",
          );
      }
      await codex!.closeThread(request.id);
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
  register(channels.projectNavigate, async (request) => {
    assertProjectNavigation(request);
    if (activeProjectId !== request.id) throw new Error("Inactive project");
    if (request.stage !== "auto_edit" && transcription!.isRunning(request.id))
      throw new UserFacingError(
        "Stop local transcription before leaving Auto Edit.",
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
      throw new UserFacingError("Switch to Edit to restore a source range.");
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
        "Switch to Edit to correct transcript wording.",
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
    title: "codex-video-edit",
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
async function showStartupFailure(): Promise<void> {
  if (quitting) return;
  const message =
    "The local application files could not be loaded. Reinstall the application and try again.";
  // Generic diagnostics contain no source paths, credentials or project details.
  console.error(`codex-video-edit: ${message}`);
  try {
    await dialog.showMessageBox({
      type: "error",
      title: "Could not open codex-video-edit",
      message,
      buttons: ["Close app"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  } finally {
    quitting = true;
    await Promise.all([codex?.close(), mcpBroker?.close()]);
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

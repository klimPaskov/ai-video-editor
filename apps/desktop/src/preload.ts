import {
  assertCodexView,
  assertCodexSelection,
} from "../../../packages/domain/src/codex-view.ts";
import { assertDeviceLoginDetails } from "../../../packages/domain/src/codex-device-login.ts";
import {
  assertApiProviderConnectRequest,
  assertApiProviderModelRequest,
  assertApiProviderRequest,
  assertApiProvidersView,
} from "../../../packages/domain/src/api-providers.ts";
import {
  assertApiThreadProjectRequest,
  assertApiThreadSendRequest,
  assertApiThreadView,
} from "../../../packages/domain/src/api-thread-view.ts";
import {
  assertTranscriptionJobRequest,
  assertTranscriptionProjectRequest,
  assertTranscriptionProjectView,
  assertTranscriptionStopRequest,
} from "../../../packages/domain/src/transcription.ts";
import { assertPreferences } from "../../../packages/domain/src/preferences.ts";
import {
  assertProjectDraftView,
  assertProjectDraftIntegrityView,
  assertProjectFrameRequest,
  assertProjectFrameResult,
  assertManualTrimRequest,
  assertManualSplitRequest,
  assertManualRangeCutRequest,
  assertManualRestoreRangeRequest,
  assertManualUndoRequest,
  assertManualRedoRequest,
  assertProjectRequest,
  assertTwoSourceProjectRequest,
  assertProjectNavigation,
  assertProjectView,
  assertProjectList,
} from "../../../packages/domain/src/project-view.ts";
import { contextBridge, ipcRenderer } from "electron";
import { channels } from "./bridge.ts";
import type { DesktopBridge, Reply } from "./bridge.ts";
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

async function invoke<T>(
  channel: string,
  request: unknown,
  validate: (value: unknown) => void,
): Promise<Reply<T>> {
  const result: unknown = await ipcRenderer.invoke(channel, request);
  return reply(result, validate);
}
function reply<T>(
  result: unknown,
  validate: (value: unknown) => void,
): Reply<T> {
  if (!result || typeof result !== "object" || !("ok" in result))
    throw new Error("Invalid desktop response");
  if (
    result.ok === false &&
    Object.keys(result).sort().join() === "message,ok" &&
    "message" in result &&
    typeof result.message === "string" &&
    result.message.length > 0 &&
    result.message.length <= 240
  ) {
    return { ok: false, message: result.message };
  }
  if (
    result.ok !== true ||
    Object.keys(result).sort().join() !== "ok,value" ||
    !("value" in result)
  )
    throw new Error("Invalid desktop response");
  validate(result.value);
  return { ok: true, value: result.value as T };
}
const bridge: DesktopBridge = {
  getApiThread: (request) => {
    assertApiThreadProjectRequest(request);
    return invoke(channels.apiThreadGet, request, assertApiThreadView);
  },
  openApiThread: (request) => {
    assertApiThreadProjectRequest(request);
    return invoke(channels.apiThreadOpen, request, assertApiThreadView);
  },
  sendApiThread: (request) => {
    assertApiThreadSendRequest(request);
    return invoke(channels.apiThreadSend, request, assertApiThreadView);
  },
  interruptApiThread: (request) => {
    assertApiThreadProjectRequest(request);
    return invoke(channels.apiThreadInterrupt, request, assertApiThreadView);
  },
  getTranscription: (request) => {
    assertTranscriptionJobRequest(request);
    return invoke(
      channels.transcriptionGet,
      request,
      assertTranscriptionProjectView,
    );
  },
  startTranscription: (request) => {
    assertTranscriptionProjectRequest(request);
    return invoke(
      channels.transcriptionStart,
      request,
      assertTranscriptionProjectView,
    );
  },
  stopTranscription: (request) => {
    assertTranscriptionStopRequest(request);
    return invoke(
      channels.transcriptionStop,
      request,
      assertTranscriptionProjectView,
    );
  },
  getApiProviders: () =>
    invoke(channels.apiProvidersGet, undefined, assertApiProvidersView),
  connectApiProvider: (request) => {
    assertApiProviderConnectRequest(request);
    return invoke(
      channels.apiProvidersConnect,
      request,
      assertApiProvidersView,
    );
  },
  removeApiProvider: (request) => {
    assertApiProviderRequest(request);
    return invoke(channels.apiProvidersRemove, request, assertApiProvidersView);
  },
  selectApiProviderModel: (request) => {
    assertApiProviderModelRequest(request);
    return invoke(
      channels.apiProvidersSelectModel,
      request,
      assertApiProvidersView,
    );
  },
  getCodex: () => invoke(channels.codexGet, undefined, assertCodexView),
  reconnectCodex: () =>
    invoke(channels.codexReconnect, undefined, assertCodexView),
  loginCodex: () => invoke(channels.codexLogin, undefined, assertCodexView),
  loginCodexDeviceCode: () =>
    invoke(channels.codexDeviceLogin, undefined, assertDeviceLoginDetails),
  openCodexDeviceVerification: () =>
    invoke(channels.codexDeviceVerification, undefined, (value) => {
      if (value !== null)
        throw new Error("Invalid device verification response");
    }),
  cancelCodexLogin: () =>
    invoke(channels.codexCancelLogin, undefined, assertCodexView),
  logoutCodex: () => invoke(channels.codexLogout, undefined, assertCodexView),
  selectCodexModel: (value) => {
    assertCodexSelection(value);
    return invoke(channels.codexSelect, value, assertCodexView);
  },
  getCodexThread: (request) => {
    assertCodexThreadProjectRequest(request);
    return invoke(channels.codexThreadGet, request, assertCodexThreadView);
  },
  openCodexThread: (request) => {
    assertCodexThreadProjectRequest(request);
    return invoke(channels.codexThreadOpen, request, assertCodexThreadView);
  },
  sendCodexThread: (request) => {
    assertCodexThreadSendRequest(request);
    return invoke(channels.codexThreadSend, request, assertCodexThreadView);
  },
  interruptCodexThread: (request) => {
    assertCodexThreadProjectRequest(request);
    return invoke(
      channels.codexThreadInterrupt,
      request,
      assertCodexThreadView,
    );
  },
  listProjects: () =>
    invoke(channels.projectList, undefined, assertProjectList),
  createProject: (request) => {
    assertProjectRequest(request);
    return invoke(channels.projectCreate, request, assertProjectView);
  },
  createTwoSourceProject: (request) => {
    assertTwoSourceProjectRequest(request);
    return invoke(channels.projectCreateTwo, request, assertProjectView);
  },
  openProject: (request) => {
    assertProjectRequest(request);
    return invoke(channels.projectOpen, request, assertProjectView);
  },
  closeProject: (request) => {
    assertProjectRequest(request);
    return invoke(channels.projectClose, request, (value) => {
      if (value !== null) throw new Error("Invalid response");
    });
  },
  navigateProject: (request) => {
    assertProjectNavigation(request);
    return invoke(channels.projectNavigate, request, assertProjectView);
  },
  verifyDraftIntegrity: (request) => {
    assertProjectRequest(request);
    return invoke(
      channels.projectIntegrityCheck,
      request,
      assertProjectDraftIntegrityView,
    );
  },
  readProjectFrame: (request) => {
    assertProjectFrameRequest(request);
    return invoke(channels.projectFrame, request, assertProjectFrameResult);
  },
  applyManualTrim: (request) => {
    assertManualTrimRequest(request);
    return invoke(channels.projectManualTrim, request, assertProjectDraftView);
  },
  applyManualSplit: (request) => {
    assertManualSplitRequest(request);
    return invoke(channels.projectManualSplit, request, assertProjectDraftView);
  },
  applyManualRangeCut: (request) => {
    assertManualRangeCutRequest(request);
    return invoke(
      channels.projectManualRangeCut,
      request,
      assertProjectDraftView,
    );
  },
  applyManualRestoreRange: (request) => {
    assertManualRestoreRangeRequest(request);
    return invoke(
      channels.projectManualRestoreRange,
      request,
      assertProjectDraftView,
    );
  },
  undoManualEdit: (request) => {
    assertManualUndoRequest(request);
    return invoke(channels.projectManualUndo, request, assertProjectDraftView);
  },
  redoManualEdit: (request) => {
    assertManualRedoRequest(request);
    return invoke(channels.projectManualRedo, request, assertProjectDraftView);
  },
  onProjectDraftChanged: (listener) => {
    if (typeof listener !== "function")
      throw new Error("Invalid project listener");
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      listener(reply(value, assertProjectDraftView));
    };
    ipcRenderer.on(channels.projectDraftChanged, receive);
    return () =>
      ipcRenderer.removeListener(channels.projectDraftChanged, receive);
  },
  getPreferences: () =>
    invoke(channels.preferencesGet, undefined, assertPreferences),
  setPreferences: (value) => {
    assertPreferences(value);
    return invoke(channels.preferencesSet, value, assertPreferences);
  },
  listMedia: () => invoke(channels.list, undefined, assertMediaList),
  importVideo: () =>
    invoke(channels.import, undefined, (value) => {
      if (value !== null) assertMediaSummary(value);
    }),
  readFrame: (request) => {
    assertFrameRequest(request);
    return invoke(channels.frame, request, assertMediaFrame);
  },
  cancelImport: () =>
    invoke(channels.cancel, undefined, (value) => {
      if (value !== null) throw new Error("Invalid response");
    }),
};
contextBridge.exposeInMainWorld("desktop", Object.freeze(bridge));

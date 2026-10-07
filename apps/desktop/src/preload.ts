import {
  assertCodexView,
  assertCodexSelection,
} from "../../../packages/domain/src/codex-view.ts";
import {
  assertClaudeSelection,
  assertClaudeThreadProjectRequest,
  assertClaudeThreadSendRequest,
  assertClaudeThreadView,
  assertClaudeView,
} from "../../../packages/domain/src/claude-view.ts";
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
  assertMagicWandProjectRequest,
  assertMagicWandStartRequest,
  assertMagicWandView,
} from "../../../packages/domain/src/magic-wand-view.ts";
import {
  assertCaptionSettings,
  assertCaptionSettingsRequest,
  assertCaptionSettingsUpdate,
} from "../../../packages/domain/src/captions.ts";
import {
  assertAudioSettings,
  assertAudioSettingsRequest,
  assertAudioSettingsUpdate,
} from "../../../packages/domain/src/audio-settings.ts";
import {
  assertShortClipRequest,
  assertShortClipsView,
  assertShortExportRequest,
  assertShortProjectRequest,
} from "../../../packages/domain/src/short-clips-view.ts";
import {
  assertPlaybackProjectRequest,
  assertPlaybackView,
} from "../../../packages/domain/src/playback-view.ts";
import {
  assertRecordingDevices,
  assertRecordingStartRequest,
  assertRecordingView,
} from "../../../packages/domain/src/recording-view.ts";
import {
  assertExportProjectRequest,
  assertExportStartRequest,
  assertExportView,
} from "../../../packages/domain/src/export-view.ts";
import {
  assertProjectDraftView,
  assertProjectDraftIntegrityView,
  assertProjectFrameRequest,
  assertProjectFrameResult,
  assertManualTrimRequest,
  assertManualSplitRequest,
  assertManualRangeCutRequest,
  assertManualZoomRequest,
  assertManualZoomRemoveRequest,
  assertManualRestoreRangeRequest,
  assertManualTranscriptCorrectionRequest,
  assertManualTranscriptCutRequest,
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
  getClaude: () => invoke(channels.claudeGet, undefined, assertClaudeView),
  checkClaude: () => invoke(channels.claudeCheck, undefined, assertClaudeView),
  signInClaude: () =>
    invoke(channels.claudeSignIn, undefined, assertClaudeView),
  cancelClaudeSignIn: () =>
    invoke(channels.claudeCancelSignIn, undefined, assertClaudeView),
  signOutClaude: () =>
    invoke(channels.claudeSignOut, undefined, assertClaudeView),
  selectClaudeModel: (value) => {
    assertClaudeSelection(value);
    return invoke(channels.claudeSelect, value, assertClaudeView);
  },
  openClaudeInstallGuide: () =>
    invoke(channels.claudeInstallGuide, undefined, (value) => {
      if (value !== null) throw new Error("Invalid install guide response");
    }),
  getClaudeThread: (request) => {
    assertClaudeThreadProjectRequest(request);
    return invoke(channels.claudeThreadGet, request, assertClaudeThreadView);
  },
  openClaudeThread: (request) => {
    assertClaudeThreadProjectRequest(request);
    return invoke(channels.claudeThreadOpen, request, assertClaudeThreadView);
  },
  sendClaudeThread: (request) => {
    assertClaudeThreadSendRequest(request);
    return invoke(channels.claudeThreadSend, request, assertClaudeThreadView);
  },
  interruptClaudeThread: (request) => {
    assertClaudeThreadProjectRequest(request);
    return invoke(
      channels.claudeThreadInterrupt,
      request,
      assertClaudeThreadView,
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
  getPlayback: (request) => {
    assertPlaybackProjectRequest(request);
    return invoke(channels.playbackGet, request, assertPlaybackView);
  },
  applyManualZoom: (request) => {
    assertManualZoomRequest(request);
    return invoke(channels.projectManualZoom, request, assertProjectDraftView);
  },
  removeManualZoom: (request) => {
    assertManualZoomRemoveRequest(request);
    return invoke(
      channels.projectManualZoomRemove,
      request,
      assertProjectDraftView,
    );
  },
  getAudioSettings: (request) => {
    assertAudioSettingsRequest(request);
    return invoke(channels.audioGet, request, assertAudioSettings);
  },
  setAudioSettings: (request) => {
    assertAudioSettingsUpdate(request);
    return invoke(channels.audioSet, request, assertAudioSettings);
  },
  getShortClips: (request) => {
    assertShortProjectRequest(request);
    return invoke(channels.shortsGet, request, assertShortClipsView);
  },
  findShortClips: (request) => {
    assertShortProjectRequest(request);
    return invoke(channels.shortsFind, request, assertShortClipsView);
  },
  discardShortClip: (request) => {
    assertShortClipRequest(request);
    return invoke(channels.shortsDiscard, request, assertShortClipsView);
  },
  exportShortClip: (request) => {
    assertShortExportRequest(request);
    return invoke(channels.shortsExport, request, assertShortClipsView);
  },
  cancelShortClip: (request) => {
    assertShortProjectRequest(request);
    return invoke(channels.shortsCancel, request, assertShortClipsView);
  },
  getCaptionSettings: (request) => {
    assertCaptionSettingsRequest(request);
    return invoke(channels.captionsGet, request, assertCaptionSettings);
  },
  setCaptionSettings: (request) => {
    assertCaptionSettingsUpdate(request);
    return invoke(channels.captionsSet, request, assertCaptionSettings);
  },
  getRecordingDevices: () =>
    invoke(channels.recordingDevices, undefined, assertRecordingDevices),
  getRecording: () =>
    invoke(channels.recordingGet, undefined, assertRecordingView),
  startRecording: (request) => {
    assertRecordingStartRequest(request);
    return invoke(channels.recordingStart, request, assertRecordingView);
  },
  pauseRecording: () =>
    invoke(channels.recordingPause, undefined, assertRecordingView),
  resumeRecording: () =>
    invoke(channels.recordingResume, undefined, assertRecordingView),
  stopRecording: () =>
    invoke(channels.recordingStop, undefined, assertRecordingView),
  cancelRecording: () =>
    invoke(channels.recordingCancel, undefined, assertRecordingView),
  getMagicWand: (request) => {
    assertMagicWandProjectRequest(request);
    return invoke(channels.magicGet, request, assertMagicWandView);
  },
  startMagicWand: (request) => {
    assertMagicWandStartRequest(request);
    return invoke(channels.magicStart, request, assertMagicWandView);
  },
  stopMagicWand: (request) => {
    assertMagicWandProjectRequest(request);
    return invoke(channels.magicStop, request, assertMagicWandView);
  },
  getExport: (request) => {
    assertExportProjectRequest(request);
    return invoke(channels.exportGet, request, assertExportView);
  },
  startExport: (request) => {
    assertExportStartRequest(request);
    return invoke(channels.exportStart, request, assertExportView);
  },
  cancelExport: (request) => {
    assertExportProjectRequest(request);
    return invoke(channels.exportCancel, request, assertExportView);
  },
  resetExport: (request) => {
    assertExportProjectRequest(request);
    return invoke(channels.exportReset, request, assertExportView);
  },
  revealExport: (request) => {
    assertExportProjectRequest(request);
    return invoke(channels.exportReveal, request, (value) => {
      if (value !== null) throw new Error("Invalid export response");
    });
  },
  openExport: (request) => {
    assertExportProjectRequest(request);
    return invoke(channels.exportOpen, request, (value) => {
      if (value !== null) throw new Error("Invalid export response");
    });
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
  correctTranscriptWord: (request) => {
    assertManualTranscriptCorrectionRequest(request);
    return invoke(
      channels.projectTranscriptCorrection,
      request,
      assertProjectDraftView,
    );
  },
  cutTranscriptWords: (request) => {
    assertManualTranscriptCutRequest(request);
    return invoke(
      channels.projectTranscriptCut,
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
  readThumbnail: (request) => {
    assertThumbnailRequest(request);
    return invoke(channels.thumbnail, request, assertThumbnail);
  },
  cancelImport: () =>
    invoke(channels.cancel, undefined, (value) => {
      if (value !== null) throw new Error("Invalid response");
    }),
};
contextBridge.exposeInMainWorld("desktop", Object.freeze(bridge));

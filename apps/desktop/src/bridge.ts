import type {
  CodexView,
  CodexSelection,
} from "../../../packages/domain/src/codex-view.ts";
import type { DeviceLoginDetails } from "../../../packages/domain/src/codex-device-login.ts";
import type {
  ApiProviderConnectRequest,
  ApiProviderModelRequest,
  ApiProviderRequest,
  ApiProvidersView,
} from "../../../packages/domain/src/api-providers.ts";
import type { Preferences } from "../../../packages/domain/src/preferences.ts";
import type {
  MagicWandProjectRequest,
  MagicWandStartRequest,
  MagicWandView,
} from "../../../packages/domain/src/magic-wand-view.ts";
import type {
  CaptionSettings,
  CaptionSettingsRequest,
  CaptionSettingsUpdate,
} from "../../../packages/domain/src/captions.ts";
import type {
  AudioSettings,
  AudioSettingsRequest,
  AudioSettingsUpdate,
} from "../../../packages/domain/src/audio-settings.ts";
import type {
  ShortClipRequest,
  ShortClipsView,
  ShortExportRequest,
  ShortProjectRequest,
} from "../../../packages/domain/src/short-clips-view.ts";
import type {
  PlaybackProjectRequest,
  PlaybackView,
} from "../../../packages/domain/src/playback-view.ts";
import type {
  RecordingDevices,
  RecordingStartRequest,
  RecordingView,
} from "../../../packages/domain/src/recording-view.ts";
import type {
  ExportProjectRequest,
  ExportStartRequest,
  ExportView,
} from "../../../packages/domain/src/export-view.ts";
import type {
  ProjectDraftView,
  ProjectDraftIntegrityView,
  ProjectFrameRequest,
  ProjectFrameResult,
  ProjectView,
  ProjectRequest,
  ProjectNavigation,
  TwoSourceProjectRequest,
  ManualTrimRequest,
  ManualSplitRequest,
  ManualRangeCutRequest,
  ManualZoomRequest,
  ManualZoomRemoveRequest,
  ManualRestoreRangeRequest,
  ManualTranscriptCorrectionRequest,
  ManualTranscriptCutRequest,
  ManualUndoRequest,
  ManualRedoRequest,
} from "../../../packages/domain/src/project-view.ts";
import type {
  FrameRequest,
  ThumbnailRequest,
  MediaFrame,
  MediaSummary,
} from "../../../packages/domain/src/library.ts";
import type {
  CodexThreadProjectRequest,
  CodexThreadSendRequest,
  CodexThreadView,
} from "../../../packages/domain/src/codex-thread-view.ts";
import type {
  ApiThreadProjectRequest,
  ApiThreadSendRequest,
  ApiThreadView,
} from "../../../packages/domain/src/api-thread-view.ts";
import type {
  TranscriptionJobRequest,
  TranscriptionProjectRequest,
  TranscriptionProjectView,
  TranscriptionStopRequest,
} from "../../../packages/domain/src/transcription.ts";

import type {
  ClaudeSelection,
  ClaudeThreadProjectRequest,
  ClaudeThreadSendRequest,
  ClaudeThreadView,
  ClaudeView,
} from "../../../packages/domain/src/claude-view.ts";

export type Reply<T> = { ok: true; value: T } | { ok: false; message: string };
export interface DesktopBridge {
  getClaude(): Promise<Reply<ClaudeView>>;
  checkClaude(): Promise<Reply<ClaudeView>>;
  signInClaude(): Promise<Reply<ClaudeView>>;
  cancelClaudeSignIn(): Promise<Reply<ClaudeView>>;
  signOutClaude(): Promise<Reply<ClaudeView>>;
  selectClaudeModel(value: ClaudeSelection): Promise<Reply<ClaudeView>>;
  openClaudeInstallGuide(): Promise<Reply<null>>;
  getClaudeThread(
    request: ClaudeThreadProjectRequest,
  ): Promise<Reply<ClaudeThreadView>>;
  openClaudeThread(
    request: ClaudeThreadProjectRequest,
  ): Promise<Reply<ClaudeThreadView>>;
  sendClaudeThread(
    request: ClaudeThreadSendRequest,
  ): Promise<Reply<ClaudeThreadView>>;
  interruptClaudeThread(
    request: ClaudeThreadProjectRequest,
  ): Promise<Reply<ClaudeThreadView>>;
  getApiThread(request: ApiThreadProjectRequest): Promise<Reply<ApiThreadView>>;
  openApiThread(
    request: ApiThreadProjectRequest,
  ): Promise<Reply<ApiThreadView>>;
  sendApiThread(request: ApiThreadSendRequest): Promise<Reply<ApiThreadView>>;
  interruptApiThread(
    request: ApiThreadProjectRequest,
  ): Promise<Reply<ApiThreadView>>;
  getTranscription(
    request: TranscriptionJobRequest,
  ): Promise<Reply<TranscriptionProjectView>>;
  startTranscription(
    request: TranscriptionProjectRequest,
  ): Promise<Reply<TranscriptionProjectView>>;
  stopTranscription(
    request: TranscriptionStopRequest,
  ): Promise<Reply<TranscriptionProjectView>>;
  getApiProviders(): Promise<Reply<ApiProvidersView>>;
  connectApiProvider(
    request: ApiProviderConnectRequest,
  ): Promise<Reply<ApiProvidersView>>;
  removeApiProvider(
    request: ApiProviderRequest,
  ): Promise<Reply<ApiProvidersView>>;
  selectApiProviderModel(
    request: ApiProviderModelRequest,
  ): Promise<Reply<ApiProvidersView>>;
  getCodex(): Promise<Reply<CodexView>>;
  reconnectCodex(): Promise<Reply<CodexView>>;
  loginCodex(): Promise<Reply<CodexView>>;
  loginCodexDeviceCode(): Promise<Reply<DeviceLoginDetails>>;
  openCodexDeviceVerification(): Promise<Reply<null>>;
  cancelCodexLogin(): Promise<Reply<CodexView>>;
  logoutCodex(): Promise<Reply<CodexView>>;
  selectCodexModel(value: CodexSelection): Promise<Reply<CodexView>>;
  getCodexThread(
    request: CodexThreadProjectRequest,
  ): Promise<Reply<CodexThreadView>>;
  openCodexThread(
    request: CodexThreadProjectRequest,
  ): Promise<Reply<CodexThreadView>>;
  sendCodexThread(
    request: CodexThreadSendRequest,
  ): Promise<Reply<CodexThreadView>>;
  interruptCodexThread(
    request: CodexThreadProjectRequest,
  ): Promise<Reply<CodexThreadView>>;
  getPlayback(request: PlaybackProjectRequest): Promise<Reply<PlaybackView>>;
  applyManualZoom(request: ManualZoomRequest): Promise<Reply<ProjectDraftView>>;
  removeManualZoom(
    request: ManualZoomRemoveRequest,
  ): Promise<Reply<ProjectDraftView>>;
  getAudioSettings(
    request: AudioSettingsRequest,
  ): Promise<Reply<AudioSettings>>;
  setAudioSettings(request: AudioSettingsUpdate): Promise<Reply<AudioSettings>>;
  getShortClips(request: ShortProjectRequest): Promise<Reply<ShortClipsView>>;
  findShortClips(request: ShortProjectRequest): Promise<Reply<ShortClipsView>>;
  discardShortClip(request: ShortClipRequest): Promise<Reply<ShortClipsView>>;
  exportShortClip(request: ShortExportRequest): Promise<Reply<ShortClipsView>>;
  cancelShortClip(request: ShortProjectRequest): Promise<Reply<ShortClipsView>>;
  getCaptionSettings(
    request: CaptionSettingsRequest,
  ): Promise<Reply<CaptionSettings>>;
  setCaptionSettings(
    request: CaptionSettingsUpdate,
  ): Promise<Reply<CaptionSettings>>;
  getRecordingDevices(): Promise<Reply<RecordingDevices>>;
  getRecording(): Promise<Reply<RecordingView>>;
  startRecording(request: RecordingStartRequest): Promise<Reply<RecordingView>>;
  pauseRecording(): Promise<Reply<RecordingView>>;
  resumeRecording(): Promise<Reply<RecordingView>>;
  stopRecording(): Promise<Reply<RecordingView>>;
  cancelRecording(): Promise<Reply<RecordingView>>;
  getMagicWand(request: MagicWandProjectRequest): Promise<Reply<MagicWandView>>;
  startMagicWand(request: MagicWandStartRequest): Promise<Reply<MagicWandView>>;
  stopMagicWand(
    request: MagicWandProjectRequest,
  ): Promise<Reply<MagicWandView>>;
  getExport(request: ExportProjectRequest): Promise<Reply<ExportView>>;
  startExport(request: ExportStartRequest): Promise<Reply<ExportView>>;
  cancelExport(request: ExportProjectRequest): Promise<Reply<ExportView>>;
  resetExport(request: ExportProjectRequest): Promise<Reply<ExportView>>;
  revealExport(request: ExportProjectRequest): Promise<Reply<null>>;
  openExport(request: ExportProjectRequest): Promise<Reply<null>>;
  listProjects(): Promise<Reply<ProjectView[]>>;
  createProject(request: ProjectRequest): Promise<Reply<ProjectView>>;
  createTwoSourceProject(
    request: TwoSourceProjectRequest,
  ): Promise<Reply<ProjectView>>;
  openProject(request: ProjectRequest): Promise<Reply<ProjectView>>;
  closeProject(request: ProjectRequest): Promise<Reply<null>>;
  navigateProject(request: ProjectNavigation): Promise<Reply<ProjectView>>;
  verifyDraftIntegrity(
    request: ProjectRequest,
  ): Promise<Reply<ProjectDraftIntegrityView>>;
  readProjectFrame(
    request: ProjectFrameRequest,
  ): Promise<Reply<ProjectFrameResult>>;
  applyManualTrim(request: ManualTrimRequest): Promise<Reply<ProjectDraftView>>;
  applyManualSplit(
    request: ManualSplitRequest,
  ): Promise<Reply<ProjectDraftView>>;
  applyManualRangeCut(
    request: ManualRangeCutRequest,
  ): Promise<Reply<ProjectDraftView>>;
  applyManualRestoreRange(
    request: ManualRestoreRangeRequest,
  ): Promise<Reply<ProjectDraftView>>;
  correctTranscriptWord(
    request: ManualTranscriptCorrectionRequest,
  ): Promise<Reply<ProjectDraftView>>;
  cutTranscriptWords(
    request: ManualTranscriptCutRequest,
  ): Promise<Reply<ProjectDraftView>>;
  undoManualEdit(request: ManualUndoRequest): Promise<Reply<ProjectDraftView>>;
  redoManualEdit(request: ManualRedoRequest): Promise<Reply<ProjectDraftView>>;
  onProjectDraftChanged(
    listener: (reply: Reply<ProjectDraftView>) => void,
  ): () => void;
  getPreferences(): Promise<Reply<Preferences>>;
  setPreferences(value: Preferences): Promise<Reply<Preferences>>;
  listMedia(): Promise<Reply<MediaSummary[]>>;
  importVideo(): Promise<Reply<MediaSummary | null>>;
  readFrame(request: FrameRequest): Promise<Reply<MediaFrame>>;
  readThumbnail(request: ThumbnailRequest): Promise<Reply<MediaFrame>>;
  cancelImport(): Promise<Reply<null>>;
}
export const channels = Object.freeze({
  playbackGet: "playback:get",
  projectManualZoom: "projects:manual-zoom",
  projectManualZoomRemove: "projects:manual-zoom-remove",
  audioGet: "audio:get",
  audioSet: "audio:set",
  shortsGet: "shorts:get",
  shortsFind: "shorts:find",
  shortsDiscard: "shorts:discard",
  shortsExport: "shorts:export",
  shortsCancel: "shorts:cancel",
  captionsGet: "captions:get",
  captionsSet: "captions:set",
  recordingDevices: "recording:devices",
  recordingGet: "recording:get",
  recordingStart: "recording:start",
  recordingPause: "recording:pause",
  recordingResume: "recording:resume",
  recordingStop: "recording:stop",
  recordingCancel: "recording:cancel",
  magicGet: "magic:get",
  magicStart: "magic:start",
  magicStop: "magic:stop",
  exportGet: "export:get",
  exportStart: "export:start",
  exportCancel: "export:cancel",
  exportReset: "export:reset",
  exportReveal: "export:reveal",
  exportOpen: "export:open",
  claudeGet: "claude:get",
  claudeCheck: "claude:check",
  claudeSignIn: "claude:sign-in",
  claudeCancelSignIn: "claude:cancel-sign-in",
  claudeSignOut: "claude:sign-out",
  claudeSelect: "claude:select",
  claudeInstallGuide: "claude:install-guide",
  claudeThreadGet: "claude-thread:get",
  claudeThreadOpen: "claude-thread:open",
  claudeThreadSend: "claude-thread:send",
  claudeThreadInterrupt: "claude-thread:interrupt",
  apiThreadGet: "api-thread:get",
  apiThreadOpen: "api-thread:open",
  apiThreadSend: "api-thread:send",
  apiThreadInterrupt: "api-thread:interrupt",
  transcriptionGet: "transcription:get",
  transcriptionStart: "transcription:start",
  transcriptionStop: "transcription:stop",
  apiProvidersGet: "api-providers:get",
  apiProvidersConnect: "api-providers:connect",
  apiProvidersRemove: "api-providers:remove",
  apiProvidersSelectModel: "api-providers:select-model",
  codexGet: "codex:get",
  codexReconnect: "codex:reconnect",
  codexLogin: "codex:login",
  codexDeviceLogin: "codex:device-login",
  codexDeviceVerification: "codex:device-verification",
  codexCancelLogin: "codex:cancel-login",
  codexLogout: "codex:logout",
  codexSelect: "codex:select",
  codexThreadGet: "codex-thread:get",
  codexThreadOpen: "codex-thread:open",
  codexThreadSend: "codex-thread:send",
  codexThreadInterrupt: "codex-thread:interrupt",
  projectList: "projects:list",
  projectCreate: "projects:create",
  projectCreateTwo: "projects:create-two",
  projectOpen: "projects:open",
  projectClose: "projects:close",
  projectNavigate: "projects:navigate",
  projectIntegrityCheck: "projects:verify-draft-integrity",
  projectFrame: "projects:frame",
  projectManualTrim: "projects:manual-trim",
  projectManualSplit: "projects:manual-split",
  projectManualRangeCut: "projects:manual-range-cut",
  projectManualRestoreRange: "projects:manual-restore-range",
  projectTranscriptCorrection: "projects:transcript-correction",
  projectTranscriptCut: "projects:transcript-cut",
  projectManualUndo: "projects:manual-undo",
  projectManualRedo: "projects:manual-redo",
  projectDraftChanged: "projects:draft-changed",
  preferencesGet: "preferences:get",
  preferencesSet: "preferences:set",
  list: "library:list",
  import: "library:import",
  frame: "library:frame",
  thumbnail: "library:thumbnail",
  cancel: "library:cancel",
});
export function assertEmptyRequest(value: unknown): void {
  if (value !== undefined) throw new Error("Unexpected request parameters");
}

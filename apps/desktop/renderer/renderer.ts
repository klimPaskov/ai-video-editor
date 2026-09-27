import { setupCodexSettings } from "./codex-settings.ts";
import { draftIntegrityFreshness } from "./draft-integrity.ts";
import { reconcileProjectDraft } from "./project-draft.ts";
import { pollTranscriptionView } from "./transcription-state.ts";
import { assertPreferences } from "../../../packages/domain/src/preferences.ts";
import type { DesktopBridge, Reply } from "../src/bridge.ts";
import type {
  MediaFrame,
  MediaSummary,
} from "../../../packages/domain/src/library.ts";
import type {
  ProjectDraftView,
  ProjectStage,
  ProjectView,
} from "../../../packages/domain/src/project-view.ts";
import type { CodexThreadView } from "../../../packages/domain/src/codex-thread-view.ts";
import type { ApiThreadView } from "../../../packages/domain/src/api-thread-view.ts";
import type { ApiProviderId } from "../../../packages/domain/src/api-providers.ts";
import type { TranscriptionProjectView } from "../../../packages/domain/src/transcription.ts";
declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Missing control");
  return value as T;
}
const home = element("home"),
  viewer = element("viewer"),
  back = element<HTMLButtonElement>("back");
const importButton = element<HTMLButtonElement>("import"),
  addFootageButton = element<HTMLButtonElement>("add-footage"),
  appendProgress = element("append-progress"),
  progress = element("progress"),
  error = element("error");
const seek = element<HTMLInputElement>("seek"),
  canvas = element<HTMLCanvasElement>("frame");
const previous = element<HTMLButtonElement>("previous"),
  next = element<HTMLButtonElement>("next");
const editActions = element("edit-actions"),
  editClip = element("edit-clip"),
  trimStart = element<HTMLButtonElement>("trim-start"),
  trimEnd = element<HTMLButtonElement>("trim-end"),
  splitClip = element<HTMLButtonElement>("split-clip"),
  undoEdit = element<HTMLButtonElement>("undo-edit"),
  redoEdit = element<HTMLButtonElement>("redo-edit"),
  markInButton = element<HTMLButtonElement>("mark-in"),
  markOutButton = element<HTMLButtonElement>("mark-out"),
  cutSelection = element("cut-selection"),
  cutRangeButton = element<HTMLButtonElement>("cut-range"),
  clearMarksButton = element<HTMLButtonElement>("clear-marks"),
  restoreToggleButton = element<HTMLButtonElement>("restore-toggle"),
  restoreForm = element("restore-form"),
  restoreSource = element<HTMLSelectElement>("restore-source"),
  restoreSourceStart = element<HTMLInputElement>("restore-source-start"),
  restoreSourceEnd = element<HTMLInputElement>("restore-source-end"),
  restoreSubmit = element<HTMLButtonElement>("restore-submit"),
  restoreError = element("restore-error");
const reviewActions = element("review-actions"),
  checkDraftIntegrityButton = element<HTMLButtonElement>(
    "check-draft-integrity",
  ),
  draftIntegrityResult = element("draft-integrity-result"),
  draftIntegrityError = element("draft-integrity-error");
const autoEditActions = element("auto-edit-actions"),
  transcribeLocalButton = element<HTMLButtonElement>("transcribe-local"),
  stopTranscriptionButton = element<HTMLButtonElement>("stop-transcription"),
  transcriptionDisclosure = element("transcription-disclosure"),
  transcriptionProgress = element<HTMLProgressElement>(
    "transcription-progress",
  ),
  transcriptionStatus = element("transcription-status"),
  transcriptionError = element("transcription-error"),
  transcriptResults = element<HTMLDetailsElement>("transcript-results"),
  transcriptSummary = element("transcript-summary"),
  transcriptLanguageNote = element("transcript-language-note"),
  transcriptContent = element("transcript-content");
const transcriptEditPanel = element("transcript-edit-panel"),
  transcriptEditSource = element<HTMLSelectElement>("transcript-edit-source"),
  transcriptWordFilter = element<HTMLInputElement>("transcript-word-filter"),
  transcriptEditWord = element<HTMLSelectElement>("transcript-edit-word"),
  transcriptCorrectionInput = element<HTMLInputElement>(
    "transcript-correction-input",
  ),
  saveTranscriptCorrectionButton = element<HTMLButtonElement>(
    "save-transcript-correction",
  ),
  transcriptEditNote = element("transcript-edit-note"),
  transcriptCorrectionStatus = element("transcript-correction-status"),
  transcriptCorrectionError = element("transcript-correction-error");
let selected: MediaSummary | undefined;
let selectedButton: HTMLButtonElement | undefined;
let requestedTime: number | undefined;
let decoding = false;
let selectionGeneration = 0;
let seekGeneration = 0;
let activeProject: ProjectView | undefined;
let routeGeneration = 0;
let loadingHome = 0;
let navigating = false;
let addingFootage = false;
let manualEditPending = false;
let draftIntegrityPending = false;
let draftIntegrityHeadKey: string | undefined;
let draftIntegrityMessage: string | null = null;
let draftIntegrityIssue: string | null = null;
let markHead: string | undefined;
let markInUs: number | undefined;
let markOutUs: number | undefined;
let restoreSourceProjectId: string | undefined;
let restoreHead: string | undefined;
let restoreRangeOpen = false;
let restoreRangeIssue: string | null = null;
let transcriptionView: TranscriptionProjectView | undefined;
let transcriptionErrorMessage: string | null = null;
let transcriptionRequestPending = false;
let transcriptionActionPending = false;
let transcriptionPollTimer: number | undefined;
let transcriptRenderKey = "";
let transcriptEditSourceProjectId: string | undefined;
let transcriptWordRenderKey = "";
let transcriptCorrectionIssue: string | null = null;
let transcriptCorrectionMessage: string | null = null;
let transcriptCorrectionPending = false;
const stageLabels: Record<ProjectStage, string> = {
  record_import: "Record or Import",
  auto_edit: "Auto Edit",
  edit: "Edit",
  review: "Review",
  export: "Export",
};
const stageSelect = element<HTMLSelectElement>("stage-select");
const stageButtons = new Map<ProjectStage, HTMLButtonElement>();
for (const stage of Object.keys(stageLabels) as ProjectStage[]) {
  const button = document.createElement("button");
  button.textContent = stageLabels[stage];
  button.addEventListener("click", () => {
    void navigate(stage);
  });
  element("stage-buttons").append(button);
  stageButtons.set(stage, button);
  const option = document.createElement("option");
  option.value = stage;
  option.textContent = stageLabels[stage];
  stageSelect.append(option);
}
stageSelect.addEventListener("change", () => {
  const value = stageSelect.value as ProjectStage;
  renderStage();
  void navigate(value);
});
function renderStage(): void {
  element("project-navigation").hidden = !activeProject;
  addFootageButton.hidden =
    !activeProject ||
    activeProject.stage !== "record_import" ||
    activeProject.sources !== undefined ||
    activeProject.draft.sequence !== 0;
  addFootageButton.disabled = addingFootage || navigating;
  stageSelect.disabled = navigating;
  if (activeProject) stageSelect.value = activeProject.stage;
  for (const [stage, button] of stageButtons) {
    button.disabled = navigating;
    if (activeProject?.stage === stage)
      button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  }
  renderEditTools();
  renderDraftIntegrityAction();
  renderTranscriptionActions();
  renderTranscriptEditor();
}
function currentClip(): NonNullable<ProjectView["clips"]>[number] | undefined {
  if (!activeProject?.clips) return undefined;
  const position = Number(seek.value);
  return activeProject.clips.find(
    (clip) => position >= clip.timelineStartUs && position < clip.timelineEndUs,
  );
}
function currentHeadKey(project: ProjectView): string {
  return `${project.id}:${project.draft.id}:${project.draft.sequence}:${project.draft.timelineSha256}`;
}
function secondsTextToMicroseconds(value: string): number | undefined {
  const match = /^(?:(\d+)(?:\.(\d{1,6}))?|\.(\d{1,6}))$/u.exec(value.trim());
  if (!match) return undefined;
  const whole = BigInt(match[1] ?? "0"),
    fraction = BigInt((match[2] ?? match[3] ?? "").padEnd(6, "0") || "0"),
    total = whole * 1_000_000n + fraction;
  return total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : undefined;
}
function restoreSources(project: ProjectView): MediaSummary[] {
  return project.sources ?? [project.source];
}
function populateRestoreSources(project: ProjectView): void {
  if (restoreSourceProjectId === project.id) return;
  restoreSource.replaceChildren();
  for (const source of restoreSources(project)) {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.name;
    restoreSource.append(option);
  }
  restoreSourceProjectId = project.id;
}
function clearDraftIntegrityResult(): void {
  draftIntegrityHeadKey = undefined;
  draftIntegrityMessage = null;
  draftIntegrityIssue = null;
}
function renderDraftIntegrityAction(): void {
  const project = activeProject,
    visible =
      project?.stage === "review" &&
      element("inspector").hidden &&
      element("codex-drawer").hidden;
  if (
    !visible ||
    (draftIntegrityHeadKey &&
      project &&
      draftIntegrityHeadKey !== currentHeadKey(project))
  )
    clearDraftIntegrityResult();
  reviewActions.hidden = !visible;
  reviewActions.setAttribute("aria-busy", String(draftIntegrityPending));
  checkDraftIntegrityButton.disabled =
    !visible || navigating || draftIntegrityPending;
  checkDraftIntegrityButton.textContent = draftIntegrityPending
    ? "Checking…"
    : "Check draft integrity";
  draftIntegrityResult.textContent = draftIntegrityMessage ?? "";
  draftIntegrityResult.hidden = !visible || !draftIntegrityMessage;
  draftIntegrityError.textContent = draftIntegrityIssue ?? "";
  draftIntegrityError.hidden = !visible || !draftIntegrityIssue;
}
function transcriptionRunning(
  view: TranscriptionProjectView | undefined,
): boolean {
  return (
    !!view &&
    ["preparing", "downloading_model", "transcribing"].includes(view.job.status)
  );
}
function updateTranscriptionText(
  view: TranscriptionProjectView | undefined,
): void {
  const project = activeProject;
  const results = view && view.project_id === project?.id ? view.results : [];
  const key = `${project?.draft.sequence ?? -1}|${results
    .map((result) => `${result.source_id}:${result.transcript.transcript_id}`)
    .join("|")}`;
  if (key === transcriptRenderKey) return;
  transcriptRenderKey = key;
  transcriptContent.replaceChildren();
  if (results.length === 0) return;
  const sources = project?.sources ?? (project ? [project.source] : []);
  for (const result of results) {
    const block = document.createElement("section");
    const name = document.createElement("strong");
    const transcript = document.createElement("pre");
    name.textContent =
      sources.find((source) => source.id === result.source_id)?.name ??
      "Transcript";
    transcript.textContent =
      result.transcript.segments
        .map((segment) =>
          joinCorrectedTranscriptWords(
            result.source_id,
            result.transcript.transcript_id,
            segment.words,
          ),
        )
        .join(" ") || "No words were recognized.";
    block.append(name, transcript);
    transcriptContent.append(block);
  }
}
function correctedTranscriptWordText(
  sourceId: string,
  transcriptId: string,
  wordId: string,
  originalText: string,
): string {
  return (
    activeProject?.transcriptEdits?.find(
      (edit) =>
        edit.source_id === sourceId &&
        edit.transcript_id === transcriptId &&
        edit.word_id === wordId,
    )?.replacement_text ?? originalText
  );
}
function joinCorrectedTranscriptWords(
  sourceId: string,
  transcriptId: string,
  words: TranscriptionProjectView["results"][number]["transcript"]["segments"][number]["words"],
): string {
  let result = "";
  for (const word of words) {
    const token = correctedTranscriptWordText(
      sourceId,
      transcriptId,
      word.word_id,
      word.text,
    ).trim();
    if (!token) continue;
    if (/^[,.;:!?…%)}\]»”’]+$/u.test(token) || /^[([{«“‘]/u.test(token))
      result = result.trimEnd() + token;
    else result = result ? `${result} ${token}` : token;
  }
  return result.trim();
}
function transcriptEditResult(
  project: ProjectView,
  sourceId: string,
): TranscriptionProjectView["results"][number] | undefined {
  if (transcriptionView?.project_id !== project.id) return undefined;
  return transcriptionView.results.find((item) => item.source_id === sourceId);
}
function renderTranscriptWordChoices(force = false): void {
  const project = activeProject;
  if (!project || project.stage !== "edit") return;
  const sourceId = transcriptEditSource.value;
  const result = transcriptEditResult(project, sourceId);
  const key = [
    project.id,
    sourceId,
    result?.transcript.transcript_id ?? "missing",
    project.draft.sequence,
    transcriptWordFilter.value.trim().toLowerCase(),
  ].join(":");
  if (!force && key === transcriptWordRenderKey) return;
  transcriptWordRenderKey = key;
  const previousWordId = transcriptEditWord.value;
  transcriptEditWord.replaceChildren();
  if (!result) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "No transcript for this source";
    transcriptEditWord.append(empty);
    transcriptEditWord.disabled = true;
    transcriptCorrectionInput.value = "";
    return;
  }
  const allWords = result.transcript.segments.flatMap(
    (segment) => segment.words,
  );
  const needle = transcriptWordFilter.value.trim().toLowerCase();
  const matches = allWords.filter((word) =>
    correctedTranscriptWordText(
      sourceId,
      result.transcript.transcript_id,
      word.word_id,
      word.text,
    )
      .toLowerCase()
      .includes(needle),
  );
  for (const word of matches.slice(0, 500)) {
    const option = document.createElement("option");
    option.value = word.word_id;
    option.textContent = `${time(word.start_us)} · ${correctedTranscriptWordText(
      sourceId,
      result.transcript.transcript_id,
      word.word_id,
      word.text,
    )}`;
    transcriptEditWord.append(option);
  }
  transcriptEditWord.disabled = matches.length === 0;
  if (matches.length > 500)
    transcriptEditNote.textContent = `Showing the first 500 of ${matches.length} matching words. Refine the search to find another word. Transcript edits do not alter recorded audio.`;
  else
    transcriptEditNote.textContent =
      "Transcript text changes do not alter recorded audio. Undo shares the edit history.";
  if (matches.some((word) => word.word_id === previousWordId))
    transcriptEditWord.value = previousWordId;
  else transcriptEditWord.selectedIndex = 0;
  const selected = allWords.find(
    (word) => word.word_id === transcriptEditWord.value,
  );
  transcriptCorrectionInput.value = selected
    ? correctedTranscriptWordText(
        sourceId,
        result.transcript.transcript_id,
        selected.word_id,
        selected.text,
      )
    : "";
}
function renderTranscriptEditor(): void {
  const project = activeProject;
  const visible =
    project?.stage === "edit" &&
    element("inspector").hidden &&
    element("codex-drawer").hidden;
  transcriptEditPanel.hidden = !visible;
  const currentView =
    project && transcriptionView?.project_id === project.id
      ? transcriptionView
      : undefined;
  const sourceKey = project
    ? `${project.id}:${currentView?.results.map((item) => item.source_id).join(",") ?? ""}`
    : "";
  if (project && transcriptEditSourceProjectId !== sourceKey) {
    transcriptEditSourceProjectId = sourceKey;
    transcriptEditSource.replaceChildren();
    const sources = project.sources ?? [project.source];
    for (const source of sources) {
      const result = currentView?.results.some(
        (item) => item.source_id === source.id,
      );
      if (!result) continue;
      const option = document.createElement("option");
      option.value = source.id;
      option.textContent = source.name;
      transcriptEditSource.append(option);
    }
    transcriptWordFilter.value = "";
    transcriptCorrectionInput.value = "";
  }
  transcriptEditSource.disabled =
    !visible ||
    transcriptEditSource.options.length === 0 ||
    navigating ||
    transcriptCorrectionPending;
  transcriptWordFilter.disabled =
    !visible ||
    transcriptEditSource.options.length === 0 ||
    navigating ||
    transcriptCorrectionPending;
  if (visible) renderTranscriptWordChoices();
  const selectedWord = currentView?.results
    .find((item) => item.source_id === transcriptEditSource.value)
    ?.transcript.segments.flatMap((segment) => segment.words)
    .find((word) => word.word_id === transcriptEditWord.value);
  const currentText = selectedWord
    ? correctedTranscriptWordText(
        transcriptEditSource.value,
        currentView!.results.find(
          (item) => item.source_id === transcriptEditSource.value,
        )!.transcript.transcript_id,
        selectedWord.word_id,
        selectedWord.text,
      )
    : "";
  saveTranscriptCorrectionButton.disabled =
    !visible ||
    !selectedWord ||
    transcriptCorrectionPending ||
    navigating ||
    !transcriptCorrectionInput.value.trim() ||
    transcriptCorrectionInput.value.trim() === currentText;
  transcriptCorrectionInput.disabled =
    !visible || !selectedWord || navigating || transcriptCorrectionPending;
  saveTranscriptCorrectionButton.textContent = transcriptCorrectionPending
    ? "Saving…"
    : "Save correction";
  transcriptCorrectionStatus.textContent = transcriptCorrectionMessage ?? "";
  transcriptCorrectionStatus.hidden = !visible || !transcriptCorrectionMessage;
  transcriptCorrectionError.textContent = transcriptCorrectionIssue ?? "";
  transcriptCorrectionError.hidden = !visible || !transcriptCorrectionIssue;
}
function syncTranscriptionPolling(): void {
  if (
    (activeProject?.stage === "auto_edit" || activeProject?.stage === "edit") &&
    transcriptionView?.project_id === activeProject.id &&
    transcriptionRunning(transcriptionView)
  ) {
    if (transcriptionPollTimer === undefined)
      transcriptionPollTimer = window.setInterval(
        () => void loadTranscription(),
        900,
      );
  } else if (transcriptionPollTimer !== undefined) {
    window.clearInterval(transcriptionPollTimer);
    transcriptionPollTimer = undefined;
  }
}
function renderTranscriptionActions(): void {
  const project = activeProject;
  const visible = project?.stage === "auto_edit";
  const view =
    transcriptionView?.project_id === project?.id
      ? transcriptionView
      : undefined;
  const running = transcriptionRunning(view);
  autoEditActions.hidden = !visible;
  autoEditActions.setAttribute(
    "aria-busy",
    String(transcriptionActionPending || running),
  );
  transcribeLocalButton.disabled =
    !visible ||
    navigating ||
    transcriptionActionPending ||
    running ||
    view?.job.status === "completed";
  stopTranscriptionButton.hidden = !running;
  stopTranscriptionButton.disabled = !running || transcriptionActionPending;
  transcriptionDisclosure.hidden = !!view && view.job.status === "completed";
  const downloadProgress = view?.job.status === "downloading_model";
  const progressVisible =
    running &&
    view?.job.progress_percent !== null &&
    view?.job.progress_percent !== undefined;
  transcriptionProgress.hidden = !progressVisible;
  transcriptionProgress.value = progressVisible
    ? (view?.job.progress_percent ?? 0)
    : 0;
  const failed =
    view?.job.status === "failed" || view?.job.status === "cancelled";
  const baseMessage = view?.job.message;
  transcriptionStatus.textContent =
    transcriptionErrorMessage === null && !failed && baseMessage
      ? view?.job.status === "completed"
        ? `Transcript complete · ${view.job.word_count} words.`
        : downloadProgress
          ? `${baseMessage} ${view?.job.progress_percent ?? 0}%`
          : view?.job.status === "transcribing"
            ? `${baseMessage} ${view.job.completed_source_count} of ${view.job.source_count} sources complete.`
            : baseMessage
      : "";
  transcriptionStatus.hidden = !transcriptionStatus.textContent;
  transcriptionError.textContent =
    transcriptionErrorMessage ?? (failed ? (baseMessage ?? "") : "");
  transcriptionError.hidden = !transcriptionError.textContent;
  const resultCount = view?.results.length ?? 0;
  transcriptResults.hidden = !visible || resultCount === 0;
  const wordCount = view?.job.word_count ?? 0;
  const languageUnknown =
    view?.results.some((result) => result.transcript.language === "und") ??
    false;
  transcriptSummary.textContent = `Transcript · ${wordCount} words${languageUnknown ? " · language not identified" : ""}`;
  transcriptLanguageNote.hidden = !languageUnknown;
  updateTranscriptionText(view);
  syncTranscriptionPolling();
}
async function loadTranscription(): Promise<void> {
  const project = activeProject;
  if (
    !project ||
    (project.stage !== "auto_edit" && project.stage !== "edit") ||
    transcriptionRequestPending
  )
    return;
  transcriptionRequestPending = true;
  const requestProjectId = project.id;
  try {
    const result = await pollTranscriptionView(
      requestProjectId,
      transcriptionView,
      window.desktop.getTranscription,
    );
    if (activeProject?.id !== requestProjectId) return;
    transcriptionView = result.view;
    transcriptionErrorMessage = result.issue;
  } finally {
    transcriptionRequestPending = false;
    renderTranscriptionActions();
    renderTranscriptEditor();
  }
}
async function startTranscription(): Promise<void> {
  const project = activeProject;
  if (
    !project ||
    project.stage !== "auto_edit" ||
    transcriptionActionPending ||
    transcriptionRunning(transcriptionView)
  )
    return;
  transcriptionActionPending = true;
  transcriptionErrorMessage = null;
  renderTranscriptionActions();
  try {
    const reply = await window.desktop.startTranscription({
      schema_version: "1.0",
      project_id: project.id,
    });
    if (activeProject?.id !== project.id) return;
    if (!reply.ok) transcriptionErrorMessage = reply.message;
    else transcriptionView = reply.value;
  } catch {
    if (activeProject?.id === project.id)
      transcriptionErrorMessage =
        "Local transcription could not start. Try again.";
  } finally {
    transcriptionActionPending = false;
    renderTranscriptionActions();
  }
}
async function stopTranscription(): Promise<void> {
  const project = activeProject;
  const jobId =
    transcriptionView && transcriptionView.project_id === project?.id
      ? transcriptionView.job.job_id
      : null;
  if (
    !project ||
    project.stage !== "auto_edit" ||
    !jobId ||
    !transcriptionRunning(transcriptionView) ||
    transcriptionActionPending
  )
    return;
  transcriptionActionPending = true;
  transcriptionErrorMessage = null;
  renderTranscriptionActions();
  try {
    const reply = await window.desktop.stopTranscription({
      schema_version: "1.0",
      project_id: project.id,
      job_id: jobId,
    });
    if (activeProject?.id !== project.id) return;
    if (!reply.ok) transcriptionErrorMessage = reply.message;
    else transcriptionView = reply.value;
  } catch {
    if (activeProject?.id === project.id)
      transcriptionErrorMessage =
        "Local transcription could not stop. Try again.";
  } finally {
    transcriptionActionPending = false;
    renderTranscriptionActions();
  }
}
async function saveTranscriptCorrection(): Promise<void> {
  const project = activeProject;
  const sourceId = transcriptEditSource.value;
  const result =
    project && project.stage === "edit"
      ? transcriptEditResult(project, sourceId)
      : undefined;
  const word = result?.transcript.segments
    .flatMap((segment) => segment.words)
    .find((candidate) => candidate.word_id === transcriptEditWord.value);
  if (
    !project ||
    project.stage !== "edit" ||
    !result ||
    !word ||
    manualEditPending ||
    transcriptCorrectionPending
  )
    return;
  const expectedText = correctedTranscriptWordText(
      sourceId,
      result.transcript.transcript_id,
      word.word_id,
      word.text,
    ),
    replacementText = transcriptCorrectionInput.value.trim();
  if (!replacementText || replacementText === expectedText) return;
  transcriptCorrectionPending = true;
  transcriptCorrectionIssue = null;
  transcriptCorrectionMessage = null;
  manualEditPending = true;
  renderStage();
  try {
    const reply = await window.desktop.correctTranscriptWord({
      schema_version: "1.0",
      projectId: project.id,
      draftId: project.draft.id,
      baseRevisionId: project.draft.baseRevisionId,
      expectedSequence: project.draft.sequence,
      expectedTimelineSha256: project.draft.timelineSha256,
      sourceId,
      transcriptId: result.transcript.transcript_id,
      wordId: word.word_id,
      expectedText,
      replacementText,
    });
    if (activeProject?.id !== project.id) return;
    if (!reply.ok) transcriptCorrectionIssue = reply.message;
    else {
      transcriptCorrectionMessage =
        "Transcript updated. Recorded audio is unchanged.";
      applyProjectDraft(reply, Number(seek.value));
    }
  } catch {
    if (activeProject?.id === project.id)
      transcriptCorrectionIssue =
        "The transcript could not be corrected. Refresh the word selection and try again.";
  } finally {
    transcriptCorrectionPending = false;
    manualEditPending = false;
    renderStage();
  }
}
function renderEditTools(): void {
  const project = activeProject;
  if (project && restoreHead && restoreHead !== currentHeadKey(project)) {
    restoreHead = undefined;
    restoreRangeOpen = false;
    restoreRangeIssue = null;
    restoreSourceStart.value = "";
    restoreSourceEnd.value = "";
  }
  if (!project || project.stage !== "edit" || !project.clips) {
    editActions.hidden = true;
    restoreRangeOpen = false;
    restoreHead = undefined;
    return;
  }
  populateRestoreSources(project);
  editActions.hidden = false;
  editActions.setAttribute("aria-busy", String(manualEditPending));
  const clip = currentClip(),
    position = Number(seek.value),
    interior =
      !!clip &&
      position > clip.timelineStartUs &&
      position < clip.timelineEndUs;
  const part =
    clip && project.clips.length > 1
      ? `part ${project.clips.indexOf(clip) + 1}`
      : "clip";
  editClip.hidden = !clip || project.clips.length === 1;
  editClip.textContent = editClip.hidden
    ? ""
    : `Part ${project.clips.indexOf(clip!) + 1}`;
  trimStart.setAttribute("aria-label", `Trim start of ${part} to playhead`);
  trimEnd.setAttribute("aria-label", `Trim end of ${part} to playhead`);
  splitClip.setAttribute("aria-label", `Split ${part} at playhead`);
  trimStart.disabled = !interior || manualEditPending || navigating;
  trimEnd.disabled = !interior || manualEditPending || navigating;
  splitClip.disabled = !interior || manualEditPending || navigating;
  undoEdit.disabled =
    !project.draft.undoTransactionId || manualEditPending || navigating;
  redoEdit.disabled =
    !project.draft.redoTransactionId || manualEditPending || navigating;
  const currentMarks = markHead === currentHeadKey(project),
    inUs = currentMarks ? markInUs : undefined,
    outUs = currentMarks ? markOutUs : undefined;
  markInButton.disabled = manualEditPending || navigating;
  markOutButton.disabled = manualEditPending || navigating;
  cutRangeButton.disabled =
    inUs === undefined ||
    outUs === undefined ||
    inUs >= outUs ||
    outUs > project.timeline.durationUs ||
    (inUs === 0 && outUs === project.timeline.durationUs) ||
    manualEditPending ||
    navigating;
  clearMarksButton.disabled =
    (inUs === undefined && outUs === undefined) || manualEditPending;
  cutSelection.hidden = inUs === undefined && outUs === undefined;
  cutSelection.textContent = [
    inUs === undefined ? undefined : `In ${time(inUs)}`,
    outUs === undefined ? undefined : `Out ${time(outUs)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  restoreToggleButton.disabled = manualEditPending || navigating;
  restoreToggleButton.textContent = restoreRangeOpen
    ? "Cancel restore"
    : "Restore source range";
  restoreToggleButton.setAttribute("aria-expanded", String(restoreRangeOpen));
  restoreForm.hidden = !restoreRangeOpen;
  restoreForm.setAttribute("aria-busy", String(manualEditPending));
  restoreSource.disabled = manualEditPending || navigating;
  restoreSourceStart.disabled = manualEditPending || navigating;
  restoreSourceEnd.disabled = manualEditPending || navigating;
  const source = restoreSources(project).find(
      (candidate) => candidate.id === restoreSource.value,
    ),
    sourceStartUs = secondsTextToMicroseconds(restoreSourceStart.value),
    sourceEndUs = secondsTextToMicroseconds(restoreSourceEnd.value),
    overlapsVisible =
      source !== undefined &&
      sourceStartUs !== undefined &&
      sourceEndUs !== undefined &&
      project.clips.some(
        (candidate) =>
          candidate.sourceId === source.id &&
          sourceStartUs < candidate.sourceEndUs &&
          sourceEndUs > candidate.sourceStartUs,
      );
  let validationIssue: string | null = null;
  if (
    (restoreSourceStart.value.trim() && sourceStartUs === undefined) ||
    (restoreSourceEnd.value.trim() && sourceEndUs === undefined)
  )
    validationIssue = "Use seconds with up to six decimal places.";
  else if (
    (restoreSourceStart.value.trim() || restoreSourceEnd.value.trim()) &&
    (sourceStartUs === undefined || sourceEndUs === undefined)
  )
    validationIssue = "Enter both source times to restore the interval.";
  else if (
    sourceStartUs !== undefined &&
    sourceEndUs !== undefined &&
    sourceStartUs >= sourceEndUs
  )
    validationIssue = "Source end must be after source start.";
  else if (
    source &&
    sourceEndUs !== undefined &&
    sourceEndUs > source.durationUs
  )
    validationIssue = "Source end exceeds the selected source duration.";
  else if (overlapsVisible)
    validationIssue = "That source interval is already visible in the draft.";
  restoreSubmit.disabled =
    !restoreRangeOpen ||
    !source ||
    sourceStartUs === undefined ||
    sourceEndUs === undefined ||
    validationIssue !== null ||
    manualEditPending ||
    navigating;
  restoreError.textContent = restoreRangeIssue ?? validationIssue ?? "";
  restoreError.hidden = !restoreRangeOpen || !restoreError.textContent;
}
async function navigate(stage: ProjectStage): Promise<void> {
  if (
    !activeProject ||
    navigating ||
    manualEditPending ||
    stage === activeProject.stage
  )
    return;
  const project = activeProject,
    generation = routeGeneration;
  const origin = document.activeElement;
  navigating = true;
  renderStage();
  clearError();
  try {
    const reply = await window.desktop.navigateProject({
      id: project.id,
      stage,
    });
    if (generation !== routeGeneration || activeProject?.id !== project.id)
      return;
    if (!reply.ok) showError(reply.message);
    else activeProject = reply.value;
  } catch {
    if (generation === routeGeneration)
      showError(
        "The stage could not be saved. Your previous stage is unchanged. Try again.",
      );
  } finally {
    if (generation === routeGeneration) {
      navigating = false;
      renderStage();
      if (
        activeProject?.stage === "auto_edit" ||
        activeProject?.stage === "edit"
      )
        void loadTranscription();
      if (
        !settingsDialog.open &&
        document.activeElement === document.body &&
        origin instanceof HTMLElement
      )
        origin.focus();
    }
  }
}
async function openProject(
  id: string,
  origin?: HTMLButtonElement,
): Promise<void> {
  const generation = ++routeGeneration;
  clearError();
  try {
    const reply = await window.desktop.openProject({ id });
    if (generation !== routeGeneration) return;
    if (!reply.ok) {
      showError(reply.message);
      return;
    }
    selectProject(reply.value, origin);
  } catch {
    if (generation === routeGeneration)
      showError("The project could not be opened. Try again.");
  }
}
function selectProject(project: ProjectView, origin?: HTMLButtonElement): void {
  transcriptionView = undefined;
  transcriptionErrorMessage = null;
  transcriptRenderKey = "";
  transcriptEditSourceProjectId = undefined;
  transcriptWordRenderKey = "";
  transcriptCorrectionIssue = null;
  transcriptCorrectionMessage = null;
  activeProject = project;
  clearDraftIntegrityResult();
  restoreSourceProjectId = undefined;
  restoreHead = undefined;
  restoreRangeOpen = false;
  restoreRangeIssue = null;
  codexThreadView = undefined;
  apiThreadView = undefined;
  codexThreadIssue = null;
  navigating = false;
  select(project.source);
  selectedButton =
    origin ??
    document.querySelector<HTMLButtonElement>(
      `[data-project-id="${project.id}"]`,
    ) ??
    undefined;
  element("source-name").textContent = project.name;
  element<HTMLButtonElement>("codex-drawer-button").hidden = false;
  setCodexDrawer(false);
  renderStage();
  if (project.stage === "auto_edit" || project.stage === "edit")
    void loadTranscription();
}
async function createProject(
  media: MediaSummary,
  origin?: HTMLButtonElement,
): Promise<void> {
  const generation = ++routeGeneration;
  if (origin) origin.disabled = true;
  clearError();
  try {
    const reply = await window.desktop.createProject({ id: media.id });
    if (generation !== routeGeneration) return;
    await loadLibrary();
    if (generation !== routeGeneration) return;
    if (!reply.ok) {
      showError(reply.message);
      return;
    }
    selectProject(reply.value);
  } catch {
    if (generation === routeGeneration)
      showError(
        "The project could not be created. Your imported source is preserved. Try Create project again.",
      );
  } finally {
    if (origin) origin.disabled = false;
  }
}
function showError(message: string): void {
  error.textContent = message;
  error.hidden = false;
  if (activeProject?.stage === "edit")
    error.scrollIntoView({ block: "nearest" });
}
function clearError(): void {
  error.hidden = true;
  error.textContent = "";
}
function time(value: number): string {
  const seconds = value / 1_000_000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(3).padStart(6, "0")}`;
}
async function loadLibrary(): Promise<void> {
  const generation = ++loadingHome;
  const [reply, projects] = await Promise.all([
    window.desktop.listMedia(),
    window.desktop.listProjects(),
  ]);
  if (generation !== loadingHome) return;
  if (!projects.ok) showError(projects.message);
  else {
    const list = element("projects");
    list.replaceChildren();
    element("projects-section").hidden = projects.value.length === 0;
    for (const project of projects.value) {
      const row = document.createElement("li"),
        button = document.createElement("button"),
        name = document.createElement("span"),
        detail = document.createElement("small");
      name.textContent = project.name;
      detail.textContent = `${time(project.timeline.durationUs)} · ${project.sources?.length ?? 1} source${project.sources ? "s" : ""} · ${stageLabels[project.stage]}`;
      button.append(name, detail);
      button.dataset.projectId = project.id;
      button.addEventListener("click", () => {
        void openProject(project.id, button);
      });
      row.append(button);
      list.append(row);
    }
  }
  if (!reply.ok) {
    showError(reply.message);
    return;
  }
  const list = element("library");
  list.replaceChildren();
  element("library-section").hidden = reply.value.length === 0;
  for (const media of reply.value) {
    const row = document.createElement("li"),
      button = document.createElement("button");
    const name = document.createElement("span"),
      detail = document.createElement("small");
    name.textContent = media.name;
    detail.textContent = `${media.width} × ${media.height} · ${time(media.durationUs)}`;
    button.append(name, detail);
    button.dataset.mediaId = media.id;
    button.addEventListener("click", async () => {
      const previousProject = activeProject?.id;
      button.disabled = true;
      if (previousProject) {
        const closed = await window.desktop.closeProject({
          id: previousProject,
        });
        if (!closed.ok) {
          button.disabled = false;
          showError(closed.message);
          return;
        }
      }
      routeGeneration++;
      activeProject = undefined;
      navigating = false;
      selectedButton = button;
      select(media);
      renderStage();
      button.disabled = false;
    });
    const create = document.createElement("button");
    create.className = "create-project";
    create.textContent = "Create project";
    create.setAttribute("aria-label", `Create project from ${media.name}`);
    create.addEventListener("click", () => {
      void createProject(media, create);
    });
    row.append(button, create);
    list.append(row);
  }
}
function select(media: MediaSummary): void {
  selected = media;
  selectedButton =
    document.querySelector<HTMLButtonElement>(
      `[data-media-id="${media.id}"]`,
    ) ?? undefined;
  setInspector(false);
  setCodexDrawer(false);
  element<HTMLButtonElement>("codex-drawer-button").hidden = !activeProject;
  selectionGeneration++;
  requestedTime = undefined;
  clearError();
  canvas.width = 0;
  canvas.height = 0;
  element("time").textContent = time(0);
  home.hidden = true;
  viewer.hidden = false;
  back.hidden = false;
  element("source-name").textContent = media.name;
  element("preview-label").textContent = activeProject
    ? "Project preview"
    : "Frame preview";
  canvas.setAttribute(
    "aria-label",
    activeProject ? "Project frame" : "Source frame",
  );
  seek.setAttribute(
    "aria-label",
    activeProject ? "Project position" : "Source position",
  );
  element("duration").textContent = ` / ${time(
    activeProject?.timeline.durationUs ?? media.durationUs,
  )}`;
  seek.max = String(
    Math.max(
      0,
      (activeProject?.timeline.durationUs ?? media.durationUs) -
        Math.ceil(frameInterval()),
    ),
  );
  seek.step = "1";
  seek.value = "0";
  canvas.hidden = !media.previewAvailable;
  const message = element("preview-message");
  message.hidden = media.previewAvailable;
  message.textContent =
    "This video's format does not have a verified preview yet. Its original file has been preserved.";
  element("frame-controls").hidden = !media.previewAvailable;
  if (media.previewAvailable) requestFrame(0);
  back.focus();
}
function requestFrame(value: number): void {
  if (!selected?.previewAvailable) return;
  requestedTime = Math.min(Number(seek.max), Math.max(0, Math.round(value)));
  seekGeneration++;
  seek.value = String(requestedTime);
  const message = element("preview-message");
  message.textContent = "Reading frame…";
  message.hidden = false;
  canvas.hidden = true;
  previous.disabled = requestedTime === 0;
  next.disabled = requestedTime >= Number(seek.max);
  renderEditTools();
  if (!decoding) void decodeFrames();
}
async function decodeFrames(): Promise<void> {
  decoding = true;
  try {
    while (selected && requestedTime !== undefined) {
      const requested = requestedTime,
        media = selected,
        project = activeProject,
        generation = selectionGeneration,
        seekVersion = seekGeneration;
      requestedTime = undefined;
      let frame: MediaFrame;
      if (project) {
        const reply = await window.desktop.readProjectFrame({
          projectId: project.id,
          draftId: project.draft.id,
          baseRevisionId: project.draft.baseRevisionId,
          expectedSequence: project.draft.sequence,
          expectedTimelineSha256: project.draft.timelineSha256,
          timelineTimeUs: requested,
        });
        if (
          generation !== selectionGeneration ||
          seekVersion !== seekGeneration
        )
          continue;
        if (!reply.ok) {
          showError(reply.message);
          element("preview-message").textContent =
            "Move the position control to retry this frame.";
          continue;
        }
        if (reply.value.status === "stale") {
          applyProjectDraft({ ok: true, value: reply.value.draft });
          continue;
        }
        if (
          activeProject?.id !== reply.value.projectId ||
          activeProject.revisionId !== reply.value.baseRevisionId ||
          activeProject.draft.id !== reply.value.draftId ||
          activeProject.draft.sequence !== reply.value.draftSequence ||
          activeProject.draft.timelineSha256 !== reply.value.timelineSha256 ||
          requested !== reply.value.timelineTimeUs
        )
          continue;
        frame = reply.value.frame;
      } else {
        const reply = await window.desktop.readFrame({
          id: media.id,
          timeUs: requested,
        });
        if (
          generation !== selectionGeneration ||
          seekVersion !== seekGeneration
        )
          continue;
        if (!reply.ok) {
          showError(reply.message);
          element("preview-message").textContent =
            "Move the position control to retry this frame.";
          continue;
        }
        frame = reply.value;
      }
      const bytes = Uint8ClampedArray.from(
        atob(frame.rgbaBase64),
        (character) => character.charCodeAt(0),
      );
      canvas.width = frame.width;
      canvas.height = frame.height;
      canvas
        .getContext("2d")
        ?.putImageData(new ImageData(bytes, frame.width, frame.height), 0, 0);
      element("time").textContent = time(requested);
      canvas.hidden = false;
      element("preview-message").hidden = true;
    }
  } catch {
    showError("The frame could not be shown. Select the video again to retry.");
  } finally {
    decoding = false;
    if (selected && requestedTime !== undefined) void decodeFrames();
  }
}
importButton.addEventListener("click", async () => {
  const generation = ++routeGeneration;
  clearError();
  importButton.disabled = true;
  progress.hidden = false;
  try {
    const reply = await window.desktop.importVideo();
    if (generation !== routeGeneration) {
      await loadLibrary();
      return;
    }
    if (!reply.ok) showError(reply.message);
    else if (reply.value) {
      element("progress-label").textContent = "Creating project…";
      element("cancel").hidden = true;
      await createProject(reply.value);
    }
  } catch {
    showError("Import could not finish. Please try again.");
  } finally {
    importButton.disabled = false;
    progress.hidden = true;
    element("progress-label").textContent = "Importing video…";
    element("cancel").hidden = false;
  }
});
addFootageButton.addEventListener("click", async () => {
  if (!activeProject || addingFootage || activeProject.sources) return;
  const project = activeProject,
    generation = routeGeneration;
  if (project.stage !== "record_import" || project.draft.sequence !== 0) return;
  addingFootage = true;
  appendProgress.hidden = false;
  renderStage();
  clearError();
  try {
    const imported = await window.desktop.importVideo();
    if (!imported.ok) {
      if (activeProject?.id === project.id) showError(imported.message);
      return;
    }
    if (!imported.value) return;
    if (generation !== routeGeneration || activeProject?.id !== project.id)
      return;
    const combined = await window.desktop.createTwoSourceProject({
      firstId: project.source.id,
      secondId: imported.value.id,
    });
    if (generation !== routeGeneration || activeProject?.id !== project.id)
      return;
    if (!combined.ok) {
      showError(
        `${combined.message} The imported footage remains in the source library.`,
      );
      return;
    }
    routeGeneration++;
    selectProject(combined.value);
    await loadLibrary();
  } catch {
    if (generation === routeGeneration && activeProject?.id === project.id)
      showError(
        "Footage could not be added. Any completed import remains in the source library.",
      );
  } finally {
    addingFootage = false;
    appendProgress.hidden = true;
    renderStage();
  }
});
element("cancel").addEventListener("click", () => {
  void window.desktop.cancelImport();
});
back.addEventListener("click", async () => {
  if (manualEditPending) return;
  const previousProject = activeProject?.id;
  back.disabled = true;
  if (previousProject) {
    const closed = await window.desktop.closeProject({ id: previousProject });
    if (!closed.ok) {
      back.disabled = false;
      showError(closed.message);
      return;
    }
  }
  routeGeneration++;
  activeProject = undefined;
  navigating = false;
  renderStage();
  selected = undefined;
  selectionGeneration++;
  requestedTime = undefined;
  viewer.hidden = true;
  home.hidden = false;
  back.hidden = true;
  back.disabled = false;
  clearError();
  setInspector(false);
  setCodexDrawer(false);
  element<HTMLButtonElement>("codex-drawer-button").hidden = true;
  (selectedButton?.isConnected ? selectedButton : importButton).focus();
  // Keep cards current after stage persistence without stealing restored focus.
  const restoreProjectId = selectedButton?.dataset.projectId;
  const restoreMediaId = selectedButton?.dataset.mediaId;
  const restoreSelector = restoreProjectId
    ? `[data-project-id="${restoreProjectId}"]`
    : restoreMediaId
      ? `[data-media-id="${restoreMediaId}"]`
      : undefined;
  const homeGeneration = routeGeneration;
  const focused = document.activeElement;
  void loadLibrary()
    .then(() => {
      if (
        home.hidden ||
        !restoreSelector ||
        homeGeneration !== routeGeneration ||
        settingsDialog.open ||
        (document.activeElement !== document.body &&
          document.activeElement !== focused)
      )
        return;
      document.querySelector<HTMLButtonElement>(restoreSelector)?.focus();
    })
    .catch(() =>
      showError("Home could not be refreshed. Try reopening the application."),
    );
});
seek.addEventListener("input", () => requestFrame(Number(seek.value)));
previous.addEventListener("click", () => {
  if (selected) requestFrame(Number(seek.value) - frameInterval());
});
next.addEventListener("click", () => {
  if (selected) requestFrame(Number(seek.value) + frameInterval());
});
function frameInterval(): number {
  return activeProject
    ? (1_000_000 * activeProject.timeline.frameRate.denominator) /
        activeProject.timeline.frameRate.numerator
    : 1_000_000 / (selected?.frameRate ?? 1);
}
function applyProjectDraft(
  reply: Reply<ProjectDraftView>,
  preferredPositionUs = Number(seek.value),
): void {
  if (!activeProject) return;
  if (!reply.ok) {
    showError(reply.message);
    return;
  }
  const current = activeProject,
    changed = reply.value,
    reconciled = reconcileProjectDraft(current, changed);
  if (reconciled.status === "invalid") {
    showError("The saved edit could not be displayed. Reopen the project.");
    return;
  }
  if (reconciled.status !== "applied") return;
  activeProject = reconciled.value;
  element("duration").textContent = ` / ${time(changed.timeline.durationUs)}`;
  selectionGeneration++;
  requestedTime = undefined;
  const position = Math.min(
    preferredPositionUs,
    Math.max(0, changed.timeline.durationUs - Math.ceil(frameInterval())),
  );
  seek.max = String(
    Math.max(0, changed.timeline.durationUs - Math.ceil(frameInterval())),
  );
  clearError();
  requestFrame(position);
  renderEditTools();
  renderDraftIntegrityAction();
  renderTranscriptionActions();
  renderTranscriptEditor();
}
transcribeLocalButton.addEventListener("click", () => {
  void startTranscription();
});
stopTranscriptionButton.addEventListener("click", () => {
  void stopTranscription();
});
transcriptEditSource.addEventListener("change", () => {
  transcriptWordFilter.value = "";
  transcriptWordRenderKey = "";
  transcriptCorrectionIssue = null;
  transcriptCorrectionMessage = null;
  renderTranscriptEditor();
});
transcriptWordFilter.addEventListener("input", () => {
  transcriptWordRenderKey = "";
  renderTranscriptEditor();
});
transcriptEditWord.addEventListener("change", () => {
  transcriptCorrectionIssue = null;
  transcriptCorrectionMessage = null;
  transcriptWordRenderKey = "";
  renderTranscriptEditor();
});
transcriptCorrectionInput.addEventListener("input", () => {
  renderTranscriptEditor();
});
saveTranscriptCorrectionButton.addEventListener("click", () => {
  void saveTranscriptCorrection();
});
checkDraftIntegrityButton.addEventListener("click", async () => {
  const project = activeProject;
  if (!project || project.stage !== "review" || draftIntegrityPending) return;
  const generation = routeGeneration,
    requestedHead = currentHeadKey(project);
  draftIntegrityPending = true;
  draftIntegrityHeadKey = requestedHead;
  draftIntegrityMessage = null;
  draftIntegrityIssue = null;
  renderDraftIntegrityAction();
  try {
    const reply = await window.desktop.verifyDraftIntegrity({ id: project.id });
    if (
      generation !== routeGeneration ||
      activeProject?.id !== project.id ||
      activeProject.stage !== "review"
    )
      return;
    if (!reply.ok) {
      draftIntegrityIssue = reply.message;
      return;
    }
    const checkedHead = `${reply.value.draft.projectId}:${reply.value.draft.draft.id}:${reply.value.draft.draft.sequence}:${reply.value.draft.draft.timelineSha256}`;
    const freshness = draftIntegrityFreshness(
      requestedHead,
      currentHeadKey(activeProject),
      checkedHead,
    );
    if (freshness === "active-head-changed") {
      draftIntegrityHeadKey = currentHeadKey(activeProject);
      draftIntegrityIssue =
        "Draft changed while the check was running. Run it again.";
      return;
    }
    applyProjectDraft({ ok: true, value: reply.value.draft });
    if (
      generation !== routeGeneration ||
      activeProject?.id !== project.id ||
      activeProject.stage !== "review"
    )
      return;
    draftIntegrityHeadKey = currentHeadKey(activeProject);
    if (freshness !== "current" || checkedHead !== draftIntegrityHeadKey) {
      draftIntegrityIssue = "Draft changed during the check. Run it again.";
      return;
    }
    draftIntegrityMessage = reply.value.structuralCheckpointRecorded
      ? "Structure and managed sources verified. Manual checkpoint recorded; meaning and A/V not reviewed."
      : "Structure and managed sources verified. No manual checkpoint; meaning and A/V not reviewed.";
  } catch {
    if (generation === routeGeneration && activeProject?.id === project.id)
      draftIntegrityIssue =
        "Draft integrity could not be checked. Reopen the project and try again.";
  } finally {
    draftIntegrityPending = false;
    renderDraftIntegrityAction();
  }
});
async function submitManualTrim(edge: "start" | "end"): Promise<void> {
  const project = activeProject,
    clip = currentClip(),
    position = Number(seek.value),
    generation = routeGeneration;
  if (
    !project ||
    project.stage !== "edit" ||
    !clip ||
    position <= clip.timelineStartUs ||
    position >= clip.timelineEndUs ||
    manualEditPending
  )
    return;
  manualEditPending = true;
  back.disabled = true;
  renderEditTools();
  clearError();
  try {
    const reply = await window.desktop.applyManualTrim({
      schema_version: "1.0",
      projectId: project.id,
      draftId: project.draft.id,
      baseRevisionId: project.draft.baseRevisionId,
      expectedSequence: project.draft.sequence,
      expectedTimelineSha256: project.draft.timelineSha256,
      clipId: clip.id,
      edge,
      timelinePositionUs: position,
    });
    if (generation === routeGeneration && activeProject?.id === project.id)
      applyProjectDraft(reply);
  } catch {
    if (generation === routeGeneration && activeProject?.id === project.id)
      showError("The trim could not be saved. Try again.");
  } finally {
    manualEditPending = false;
    back.disabled = false;
    renderEditTools();
  }
}
async function submitManualSplit(): Promise<void> {
  const project = activeProject,
    clip = currentClip(),
    position = Number(seek.value),
    generation = routeGeneration;
  if (
    !project ||
    project.stage !== "edit" ||
    !clip ||
    position <= clip.timelineStartUs ||
    position >= clip.timelineEndUs ||
    manualEditPending
  )
    return;
  manualEditPending = true;
  back.disabled = true;
  renderEditTools();
  clearError();
  try {
    const reply = await window.desktop.applyManualSplit({
      schema_version: "1.0",
      projectId: project.id,
      draftId: project.draft.id,
      baseRevisionId: project.draft.baseRevisionId,
      expectedSequence: project.draft.sequence,
      expectedTimelineSha256: project.draft.timelineSha256,
      clipId: clip.id,
      timelinePositionUs: position,
    });
    if (generation === routeGeneration && activeProject?.id === project.id)
      applyProjectDraft(reply);
  } catch {
    if (generation === routeGeneration && activeProject?.id === project.id)
      showError("The split could not be saved. Try again.");
  } finally {
    manualEditPending = false;
    back.disabled = false;
    renderEditTools();
  }
}
function markBoundary(edge: "in" | "out"): void {
  const project = activeProject;
  if (!project || project.stage !== "edit" || manualEditPending || navigating)
    return;
  const head = currentHeadKey(project);
  if (markHead !== head) {
    markHead = head;
    markInUs = undefined;
    markOutUs = undefined;
  }
  const position = Number(seek.value);
  if (edge === "in") markInUs = position;
  else markOutUs = position;
  renderEditTools();
}
async function submitManualRangeCut(): Promise<void> {
  const project = activeProject,
    startUs = markInUs,
    endUs = markOutUs,
    generation = routeGeneration;
  if (
    !project ||
    project.stage !== "edit" ||
    markHead !== currentHeadKey(project) ||
    startUs === undefined ||
    endUs === undefined ||
    startUs >= endUs ||
    endUs > project.timeline.durationUs ||
    (startUs === 0 && endUs === project.timeline.durationUs) ||
    manualEditPending
  )
    return;
  manualEditPending = true;
  back.disabled = true;
  renderEditTools();
  clearError();
  try {
    const reply = await window.desktop.applyManualRangeCut({
      schema_version: "1.0",
      projectId: project.id,
      draftId: project.draft.id,
      baseRevisionId: project.draft.baseRevisionId,
      expectedSequence: project.draft.sequence,
      expectedTimelineSha256: project.draft.timelineSha256,
      startUs,
      endUs,
    });
    if (generation === routeGeneration && activeProject?.id === project.id) {
      applyProjectDraft(reply);
      if (reply.ok) requestFrame(startUs);
    }
  } catch {
    if (generation === routeGeneration && activeProject?.id === project.id)
      showError("The range cut could not be saved. Try again.");
  } finally {
    manualEditPending = false;
    back.disabled = false;
    renderEditTools();
  }
}
async function submitManualRestoreRange(): Promise<void> {
  const project = activeProject,
    sourceId = restoreSource.value,
    sourceStartUs = secondsTextToMicroseconds(restoreSourceStart.value),
    sourceEndUs = secondsTextToMicroseconds(restoreSourceEnd.value),
    source =
      project &&
      restoreSources(project).find((candidate) => candidate.id === sourceId),
    generation = routeGeneration;
  const overlapsVisible =
    project !== undefined &&
    sourceStartUs !== undefined &&
    sourceEndUs !== undefined &&
    project.clips?.some(
      (clip) =>
        clip.sourceId === sourceId &&
        sourceStartUs < clip.sourceEndUs &&
        sourceEndUs > clip.sourceStartUs,
    );
  if (
    !project ||
    project.stage !== "edit" ||
    !source ||
    sourceStartUs === undefined ||
    sourceEndUs === undefined ||
    sourceStartUs >= sourceEndUs ||
    sourceEndUs > source.durationUs ||
    overlapsVisible ||
    !restoreRangeOpen ||
    restoreHead !== currentHeadKey(project) ||
    manualEditPending
  )
    return;
  const requestedHead = currentHeadKey(project);
  manualEditPending = true;
  back.disabled = true;
  restoreRangeIssue = null;
  renderEditTools();
  clearError();
  try {
    const reply = await window.desktop.applyManualRestoreRange({
      schema_version: "1.0",
      projectId: project.id,
      draftId: project.draft.id,
      baseRevisionId: project.draft.baseRevisionId,
      expectedSequence: project.draft.sequence,
      expectedTimelineSha256: project.draft.timelineSha256,
      sourceId,
      sourceStartUs,
      sourceEndUs,
    });
    if (
      generation !== routeGeneration ||
      activeProject?.id !== project.id ||
      activeProject.stage !== "edit"
    )
      return;
    if (!reply.ok) {
      if (currentHeadKey(activeProject) !== requestedHead) {
        restoreRangeOpen = false;
        restoreHead = undefined;
        showError(
          "Draft changed during restore. Check the source range again.",
        );
      } else restoreRangeIssue = reply.message;
      return;
    }
    const returnedHead = `${reply.value.projectId}:${reply.value.draft.id}:${reply.value.draft.sequence}:${reply.value.draft.timelineSha256}`,
      activeHead = currentHeadKey(activeProject);
    if (activeHead !== requestedHead && activeHead !== returnedHead) {
      restoreRangeOpen = false;
      restoreHead = undefined;
      showError("Draft changed during restore. Check the source range again.");
      return;
    }
    const restoredClip = reply.value.clips?.find(
      (clip) =>
        clip.sourceId === sourceId &&
        clip.sourceStartUs <= sourceStartUs &&
        clip.sourceEndUs >= sourceEndUs,
    );
    restoreRangeOpen = false;
    restoreHead = undefined;
    restoreSourceStart.value = "";
    restoreSourceEnd.value = "";
    const restorePosition = restoredClip
      ? restoredClip.timelineStartUs +
        (sourceStartUs - restoredClip.sourceStartUs)
      : Number(seek.value);
    if (activeHead === returnedHead) {
      applyProjectDraft(reply);
      requestFrame(restorePosition);
    } else applyProjectDraft(reply, restorePosition);
  } catch {
    if (generation === routeGeneration && activeProject?.id === project.id) {
      if (currentHeadKey(activeProject) !== requestedHead) {
        restoreRangeOpen = false;
        restoreHead = undefined;
        showError(
          "Draft changed during restore. Check the source range again.",
        );
      } else
        restoreRangeIssue =
          "The source range could not be restored. Check the missing interval and try again.";
    }
  } finally {
    manualEditPending = false;
    back.disabled = false;
    renderEditTools();
  }
}
async function submitManualUndo(): Promise<void> {
  const project = activeProject,
    target = project?.draft.undoTransactionId,
    generation = routeGeneration;
  if (!project || project.stage !== "edit" || !target || manualEditPending)
    return;
  manualEditPending = true;
  back.disabled = true;
  renderEditTools();
  clearError();
  try {
    const reply = await window.desktop.undoManualEdit({
      schema_version: "1.0",
      projectId: project.id,
      draftId: project.draft.id,
      baseRevisionId: project.draft.baseRevisionId,
      expectedSequence: project.draft.sequence,
      expectedTimelineSha256: project.draft.timelineSha256,
      targetTransactionId: target,
    });
    if (generation === routeGeneration && activeProject?.id === project.id)
      applyProjectDraft(reply);
  } catch {
    if (generation === routeGeneration && activeProject?.id === project.id)
      showError("Undo could not be saved. Try again.");
  } finally {
    manualEditPending = false;
    back.disabled = false;
    renderEditTools();
  }
}
async function submitManualRedo(): Promise<void> {
  const project = activeProject,
    target = project?.draft.redoTransactionId,
    generation = routeGeneration;
  if (!project || project.stage !== "edit" || !target || manualEditPending)
    return;
  manualEditPending = true;
  back.disabled = true;
  renderEditTools();
  clearError();
  try {
    const reply = await window.desktop.redoManualEdit({
      schema_version: "1.0",
      projectId: project.id,
      draftId: project.draft.id,
      baseRevisionId: project.draft.baseRevisionId,
      expectedSequence: project.draft.sequence,
      expectedTimelineSha256: project.draft.timelineSha256,
      targetTransactionId: target,
    });
    if (generation === routeGeneration && activeProject?.id === project.id)
      applyProjectDraft(reply);
  } catch {
    if (generation === routeGeneration && activeProject?.id === project.id)
      showError("Redo could not be saved. Try again.");
  } finally {
    manualEditPending = false;
    back.disabled = false;
    renderEditTools();
  }
}
trimStart.addEventListener("click", () => void submitManualTrim("start"));
trimEnd.addEventListener("click", () => void submitManualTrim("end"));
splitClip.addEventListener("click", () => void submitManualSplit());
markInButton.addEventListener("click", () => markBoundary("in"));
markOutButton.addEventListener("click", () => markBoundary("out"));
cutRangeButton.addEventListener("click", () => void submitManualRangeCut());
restoreToggleButton.addEventListener("click", () => {
  const project = activeProject;
  if (!project || project.stage !== "edit" || manualEditPending || navigating)
    return;
  restoreRangeOpen = !restoreRangeOpen;
  restoreHead = restoreRangeOpen ? currentHeadKey(project) : undefined;
  restoreRangeIssue = null;
  if (restoreRangeOpen) {
    restoreSourceStart.value = "";
    restoreSourceEnd.value = "";
  }
  renderEditTools();
  if (restoreRangeOpen)
    requestAnimationFrame(() =>
      restoreForm.scrollIntoView({ block: "nearest" }),
    );
});
for (const input of [restoreSource, restoreSourceStart, restoreSourceEnd]) {
  input.addEventListener("input", () => {
    restoreRangeIssue = null;
    renderEditTools();
  });
  input.addEventListener("change", () => {
    restoreRangeIssue = null;
    renderEditTools();
  });
}
restoreSubmit.addEventListener("click", () => void submitManualRestoreRange());
clearMarksButton.addEventListener("click", () => {
  markHead = undefined;
  markInUs = undefined;
  markOutUs = undefined;
  renderEditTools();
});
undoEdit.addEventListener("click", () => void submitManualUndo());
redoEdit.addEventListener("click", () => void submitManualRedo());
window.desktop.onProjectDraftChanged(applyProjectDraft);
void loadLibrary().catch(() =>
  showError(
    "The library could not be opened. Restart the application to retry.",
  ),
);

const inspector = element("inspector");
const detailsButton = element<HTMLButtonElement>("source-details");
const codexDrawer = element("codex-drawer");
const codexDrawerButton = element<HTMLButtonElement>("codex-drawer-button");
const settingsButton = element<HTMLButtonElement>("settings");
const settingsDialog = element<HTMLDialogElement>("settings-dialog");
const scaleSelect = element<HTMLSelectElement>("interface-scale");
const resetSettingsSection = setupCodexSettings(settingsDialog);
let savingPreferences = false;
let settingsLoad = 0;
let restoreInspector = false;
let dialogOrigin: HTMLElement | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function setInspector(open: boolean): void {
  if (open) setCodexDrawer(false);
  inspector.hidden = !open;
  detailsButton.setAttribute("aria-expanded", String(open));
  if (open && selected) {
    const list = element("source-properties");
    list.replaceChildren();
    const details = activeProject?.sources
      ? activeProject.sources.flatMap((source, index) => [
          [`Part ${index + 1}`, source.name],
          [`Duration ${index + 1}`, time(source.durationUs)],
        ])
      : [
          ["File", selected.name],
          ["Dimensions", `${selected.width} × ${selected.height}`],
          ["Duration", time(selected.durationUs)],
          ["Frame rate", `${Number(selected.frameRate.toFixed(3))} fps`],
        ];
    for (const [label, value] of details) {
      const term = document.createElement("dt"),
        definition = document.createElement("dd");
      term.textContent = label!;
      definition.textContent = value!;
      list.append(term, definition);
    }
  }
  renderDraftIntegrityAction();
  renderTranscriptEditor();
}

let codexThreadView: CodexThreadView | undefined;
let apiThreadView: ApiThreadView | undefined;
let codexThreadIssue: string | null = null;
let codexPollGeneration = 0;
const assistantProvider = element<HTMLSelectElement>("assistant-provider");
function selectedApiProvider(): ApiProviderId | null {
  return assistantProvider.value === "deepseek" ||
    assistantProvider.value === "openai" ||
    assistantProvider.value === "gemini"
    ? assistantProvider.value
    : null;
}
function assistantName(): string {
  return assistantProvider.value === "deepseek"
    ? "DeepSeek"
    : assistantProvider.value === "openai"
      ? "OpenAI API"
      : assistantProvider.value === "gemini"
        ? "Gemini API"
        : "Codex";
}
const threadStatus: Record<CodexThreadView["status"], string> = {
  closed: "",
  opening: "Opening conversation…",
  ready: "",
  starting: "Sending…",
  running: "Codex is working…",
  interrupting: "Stopping…",
  uncertain: "",
  failed: "",
};
function renderCodexThread(view: CodexThreadView): void {
  codexThreadView = view;
  const status = element("codex-thread-status");
  status.textContent = threadStatus[view.status];
  status.hidden = !status.textContent;
  const messages = element("codex-thread-messages");
  messages.replaceChildren();
  for (const item of view.messages) {
    const message = document.createElement("p");
    message.className = `codex-message ${item.role}`;
    const role = document.createElement("strong");
    role.textContent = item.role === "user" ? "You" : "Codex";
    const text = document.createElement("span");
    text.textContent = item.text;
    message.append(role, text);
    messages.append(message);
  }
  const activity = element("codex-thread-activity");
  activity.replaceChildren();
  for (const item of view.activities.filter((entry) => !entry.complete)) {
    const row = document.createElement("li");
    row.textContent = item.label;
    activity.append(row);
  }
  activity.hidden = activity.childElementCount === 0;
  const open = element<HTMLButtonElement>("open-codex-thread");
  open.hidden = view.status !== "closed";
  const form = element<HTMLFormElement>("codex-thread-form");
  form.hidden = !["ready", "starting", "running", "interrupting"].includes(
    view.status,
  );
  const input = element<HTMLTextAreaElement>("codex-thread-input");
  const send = element<HTMLButtonElement>("send-codex-thread");
  input.disabled = view.status !== "ready";
  send.disabled = view.status !== "ready" || !input.value.trim();
  const stop = element<HTMLButtonElement>("interrupt-codex-thread");
  stop.hidden = !["running", "interrupting"].includes(view.status);
  stop.disabled = view.status !== "running";
  const retry = element<HTMLButtonElement>("retry-codex-thread");
  retry.hidden = !view.retryable || view.status !== "ready";
  retry.disabled = retry.hidden;
  const issue = element("codex-thread-error");
  const nextIssue = view.message ?? codexThreadIssue ?? "";
  const revealIssue = issue.hidden || issue.textContent !== nextIssue;
  issue.textContent = nextIssue;
  issue.hidden = !issue.textContent;
  if (nextIssue && revealIssue) issue.scrollIntoView({ block: "nearest" });
  messages.scrollTop = messages.scrollHeight;
}
function renderApiThread(view: ApiThreadView): void {
  apiThreadView = view;
  const status = element("codex-thread-status");
  status.textContent = {
    closed: "",
    ready: "",
    running: `${assistantName()} is working…`,
    interrupting: "Stopping…",
    failed: "",
  }[view.status];
  status.hidden = !status.textContent;
  const messages = element("codex-thread-messages");
  messages.replaceChildren();
  for (const item of view.messages) {
    const message = document.createElement("p");
    message.className = `codex-message ${item.role}`;
    const role = document.createElement("strong");
    role.textContent = item.role === "user" ? "You" : assistantName();
    const text = document.createElement("span");
    text.textContent = item.text;
    message.append(role, text);
    messages.append(message);
  }
  element("codex-thread-activity").replaceChildren();
  element("codex-thread-activity").hidden = true;
  element<HTMLButtonElement>("open-codex-thread").hidden =
    view.status !== "closed";
  element<HTMLFormElement>("codex-thread-form").hidden =
    view.status === "closed";
  const input = element<HTMLTextAreaElement>("codex-thread-input");
  input.disabled = view.status !== "ready" && view.status !== "failed";
  element<HTMLButtonElement>("send-codex-thread").disabled =
    input.disabled || !input.value.trim();
  const stop = element<HTMLButtonElement>("interrupt-codex-thread");
  stop.hidden = view.status !== "running" && view.status !== "interrupting";
  stop.disabled = view.status !== "running";
  const retry = element<HTMLButtonElement>("retry-codex-thread");
  retry.hidden = true;
  retry.disabled = true;
  const issue = element("codex-thread-error");
  const nextIssue = view.message ?? codexThreadIssue ?? "";
  const revealIssue = issue.hidden || issue.textContent !== nextIssue;
  issue.textContent = nextIssue;
  issue.hidden = !issue.textContent;
  if (nextIssue && revealIssue) issue.scrollIntoView({ block: "nearest" });
  messages.scrollTop = messages.scrollHeight;
}
function clearAssistantDisplay(): void {
  element("codex-thread-status").hidden = true;
  element("codex-thread-messages").replaceChildren();
  element("codex-thread-activity").replaceChildren();
  element("codex-thread-activity").hidden = true;
  element<HTMLFormElement>("codex-thread-form").hidden = true;
  element<HTMLButtonElement>("open-codex-thread").hidden = true;
  element<HTMLButtonElement>("retry-codex-thread").hidden = true;
  element("codex-thread-error").hidden = true;
}
assistantProvider.addEventListener("change", () => {
  codexThreadIssue = null;
  element<HTMLTextAreaElement>("codex-thread-input").value = "";
  const name = assistantName();
  codexDrawerButton.textContent = name;
  codexDrawer.setAttribute("aria-label", `${name} conversation`);
  element("close-codex").setAttribute("aria-label", `Close ${name}`);
  element("api-turn-notice").hidden = selectedApiProvider() === null;
  clearAssistantDisplay();
  if (!codexDrawer.hidden) void pollCodex(++codexPollGeneration);
});
function setCodexDrawer(open: boolean): void {
  codexDrawer.hidden = !open;
  codexDrawerButton.setAttribute("aria-expanded", String(open));
  if (open) {
    inspector.hidden = true;
    detailsButton.setAttribute("aria-expanded", "false");
    const generation = ++codexPollGeneration;
    void pollCodex(generation);
  } else {
    codexPollGeneration++;
  }
  renderDraftIntegrityAction();
  renderTranscriptEditor();
}
async function pollCodex(generation: number): Promise<void> {
  while (
    generation === codexPollGeneration &&
    !codexDrawer.hidden &&
    activeProject
  ) {
    const project = activeProject;
    const provider = selectedApiProvider();
    try {
      const reply = provider
        ? await window.desktop.getApiThread({
            schema_version: "1.0",
            project_id: project.id,
            provider,
          })
        : await window.desktop.getCodexThread({
            schema_version: "1.0",
            project_id: project.id,
          });
      if (
        generation !== codexPollGeneration ||
        codexDrawer.hidden ||
        activeProject?.id !== project.id ||
        selectedApiProvider() !== provider
      )
        return;
      if (reply.ok) {
        if (provider) renderApiThread(reply.value as ApiThreadView);
        else renderCodexThread(reply.value as CodexThreadView);
      } else {
        codexThreadIssue = reply.message;
        const issue = element("codex-thread-error");
        issue.textContent = reply.message;
        issue.hidden = false;
      }
    } catch {
      if (generation === codexPollGeneration) {
        codexThreadIssue = "The conversation could not be refreshed.";
        const issue = element("codex-thread-error");
        issue.textContent = codexThreadIssue;
        issue.hidden = false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
codexDrawerButton.addEventListener("click", () => {
  setCodexDrawer(Boolean(codexDrawer.hidden));
});
element("close-codex").addEventListener("click", () => setCodexDrawer(false));
element("open-codex-thread").addEventListener("click", async () => {
  if (!activeProject || codexThreadView?.status === "opening") return;
  const project = activeProject;
  const provider = selectedApiProvider();
  codexThreadIssue = null;
  element<HTMLButtonElement>("open-codex-thread").disabled = true;
  const reply = provider
    ? await window.desktop.openApiThread({
        schema_version: "1.0",
        project_id: project.id,
        provider,
      })
    : await window.desktop.openCodexThread({
        schema_version: "1.0",
        project_id: project.id,
      });
  element<HTMLButtonElement>("open-codex-thread").disabled = false;
  if (activeProject?.id !== project.id || selectedApiProvider() !== provider)
    return;
  if (reply.ok) {
    if (provider) renderApiThread(reply.value as ApiThreadView);
    else renderCodexThread(reply.value as CodexThreadView);
  } else {
    codexThreadIssue = reply.message;
    if (provider)
      renderApiThread({
        status: "closed",
        projectId: null,
        provider: null,
        messages: [],
        message: null,
      });
    else
      renderCodexThread({
        status: "closed",
        projectId: null,
        messages: [],
        activities: [],
        message: null,
        retryable: false,
      });
  }
});
element<HTMLTextAreaElement>("codex-thread-input").addEventListener(
  "input",
  () => {
    if (selectedApiProvider()) {
      if (apiThreadView) renderApiThread(apiThreadView);
    } else if (codexThreadView) renderCodexThread(codexThreadView);
  },
);
element<HTMLFormElement>("codex-thread-form").addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();
    if (!activeProject) return;
    const provider = selectedApiProvider();
    if (
      provider
        ? apiThreadView?.status !== "ready" &&
          apiThreadView?.status !== "failed"
        : codexThreadView?.status !== "ready"
    )
      return;
    const input = element<HTMLTextAreaElement>("codex-thread-input");
    const text = input.value.trim();
    if (!text) return;
    const project = activeProject;
    input.value = "";
    const reply = provider
      ? await window.desktop.sendApiThread({
          schema_version: "1.0",
          project_id: project.id,
          provider,
          text,
        })
      : await window.desktop.sendCodexThread({
          schema_version: "1.0",
          project_id: project.id,
          text,
        });
    if (
      activeProject?.id === project.id &&
      selectedApiProvider() === provider &&
      reply.ok
    ) {
      if (provider) renderApiThread(reply.value as ApiThreadView);
      else renderCodexThread(reply.value as CodexThreadView);
    } else if (!reply.ok) {
      const issue = element("codex-thread-error");
      issue.textContent = reply.message;
      issue.hidden = false;
    }
  },
);
element<HTMLButtonElement>("retry-codex-thread").addEventListener(
  "click",
  async () => {
    const project = activeProject;
    const view = codexThreadView;
    if (
      !project ||
      selectedApiProvider() !== null ||
      view?.projectId !== project.id ||
      view.status !== "ready" ||
      !view.retryable
    )
      return;
    const text = [...view.messages]
      .reverse()
      .find((item) => item.role === "user")?.text;
    if (!text?.trim()) return;
    const button = element<HTMLButtonElement>("retry-codex-thread");
    button.disabled = true;
    try {
      const reply = await window.desktop.sendCodexThread({
        schema_version: "1.0",
        project_id: project.id,
        text,
      });
      if (activeProject?.id !== project.id || selectedApiProvider() !== null)
        return;
      if (reply.ok) renderCodexThread(reply.value);
      else {
        codexThreadIssue = reply.message;
        const issue = element("codex-thread-error");
        issue.textContent = reply.message;
        issue.hidden = false;
        void pollCodex(++codexPollGeneration);
      }
    } catch {
      codexThreadIssue =
        "The request could not be retried. Check the conversation and try again.";
      const issue = element("codex-thread-error");
      issue.textContent = codexThreadIssue;
      issue.hidden = false;
      void pollCodex(++codexPollGeneration);
    }
  },
);
element("interrupt-codex-thread").addEventListener("click", async () => {
  if (!activeProject) return;
  const project = activeProject;
  const provider = selectedApiProvider();
  if (
    provider
      ? apiThreadView?.status !== "running"
      : codexThreadView?.status !== "running"
  )
    return;
  const reply = provider
    ? await window.desktop.interruptApiThread({
        schema_version: "1.0",
        project_id: project.id,
        provider,
      })
    : await window.desktop.interruptCodexThread({
        schema_version: "1.0",
        project_id: project.id,
      });
  if (
    activeProject?.id === project.id &&
    selectedApiProvider() === provider &&
    reply.ok
  ) {
    if (provider) renderApiThread(reply.value as ApiThreadView);
    else renderCodexThread(reply.value as CodexThreadView);
  }
});
detailsButton.addEventListener("click", () => {
  setInspector(inspector.hidden === true);
  if (!inspector.hidden) element("close-inspector").focus();
});
element("close-inspector").addEventListener("click", () => {
  setInspector(false);
  detailsButton.focus();
});
function showToast(message: string): void {
  const toast = element("toast");
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}
async function openSettings(): Promise<void> {
  if (settingsDialog.open || settingsButton.disabled) return;
  const load = ++settingsLoad;
  dialogOrigin =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  settingsButton.disabled = true;
  restoreInspector = !inspector.hidden;
  setInspector(false);
  const message = element("settings-error");
  message.hidden = true;
  element<HTMLButtonElement>("save-settings").disabled = true;
  resetSettingsSection();
  settingsDialog.showModal();
  scaleSelect.disabled = true;
  element("close-settings").focus();
  try {
    const reply = await window.desktop.getPreferences();
    if (!settingsDialog.open || load !== settingsLoad) return;
    if (!reply.ok) throw new Error("load");
    scaleSelect.value = String(reply.value.interfaceScale);
    scaleSelect.disabled = false;
    element<HTMLButtonElement>("save-settings").disabled = false;
    if (!element("appearance-settings").hidden) scaleSelect.focus();
  } catch {
    if (settingsDialog.open && load === settingsLoad) {
      message.textContent =
        "Settings could not be loaded. Close this dialog and retry. Your saved settings have been preserved.";
      message.hidden = false;
    }
  } finally {
    if (load === settingsLoad) settingsButton.disabled = false;
  }
}
settingsButton.addEventListener("click", () => {
  void openSettings();
});
function closeSettings(): void {
  if (!savingPreferences) settingsDialog.close();
}
element("close-settings").addEventListener("click", closeSettings);
element("cancel-settings").addEventListener("click", closeSettings);
settingsDialog.addEventListener("cancel", (event) => {
  if (savingPreferences) event.preventDefault();
});
settingsDialog.addEventListener("close", () => {
  settingsLoad++;
  settingsButton.disabled = false;
  if (restoreInspector && selected) setInspector(true);
  if (dialogOrigin?.isConnected && !dialogOrigin.closest("[hidden]"))
    dialogOrigin.focus();
  else settingsButton.focus();
});
element("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (
    savingPreferences ||
    scaleSelect.disabled ||
    !element("codex-settings").hidden ||
    !element("api-provider-settings").hidden
  )
    return;
  void savePreferences();
});
async function savePreferences(): Promise<void> {
  savingPreferences = true;
  const message = element("settings-error");
  message.hidden = true;
  const controls = Array.from(
    settingsDialog.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
      "button, select",
    ),
  );
  controls.forEach((control) => {
    control.disabled = true;
  });
  try {
    const value = { interfaceScale: Number(scaleSelect.value) };
    assertPreferences(value);
    const reply = await window.desktop.setPreferences(value);
    if (!reply.ok) throw new Error("save");
    savingPreferences = false;
    settingsDialog.close();
    showToast("Interface size saved");
  } catch {
    message.textContent =
      "Settings could not be saved. Your previous interface size is unchanged. Try again.";
    message.hidden = false;
  } finally {
    savingPreferences = false;
    controls.forEach((control) => {
      control.disabled = false;
    });
  }
}
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === ",") {
    event.preventDefault();
    void openSettings();
  } else if (
    event.key === "Escape" &&
    !settingsDialog.open &&
    !inspector.hidden
  ) {
    event.preventDefault();
    setInspector(false);
    detailsButton.focus();
  }
});
void window.desktop
  .getPreferences()
  .then((reply) => {
    if (!reply.ok)
      showError(
        "Saved interface settings could not be loaded. Open Settings to retry.",
      );
  })
  .catch(() =>
    showError(
      "Saved interface settings could not be loaded. Open Settings to retry.",
    ),
  );

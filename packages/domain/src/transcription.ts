/** Path-free local transcription and analysis contracts. */
export const transcriptSchemaVersion = "1.0" as const;
export const transcriptionJobStatuses = [
  "idle",
  "preparing",
  "downloading_model",
  "transcribing",
  "completed",
  "failed",
  "cancelled",
] as const;

export const transcriptionMessages = [
  null,
  "Preparing audio for transcription.",
  "Downloading the local speech model.",
  "Transcribing source audio locally.",
  "Transcript ready.",
  "This project has no audio tracks to transcribe.",
  "One or more sources have no audio track.",
  "The local speech model could not be downloaded. Try again.",
  "Local transcription failed. Try again.",
  "Transcription was interrupted. Start it again.",
  "The project changed. Reopen it before transcribing.",
  "This source's audio timing needs a supported synchronization profile.",
  "Local transcription failed. Check this source's audio and try again.",
  "The local speech model could not start. Restart the app and try again.",
] as const;

export type TranscriptionJobStatus = (typeof transcriptionJobStatuses)[number];
export type TranscriptionMessage = (typeof transcriptionMessages)[number];
export type TranscriptWordFlag =
  "uncertain" | "number" | "name" | "negation" | "protected" | "overlap";

export interface TranscriptWord {
  word_id: string;
  text: string;
  start_us: number;
  end_us: number;
  confidence?: number | null;
  speaker?: string | null;
  flags?: TranscriptWordFlag[];
}

export interface TranscriptSegment {
  segment_id: string;
  start_us: number;
  end_us: number;
  text: string;
  words: TranscriptWord[];
}

export interface LocalTranscript {
  schema_version: typeof transcriptSchemaVersion;
  transcript_id: string;
  project_id: string;
  source_id: string;
  duration_us: number;
  language: string;
  model: {
    provider: "local";
    name: string;
    version: string;
    sha256?: string | null;
    device?: string;
  };
  segments: TranscriptSegment[];
  warnings?: string[];
}

export interface TranscriptSilence {
  start_us: number;
  end_us: number;
}

/** Silence is analysis evidence only; it does not authorize a cut. */
export interface TranscriptAnalysis {
  schema_version: typeof transcriptSchemaVersion;
  project_id: string;
  source_id: string;
  source_sha256: string;
  duration_us: number;
  silence_policy: {
    version: "1";
    noise_db: number;
    minimum_duration_us: number;
  };
  silences: TranscriptSilence[];
}

/** A text-only correction attached to the shared reversible draft history. */
export interface TranscriptTextOverride {
  source_id: string;
  transcript_id: string;
  word_id: string;
  original_text: string;
  replacement_text: string;
}

export interface TranscriptionProjectRequest {
  schema_version: typeof transcriptSchemaVersion;
  project_id: string;
}

export interface TranscriptionJobRequest extends TranscriptionProjectRequest {
  job_id: string | null;
}

export interface TranscriptionStopRequest extends TranscriptionProjectRequest {
  job_id: string;
}

export interface TranscriptionJobView {
  project_id: string;
  job_id: string | null;
  status: TranscriptionJobStatus;
  progress_percent: number | null;
  source_count: number;
  completed_source_count: number;
  word_count: number;
  message: TranscriptionMessage;
}

export interface TranscriptionSourceResult {
  source_id: string;
  transcript: LocalTranscript;
  analysis: TranscriptAnalysis;
}

export interface TranscriptionProjectView {
  project_id: string;
  job: TranscriptionJobView;
  results: TranscriptionSourceResult[];
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const wordFlags = new Set<TranscriptWordFlag>([
  "uncertain",
  "number",
  "name",
  "negation",
  "protected",
  "overlap",
]);
const messages = new Set<TranscriptionMessage>(transcriptionMessages);
const statuses = new Set<TranscriptionJobStatus>(transcriptionJobStatuses);

function invalid(): never {
  throw new Error("Invalid local transcription state.");
}

function object(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!object(value)) invalid();
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
  return value;
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value)) invalid();
}

function integer(
  value: unknown,
  maximum = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  )
    invalid();
}

function text(value: unknown, maxLength: number): asserts value is string {
  if (typeof value !== "string" || value.length > maxLength) invalid();
}

function validateWord(value: unknown): asserts value is TranscriptWord {
  const word = exact(
    value,
    ["word_id", "text", "start_us", "end_us"],
    ["confidence", "speaker", "flags"],
  );
  identifier(word.word_id);
  text(word.text, 200);
  if (!word.text.trim()) invalid();
  integer(word.start_us);
  integer(word.end_us);
  if (word.start_us > word.end_us) invalid();
  if (
    word.confidence !== undefined &&
    word.confidence !== null &&
    (typeof word.confidence !== "number" ||
      !Number.isFinite(word.confidence) ||
      word.confidence < 0 ||
      word.confidence > 1)
  )
    invalid();
  if (
    word.speaker !== undefined &&
    word.speaker !== null &&
    (typeof word.speaker !== "string" || word.speaker.length > 80)
  )
    invalid();
  if (
    word.flags !== undefined &&
    (!Array.isArray(word.flags) ||
      word.flags.length > 16 ||
      word.flags.some(
        (flag) =>
          typeof flag !== "string" ||
          !wordFlags.has(flag as TranscriptWordFlag),
      ) ||
      new Set(word.flags).size !== word.flags.length)
  )
    invalid();
}

export function assertLocalTranscript(
  value: unknown,
): asserts value is LocalTranscript {
  const transcript = exact(
    value,
    [
      "schema_version",
      "transcript_id",
      "project_id",
      "source_id",
      "duration_us",
      "language",
      "model",
      "segments",
    ],
    ["warnings"],
  );
  if (transcript.schema_version !== transcriptSchemaVersion) invalid();
  identifier(transcript.transcript_id);
  identifier(transcript.project_id);
  identifier(transcript.source_id);
  integer(transcript.duration_us);
  text(transcript.language, 35);
  if (transcript.language.length < 2) invalid();

  const model = exact(
    transcript.model,
    ["provider", "name", "version"],
    ["sha256", "device"],
  );
  if (model.provider !== "local") invalid();
  text(model.name, 256);
  text(model.version, 128);
  if (!model.name || !model.version) invalid();
  if (
    model.sha256 !== undefined &&
    model.sha256 !== null &&
    (typeof model.sha256 !== "string" || !hashPattern.test(model.sha256))
  )
    invalid();
  if (model.device !== undefined) text(model.device, 64);

  if (
    !Array.isArray(transcript.segments) ||
    transcript.segments.length > 20_000
  )
    invalid();
  let words = 0;
  let textBytes = 0;
  let priorSegmentStart = -1;
  const encoder = new TextEncoder();
  const segmentIds = new Set<string>();
  const wordIds = new Set<string>();
  for (const rawSegment of transcript.segments) {
    const segment = exact(rawSegment, [
      "segment_id",
      "start_us",
      "end_us",
      "text",
      "words",
    ]);
    identifier(segment.segment_id);
    if (segmentIds.has(segment.segment_id)) invalid();
    segmentIds.add(segment.segment_id as string);
    integer(segment.start_us, transcript.duration_us as number);
    integer(segment.end_us, transcript.duration_us as number);
    if (
      segment.start_us > segment.end_us ||
      segment.start_us < priorSegmentStart
    )
      invalid();
    priorSegmentStart = segment.start_us as number;
    text(segment.text, 16_384);
    textBytes += encoder.encode(segment.text).length;
    if (!Array.isArray(segment.words) || segment.words.length > 200) invalid();
    words += segment.words.length;
    if (words > 100_000) invalid();
    for (const rawWord of segment.words) {
      validateWord(rawWord);
      if (wordIds.has(rawWord.word_id)) invalid();
      wordIds.add(rawWord.word_id);
      if (
        rawWord.start_us < (segment.start_us as number) ||
        rawWord.end_us > (segment.end_us as number)
      )
        invalid();
      textBytes += encoder.encode(rawWord.text).length;
    }
    if (textBytes > 8 * 1024 * 1024) invalid();
  }
  if (transcript.warnings !== undefined) {
    if (!Array.isArray(transcript.warnings) || transcript.warnings.length > 64)
      invalid();
    for (const warning of transcript.warnings) text(warning, 1024);
  }
}

export function assertTranscriptAnalysis(
  value: unknown,
): asserts value is TranscriptAnalysis {
  const analysis = exact(value, [
    "schema_version",
    "project_id",
    "source_id",
    "source_sha256",
    "duration_us",
    "silence_policy",
    "silences",
  ]);
  if (analysis.schema_version !== transcriptSchemaVersion) invalid();
  identifier(analysis.project_id);
  identifier(analysis.source_id);
  if (
    typeof analysis.source_sha256 !== "string" ||
    !hashPattern.test(analysis.source_sha256)
  )
    invalid();
  integer(analysis.duration_us);
  const policy = exact(analysis.silence_policy, [
    "version",
    "noise_db",
    "minimum_duration_us",
  ]);
  if (
    policy.version !== "1" ||
    typeof policy.noise_db !== "number" ||
    !Number.isFinite(policy.noise_db) ||
    policy.noise_db < -120 ||
    policy.noise_db > 0
  )
    invalid();
  integer(policy.minimum_duration_us, 10_000_000);
  if (!Array.isArray(analysis.silences) || analysis.silences.length > 50_000)
    invalid();
  let priorEnd = -1;
  for (const rawRange of analysis.silences) {
    const range = exact(rawRange, ["start_us", "end_us"]);
    integer(range.start_us, analysis.duration_us as number);
    integer(range.end_us, analysis.duration_us as number);
    if (
      range.start_us >= range.end_us ||
      range.start_us < priorEnd ||
      range.end_us - range.start_us < (policy.minimum_duration_us as number)
    )
      invalid();
    priorEnd = range.end_us as number;
  }
}

export function assertTranscriptTextOverrides(
  value: unknown,
  allowedSourceIds?: readonly string[],
): asserts value is TranscriptTextOverride[] {
  if (!Array.isArray(value) || value.length > 100_000) invalid();
  const seen = new Set<string>();
  for (const raw of value) {
    const override = exact(raw, [
      "source_id",
      "transcript_id",
      "word_id",
      "original_text",
      "replacement_text",
    ]);
    identifier(override.source_id);
    identifier(override.transcript_id);
    identifier(override.word_id);
    text(override.original_text, 200);
    text(override.replacement_text, 200);
    if (
      !override.original_text.trim() ||
      !override.replacement_text.trim() ||
      override.original_text === override.replacement_text ||
      (allowedSourceIds && !allowedSourceIds.includes(override.source_id))
    )
      invalid();
    const key = `${override.source_id}\0${override.transcript_id}\0${override.word_id}`;
    if (seen.has(key)) invalid();
    seen.add(key);
  }
}

export function assertTranscriptionProjectRequest(
  value: unknown,
): asserts value is TranscriptionProjectRequest {
  const request = exact(value, ["schema_version", "project_id"]);
  if (request.schema_version !== transcriptSchemaVersion) invalid();
  identifier(request.project_id);
}

export function assertTranscriptionJobRequest(
  value: unknown,
): asserts value is TranscriptionJobRequest {
  const request = exact(value, ["schema_version", "project_id", "job_id"]);
  assertTranscriptionProjectRequest({
    schema_version: request.schema_version,
    project_id: request.project_id,
  });
  if (
    request.job_id !== null &&
    (typeof request.job_id !== "string" ||
      !/^transcription-[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(request.job_id))
  )
    invalid();
}

export function assertTranscriptionStopRequest(
  value: unknown,
): asserts value is TranscriptionStopRequest {
  assertTranscriptionJobRequest(value);
  if (value.job_id === null) invalid();
}

export function assertTranscriptionJobView(
  value: unknown,
): asserts value is TranscriptionJobView {
  const view = exact(value, [
    "project_id",
    "job_id",
    "status",
    "progress_percent",
    "source_count",
    "completed_source_count",
    "word_count",
    "message",
  ]);
  identifier(view.project_id);
  if (view.job_id !== null) identifier(view.job_id);
  if (
    typeof view.status !== "string" ||
    !statuses.has(view.status as TranscriptionJobStatus)
  )
    invalid();
  if (
    view.progress_percent !== null &&
    (typeof view.progress_percent !== "number" ||
      !Number.isFinite(view.progress_percent) ||
      view.progress_percent < 0 ||
      view.progress_percent > 100)
  )
    invalid();
  integer(view.source_count, 100);
  integer(view.completed_source_count, 100);
  integer(view.word_count, 100_000);
  if (view.completed_source_count > view.source_count) invalid();
  if (
    view.message !== null &&
    (typeof view.message !== "string" ||
      !messages.has(view.message as TranscriptionMessage))
  )
    invalid();
}

export function assertTranscriptionProjectView(
  value: unknown,
): asserts value is TranscriptionProjectView {
  const view = exact(value, ["project_id", "job", "results"]);
  identifier(view.project_id);
  assertTranscriptionJobView(view.job);
  if (view.job.project_id !== view.project_id) invalid();
  if (!Array.isArray(view.results) || view.results.length > 100) invalid();
  const sourceIds = new Set<string>();
  let wordCount = 0;
  for (const rawResult of view.results) {
    const result = exact(rawResult, ["source_id", "transcript", "analysis"]);
    identifier(result.source_id);
    if (sourceIds.has(result.source_id)) invalid();
    sourceIds.add(result.source_id);
    assertLocalTranscript(result.transcript);
    assertTranscriptAnalysis(result.analysis);
    wordCount += result.transcript.segments.reduce(
      (count: number, segment: TranscriptSegment) =>
        count + segment.words.length,
      0,
    );
    if (
      result.transcript.project_id !== view.project_id ||
      result.transcript.source_id !== result.source_id ||
      result.analysis.project_id !== view.project_id ||
      result.analysis.source_id !== result.source_id ||
      result.transcript.duration_us !== result.analysis.duration_us
    )
      invalid();
  }
  if (view.job.word_count !== wordCount) invalid();
}

import { createHash } from "node:crypto";
import { isAbsolute, win32 } from "node:path";

import { projectStages } from "./project-view.ts";
import type { ProjectStage } from "./project-view.ts";
export { projectStages } from "./project-view.ts";
export type { ProjectStage } from "./project-view.ts";
type Rational = { numerator: number; denominator: number };
type SourceStream = {
  index: number;
  media_type: "video" | "audio" | "subtitle" | "data";
  codec: string;
  width?: number;
  height?: number;
  frame_rate?: Rational;
  sample_rate_hz?: number;
  channels?: number;
};
export interface InitialProjectInput {
  projectId: string;
  timelineId: string;
  revisionId: string;
  sourceId: string;
  name: string;
  createdAt: string;
  projectRoot: string;
  originalPath: string;
  managedPath: string;
  sha256: string;
  sizeBytes: number;
  probe: Record<string, unknown>;
}
export interface InitialProjectSnapshot {
  schema_version: "1.0";
  project: {
    schema_version: "1.0";
    project_id: string;
    name: string;
    created_at: string;
    updated_at: string;
    workflow_step: ProjectStage;
    current_revision_id: string;
    source_ids: string[];
    codex_thread_id: null;
    storage: {
      project_root: string;
      autosave_enabled: true;
      source_policy: "managed_copy";
    };
  };
  source: {
    schema_version: "1.0";
    source_id: string;
    kind: "imported_video";
    original_path: string;
    managed_path: string;
    sha256: string;
    size_bytes: number;
    duration_us: number;
    immutable: true;
    created_at: string;
    streams: SourceStream[];
  };
  timeline: {
    schema_version: "1.0";
    timeline_id: string;
    project_id: string;
    revision_id: string;
    duration_us: number;
    frame_rate: Rational;
    canvas: { width: number; height: number; aspect_ratio: "custom" };
    tracks: {
      track_id: string;
      kind: "main_video";
      order: number;
      visible: true;
      locked: false;
    }[];
    clips: {
      clip_id: string;
      track_id: string;
      source_id: string;
      source_start_us: number;
      source_end_us: number;
      timeline_start_us: number;
      timeline_end_us: number;
      enabled: true;
      /** Whole-number speed-up; absent means normal speed. */
      speed?: number;
    }[];
    operation_ids: string[];
    zoom_ids: string[];
    speed_ids: string[];
    created_at: string;
  };
  revision: {
    schema_version: "1.0";
    revision_id: string;
    project_id: string;
    parent_revision_id: null;
    created_at: string;
    created_by: "import";
    timeline_sha256: string;
    operation_ids: string[];
    summary: string;
    locked: true;
    qa_status: "not_run";
    export_ids: string[];
  };
  /** Retains the complete original probe, including precision/color metadata absent from source.schema. */
  source_probe: Record<string, unknown>;
}
function invalid(message = "Invalid initial project snapshot."): never {
  throw new Error(message);
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
}
function text(value: unknown, max = 4096): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    /[\x00-\x1f]/u.test(value)
  )
    invalid();
}
function id(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u.test(value)
  )
    invalid();
}
function positive(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    invalid();
}
function timestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    invalid();
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) invalid();
}
function absolute(value: unknown): asserts value is string {
  text(value);
  if (!isAbsolute(value) && !win32.isAbsolute(value)) invalid();
}
function rational(value: unknown): Rational {
  if (typeof value !== "string" || !/^\d+\/\d+$/u.test(value))
    invalid("A measured rational frame rate is required.");
  const parts = value.split("/").map(Number);
  const numerator = parts[0],
    denominator = parts[1];
  positive(numerator);
  positive(denominator);
  function gcd(a: number, b: number): number {
    return b ? gcd(b, a % b) : a;
  }
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
function duration(value: unknown): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,12})?$/u.test(value))
    invalid("A measured positive source duration is required.");
  const [seconds, fraction = ""] = value.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const ticks =
    (BigInt(seconds!) * denominator + BigInt(fraction || "0")) * 1_000_000n;
  const rounded = (ticks + denominator / 2n) / denominator;
  const result = Number(rounded);
  positive(result);
  return result;
}
/** Canonical sorted-key JSON. Rejects values JSON would silently erase or coerce. */
export function projectCanonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): string {
    if (depth > 40) invalid();
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return JSON.stringify(item);
    if (typeof item === "number") {
      if (!Number.isFinite(item)) invalid();
      return JSON.stringify(item);
    }
    if (!item || typeof item !== "object" || seen.has(item)) invalid();
    if (Object.getOwnPropertySymbols(item).length) invalid();
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) invalid();
      result = `[${Array.from(item, (child) => visit(child, depth + 1)).join(",")}]`;
    } else {
      record(item);
      if (Object.getOwnPropertySymbols(item).length) invalid();
      result = `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit(item[key], depth + 1)}`)
        .join(",")}}`;
    }
    seen.delete(item);
    return result;
  }
  return visit(value, 0);
}
export function timelineSha256(
  timeline: InitialProjectSnapshot["timeline"],
): string {
  return canonicalSha256(timeline);
}
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(projectCanonicalJson(value)).digest("hex");
}
export function createInitialProject(
  input: InitialProjectInput,
): InitialProjectSnapshot {
  record(input);
  if (
    Object.keys(input).sort().join() !==
    "createdAt,managedPath,name,originalPath,probe,projectId,projectRoot,revisionId,sha256,sizeBytes,sourceId,timelineId"
  )
    invalid();
  for (const value of [
    input.projectId,
    input.timelineId,
    input.revisionId,
    input.sourceId,
  ])
    id(value);
  if (
    new Set([
      input.projectId,
      input.timelineId,
      input.revisionId,
      input.sourceId,
    ]).size !== 4
  )
    invalid();
  text(input.name, 160);
  timestamp(input.createdAt);
  absolute(input.projectRoot);
  absolute(input.originalPath);
  absolute(input.managedPath);
  positive(input.sizeBytes);
  if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.sha256))
    invalid();
  record(input.probe);
  const serialized = projectCanonicalJson(input.probe);
  if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) invalid();
  const probe: Record<string, unknown> = JSON.parse(serialized);
  if (
    !Array.isArray(probe.streams) ||
    !probe.streams.length ||
    probe.streams.length > 128
  )
    invalid();
  record(probe.format);
  const streams: SourceStream[] = probe.streams.map((item: unknown) => {
    record(item);
    if (!Number.isSafeInteger(item.index) || (item.index as number) < 0)
      invalid();
    if (
      !["video", "audio", "subtitle", "data"].includes(
        item.codec_type as string,
      )
    )
      invalid("This stream type needs an explicit project adapter.");
    text(item.codec_name, 128);
    const stream: SourceStream = {
      index: item.index as number,
      media_type: item.codec_type as SourceStream["media_type"],
      codec: item.codec_name,
    };
    if (item.codec_type === "video") {
      positive(item.width);
      positive(item.height);
      stream.width = item.width;
      stream.height = item.height;
      stream.frame_rate = rational(item.avg_frame_rate);
    } else if (item.codec_type === "audio") {
      if (
        typeof item.sample_rate !== "string" ||
        !/^\d+$/u.test(item.sample_rate)
      )
        invalid();
      const rate = Number(item.sample_rate);
      positive(rate);
      positive(item.channels);
      stream.sample_rate_hz = rate;
      stream.channels = item.channels;
    }
    return stream;
  });
  if (new Set(streams.map((stream) => stream.index)).size !== streams.length)
    invalid();
  const videos = streams.filter((stream) => stream.media_type === "video");
  if (videos.length !== 1)
    invalid("The initial project requires exactly one video stream.");
  const video = videos[0]!;
  const rawVideo = probe.streams.find(
    (item: Record<string, unknown>) => item.index === video.index,
  ) as Record<string, unknown>;
  const durationUs = duration(rawVideo.duration ?? probe.format.duration);
  const rate = video.frame_rate!;
  if (rawVideo.nb_frames !== undefined && rawVideo.nb_frames !== "N/A") {
    if (
      typeof rawVideo.nb_frames !== "string" ||
      !/^\d+$/u.test(rawVideo.nb_frames)
    )
      invalid();
    const count = Number(rawVideo.nb_frames);
    positive(count);
    const frameDuration = Number(
      (BigInt(count) * BigInt(rate.denominator) * 1_000_000n) /
        BigInt(rate.numerator),
    );
    // Matroska duration metadata can be quantized to milliseconds. No inferred frame count is stored.
    if (
      !Number.isSafeInteger(frameDuration) ||
      Math.abs(frameDuration - durationUs) > 1000
    )
      invalid(
        "Frame count, measured rate and duration require an explicit timing adapter.",
      );
  }
  const timeline: InitialProjectSnapshot["timeline"] = {
    schema_version: "1.0",
    timeline_id: input.timelineId,
    project_id: input.projectId,
    revision_id: input.revisionId,
    duration_us: durationUs,
    frame_rate: rate,
    canvas: {
      width: video.width!,
      height: video.height!,
      aspect_ratio: "custom",
    },
    tracks: [
      {
        track_id: "track-main",
        kind: "main_video",
        order: 0,
        visible: true,
        locked: false,
      },
    ],
    clips: [
      {
        clip_id: "clip-main",
        track_id: "track-main",
        source_id: input.sourceId,
        source_start_us: 0,
        source_end_us: durationUs,
        timeline_start_us: 0,
        timeline_end_us: durationUs,
        enabled: true,
      },
    ],
    operation_ids: [],
    zoom_ids: [],
    speed_ids: [],
    created_at: input.createdAt,
  };
  return {
    schema_version: "1.0",
    project: {
      schema_version: "1.0",
      project_id: input.projectId,
      name: input.name,
      created_at: input.createdAt,
      updated_at: input.createdAt,
      workflow_step: "record_import",
      current_revision_id: input.revisionId,
      source_ids: [input.sourceId],
      codex_thread_id: null,
      storage: {
        project_root: input.projectRoot,
        autosave_enabled: true,
        source_policy: "managed_copy",
      },
    },
    source: {
      schema_version: "1.0",
      source_id: input.sourceId,
      kind: "imported_video",
      original_path: input.originalPath,
      managed_path: input.managedPath,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      duration_us: durationUs,
      immutable: true,
      created_at: input.createdAt,
      streams,
    },
    timeline,
    revision: {
      schema_version: "1.0",
      revision_id: input.revisionId,
      project_id: input.projectId,
      parent_revision_id: null,
      created_at: input.createdAt,
      created_by: "import",
      timeline_sha256: timelineSha256(timeline),
      operation_ids: [],
      summary: "Imported source baseline",
      locked: true,
      qa_status: "not_run",
      export_ids: [],
    },
    source_probe: probe,
  };
}
/** Strict initial-baseline subset. Edited snapshots require the later shared transaction validator. */
export function assertInitialProjectSnapshot(
  value: unknown,
): asserts value is InitialProjectSnapshot {
  record(value);
  record(value.project);
  record(value.source);
  record(value.timeline);
  record(value.revision);
  record(value.project.storage);
  record(value.source_probe);
  const expected = createInitialProject({
    projectId: value.project.project_id as string,
    timelineId: value.timeline.timeline_id as string,
    revisionId: value.revision.revision_id as string,
    sourceId: value.source.source_id as string,
    name: value.project.name as string,
    createdAt: value.project.created_at as string,
    projectRoot: value.project.storage.project_root as string,
    originalPath: value.source.original_path as string,
    managedPath: value.source.managed_path as string,
    sha256: value.source.sha256 as string,
    sizeBytes: value.source.size_bytes as number,
    probe: value.source_probe,
  });
  if (!projectStages.includes(value.project.workflow_step as ProjectStage))
    invalid();
  timestamp(value.project.updated_at);
  if (
    Date.parse(value.project.updated_at) <
    Date.parse(expected.project.created_at)
  )
    invalid();
  expected.project.workflow_step = value.project.workflow_step as ProjectStage;
  expected.project.updated_at = value.project.updated_at;
  if (projectCanonicalJson(value) !== projectCanonicalJson(expected)) invalid();
}

/** A measured presentation boundary, produced by the media timing index. */
export interface TwoSourceTimingEvidence {
  timeBaseNumerator: number;
  timeBaseDenominator: number;
  firstPts: number;
  lastPts: number;
  lastDurationTicks: number;
  frameCount: number;
  presentationEndUs: number;
}

export interface TwoSourceInitialProjectSourceInput {
  sourceId: string;
  originalPath: string;
  managedPath: string;
  sha256: string;
  sizeBytes: number;
  probe: Record<string, unknown>;
  timing: TwoSourceTimingEvidence;
}

export interface TwoSourceInitialProjectInput {
  projectId: string;
  timelineId: string;
  revisionId: string;
  name: string;
  createdAt: string;
  projectRoot: string;
  sources: [
    TwoSourceInitialProjectSourceInput,
    TwoSourceInitialProjectSourceInput,
  ];
}

/** New baseline envelope; published 1.0 records and old baselines remain untouched. */
export interface TwoSourceInitialProjectSnapshot {
  schema_version: "1.1";
  project: InitialProjectSnapshot["project"];
  sources: [InitialProjectSnapshot["source"], InitialProjectSnapshot["source"]];
  source_probes: [Record<string, unknown>, Record<string, unknown>];
  source_timings: [TwoSourceTimingEvidence, TwoSourceTimingEvidence];
  timeline: InitialProjectSnapshot["timeline"];
  revision: InitialProjectSnapshot["revision"];
}

function nonnegative(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid();
}

function ceilUs(ticks: number, numerator: number, denominator: number): number {
  const result = Number(
    (BigInt(ticks) * BigInt(numerator) * 1_000_000n +
      BigInt(denominator) -
      1n) /
      BigInt(denominator),
  );
  positive(result);
  return result;
}

function validateTiming(
  timing: TwoSourceTimingEvidence,
  video: Record<string, unknown>,
  streamDurationUs: number,
): TwoSourceTimingEvidence {
  record(timing);
  if (
    Object.keys(timing).sort().join() !==
    "firstPts,frameCount,lastDurationTicks,lastPts,presentationEndUs,timeBaseDenominator,timeBaseNumerator"
  )
    invalid();
  positive(timing.timeBaseNumerator);
  positive(timing.timeBaseDenominator);
  nonnegative(timing.firstPts);
  nonnegative(timing.lastPts);
  positive(timing.lastDurationTicks);
  positive(timing.frameCount);
  positive(timing.presentationEndUs);
  if (
    timing.firstPts !== 0 ||
    timing.lastPts < timing.firstPts ||
    (timing.frameCount > 1 && timing.lastPts === timing.firstPts)
  )
    invalid(
      "Presentation timing must begin at zero and contain measured frames.",
    );
  const endTicks = timing.lastPts + timing.lastDurationTicks;
  if (!Number.isSafeInteger(endTicks)) invalid();
  if (
    timing.presentationEndUs !==
    ceilUs(endTicks, timing.timeBaseNumerator, timing.timeBaseDenominator)
  )
    invalid("Presentation end does not match measured timestamp evidence.");
  const probeTimeBase = rational(video.time_base);
  const timingTimeBase = {
    numerator: timing.timeBaseNumerator,
    denominator: timing.timeBaseDenominator,
  };
  if (
    projectCanonicalJson(probeTimeBase) !== projectCanonicalJson(timingTimeBase)
  )
    invalid("Presentation time base does not match the source probe.");
  if (
    video.start_pts !== undefined &&
    video.start_pts !== 0 &&
    video.start_pts !== "0"
  )
    invalid("Nonzero presentation start needs an explicit timing adapter.");
  if (video.nb_frames !== undefined && video.nb_frames !== "N/A") {
    if (typeof video.nb_frames !== "string" || !/^\d+$/u.test(video.nb_frames))
      invalid();
    if (Number(video.nb_frames) !== timing.frameCount)
      invalid("Presentation frame count does not match the source probe.");
  }
  const finalFrameUs = ceilUs(
    timing.lastDurationTicks,
    timing.timeBaseNumerator,
    timing.timeBaseDenominator,
  );
  // Container duration can be rounded, and VFR files can put the final PTS
  // slightly beyond it. A disagreement beyond two final-frame spans needs an
  // explicit source timing adapter instead of a guessed endpoint.
  if (
    Math.abs(timing.presentationEndUs - streamDurationUs) >
    finalFrameUs * 2 + 1
  )
    invalid("Source duration and presentation end require a timing adapter.");
  return { ...timing };
}

function validatedTwoSource(
  input: TwoSourceInitialProjectInput,
  source: TwoSourceInitialProjectSourceInput,
): {
  source: InitialProjectSnapshot["source"];
  probe: Record<string, unknown>;
  timing: TwoSourceTimingEvidence;
  video: Record<string, unknown>;
  nominalRate: Rational;
} {
  record(source);
  if (
    Object.keys(source).sort().join() !==
    "managedPath,originalPath,probe,sha256,sizeBytes,sourceId,timing"
  )
    invalid();
  record(source.probe);
  const probe = JSON.parse(projectCanonicalJson(source.probe)) as Record<
    string,
    unknown
  >;
  if (!Array.isArray(probe.streams)) invalid();
  const rawVideos = probe.streams.filter(
    (stream: unknown) =>
      !!stream &&
      typeof stream === "object" &&
      !Array.isArray(stream) &&
      (stream as Record<string, unknown>).codec_type === "video",
  ) as Record<string, unknown>[];
  if (rawVideos.length !== 1) invalid("Exactly one video stream is required.");
  const video = rawVideos[0]!;
  const nominalRate = rational(video.r_frame_rate);

  // Reuse every legacy source/probe check except the CFR-only frame-count
  // inference. The original probe is retained verbatim and its frame count is
  // checked against measured presentation timestamps below.
  const normalizedProbe = JSON.parse(projectCanonicalJson(probe)) as Record<
    string,
    unknown
  >;
  const normalizedVideo = (
    normalizedProbe.streams as Record<string, unknown>[]
  ).find((stream) => stream.index === video.index)!;
  delete normalizedVideo.nb_frames;
  const base = createInitialProject({
    projectId: input.projectId,
    timelineId: input.timelineId,
    revisionId: input.revisionId,
    sourceId: source.sourceId,
    name: input.name,
    createdAt: input.createdAt,
    projectRoot: input.projectRoot,
    originalPath: source.originalPath,
    managedPath: source.managedPath,
    sha256: source.sha256,
    sizeBytes: source.sizeBytes,
    probe: normalizedProbe,
  });
  const timing = validateTiming(source.timing, video, base.source.duration_us);
  return {
    source: {
      ...base.source,
      duration_us: Math.max(base.source.duration_us, timing.presentationEndUs),
    },
    probe,
    timing,
    video,
    nominalRate,
  };
}

/** Construct an immutable two-source baseline from ordered, independently verified inputs. */
export function createTwoSourceInitialProject(
  input: TwoSourceInitialProjectInput,
): TwoSourceInitialProjectSnapshot {
  record(input);
  if (
    Object.keys(input).sort().join() !==
    "createdAt,name,projectId,projectRoot,revisionId,sources,timelineId"
  )
    invalid();
  if (!Array.isArray(input.sources) || input.sources.length !== 2) invalid();
  const [first, second] = input.sources.map((source) =>
    validatedTwoSource(input, source),
  ) as [
    ReturnType<typeof validatedTwoSource>,
    ReturnType<typeof validatedTwoSource>,
  ];
  if (first.source.source_id === second.source.source_id) invalid();
  if (first.source.managed_path === second.source.managed_path) invalid();
  if (first.source.original_path === second.source.original_path) invalid();
  if (
    projectCanonicalJson(first.nominalRate) !==
    projectCanonicalJson(second.nominalRate)
  )
    invalid(
      "Mixed nominal frame rates need an explicit working timeline format.",
    );
  if (
    first.source.streams.find((stream) => stream.media_type === "video")
      ?.width !==
      second.source.streams.find((stream) => stream.media_type === "video")
        ?.width ||
    first.source.streams.find((stream) => stream.media_type === "video")
      ?.height !==
      second.source.streams.find((stream) => stream.media_type === "video")
        ?.height
  )
    invalid("Mixed dimensions need an explicit working canvas.");
  for (const tag of [
    "pix_fmt",
    "color_range",
    "color_space",
    "color_primaries",
    "color_transfer",
    "sample_aspect_ratio",
  ]) {
    if (tag !== "sample_aspect_ratio") {
      text(first.video[tag], 128);
      text(second.video[tag], 128);
    }
    if (first.video[tag] !== second.video[tag])
      invalid(
        "Mixed pixel or color metadata needs an explicit working format.",
      );
  }
  const audioFields = [
    "codec_name",
    "sample_fmt",
    "sample_rate",
    "channels",
    "channel_layout",
    "bits_per_sample",
    "bits_per_raw_sample",
  ];
  const audioProfile = (probe: Record<string, unknown>): unknown[] =>
    (probe.streams as Record<string, unknown>[])
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => audioFields.map((field) => stream[field] ?? null));
  if (
    projectCanonicalJson(audioProfile(first.probe)) !==
    projectCanonicalJson(audioProfile(second.probe))
  )
    invalid(
      "Mixed audio stream formats need an explicit working audio profile.",
    );
  const firstEnd = first.source.duration_us;
  const total = firstEnd + second.source.duration_us;
  positive(total);
  // This is the shared nominal navigation grid, not a claim that either VFR
  // source is CFR or that export may normalize presentation timestamps.
  const timeline: InitialProjectSnapshot["timeline"] = {
    schema_version: "1.0",
    timeline_id: input.timelineId,
    project_id: input.projectId,
    revision_id: input.revisionId,
    duration_us: total,
    frame_rate: first.nominalRate,
    canvas: {
      width: first.source.streams.find(
        (stream) => stream.media_type === "video",
      )!.width!,
      height: first.source.streams.find(
        (stream) => stream.media_type === "video",
      )!.height!,
      aspect_ratio: "custom",
    },
    tracks: [
      {
        track_id: "track-main",
        kind: "main_video",
        order: 0,
        visible: true,
        locked: false,
      },
    ],
    clips: [
      {
        clip_id: "clip-main",
        track_id: "track-main",
        source_id: first.source.source_id,
        source_start_us: 0,
        source_end_us: firstEnd,
        timeline_start_us: 0,
        timeline_end_us: firstEnd,
        enabled: true,
      },
      {
        clip_id: "clip-following",
        track_id: "track-main",
        source_id: second.source.source_id,
        source_start_us: 0,
        source_end_us: second.source.duration_us,
        timeline_start_us: firstEnd,
        timeline_end_us: total,
        enabled: true,
      },
    ],
    operation_ids: [],
    zoom_ids: [],
    speed_ids: [],
    created_at: input.createdAt,
  };
  return {
    schema_version: "1.1",
    project: {
      schema_version: "1.0",
      project_id: input.projectId,
      name: input.name,
      created_at: input.createdAt,
      updated_at: input.createdAt,
      workflow_step: "record_import",
      current_revision_id: input.revisionId,
      source_ids: [first.source.source_id, second.source.source_id],
      codex_thread_id: null,
      storage: {
        project_root: input.projectRoot,
        autosave_enabled: true,
        source_policy: "managed_copy",
      },
    },
    sources: [first.source, second.source],
    source_probes: [first.probe, second.probe],
    source_timings: [first.timing, second.timing],
    timeline,
    revision: {
      schema_version: "1.0",
      revision_id: input.revisionId,
      project_id: input.projectId,
      parent_revision_id: null,
      created_at: input.createdAt,
      created_by: "import",
      timeline_sha256: timelineSha256(timeline),
      operation_ids: [],
      summary: "Imported two-source baseline",
      locked: true,
      qa_status: "not_run",
      export_ids: [],
    },
  };
}

/** Strict 1.1 baseline subset; normal edit transactions validate the active draft. */
export function assertTwoSourceInitialProjectSnapshot(
  value: unknown,
): asserts value is TwoSourceInitialProjectSnapshot {
  record(value);
  record(value.project);
  record(value.timeline);
  record(value.revision);
  record(value.project.storage);
  if (
    !Array.isArray(value.sources) ||
    value.sources.length !== 2 ||
    !Array.isArray(value.source_probes) ||
    value.source_probes.length !== 2 ||
    !Array.isArray(value.source_timings) ||
    value.source_timings.length !== 2
  )
    invalid();
  const [source1, source2] = value.sources;
  record(source1);
  record(source2);
  const expected = createTwoSourceInitialProject({
    projectId: value.project.project_id as string,
    timelineId: value.timeline.timeline_id as string,
    revisionId: value.revision.revision_id as string,
    name: value.project.name as string,
    createdAt: value.project.created_at as string,
    projectRoot: value.project.storage.project_root as string,
    sources: [
      {
        sourceId: source1.source_id as string,
        originalPath: source1.original_path as string,
        managedPath: source1.managed_path as string,
        sha256: source1.sha256 as string,
        sizeBytes: source1.size_bytes as number,
        probe: value.source_probes[0] as Record<string, unknown>,
        timing: value.source_timings[0] as TwoSourceTimingEvidence,
      },
      {
        sourceId: source2.source_id as string,
        originalPath: source2.original_path as string,
        managedPath: source2.managed_path as string,
        sha256: source2.sha256 as string,
        sizeBytes: source2.size_bytes as number,
        probe: value.source_probes[1] as Record<string, unknown>,
        timing: value.source_timings[1] as TwoSourceTimingEvidence,
      },
    ],
  });
  if (!projectStages.includes(value.project.workflow_step as ProjectStage))
    invalid();
  timestamp(value.project.updated_at);
  if (
    Date.parse(value.project.updated_at) <
    Date.parse(expected.project.created_at)
  )
    invalid();
  expected.project.workflow_step = value.project.workflow_step as ProjectStage;
  expected.project.updated_at = value.project.updated_at;
  if (projectCanonicalJson(value) !== projectCanonicalJson(expected)) invalid();
}

/**
 * Sound layers: music and sound effects mixed under (or over) the edit's own
 * audio. A layer plays a stretch of one of the project's audio files, placed
 * either at an output time (a music bed that starts with the video) or at a
 * source moment (an effect that follows cuts, like a graphic).
 *
 * The audio files themselves are project assets (`SoundAsset`): copied into
 * the project, hashed and never changed. A layer names an asset by id and
 * hash, so a draft stays self-verifying and the export refuses a file whose
 * bytes changed.
 */
import { graphicAnchor } from "./graphics.ts";
import { viewTimelineAt } from "./speed.ts";

export type SoundKind = "music" | "effect";

export type SoundStart =
  /** A fixed output time: a music bed that does not move with cuts. */
  | { type: "output"; start_us: number }
  /** A source moment: the layer follows later cuts. Cut away, it is silent. */
  | { type: "source"; source_id: string; source_us: number };

export interface SoundLayer {
  sound_id: string;
  /** Short label, e.g. "Intro music". */
  name: string;
  kind: SoundKind;
  asset_id: string;
  asset_sha256: string;
  /** Where in the audio file the layer starts playing. */
  asset_start_us: number;
  /** How long it plays in output time; the file repeats when `loop` is set. */
  duration_us: number;
  start: SoundStart;
  /** Level in whole dB relative to the file (0 = unchanged). */
  gain_db: number;
  fade_in_us: number;
  fade_out_us: number;
  /** Whole dB the layer is lowered while the edit's own speech plays; 0 = never. */
  duck_db: number;
  /** Repeat the file to fill the duration instead of ending with it. */
  loop: boolean;
}

/** An audio file of the project, usable by sound layers. */
export interface SoundAsset {
  asset_id: string;
  /** The original file name, for display. */
  name: string;
  sha256: string;
  duration_us: number;
  sample_rate: number;
  channels: number;
  size_bytes: number;
}

export const soundLimits = Object.freeze({
  maxSounds: 64,
  maxAssets: 256,
  maxNameChars: 80,
  minDurationUs: 50_000,
  maxDurationUs: 14_400_000_000,
  minGainDb: -60,
  maxGainDb: 12,
  maxDuckDb: 30,
  maxFileBytes: 512 * 1024 * 1024,
  maxAssetDurationUs: 14_400_000_000,
});

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const soundKeys = [
  "sound_id",
  "name",
  "kind",
  "asset_id",
  "asset_sha256",
  "asset_start_us",
  "duration_us",
  "start",
  "gain_db",
  "fade_in_us",
  "fade_out_us",
  "duck_db",
  "loop",
] as const;

function invalid(): never {
  throw new Error("Invalid sound.");
}

function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    invalid();
  return value;
}

function plain(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value as Record<string, unknown>;
}

function label(value: unknown): void {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    [...value].length > soundLimits.maxNameChars ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    invalid();
}

export function assertSoundAsset(value: unknown): asserts value is SoundAsset {
  const asset = plain(value, [
    "asset_id",
    "name",
    "sha256",
    "duration_us",
    "sample_rate",
    "channels",
    "size_bytes",
  ]);
  if (
    typeof asset.asset_id !== "string" ||
    !idPattern.test(asset.asset_id) ||
    typeof asset.sha256 !== "string" ||
    !hashPattern.test(asset.sha256)
  )
    invalid();
  label(asset.name);
  integer(asset.duration_us, 1, soundLimits.maxAssetDurationUs);
  integer(asset.sample_rate, 8_000, 384_000);
  integer(asset.channels, 1, 8);
  integer(asset.size_bytes, 1, soundLimits.maxFileBytes);
}

export function assertSoundLayer(value: unknown): asserts value is SoundLayer {
  const sound = plain(value, soundKeys);
  if (
    typeof sound.sound_id !== "string" ||
    !idPattern.test(sound.sound_id) ||
    (sound.kind !== "music" && sound.kind !== "effect") ||
    typeof sound.asset_id !== "string" ||
    !idPattern.test(sound.asset_id) ||
    typeof sound.asset_sha256 !== "string" ||
    !hashPattern.test(sound.asset_sha256) ||
    typeof sound.loop !== "boolean"
  )
    invalid();
  label(sound.name);
  integer(sound.asset_start_us, 0, soundLimits.maxAssetDurationUs);
  const duration = integer(
    sound.duration_us,
    soundLimits.minDurationUs,
    soundLimits.maxDurationUs,
  );
  integer(sound.gain_db, soundLimits.minGainDb, soundLimits.maxGainDb);
  integer(sound.duck_db, 0, soundLimits.maxDuckDb);
  const fadeIn = integer(sound.fade_in_us, 0, duration);
  const fadeOut = integer(sound.fade_out_us, 0, duration);
  if (fadeIn + fadeOut > duration) invalid();
  const start = sound.start;
  if (start === null || typeof start !== "object" || Array.isArray(start))
    invalid();
  const where = start as Record<string, unknown>;
  if (where.type === "output") {
    plain(where, ["type", "start_us"]);
    integer(where.start_us, 0, soundLimits.maxDurationUs);
  } else if (where.type === "source") {
    plain(where, ["type", "source_id", "source_us"]);
    if (typeof where.source_id !== "string" || !idPattern.test(where.source_id))
      invalid();
    integer(where.source_us, 0, Number.MAX_SAFE_INTEGER);
  } else invalid();
}

/**
 * Sound layers of a draft: valid, unique ids, and a source anchor inside its
 * source. (Whether the asset exists is checked where the project's assets are
 * known: when a layer is set and when the draft is exported.)
 */
export function assertSoundLayers(
  value: unknown,
  sources: readonly {
    source_id: string;
    source_start_us: number;
    source_end_us: number;
  }[],
): asserts value is SoundLayer[] {
  if (!Array.isArray(value) || value.length > soundLimits.maxSounds) invalid();
  const ids = new Set<string>();
  for (const sound of value) {
    assertSoundLayer(sound);
    if (sound.start.type === "source") {
      const anchor = sound.start;
      const source = sources.find(
        (item) => item.source_id === anchor.source_id,
      );
      if (
        !source ||
        anchor.source_us < source.source_start_us ||
        anchor.source_us >= source.source_end_us
      )
        invalid();
    }
    if (ids.has(sound.sound_id)) invalid();
    ids.add(sound.sound_id);
  }
}

export interface SoundClip {
  sourceId: string;
  timelineStartUs: number;
  timelineEndUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
  speed?: number;
}

/** A sound layer placed in output time. */
export interface SoundInterval {
  soundId: string;
  name: string;
  kind: SoundKind;
  assetId: string;
  assetSha256: string;
  assetStartUs: number;
  startUs: number;
  endUs: number;
  gainDb: number;
  /** Fades are measured from the layer's start and end as played. */
  fadeInUs: number;
  fadeOutUs: number;
  duckDb: number;
  loop: boolean;
}

/**
 * Where each layer plays in the edit. A layer anchored to a source moment
 * that was cut away is not heard; every layer ends at the end of the edit at
 * the latest, and its fades are shortened to fit what actually plays.
 */
export function soundIntervals(
  sounds: readonly SoundLayer[],
  clips: readonly SoundClip[],
  durationUs: number,
): SoundInterval[] {
  const placed: SoundInterval[] = [];
  for (const sound of sounds) {
    let startUs: number;
    if (sound.start.type === "output") startUs = sound.start.start_us;
    else {
      const anchor = sound.start;
      const clip = clips.find(
        (item) =>
          item.sourceId === anchor.source_id &&
          anchor.source_us >= item.sourceStartUs &&
          anchor.source_us < item.sourceEndUs,
      );
      if (!clip) continue;
      startUs = Math.min(
        clip.timelineEndUs - 1,
        viewTimelineAt(clip, anchor.source_us),
      );
    }
    const endUs = Math.min(durationUs, startUs + sound.duration_us);
    if (startUs < 0 || endUs <= startUs) continue;
    const played = endUs - startUs;
    const fadeInUs = Math.min(sound.fade_in_us, played);
    placed.push({
      soundId: sound.sound_id,
      name: sound.name,
      kind: sound.kind,
      assetId: sound.asset_id,
      assetSha256: sound.asset_sha256,
      assetStartUs: sound.asset_start_us,
      startUs,
      endUs,
      gainDb: sound.gain_db,
      fadeInUs,
      fadeOutUs: Math.min(sound.fade_out_us, played - fadeInUs),
      duckDb: sound.duck_db,
      loop: sound.loop,
    });
  }
  return placed.sort(
    (a, b) => a.startUs - b.startUs || a.soundId.localeCompare(b.soundId),
  );
}

/** The linear gain of a level in dB. */
export function linearGain(db: number): number {
  return 10 ** (db / 20);
}

/** A request for a layer is not usable; the message says what to change. */
export class SoundBuildError extends Error {}

export interface SoundLayerRequest {
  /** The existing layer to replace; omitted for a new one. */
  soundId?: string;
  name: string;
  kind: SoundKind;
  asset: SoundAsset;
  /** Output time the layer starts at (or, for a cut-following one, the moment shown there). */
  startUs: number;
  followsCuts?: boolean | undefined;
  assetStartUs?: number | undefined;
  durationUs?: number | undefined;
  gainDb?: number | undefined;
  fadeInUs?: number | undefined;
  fadeOutUs?: number | undefined;
  duckDb?: number | undefined;
  loop?: boolean | undefined;
}

/**
 * A valid layer from a request, with the defaults every route shares. Music
 * is a bed: it starts at an output time, repeats to the end of the edit, sits
 * at -18 dB, fades in and out and lowers 12 dB under speech. An effect is a
 * short sound at a moment: anchored to the source moment shown there so it
 * follows later cuts, played once at -6 dB, never ducked.
 */
export function buildSoundLayer(
  request: SoundLayerRequest,
  timeline: {
    duration_us: number;
    clips: Parameters<typeof graphicAnchor>[0];
  },
  newId: () => string,
): SoundLayer {
  const music = request.kind === "music";
  const assetStart = request.assetStartUs ?? 0;
  if (assetStart >= request.asset.duration_us)
    throw new SoundBuildError(
      "asset_start_us is past the end of that audio file.",
    );
  const loop = request.loop ?? music;
  const remaining = Math.max(0, timeline.duration_us - request.startUs);
  const duration =
    request.durationUs ??
    (loop
      ? remaining
      : Math.min(
          remaining,
          Math.max(0, request.asset.duration_us - assetStart),
        ));
  let start: SoundStart;
  if (request.followsCuts ?? !music) {
    const anchor = graphicAnchor(timeline.clips, request.startUs);
    if (!anchor) throw new SoundBuildError("start_us is outside the edit.");
    start = {
      type: "source",
      source_id: anchor.source_id,
      source_us: anchor.source_us,
    };
  } else {
    if (request.startUs >= timeline.duration_us)
      throw new SoundBuildError("start_us is outside the edit.");
    start = { type: "output", start_us: request.startUs };
  }
  const layer: SoundLayer = {
    sound_id: request.soundId ?? newId(),
    name: request.name.trim(),
    kind: request.kind,
    asset_id: request.asset.asset_id,
    asset_sha256: request.asset.sha256,
    asset_start_us: assetStart,
    duration_us: duration,
    start,
    gain_db: request.gainDb ?? (music ? -18 : -6),
    fade_in_us: request.fadeInUs ?? (music ? 1_000_000 : 0),
    fade_out_us: request.fadeOutUs ?? (music ? 2_000_000 : 0),
    duck_db: request.duckDb ?? (music ? 12 : 0),
    loop,
  };
  // Fades may not outlast a short layer: shorten them, never refuse.
  layer.fade_in_us = Math.min(layer.fade_in_us, Math.floor(duration / 2));
  layer.fade_out_us = Math.min(layer.fade_out_us, duration - layer.fade_in_us);
  try {
    assertSoundLayer(layer);
  } catch {
    throw new SoundBuildError(
      `Check the values: gain_db ${soundLimits.minGainDb} to ${soundLimits.maxGainDb}, duck_db 0 to ${soundLimits.maxDuckDb}, duration_us ${soundLimits.minDurationUs} or more, asset_start_us inside the file, a name of 1 to ${soundLimits.maxNameChars} characters.`,
    );
  }
  return layer;
}

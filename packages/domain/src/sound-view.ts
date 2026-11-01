/**
 * What the Sound card shows and the requests it makes. Audio files stay in the
 * project; no file path crosses this boundary (the file is chosen in a
 * dialog owned by the main process).
 */
import { soundLimits, type SoundKind } from "./sounds.ts";

export interface SoundLayerView {
  sound_id: string;
  name: string;
  kind: SoundKind;
  /** The audio file's original name. */
  file_name: string;
  asset_id: string;
  asset_start_us: number;
  fade_in_us: number;
  fade_out_us: number;
  gain_db: number;
  duck_db: number;
  loop: boolean;
  /** Where the layer plays in the edit; null when its moment was cut away. */
  timeline_range: { start_us: number; end_us: number } | null;
}

export interface SoundsView {
  schema_version: "1.0";
  project_id: string;
  layers: SoundLayerView[];
}

export interface SoundsRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface SoundAddRequest extends SoundsRequest {
  kind: SoundKind;
  /** Output time to start at; music beds are normally added at 0. */
  start_us: number;
}

export interface SoundUpdateRequest extends SoundsRequest {
  sound_id: string;
  gain_db: number;
  duck_db: number;
}

export interface SoundRemoveRequest extends SoundsRequest {
  sound_id: string;
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalid(): never {
  throw new Error("Invalid sound exchange.");
}

function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
  return value as Record<string, unknown>;
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

function head(request: Record<string, unknown>): void {
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !projectIdPattern.test(request.project_id)
  )
    invalid();
}

export function assertSoundsRequest(
  value: unknown,
): asserts value is SoundsRequest {
  head(exact(value, ["schema_version", "project_id"]));
}

export function assertSoundAddRequest(
  value: unknown,
): asserts value is SoundAddRequest {
  const request = exact(value, [
    "schema_version",
    "project_id",
    "kind",
    "start_us",
  ]);
  head(request);
  if (request.kind !== "music" && request.kind !== "effect") invalid();
  integer(request.start_us, 0, soundLimits.maxDurationUs);
}

export function assertSoundUpdateRequest(
  value: unknown,
): asserts value is SoundUpdateRequest {
  const request = exact(value, [
    "schema_version",
    "project_id",
    "sound_id",
    "gain_db",
    "duck_db",
  ]);
  head(request);
  if (typeof request.sound_id !== "string" || !idPattern.test(request.sound_id))
    invalid();
  integer(request.gain_db, soundLimits.minGainDb, soundLimits.maxGainDb);
  integer(request.duck_db, 0, soundLimits.maxDuckDb);
}

export function assertSoundRemoveRequest(
  value: unknown,
): asserts value is SoundRemoveRequest {
  const request = exact(value, ["schema_version", "project_id", "sound_id"]);
  head(request);
  if (typeof request.sound_id !== "string" || !idPattern.test(request.sound_id))
    invalid();
}

export function assertSoundsView(value: unknown): asserts value is SoundsView {
  const view = exact(value, ["schema_version", "project_id", "layers"]);
  head(view);
  if (!Array.isArray(view.layers) || view.layers.length > soundLimits.maxSounds)
    invalid();
  for (const item of view.layers) {
    const layer = exact(item, [
      "sound_id",
      "name",
      "kind",
      "file_name",
      "asset_id",
      "asset_start_us",
      "fade_in_us",
      "fade_out_us",
      "gain_db",
      "duck_db",
      "loop",
      "timeline_range",
    ]);
    if (
      typeof layer.sound_id !== "string" ||
      !idPattern.test(layer.sound_id) ||
      typeof layer.name !== "string" ||
      layer.name.length > 400 ||
      (layer.kind !== "music" && layer.kind !== "effect") ||
      typeof layer.file_name !== "string" ||
      layer.file_name.length > 400 ||
      typeof layer.asset_id !== "string" ||
      !idPattern.test(layer.asset_id) ||
      typeof layer.loop !== "boolean"
    )
      invalid();
    integer(layer.asset_start_us, 0, soundLimits.maxAssetDurationUs);
    integer(layer.fade_in_us, 0, soundLimits.maxDurationUs);
    integer(layer.fade_out_us, 0, soundLimits.maxDurationUs);
    integer(layer.gain_db, soundLimits.minGainDb, soundLimits.maxGainDb);
    integer(layer.duck_db, 0, soundLimits.maxDuckDb);
    if (layer.timeline_range !== null) {
      const range = exact(layer.timeline_range, ["start_us", "end_us"]);
      const start = integer(range.start_us, 0, soundLimits.maxDurationUs);
      const end = integer(range.end_us, 0, soundLimits.maxDurationUs);
      if (end <= start) invalid();
    }
  }
}

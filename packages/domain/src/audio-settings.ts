/** Per-project audio cleanup applied when exporting (not to sources). */
export interface AudioSettings {
  /** Two-pass loudness normalisation to -16 LUFS with a -1.5 dBTP ceiling. */
  normalize: boolean;
  /** FFmpeg's spectral noise reduction for steady background noise. */
  denoise: boolean;
}

export const defaultAudioSettings: AudioSettings = Object.freeze({
  normalize: false,
  denoise: false,
});

export interface AudioSettingsRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface AudioSettingsUpdate extends AudioSettingsRequest {
  settings: AudioSettings;
}

/** Loudness target for normalisation; common for spoken online video. */
export const loudnessTarget = Object.freeze({
  integratedLufs: -16,
  truePeakDb: -1.5,
  range: 11,
});

const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

function invalid(): never {
  throw new Error("Invalid audio settings exchange.");
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

export function assertAudioSettings(
  value: unknown,
): asserts value is AudioSettings {
  const settings = exact(value, ["normalize", "denoise"]);
  if (
    typeof settings.normalize !== "boolean" ||
    typeof settings.denoise !== "boolean"
  )
    invalid();
}

export function assertAudioSettingsRequest(
  value: unknown,
): asserts value is AudioSettingsRequest {
  const request = exact(value, ["schema_version", "project_id"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !projectIdPattern.test(request.project_id)
  )
    invalid();
}

export function assertAudioSettingsUpdate(
  value: unknown,
): asserts value is AudioSettingsUpdate {
  const request = exact(value, ["schema_version", "project_id", "settings"]);
  assertAudioSettingsRequest({
    schema_version: request.schema_version,
    project_id: request.project_id,
  });
  assertAudioSettings(request.settings);
}

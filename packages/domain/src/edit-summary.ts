import { clipSpeed } from "./speed.ts";
import type {
  DraftEditIntent,
  DraftState,
  DraftTimeline,
  DraftTransactionRecord,
} from "./draft-transaction.ts";

/**
 * "What Magic Edit did" (ADR 0031): one plain row per kind of change the AI
 * made, built from the draft's own transaction records.
 *
 * Draft transactions can be undone only newest first, and an effect
 * transaction carries one operation, so a single older item cannot be
 * undone safely. A row therefore undoes its whole kind: one ordinary
 * transaction per item, committed after the rest and undoable like any
 * other, and then offers Put back, which undoes exactly those entries.
 */
export const editSummaryKinds = [
  "cuts",
  "zooms",
  "graphics",
  "captions",
  "music",
  "effects",
  "speed",
  "transitions",
  "camera",
  "sound",
] as const;
export type EditSummaryKind = (typeof editSummaryKinds)[number];

export interface EditSummaryRow {
  kind: EditSummaryKind;
  /** One plain line, such as "Cut 14 parts" or "5 zooms". */
  label: string;
  count: number;
}

export interface EditSummaryView {
  projectId: string;
  draftSequence: number;
  rows: EditSummaryRow[];
  /** The newest undo of a whole kind, still on top of the history. */
  putBack: { kind: EditSummaryKind; label: string } | null;
}

export interface EditSummaryProjectRequest {
  schema_version: "1.0";
  project_id: string;
}

export interface EditSummaryUndoRequest extends EditSummaryProjectRequest {
  kind: EditSummaryKind;
}

/** Prefix of the pass groups made by an undo of a whole kind. */
export const editSummaryGroupPrefix = "edit-summary-";

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export function editSummaryLabel(kind: EditSummaryKind, count: number): string {
  switch (kind) {
    case "cuts":
      return `Cut ${plural(count, "part", "parts")}`;
    case "zooms":
      return plural(count, "zoom", "zooms");
    case "graphics":
      return plural(count, "graphic", "graphics");
    case "captions":
      return "Captions on";
    case "music":
      return "Music added";
    case "effects":
      return plural(count, "sound effect", "sound effects");
    case "speed":
      return `${plural(count, "part", "parts")} sped up`;
    case "transitions":
      return plural(count, "transition", "transitions");
    case "camera":
      return plural(count, "camera change", "camera changes");
    case "sound":
      return "Sound cleaned up";
  }
}

/** What a row says once its kind has been undone. */
export function editSummaryUndoneLabel(
  kind: EditSummaryKind,
  count: number,
): string {
  switch (kind) {
    case "cuts":
      return `${plural(count, "part", "parts")} put back`;
    case "zooms":
      return `${plural(count, "zoom", "zooms")} removed`;
    case "graphics":
      return `${plural(count, "graphic", "graphics")} removed`;
    case "captions":
      return "Captions off";
    case "music":
      return "Music removed";
    case "effects":
      return `${plural(count, "sound effect", "sound effects")} removed`;
    case "speed":
      return "Normal speed restored";
    case "transitions":
      return `${plural(count, "transition", "transitions")} removed`;
    case "camera":
      return "Camera changes removed";
    case "sound":
      return "Sound back to the original";
  }
}

/** One step of an undo: a draft intent and the reason recorded with it. */
export interface EditSummaryStep {
  intent: DraftEditIntent;
  reason: string;
}

export interface EditSummaryPlan {
  rows: EditSummaryRow[];
  /** The steps that undo each listed kind, in the order to commit them. */
  steps: Partial<Record<EditSummaryKind, EditSummaryStep[]>>;
}

interface Interval {
  start: number;
  end: number;
}
type Coverage = Map<string, Interval[]>;

function merged(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((item) => item.start < item.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: Interval[] = [];
  for (const item of sorted) {
    const last = result.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else result.push({ ...item });
  }
  return result;
}

function coverage(clips: DraftTimeline["clips"]): Coverage {
  const map: Coverage = new Map();
  for (const clip of clips) {
    const list = map.get(clip.source_id) ?? [];
    list.push({ start: clip.source_start_us, end: clip.source_end_us });
    map.set(clip.source_id, list);
  }
  for (const [key, list] of map) map.set(key, merged(list));
  return map;
}

/** The parts of `whole` that `taken` does not cover. */
function subtract(whole: Interval[], taken: Interval[]): Interval[] {
  let rest = merged(whole);
  for (const hole of merged(taken)) {
    const next: Interval[] = [];
    for (const piece of rest) {
      if (hole.end <= piece.start || hole.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (hole.start > piece.start)
        next.push({ start: piece.start, end: hole.start });
      if (hole.end < piece.end) next.push({ start: hole.end, end: piece.end });
    }
    rest = next;
  }
  return rest;
}

/**
 * Plans the rows and the undo steps from the applied transactions (oldest
 * first) and the draft they lead to. Only what an AI connection did and what
 * is still in the draft is listed; manual edits never are.
 */
export function planEditSummary(
  records: readonly DraftTransactionRecord[],
  state: DraftState,
): EditSummaryPlan {
  const timeline = state.timeline;
  const added = {
    zoom: new Set<string>(),
    graphic: new Set<string>(),
    transition: new Set<string>(),
    layout: new Set<string>(),
    sound: new Set<string>(),
  };
  let aiCaptions = false;
  let aiAudio = false;
  let audioBefore: { normalize: boolean; denoise: boolean } | null = null;
  let aiSpeed = false;
  const removed: Coverage = new Map();
  const addRemoved = (sourceId: string, intervals: Interval[]) => {
    if (intervals.length === 0) return;
    removed.set(sourceId, [...(removed.get(sourceId) ?? []), ...intervals]);
  };
  for (const record of records) {
    if (record.kind !== "apply" || record.origin === "manual") continue;
    for (const operation of record.operations) {
      switch (operation.operation_type) {
        case "zoom":
          if (operation.action === "set") added.zoom.add(operation.zoom_id);
          break;
        case "graphic":
          if (operation.action === "set")
            added.graphic.add(operation.graphic_id);
          break;
        case "transition":
          if (operation.action === "set")
            added.transition.add(operation.transition_id);
          break;
        case "layout":
          if (operation.action === "set") added.layout.add(operation.layout_id);
          break;
        case "sound":
          if (operation.action === "set") added.sound.add(operation.sound_id);
          break;
        case "captions":
          if (operation.after.enabled) aiCaptions = true;
          break;
        case "audio":
          // The earliest AI audio change says what the sound was before.
          if (!aiAudio) {
            aiAudio = true;
            audioBefore = operation.before;
          }
          break;
        case "speed":
          aiSpeed = true;
          break;
        case "ripple_delete":
        case "transcript_cut": {
          const before = coverage(operation.before);
          const after = coverage(operation.after);
          for (const [sourceId, list] of before)
            addRemoved(sourceId, subtract(list, after.get(sourceId) ?? []));
          break;
        }
        case "trim": {
          const before = coverage([operation.before]);
          const after = coverage([operation.after]);
          for (const [sourceId, list] of before)
            addRemoved(sourceId, subtract(list, after.get(sourceId) ?? []));
          break;
        }
        default:
          break;
      }
    }
  }

  const rows: EditSummaryRow[] = [];
  const steps: EditSummaryPlan["steps"] = {};
  const push = (
    kind: EditSummaryKind,
    count: number,
    plan: EditSummaryStep[],
  ) => {
    if (count <= 0) return;
    rows.push({ kind, label: editSummaryLabel(kind, count), count });
    steps[kind] = plan;
  };

  // Cuts: what an AI removed and the draft still lacks, as whole pieces.
  const visible = coverage(timeline.clips);
  const cutSteps: EditSummaryStep[] = [];
  for (const [sourceId, list] of removed)
    for (const piece of subtract(merged(list), visible.get(sourceId) ?? []))
      cutSteps.push({
        intent: {
          type: "restore_range",
          source_id: sourceId,
          source_start_us: piece.start,
          source_end_us: piece.end,
        },
        reason: "Put a cut part back.",
      });
  push("cuts", cutSteps.length, cutSteps);

  const present = <T>(
    list: T[] | undefined,
    id: (item: T) => string,
    ids: Set<string>,
  ) => (list ?? []).filter((item) => ids.has(id(item)));

  const zooms = present(timeline.zooms, (item) => item.zoom_id, added.zoom);
  push(
    "zooms",
    zooms.length,
    zooms.map((item) => ({
      intent: { type: "remove_zoom", zoom_id: item.zoom_id },
      reason: "Remove a zoom.",
    })),
  );
  const graphics = present(
    timeline.graphics,
    (item) => item.graphic_id,
    added.graphic,
  );
  push(
    "graphics",
    graphics.length,
    graphics.map((item) => ({
      intent: { type: "remove_graphic", graphic_id: item.graphic_id },
      reason: "Remove a graphic.",
    })),
  );
  if (aiCaptions && timeline.captions?.enabled)
    push("captions", 1, [
      {
        intent: {
          type: "set_captions",
          captions: { ...timeline.captions, enabled: false },
        },
        reason: "Turn captions off.",
      },
    ]);
  const sounds = present(timeline.sounds, (item) => item.sound_id, added.sound);
  const sound = (kind: "music" | "effect") =>
    sounds
      .filter((item) => item.kind === kind)
      .map((item) => ({
        intent: { type: "remove_sound", sound_id: item.sound_id } as const,
        reason: "Remove a sound.",
      }));
  const music = sound("music");
  push("music", music.length, music);
  const effects = sound("effect");
  push("effects", effects.length, effects);
  const transitions = present(
    timeline.transitions,
    (item) => item.transition_id,
    added.transition,
  );
  push(
    "transitions",
    transitions.length,
    transitions.map((item) => ({
      intent: { type: "remove_transition", transition_id: item.transition_id },
      reason: "Remove a transition.",
    })),
  );
  const layouts = present(
    timeline.layouts,
    (item) => item.layout_id,
    added.layout,
  );
  push(
    "camera",
    layouts.length,
    layouts.map((item) => ({
      intent: { type: "remove_layout", layout_id: item.layout_id },
      reason: "Remove a camera change.",
    })),
  );
  if (aiSpeed) {
    const runs: Interval[] = [];
    for (const clip of timeline.clips) {
      if (clipSpeed(clip) <= 1) continue;
      const last = runs.at(-1);
      if (last && last.end === clip.timeline_start_us)
        last.end = clip.timeline_end_us;
      else
        runs.push({ start: clip.timeline_start_us, end: clip.timeline_end_us });
    }
    push(
      "speed",
      runs.length,
      runs.map((run) => ({
        intent: {
          type: "set_speed",
          start_us: run.start,
          end_us: run.end,
          speed: 1,
        },
        reason: "Back to normal speed.",
      })),
    );
  }
  if (
    aiAudio &&
    timeline.audio &&
    (timeline.audio.normalize || timeline.audio.denoise)
  ) {
    const previous = audioBefore ?? { normalize: false, denoise: false };
    push("sound", 1, [
      {
        intent: {
          type: "set_audio",
          audio: {
            normalize: previous.normalize,
            denoise: previous.denoise,
          },
        },
        reason: "Put the sound back.",
      },
    ]);
  }
  return { rows, steps };
}

/**
 * The newest transactions that were one undo of a whole kind, if they are
 * still the newest: the kind and how many entries to undo to put it back.
 */
export function newestKindUndo(
  records: readonly DraftTransactionRecord[],
): { kind: EditSummaryKind; entries: number } | null {
  const newest = records.at(-1);
  const group = newest?.pass_group?.pass_group_id;
  if (!newest || !group?.startsWith(editSummaryGroupPrefix)) return null;
  const kind = group
    .slice(editSummaryGroupPrefix.length)
    .split("-", 1)[0] as EditSummaryKind;
  if (!editSummaryKinds.includes(kind)) return null;
  let entries = 0;
  for (let index = records.length - 1; index >= 0; index--) {
    if (records[index]!.pass_group?.pass_group_id !== group) break;
    entries++;
  }
  return { kind, entries };
}

function invalid(): never {
  throw new Error("Invalid edit summary exchange.");
}

function exact(
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

const projectIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;

export function assertEditSummaryProjectRequest(
  value: unknown,
): asserts value is EditSummaryProjectRequest {
  const request = exact(value, ["schema_version", "project_id"]);
  if (
    request.schema_version !== "1.0" ||
    typeof request.project_id !== "string" ||
    !projectIdPattern.test(request.project_id)
  )
    invalid();
}

export function assertEditSummaryUndoRequest(
  value: unknown,
): asserts value is EditSummaryUndoRequest {
  const request = exact(value, ["schema_version", "project_id", "kind"]);
  assertEditSummaryProjectRequest({
    schema_version: request.schema_version,
    project_id: request.project_id,
  });
  if (!editSummaryKinds.includes(request.kind as EditSummaryKind)) invalid();
}

export function assertEditSummaryView(
  value: unknown,
): asserts value is EditSummaryView {
  const view = exact(value, ["projectId", "draftSequence", "rows", "putBack"]);
  if (
    typeof view.projectId !== "string" ||
    !projectIdPattern.test(view.projectId) ||
    !Number.isSafeInteger(view.draftSequence) ||
    (view.draftSequence as number) < 0 ||
    !Array.isArray(view.rows) ||
    view.rows.length > editSummaryKinds.length
  )
    invalid();
  const seen = new Set<string>();
  for (const row of view.rows as unknown[]) {
    const item = exact(row, ["kind", "label", "count"]);
    if (
      !editSummaryKinds.includes(item.kind as EditSummaryKind) ||
      seen.has(item.kind as string) ||
      !Number.isSafeInteger(item.count) ||
      (item.count as number) < 1 ||
      item.label !==
        editSummaryLabel(item.kind as EditSummaryKind, item.count as number)
    )
      invalid();
    seen.add(item.kind as string);
  }
  if (view.putBack !== null) {
    const put = exact(view.putBack, ["kind", "label"]);
    if (
      !editSummaryKinds.includes(put.kind as EditSummaryKind) ||
      typeof put.label !== "string" ||
      put.label.length < 1 ||
      put.label.length > 80
    )
      invalid();
  }
}

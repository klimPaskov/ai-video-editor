import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LocalTranscript } from "../../../packages/domain/src/transcription.ts";

/**
 * The project workspace Claude works in (ADR 0021): the edit as readable
 * files, kept current by main, plus the app's guides. Claude's own notes live
 * next to them. Nothing here is source media or a path outside it.
 */

export interface WorkspaceClip {
  source_id: string;
  source_start_us: number;
  source_end_us: number;
  timeline_start_us: number;
  timeline_end_us: number;
  speed?: number;
}

export interface WorkspaceTimeline {
  duration_us: number;
  draft_sequence: number;
  clips: readonly WorkspaceClip[];
  [key: string]: unknown;
}

const seconds = (us: number) => (us / 1_000_000).toFixed(3);

/**
 * The edit's spoken words in timeline order: one line per transcript segment
 * piece that the edit keeps, with its edit time and its recording time.
 */
export function editedTranscript(
  timeline: WorkspaceTimeline,
  transcripts: readonly LocalTranscript[],
  sourceNames: ReadonlyMap<string, string>,
): string {
  const lines = [
    "# The edit, as spoken",
    "",
    "Each line: [edit start–end s] (recording, its own time start–end s) words. Edit times are the timeline (the cut tools use them in microseconds); recording times are what transcript.get_range uses. Updated after every change.",
    "",
  ];
  if (!transcripts.length) {
    lines.push("No transcript yet. Run Magic Edit or transcribe in Auto Edit.");
    return `${lines.join("\n")}\n`;
  }
  const bySource = new Map(transcripts.map((item) => [item.source_id, item]));
  for (const [index, clip] of timeline.clips.entries()) {
    const transcript = bySource.get(clip.source_id);
    const speed = clip.speed ?? 1;
    const name = sourceNames.get(clip.source_id) ?? clip.source_id;
    lines.push(
      `## Part ${index + 1} · edit ${seconds(clip.timeline_start_us)}–${seconds(clip.timeline_end_us)} s · ${name} ${seconds(clip.source_start_us)}–${seconds(clip.source_end_us)} s${speed > 1 ? ` · ${speed}× speed` : ""}`,
    );
    const toEdit = (us: number) =>
      clip.timeline_start_us + (us - clip.source_start_us) / speed;
    for (const segment of transcript?.segments ?? []) {
      const words = segment.words.filter(
        (word) =>
          word.start_us >= clip.source_start_us &&
          word.end_us <= clip.source_end_us,
      );
      if (!words.length) continue;
      const first = words[0]!;
      const last = words.at(-1)!;
      lines.push(
        `[${seconds(toEdit(first.start_us))}–${seconds(toEdit(last.end_us))}] (${seconds(first.start_us)}–${seconds(last.end_us)}) ${words
          .map((word) => word.text.trim())
          .join(" ")}`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/** Writes a file only when its content changed, atomically. */
async function put(path: string, content: string): Promise<void> {
  const next = createHash("sha256").update(content).digest("hex");
  try {
    const current = createHash("sha256")
      .update(await readFile(path, "utf8"))
      .digest("hex");
    if (current === next) return;
  } catch {
    // Missing: write it.
  }
  const temporary = `${path}.${next.slice(0, 12)}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

export interface WorkspaceContent {
  timeline: WorkspaceTimeline;
  project: unknown;
  transcripts: readonly LocalTranscript[];
  sourceNames: ReadonlyMap<string, string>;
  guides: Readonly<Record<string, string>>;
}

/** Brings the project workspace up to date with the committed draft. */
export async function writeClaudeWorkspace(
  directory: string,
  content: WorkspaceContent,
): Promise<void> {
  await mkdir(join(directory, "guides"), { recursive: true, mode: 0o700 });
  await put(
    join(directory, "edit.md"),
    editedTranscript(
      content.timeline,
      content.transcripts,
      content.sourceNames,
    ),
  );
  await put(
    join(directory, "timeline.json"),
    `${JSON.stringify(content.timeline, null, 1)}\n`,
  );
  await put(
    join(directory, "project.json"),
    `${JSON.stringify(content.project, null, 1)}\n`,
  );
  for (const [name, text] of Object.entries(content.guides))
    if (/^[a-z][a-z0-9-]{0,40}\.md$/u.test(name))
      await put(join(directory, "guides", name), text);
}

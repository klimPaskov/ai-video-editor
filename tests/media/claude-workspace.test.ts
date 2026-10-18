import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  editedTranscript,
  writeClaudeWorkspace,
} from "../../apps/desktop/src/claude-workspace.ts";
import {
  claudeAgents,
  claudeGuides,
} from "../../apps/desktop/src/claude-guides.ts";
import { claudeEditorTools } from "../../apps/desktop/src/claude.ts";
import { claudeBuiltInTools } from "../../packages/claude-bridge/src/turn.ts";
import type { LocalTranscript } from "../../packages/domain/src/transcription.ts";

const word = (id: string, text: string, start: number, end: number) => ({
  word_id: id,
  text,
  start_us: start,
  end_us: end,
});

const transcript = (sourceId: string, words: ReturnType<typeof word>[]) =>
  ({
    source_id: sourceId,
    segments: [
      {
        segment_id: `${sourceId}-s1`,
        start_us: words[0]!.start_us,
        end_us: words.at(-1)!.end_us,
        text: words.map((item) => item.text).join(" "),
        words,
      },
    ],
  }) as unknown as LocalTranscript;

test("edit.md lists the kept words in timeline order with both times", () => {
  const timeline = {
    duration_us: 5_000_000,
    draft_sequence: 3,
    clips: [
      // The second recording's opening, then the first recording's end.
      {
        source_id: "b",
        source_start_us: 0,
        source_end_us: 2_000_000,
        timeline_start_us: 0,
        timeline_end_us: 2_000_000,
      },
      {
        source_id: "a",
        source_start_us: 10_000_000,
        source_end_us: 16_000_000,
        timeline_start_us: 2_000_000,
        timeline_end_us: 5_000_000,
        speed: 2,
      },
    ],
  };
  const text = editedTranscript(
    timeline,
    [
      transcript("a", [
        word("a1", "cut", 1_000_000, 1_400_000),
        word("a2", "Kept", 11_000_000, 11_500_000),
        word("a3", "words", 12_000_000, 12_400_000),
      ]),
      transcript("b", [
        word("b1", "Hello", 100_000, 500_000),
        word("b2", "later", 2_500_000, 2_900_000),
      ]),
    ],
    new Map([
      ["a", "recording 1"],
      ["b", "recording 2"],
    ]),
  );
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.startsWith("## Part 1"));
  assert.match(
    lines[first]!,
    /edit 0\.000–2\.000 s · recording 2 0\.000–2\.000 s/u,
  );
  assert.equal(lines[first + 1], "[0.100–0.500] (0.100–0.500) Hello");
  const second = lines.findIndex((line) => line.startsWith("## Part 2"));
  assert.match(lines[second]!, /recording 1 10\.000–16\.000 s · 2× speed/u);
  // Edit time of a sped-up part runs at half the recording's pace.
  assert.equal(lines[second + 1], "[2.500–3.200] (11.000–12.400) Kept words");
  // Words outside the kept ranges never appear.
  assert.doesNotMatch(
    lines.filter((line) => line.startsWith("[")).join("\n"),
    /\bcut\b|\blater\b/u,
  );
  assert.match(editedTranscript(timeline, [], new Map()), /No transcript yet/u);
});

test("the workspace holds the edit, the guides and nothing outside it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-workspace-"));
  try {
    await writeClaudeWorkspace(directory, {
      timeline: { duration_us: 1, draft_sequence: 0, clips: [] },
      project: { name: "Demo" },
      transcripts: [],
      sourceNames: new Map(),
      guides: { ...claudeGuides, "../escape.md": "no" },
    });
    assert.deepEqual((await readdir(directory)).sort(), [
      "edit.md",
      "guides",
      "project.json",
      "timeline.json",
    ]);
    assert.deepEqual((await readdir(join(directory, "guides"))).sort(), [
      "motion-design.md",
      "production.md",
      "story-edit.md",
    ]);
    assert.match(
      await readFile(join(directory, "guides", "story-edit.md"), "utf8"),
      /Rough cut playbook/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("helpers use only tools the turn itself has, and never edit", () => {
  const available = new Set<string>([
    ...claudeEditorTools,
    ...claudeBuiltInTools,
  ]);
  for (const [name, agent] of Object.entries(claudeAgents)) {
    for (const tool of agent.tools)
      assert.ok(available.has(tool), `${name}: ${tool}`);
    for (const tool of agent.tools)
      assert.doesNotMatch(
        tool,
        /cut_|zoom_|speed_|graphics_|captions_|audio_|undo|Write|Edit/u,
      );
  }
});

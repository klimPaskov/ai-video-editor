import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CaptionWord } from "../../packages/domain/src/captions.ts";
import { shortIssues } from "../../packages/domain/src/short-clips-view.ts";
import {
  DesktopShortClips,
  ShortClipError,
  type DraftWords,
  type ShortClipsOptions,
} from "../../apps/desktop/src/short-clips.ts";

const project = "project-short-1";

/** A monologue of about 100 s: eleven-word sentences, one word every 0.4 s. */
function monologue(): CaptionWord[] {
  const words: CaptionWord[] = [];
  let at = 0;
  for (let sentence = 0; sentence < 22; sentence++) {
    const text = "Here is how to record a clean demo of your app in minutes.";
    for (const token of text.split(" ")) {
      words.push({ text: token, startUs: at, endUs: at + 350_000 });
      at += 400_000;
    }
    at += 300_000;
  }
  return words;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "short-clips-"));
  const state = {
    words: monologue() as CaptionWord[] | null,
    sequence: 3,
    sha: "a".repeat(64),
    picking: false,
    started: 0,
    startFails: null as string | null,
    revealed: [] as string[],
  };
  const options: ShortClipsOptions = {
    root: join(root, "shorts"),
    drafts: {
      snapshotWithProject: async () => {
        throw new Error("not used");
      },
    },
    draftWords: async (): Promise<DraftWords> => ({
      words: state.words,
      sequence: state.sequence,
      timelineSha256: state.sha,
    }),
    captionSettings: async () => {
      throw new Error("not used");
    },
    audioSettings: async () => {
      throw new Error("not used");
    },
    defaultDirectory: () => root,
    chooseDestination: async () => null,
    chooseFolder: async () => null,
    reveal: (file) => state.revealed.push(file),
    pickRunning: () => state.picking,
    startPick: async () => {
      state.started++;
      if (state.startFails) throw new ShortClipError(state.startFails);
    },
  };
  return {
    root,
    state,
    shorts: new DesktopShortClips(options),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("rule-based clips are found with their origin and an empty library", async () => {
  const f = await fixture();
  try {
    const none = await f.shorts.view(project);
    assert.equal(none.status, "none");
    assert.deepEqual(none.library, []);
    assert.deepEqual(none.pick, { running: false, message: null });
    const found = await f.shorts.find(project);
    assert.equal(found.status, "ready");
    assert.ok(found.candidates.length > 0);
    assert.ok(found.candidates.every((clip) => clip.origin === "rules"));
    assert.equal(found.job.batch, null);
  } finally {
    await f.cleanup();
  }
});

test("Claude's proposals replace the set, are marked, and go stale with the draft", async () => {
  const f = await fixture();
  try {
    await f.shorts.find(project);
    const answer = await f.shorts.propose(project, [
      { start_us: 0, end_us: 30_000_000, title: "First", reasons: ["Opens"] },
      {
        start_us: 10_000_000,
        end_us: 40_000_000,
        title: "Overlap",
        reasons: [],
      },
    ]);
    assert.equal(answer.accepted, 1);
    assert.match(answer.rejected[0]!, /overlaps/u);
    const view = await f.shorts.view(project);
    assert.equal(view.candidates.length, 1);
    assert.equal(view.candidates[0]!.origin, "ai");
    assert.equal(view.candidates[0]!.title, "First");
    assert.deepEqual(view.pick, { running: false, message: null });
    // Nothing accepted leaves the stored set alone.
    const none = await f.shorts.propose(project, [
      { start_us: 0, end_us: 5_000_000, title: "Short", reasons: [] },
    ]);
    assert.equal(none.accepted, 0);
    assert.equal((await f.shorts.view(project)).candidates.length, 1);
    f.state.sequence++;
    const stale = await f.shorts.view(project);
    assert.equal(stale.status, "stale");
    assert.equal(stale.message, shortIssues.stale);
    // No transcript: nothing to choose from.
    f.state.words = null;
    await assert.rejects(
      () => f.shorts.propose(project, []),
      (error: unknown) =>
        error instanceof ShortClipError &&
        error.message === shortIssues.transcript,
    );
  } finally {
    await f.cleanup();
  }
});

test("picking with Claude reports running, an empty result, and refusals in plain words", async () => {
  const f = await fixture();
  try {
    f.state.words = null;
    await assert.rejects(
      () => f.shorts.pick(project),
      (error: unknown) =>
        error instanceof ShortClipError &&
        error.message === shortIssues.transcript,
    );
    assert.equal(f.state.started, 0);
    f.state.words = monologue();
    f.state.startFails = shortIssues.pickSignIn;
    await assert.rejects(
      () => f.shorts.pick(project),
      (error: unknown) =>
        error instanceof ShortClipError &&
        error.message === shortIssues.pickSignIn,
    );
    // A refused start leaves no message behind.
    assert.equal((await f.shorts.view(project)).pick.message, null);
    f.state.startFails = null;
    await f.shorts.pick(project);
    // The refused start counted too: two attempts reached Claude.
    assert.equal(f.state.started, 2);
    // Claude is working: the view says so, with no message yet.
    f.state.picking = true;
    assert.deepEqual((await f.shorts.view(project)).pick, {
      running: true,
      message: null,
    });
    // Asking again while it runs starts nothing new.
    await f.shorts.pick(project);
    assert.equal(f.state.started, 2);
    // It ended without proposing anything.
    f.state.picking = false;
    assert.deepEqual((await f.shorts.view(project)).pick, {
      running: false,
      message: shortIssues.pickNone,
    });
    // A proposal clears that message.
    await f.shorts.propose(project, [
      { start_us: 0, end_us: 30_000_000, title: "First", reasons: [] },
    ]);
    assert.equal((await f.shorts.view(project)).pick.message, null);
  } finally {
    await f.cleanup();
  }
});

test("saved clips are listed without paths, shown on request and forgotten without touching the file", async () => {
  const f = await fixture();
  try {
    await f.shorts.find(project);
    const saved = join(f.root, "Saved clip.mp4");
    await writeFile(saved, "mp4");
    const file = join(f.root, "shorts", `${project}.json`);
    const stored = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    stored.library = [
      {
        id: "export-aaaaaaaa-0001",
        title: "Saved clip",
        fileName: "Saved clip.mp4",
        outputPath: saved,
        format: "vertical",
        speed: 2,
        durationUs: 15_000_000,
        createdAt: "2026-10-25T12:00:00.000Z",
      },
      {
        id: "export-aaaaaaaa-0002",
        title: "Gone",
        fileName: "Gone.mp4",
        outputPath: join(f.root, "Gone.mp4"),
        format: "square",
        speed: 1,
        durationUs: 20_000_000,
        createdAt: "2026-10-25T11:00:00.000Z",
      },
    ];
    await writeFile(file, JSON.stringify(stored));
    const view = await f.shorts.view(project);
    assert.deepEqual(
      view.library.map((item) => [item.fileName, item.exists]),
      [
        ["Saved clip.mp4", true],
        ["Gone.mp4", false],
      ],
    );
    assert.ok(!JSON.stringify(view).includes(f.root), "no path in the view");
    await f.shorts.reveal(project, "export-aaaaaaaa-0001");
    assert.deepEqual(f.state.revealed, [saved]);
    // A file that is no longer there is not handed to the file manager.
    await f.shorts.reveal(project, "export-aaaaaaaa-0002");
    assert.deepEqual(f.state.revealed, [saved]);
    await assert.rejects(
      () => f.shorts.reveal(project, "export-aaaaaaaa-9999"),
      (error: unknown) =>
        error instanceof ShortClipError &&
        error.message === shortIssues.libraryUnknown,
    );
    const forgotten = await f.shorts.forget(project, "export-aaaaaaaa-0001");
    assert.deepEqual(
      forgotten.library.map((item) => item.fileName),
      ["Gone.mp4"],
    );
    assert.equal(await readFile(saved, "utf8"), "mp4");
    // Finding clips again keeps the list.
    const again = await f.shorts.find(project);
    assert.deepEqual(
      again.library.map((item) => item.fileName),
      ["Gone.mp4"],
    );
  } finally {
    await f.cleanup();
  }
});

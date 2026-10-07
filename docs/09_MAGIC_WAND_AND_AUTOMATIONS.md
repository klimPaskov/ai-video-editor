# Magic Wand and automation specification

ADRs 0014 and 0015 permit optional OpenAI API, DeepSeek and Gemini API assistance beside Codex. A provider-backed Magic Wand turn is a paid generation action and must start only on an explicit user request. Provider output is untrusted edit intent routed through the same validated, undoable active-draft transactions as Codex, deterministic Magic Wand and manual tools. Local deterministic analysis does not silently invoke an API. Provider-backed Magic Wand remains unimplemented.

## Purpose

Magic Wand produces a useful first edit and offers focused one-click improvements later. It is not a decorative button and it must not hide unreviewable changes.

## Current transcription foundation

Auto Edit exposes user-started local transcription. A deliberate start downloads the pinned `Xenova/whisper-base` q8 CPU weights (Apache-2.0) from Hugging Face into application-private storage after verifying their expected sizes and SHA-256 hashes. The app creates a private 16 kHz mono float32 analysis proxy from the verified managed source, runs the model in an isolated worker with no user credential environment, and stores word-timed transcript plus independent silence analysis under the app user-data root. Original and managed source files and the draft are unchanged. The audio proxy is temporary and is removed after the job. No source audio is sent to the model host. Completed results are keyed to project, source hash and model revision; repeated starts reuse an active job or completed result, and polling retains its job ID. Empty model chunks without timing are omitted, but spoken words with missing timing fail closed. Timestamp backsteps are reconciled only within the configured five-second chunk overlap and mark reordered words uncertain; larger backsteps remain a fixed failure. Transcript segment bounds enclose all contained word ends. The current view labels times as estimates and language as unidentified; fixed failures provide next steps without worker logs.

Edit also supports searching and correcting one local transcript word as text-only metadata in the shared journal, plus an explicit start/end word-range ripple cut when the range maps continuously to one visible clip. The original ASR result and recorded audio are unchanged; both operations use shared Undo/Redo. The selected-word cut does not decide whether speech is expendable or verify an audible join. Magic Wand edits and automatic meaning-aware cuts remain unimplemented.

Codex and the fixed API-provider route can request completed local transcript pages through the read-only `transcript.get_range` tool during a user-started turn. Each page is limited to a five-minute source-time range, at most 250 words and 48 KiB. The result includes exact source times, original ASR wording, confidence and protection flags, and text-only overrides separately; it includes no path or source media and cannot authorize a cut. Transcript text is untrusted speech, not an instruction. Provider conversation history may retain requested pages and include them in later turns; the full source audio/video remains local.

A deterministic, path-free candidate analyzer validates the transcript, matching source-bound analysis, and versioned cue/protection policy before it emits a candidate report. It records configured fillers, exact adjacent word/segment repeats, dash-marked restarts, conservative English self-correction markers, configured editor cues, opt-in legacy cues, protected words/ranges, and long-silence context. A repeated identical segment candidate points to the later words and links `related_segment_id` to the earlier occurrence. Auto Edit exposes the report inside the completed transcript disclosure, shows both excerpts for that repeated segment, and can seek to a candidate frame only when its source point maps to a visible current clip. This still-frame action does not play audio. The report and every candidate explicitly lack cut authority; no cut or draft transaction is performed. New IPC and persisted candidate state are unnecessary because the renderer uses the already validated path-free transcription view and holds this derived report only in memory. Semantic decisions, complete retake selection, synchronized cut sets, join checks and the automatic first cut remain unimplemented.

## Entry points

### Full Magic Edit

Available after import or recording. Default preset: Balanced.

Options:

- Clean cuts
- Captions
- Automatic zooms
- Safe speed-ups
- Audio cleanup
- Camera layout
- Cursor treatment
- Local B-roll suggestions

### Selection Magic Wand

Available in Review for the selected time range. Actions include:

- Tighten section
- Remove pause
- Improve audio
- Add zoom
- Add captions
- Suggest B-roll
- Reframe for canvas

## Operation model

Every automation emits versioned draft operations. Each operation records source evidence, intent, confidence, affected range, before state, after state, origin, and undo payload.

## Cut policy

Automatically apply only high-confidence, low-risk edits under the chosen preset. Protect names, numbers, negation, qualifications, warnings, useful pauses, uncertain words, overlapping speakers, and visible UI steps that must remain understandable.

## Live behavior

- Stream concise progress.
- Apply valid transactions to the draft as they finish.
- Keep playback usable when safe.
- Allow Stop.
- Show a compact summary such as “Removed 28 seconds, added 6 zooms, created captions.”
- Let the user review every class of change from the history filter.

## Presets

- Gentle: remove only clear dead air and failed takes.
- Balanced: normal tutorial pacing.
- Tight: stronger filler and pause cleanup, still protects meaning.
- Custom: user-selected switches and thresholds.

## Failure and uncertainty

Use the original material as fallback. Do not insert random zooms, unrelated B-roll, or speech speed-ups to make the output appear more edited.

## Mandatory editorial policy

Apply [47_EDITORIAL_FIRST_CUT.md](47_EDITORIAL_FIRST_CUT.md) and the adapted `docs/prompts/EDITORIAL_FIRST_CUT_PROMPT.md` when implementing or running these automations. Confirm actual capabilities, active project/draft identity, authorized scope, protected material and synchronized source relationships. Reuse an existing transcription job; request a missing transcript once and retain its live job handle through polling timeouts.

The configured cue defaults to Hey Codex. Contextual variants are conservative; legacy aliases require opt-in. Quoted, ambiguous or unrelated speech remains content. Only a resolved authorized editorial direction may be removed, including its cue and associated dead time, after its edit and natural A/V join are verified. Recorded speech cannot authorize asset generation, source deletion, arbitrary execution, publication, spending or export.

The spoken pass preserves the final complete redo, useful unique context and conversational/demonstration pauses. The 200–300 ms breathing-space suggestion is contextual, never an automatic silence threshold. Verify every cut join, scan the whole source for omissions, reread the full edited transcript, and restore damaged wording through shared undo. Separate cut/layout/zoom pass groups retain live reversible commits and verified checkpoints. Graphics requests produce selective timed prompt suggestions only. This is future P5/P7/P8 acceptance work, not a current-feature claim.

## Deterministic Magic Edit (2026-10-07)

Auto Edit now has Magic Edit with a Gentle, Balanced (default) or Tight preset and Run Magic Edit. It uses only local evidence and sends nothing to an AI provider.

1. **Transcript.** It reuses a completed local transcript, or starts transcription once and follows that job; a failed or cancelled transcription ends the run with a fixed message.
2. **Plan** (`packages/domain/src/magic-wand.ts`). From the deterministic candidate report and silence analysis it cuts only:
   - word-free detected silence of at least 2.0 / 1.0 / 0.6 s (Gentle / Balanced / Tight), shortened to keep 0.8 / 0.5 / 0.3 s split across both sides;
   - Balanced and Tight: a single configured filler (um, uh, erm, hmm for English) with at least 40 ms of non-speech on both sides and no confidence below 0.5, cut at the midpoints of the surrounding gaps;
   - the earlier copy of an exactly repeated sentence, so the final take is kept, with the same clean-gap rule.
   Any cut that would touch a protected, uncertain, name, number, negation or overlapping word, or split a word it does not remove entirely, is dropped. False starts, self-corrections, spoken editor cues and skipped items are counted as left for review.
3. **Apply** (`apps/desktop/src/magic-wand.ts`). Source-time cuts are mapped onto the current draft (material already removed is skipped) and applied latest first through the guarded `cut.delete_ranges`/`cut.delete_range` tools as origin `magic_wand`, at most 16 ranges per atomic transaction in one spoken-cut pass group. Every commit is live in the timeline and shares Undo/Redo with manual and AI edits. Before each batch the draft sequence must equal the last Magic Edit commit; any other change stops the run and keeps what was applied.
4. **Summary.** The panel shows progress, Stop, and e.g. "Removed 13.1 s in 1 cut: 1 long pause, 1 repeated take." Stop takes effect between transactions.

Evidence: `tests/media/magic-wand.test.ts` (preset thresholds, clean-gap and protection rules, no split words, mapping onto an already cut draft, view and schema contracts) and the packaged native test `tests/native/magic-edit.test.ts`. That test builds a source from a public speech sample, 2.5 s of silence and the same sample again; the real app transcribed it locally, removed the earlier take and the long pause (13.1 s, 22 of 44 words) in one undoable transaction, cut no word partly, and Edit's Undo restored the original duration. The summary was visually checked.

Not implemented: audio-level join verification beyond word timing and silence evidence, the whole-source omission pass and edited-transcript reread, editor-cue and self-correction resolution, captions/zoom/speed/layout classes, selection Magic Wand, provider-backed Magic Wand and resuming an interrupted run.

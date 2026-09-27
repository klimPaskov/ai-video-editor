# Magic Wand and automation specification

ADRs 0014 and 0015 permit optional OpenAI API, DeepSeek and Gemini API assistance beside Codex. A provider-backed Magic Wand turn is a paid generation action and must start only on an explicit user request. Provider output is untrusted edit intent routed through the same validated, undoable active-draft transactions as Codex, deterministic Magic Wand and manual tools. Local deterministic analysis does not silently invoke an API. Provider-backed Magic Wand remains unimplemented.

## Purpose

Magic Wand produces a useful first edit and offers focused one-click improvements later. It is not a decorative button and it must not hide unreviewable changes.

## Current transcription foundation

Auto Edit currently exposes only Transcribe locally. A deliberate start downloads the pinned `Xenova/whisper-base` q8 CPU weights (Apache-2.0) from Hugging Face into application-private storage after verifying their expected sizes and SHA-256 hashes. The app creates a private 16 kHz mono float32 analysis proxy from the verified managed source, runs the model in an isolated worker with no user credential environment, and stores word-timed transcript plus independent silence analysis under the app user-data root. Original and managed source files and the draft are unchanged. The audio proxy is temporary and is removed after the job. No source audio is sent to the model host. Completed results are keyed to project, source hash and model revision; repeated starts reuse an active job or completed result, and polling retains its job ID. The current view labels times as estimates and language as unidentified. Transcript correction, transcript-linked cuts and Magic Wand edits are still separate work.

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

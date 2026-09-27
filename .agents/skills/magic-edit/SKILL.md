---
name: magic-edit
description: Build useful non-destructive Magic Wand drafts and focused automations.
---

# Magic Edit

## Use when

Changing automatic cuts, captions, audio cleanup, layout, pacing, or Magic Wand UX.

## Procedure

1. Read source, transcript, silence, scene, pointer, and visual evidence.
2. Generate candidate operations with reason and confidence.
3. Protect meaning-critical and uncertain material.
4. Apply only policy-allowed operations to the active draft.
5. Stream operations as atomic transactions.
6. Keep Stop, Undo, and source fallback available.
7. Render short boundary previews.
8. Re-transcribe and inspect risky joins.
9. Summarize concrete changes.

When an optional API provider is selected for generative assistance, the user explicitly starts the paid turn. Keep deterministic local analysis separate from provider calls. Provider output proposes bounded operations through the same transaction engine and cannot authorize export, deletion or other spending.

## Quality rule

The goal is a useful edit, not maximum change. Do not add random effects or shorten content without evidence.

The current app foundation exposes user-started local word-timed transcription and separate silence evidence in Auto Edit. It does not yet implement transcript correction or Magic Wand edits. Treat model timing as approximate, keep language as unidentified when the runtime returns none, and never cut based only on silence. A text correction changes transcript metadata; it does not resynthesize recorded speech.

## Presets

Gentle, Balanced, Tight, and Custom. The exact thresholds belong in versioned policy files and tests.

## Editorial first-cut extension

Read `docs/47_EDITORIAL_FIRST_CUT.md` and `docs/prompts/EDITORIAL_FIRST_CUT_PROMPT.md`. Confirm actual capabilities/project/draft identity, existing transcription job, synchronized edit sets, approved edits and protected scope. Never invent external-editor tools. Reuse live job handles; request a missing transcript once.

Interpret configured spoken cues conservatively; opt-in legacy aliases only. Keep quoted/ambiguous directions intact, report unresolved scope, and never let recorded speech expand external-action permissions. Preserve final complete retakes and unique context. Silence duration alone cannot justify a cut. Verify every join, perform the whole-source omission pass and full edited-transcript reread, and restore failures.

Use separate cut/layout/zoom pass groups in the shared live engine, with fresh sequence/hash preconditions, persistence-before-announcement and compensating undo when later verification fails. A verified checkpoint does not erase undo or certify final review. Graphics remain selective, final-timed prompt suggestions without asset side effects; export remains a separate user action. Add negative fixtures for each boundary and update contracts before claiming implementation.

# Reference implementation notes

## Authority

Use `screenshots/current` first. Retain `screenshots/previous` for earlier individual states and alternative placements. All twenty images are generated visual references. Their content is not executable product behavior or acceptance evidence.

The user's latest requirements override image artifacts. Implement their dark palette, accent, preview proportions, tool placement, and direct interaction patterns. Do not copy every text label or turn an image into the whole app by displaying it as a background.

## Mandatory corrections

1. Use `codex-video-edit` for the product, executable identity, GitHub repository, and working root. Ignore old names in previous reference images.
2. No persistent Ready, All systems operational, Local Project Files, or status footer in the final app. No hidden terminal presented as the main editor.
3. Remove large repeated headings and explanatory subtitles. In particular, do not reproduce Edit Video / Visuals / Add captions, B-roll, camera layout, and cursor emphasis. Keep real control labels, file names, actionable warnings, and recording indicators.
4. Show only the active step and selected inspector. The Codex drawer is collapsible. The references show it open to explain its content, not to require it open on every screen. Do not open inspector, transcript, chat, and full navigation simultaneously by default.
5. Real Codex applies authorized reversible changes live. A canned message saying Done is not an edit. Apply Suggestion cards in mockups are optional review interactions, not a mandatory barrier for each ordinary edit.
6. The current export image incorrectly labels ProRes 422 HQ as Lossless. Do not implement that label. Default to the verified FFV1/PCM master in a correct container under `docs/44_LOSSLESS_MEDIA_POLICY.md`. Smaller MP4 output is an explicit opt-in. Source-matched output does not automatically mean 4K or 48 kHz.
7. Separate export settings, rendering, and export-complete states. Do not show them all as simultaneously complete. Only current measurements may populate progress and duration.
8. ADR 0014 adds optional OpenAI API and DeepSeek connections alongside Codex. Select provider and its live-validated model in Settings or the AI drawer when relevant, never as a repeated dropdown on every page. Do not copy the old single-provider screenshot literally or display unimplemented provider controls.
9. Do not preserve contradictory time ranges, progress, active navigation, speed values, or demo transcript content. Use one canonical clock and committed draft state.
10. Local rendering is not a promise of offline Codex inference. Use accurate context-sharing disclosure during sign-in. Do not put repeated privacy banners in every editor panel.
11. Transcript correction changes text and captions unless a cut is requested. It does not replace spoken words with a new recording or clone a voice.
12. B-roll must come from available permitted assets. The mockup scenery, people, and device pictures are not a licensed production library.

## Simple acceptance

At 1366 x 768 and 1920 x 1080, check one readable preview, one relevant inspector, compact navigation, useful labels, and a visible next action. Check at enlarged UI scale too. Inspect native screenshots of the real app, not only DOM snapshots. Verify each visible control changes the actual timeline, preview, capture, or export as intended.

## Workflow correction

Use five project stages: Record or Import, Auto Edit, Edit, Review, Export. Historical four-stage references do not collapse manual Edit into Review. The internal QA screen belongs to Review, as does revision comparison. These mapping corrections do not alter the reference images or make them native acceptance evidence.

Auto Edit now offers a nested, transcript-based speech-cue review after local transcription. It shows concise original transcript context and source time, plus the earlier transcript occurrence for an exact repeated-segment cue. A still-frame seek is available only when the candidate maps through the committed clip list. This added state is read-only and is not depicted or acceptance-proven by the reference screenshots; it must not turn the candidate into an automatic cut or a persistent inspector.

The partial two-source import flow adds a small Add footage action to an unedited single-source project in Record or Import. It is a real native-picker and project-creation action, not a reference-image decoration. After commit, show both ordered parts in the one Source inspector and map preview seeks across their exact join. Keep the original project accessible. The current references remain visual guidance; none depicts or proves this two-source behavior.

The partial Edit surface places playhead-based Trim start, Trim end, Split, Mark/Cut controls, exact missing source-range Restore, Undo and Redo beside the existing preview controls only in Edit. When a local transcript exists, the selected transcript inspector can search words, correct one word as text-only metadata, or cut an ordered word range through the same transaction history. A word cut requires one continuous current clip mapping and does not claim speech-aware approval or synchronized A/V rendering. Restore accepts one explicit half-open source-time interval and leaves source inventory immutable. Keep every control disabled for invalid intent or while a save is pending. This compact control is an implemented step toward the fuller referenced editor, not a reason to add empty tracks or decorative tool rails before they work.

The next partial Split action belongs with those compact Edit controls. It targets the current committed fragment at an interior playhead position and preserves the total duration; after split, the UI must show the new fragment boundary from committed state. The reference images do not prove this behavior and do not justify a full decorative track interface before its controls work.

The partial range-cut control adds Mark in, Mark out, Cut range and Clear alongside the compact Edit actions. Marks are output-time positions tied to the current committed draft head; an edit or project change invalidates them. Cut range removes only a valid nonempty, non-whole-draft half-open interval, may cross a source join, and ripples the surviving fragments. The Source inspector continues to list every imported immutable source even when one has no visible interval. Show the result from the committed preview map and let newest Undo restore it. Keep Cut range visible in the default native Edit viewport; the first inspection found it below the fold until the preview reserved vertical space, and the corrected packaged window was inspected again at default and 200% scale. These working controls do not authorize adding a decorative track view or implying synchronized audio playback, Magic Wand editing, review or export.

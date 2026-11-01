# Test fixture matrix

## Generated media fixtures

| Fixture | Purpose |
| --- | --- |
| `screen-basic` | Fixed-frame screen recording with clear clicks and UI regions |
| `screen-vfr` | Variable-frame-rate input and normalization |
| `speech-pauses` | Speech with short and long pauses |
| `speech-fillers` | Filler words, stutters, false starts, and protected numbers |
| `duplicate-takes` | Two takes with one obvious failure and one complete take |
| `typing-waiting` | Silent typing, loading, and waiting ranges |
| `zoom-edge` | Targets near every canvas edge |
| `cursor-clicks` | Cursor path and click telemetry with exact timestamps |
| `camera-sync` | Virtual camera and screen with sync marker |
| `multi-audio` | Microphone plus system audio with known offset |
| `captions-long` | Long words, punctuation, two lines, and safe-area stress |
| `broll-local` | Licensed fixture clips and images with metadata |
| `audio-clipping` | Intentionally clipped speech for QA |
| `black-freeze` | Known black and frozen intervals |
| `corrupt-media` | Truncated container and invalid streams |

## Native UI fixtures

- empty Home
- three recent projects
- dependency warning
- Codex signed out
- Codex rate limit warning
- API provider key absent/rejected, secure persistence unavailable, live catalog unavailable and explicit paid-turn start
- processing in progress
- interrupted Magic Wand
- timeline with each supported selection kind
- QA pass, warning, and blocked
- export complete
- missing local asset
- recovered autosave

## Capture fixtures

Use virtual screen, microphone, camera, and loopback devices. Record known sync flashes and tones. Never rely on a developer's physical device for repeatable CI.

## Codex fixtures

Use a fake protocol server for parser and recovery tests. Keep a separate real authenticated smoke test that proves current login, model discovery, skill discovery, streamed events, and one guarded draft edit. A fake transport cannot satisfy real integration acceptance. `tests/native/codex-range-cut.test.ts` passed a guarded `cut.delete_range` across a source join, committed preview mapping, manual newest Undo and reopen first with synthetic two-source media and then with the privately combined supplied recordings, using real signed-in Codex in packaged Electron. `tests/native/codex-split.test.ts` then passed an exact `cut.split` at 0.5 seconds in a synthetic two-source draft, three-fragment live projection, exact start/split/join frames, manual Undo, reopen and immutable input checks under the same isolated packaged runtime. The first split harness asserted before asynchronous Undo settled and failed; the corrected wait passed. Focused tests reject stale, reversed and whole-draft ranges, plus split boundaries and stale heads. The native tests do not prove speech selection, continuous A/V review or export.

The `--batch` route of `tests/native/codex-range-cut.test.ts` checks a real Luna/high dynamic host call with two ordered ranges, one across the source join and one earlier in the first source. Synthetic and both privately staged supplied recordings passed one committed two-operation transaction during the turn, exact edited join frame, shared manual Undo, reopen, original/managed source and baseline integrity. The supplied run's actual guest Electron window was visually inspected. These are requested time cuts, not semantic speech cleanup or A/V join certification.

For a fresh large-media run, the harness must navigate Home and reopen the combined project after the second import, then wait for committed duration and Edit controls before sending the Codex turn. A final-package rerun passed with that focus/wait sequence; earlier attempts failed before mutation when the first project remained selected or its Refine stage had not settled.

## API-provider fixtures

Use a local fake HTTP server for fixed-endpoint/parser/failure/timeout and key-redaction tests, with provider adapters injected only in tests. Verify no renderer or project key exposure, OS-protected storage or session-only fallback, live catalog validation, explicit paid-turn start, malicious edit-output rejection, stale transaction rejection and shared undo. The optional packaged `api-provider-live-catalog.test.ts` consumes a private guest-only key file, deletes it before launch, authenticates OpenAI model discovery and selection without generation, and checks session-only restart. Separate real authenticated OpenAI API and DeepSeek fixture turns plus packaged isolated native inspection are still required before P2 provider acceptance; fake responses and catalog discovery alone are insufficient. Keep private keys and outputs outside Git.

## User example sequence

The two user-supplied videos form one ordered final-acceptance sequence, not a unit-test fixture. Preserve and verify both hashes, keep both files outside source control, append the second after the first without rewriting either source, and record every derived artifact used for acceptance.

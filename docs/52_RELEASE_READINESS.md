# Release readiness (2026-10-25)

What has been verified, how, and what has not. Update this file when that changes; do not claim more than it says.

## Verified

- **Unit and contract checks**: `npm run check` (typecheck, lint, format, 608 media and foundation tests, schema and delivery validation) and `npm run check:publication`.
- **Packaged app in the isolated guest** (Docker, Xvfb, never the host), final build of commit 6759dd4:
  - Layout audit `tests/native/layout.test.ts --enforce`: 411 screens (5 themes x 5 window sizes and scales x Home, the five steps with and without disclosures, the assistant drawer, source details, every Settings section, failed start, Review result, export running and done, project options, recording dialog), no page overflow, cut-off control, overlap, clipped text, small target or low-contrast text.
  - A full native run on that build: 35 tests, 32 passed on the first run; `codex-feature-policy` and `codex-runtime` passed on rerun (they take the bundled Codex binary as their only argument, which the runner script did not pass); `composition` is intermittent (see below).
  - 31 other native tests, among them export (lossless, verified), captions, graphics, sound mix and Sound card, speed, zoom, playback, short clips, two sources, recording and recovery, transcription, themes (restart persistence), robustness (unwritable export folder, a genuinely full volume, clip without speech, source removed from disk), offline first use of the speech model (host blocked; plain message, button usable), a control sweep (every safe button on every step pressed once: 50 presses, no page error, no stuck dialog; the long or irreversible ones are covered by their own tests), accessibility, Magic Edit and full edit with the guest provider fixtures.
  - With the signed-in Claude profile: `claude-connection`, `one-click-edit` (real rough cut, cuts, graphic and audio choice on a public speech sample), `claude-confinement` (a real Claude Code could not read or write outside its workspace), and a real full edit of the user's two recordings exported to a verified lossless master and to an MP4 (frames at graphic times viewed; MP4 delivered to the user's Videos folder).
- **Windows**: release build from the final source and a Wine install, upgrade and uninstall smoke (ADR 0022).

## Known failing or flaky

- `lifecycle.test.ts` (crash recovery, second instance, damaged install) is slow and timing-sensitive in the guest: the renderer-crash report arrives 10 to 60+ seconds late there. After the waits were lengthened it passed in 4 of 5 runs; the one failure was a 30 s wait for a broken launch to exit, now 90 s, and it passed twice after that. It needs a quiet guest (never run two at once).
- Two media tests (`claude-bridge`: a full edit with the playbook; `recorder`: a paused and resumed take) failed once each in a full `npm run check` while the host was saturated by the guest, and pass three of three when run alone: they are timing-sensitive under heavy load.
- `composition.test.ts` fails intermittently in the guest at its hostile-page step ("the composition did not answer in time" where it expects "could not be loaded"): about half of the runs on the previous build and most on the final one (the CSS-only differences between the builds were bisected and do not explain it). It passes when the guest is quiet and retried; the cause is not found, so treat the composition sandbox check as unreliable in this guest.
- Several native tests are timing-sensitive when the host is busy (5 s expectations); they pass on rerun.

## Not verified

- Anything on real Windows or macOS: installer UI, SmartScreen and antivirus behaviour, capture, Claude and Codex on those systems.
- Completing Claude sign-in through the app's own button (needs a browser inside the guest and the user).
- Codex and API-key providers end to end with real accounts in this release (the 17 authenticated `codex-*` and `api-provider-*` native tests were not run: the guest has no Codex account or API key and none was copied in); only their fixtures and unit tests.
- Offline and full-disk cases were simulated in the guest (the model host pointed at 127.0.0.1; a 1 GB memory volume filled to the last byte), not on a real offline or full machine.
- The control sweep skips controls that start long or irreversible work (export, transcription, one-click edit, Magic Edit, project deletion, sign-in, capture); those have their own tests, but not every control was pressed in every state.
- Playback of sound layers in the preview against the export frame by frame (the export mix is tested; the preview is display only).

## Deviations from the reference designs

The player has a Full screen control but no volume control (the preview plays no audio, so one would do nothing); the Edit timeline is one clip bar with markers, not a thumbnail filmstrip with a time ruler; below 821 px or 561 px high the Cinematic layout becomes the classic layout.

## What only the user can supply

A code-signing certificate and publisher identity, a clean Windows 10/11 image for the release checks, an `.ico` app icon, hosting for the exact FFmpeg source and build recipe beside each release, and a legal review of H.264 and OpenH264 terms and the bundled notices.

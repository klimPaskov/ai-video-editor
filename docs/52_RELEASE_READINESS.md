# Release readiness (2026-10-25)

What has been verified, how, and what has not. Update this file when that changes; do not claim more than it says.

## Verified

- **Unit and contract checks**: `npm run check` (typecheck, lint, format, 608 media and foundation tests, schema and delivery validation) and `npm run check:publication`.
- **Packaged app in the isolated guest** (Docker, Xvfb, never the host):
  - Layout audit `tests/native/layout.test.ts --enforce`: 411 screens (5 themes x 5 window sizes and scales x Home, the five steps with and without disclosures, the assistant drawer, source details, every Settings section, failed start, Review result, export running and done, project options, recording dialog), no page overflow, cut-off control, overlap, clipped text, small target or low-contrast text.
  - 31 other native tests, among them export (lossless, verified), captions, graphics, sound mix and Sound card, speed, zoom, playback, short clips, two sources, recording and recovery, transcription, themes (restart persistence), robustness (unwritable export, clip without speech, source removed from disk), accessibility, Magic Edit and full edit with the guest provider fixtures.
  - With the signed-in Claude profile: `claude-connection`, `one-click-edit` (real rough cut, cuts, graphic and audio choice on a public speech sample), `claude-confinement` (a real Claude Code could not read or write outside its workspace), and a real full edit of the user's two recordings exported to a verified lossless master and to an MP4 (frames at graphic times viewed; MP4 delivered to the user's Videos folder).
- **Windows**: release build from the final source and a Wine install, upgrade and uninstall smoke (ADR 0022).

## Known failing or flaky

- `lifecycle.test.ts` fails in the guest at its crash-recovery steps, also on the build from before the redesign.
- Two media tests (`claude-bridge`: a full edit with the playbook; `recorder`: a paused and resumed take) failed once each in a full `npm run check` while the host was saturated by the guest, and pass three of three when run alone: they are timing-sensitive under heavy load.
- Several native tests are timing-sensitive when the host is busy (5 s expectations); they pass on rerun.

## Not verified

- Anything on real Windows or macOS: installer UI, SmartScreen and antivirus behaviour, capture, Claude and Codex on those systems.
- Completing Claude sign-in through the app's own button (needs a browser inside the guest and the user).
- Codex and API-key providers end to end with real accounts in this release (the authenticated `codex-*` and `api-provider-*` native tests were not run); only their fixtures and unit tests.
- Offline first-use download of the speech model (the guest has network; a proxy flag does not cut the model library's fetches).
- A genuinely full disk during export (an unwritable destination is tested).
- Playback of sound layers in the preview against the export frame by frame (the export mix is tested; the preview is display only).

## Deviations from the reference designs

The player has no volume or fullscreen control; the Edit timeline is one clip bar with markers, not a thumbnail filmstrip with a time ruler; Export keeps a quality dropdown instead of two selectable cards; below 821 px or 561 px high the Cinematic layout becomes the classic layout.

## What only the user can supply

A code-signing certificate and publisher identity, a clean Windows 10/11 image for the release checks, an `.ico` app icon, hosting for the exact FFmpeg source and build recipe beside each release, and a legal review of H.264 and OpenH264 terms and the bundled notices.

# Installer and release

## First release

Create a Windows installer that launches a real desktop application from the Start menu. It must not open a localhost URL.

## Managed dependencies

The installer or first-run setup must verify and provision compatible builds of:

- application runtime
- FFmpeg and ffprobe
- local transcription runtime and selected model
- official Codex client or app-server dependency according to its licence and supported distribution path

Do not silently download large models without size and destination disclosure.

## Packaging

- Package renderer assets locally.
- Sign production builds when credentials are available.
- Produce checksums.
- Support clean uninstall without deleting user projects by default.
- Keep updates disabled until a signed and tested channel exists.

## Release checks

- install on a clean Windows test image
- first launch
- ChatGPT login flow
- import fixture
- virtual recording fixture
- Magic Wand
- manual edit
- export and decode
- restart and project recovery
- uninstall and project preservation

## macOS later

Keep platform capture and packaging behind interfaces. Do not claim macOS support until a signed native build passes equivalent tests.

## Public development starts before release

Follow `docs/45_OPEN_SOURCE_DEVELOPMENT.md` from P0 onward. The product display name is **AI Video Editor**; repository, package, executable and working-folder identities use `ai-video-editor`. Public source commits happen throughout implementation. Binary releases remain subject to the installer, privacy, licensing, native acceptance, and lossless media gates.

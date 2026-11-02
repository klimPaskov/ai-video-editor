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

## Windows build (ADR 0022)

`docs/adr/0022-windows-release.md` records the decisions, sources and unverified points. In short:

- **Build**: `node scripts/build_desktop.mjs --platform win32 --release` (`npm run desktop:build:win`) in the isolated Linux guest cross-packages Electron for win32-x64 with `@electron/packager`, stages the Windows builds of the native Node packages from a tree whose every package must match `package-lock.json`, provisions the pinned sidecars below, flips the release fuses and builds the NSIS installer with `makensis` (`MAKENSIS`/`NSISDIR` select the tool; no Wine is needed to build). `--fast-installer` swaps LZMA for zlib for smoke tests only. The pins live in `scripts/windows/windows-release.json`; downloads must match their pinned size and SHA-256 and are cached under `test-results/download-cache/`.
- **FFmpeg and ffprobe**: the pinned BtbN `win64-lgpl-shared` build, under `resources/ffmpeg` with a manifest, its LGPL licence text and a generated `NOTICE.txt`. The build step refuses any FFmpeg whose configuration enables GPL or nonfree code. At every start the app verifies each file's size and SHA-256 (`apps/desktop/src/media-tools.ts`); a missing or changed file stops the app with a plain "reinstall" message, and the release never falls back to an FFmpeg on PATH. Builds without that folder (the Linux guest, developer machines) still use PATH.
- **Smaller-file MP4**: libx264 is GPL and not bundled. The LGPL build exports H.264 with OpenH264 at a size-based bitrate; the playback copy falls back to VP9/Opus. Hardware or software availability is checked once per FFmpeg; if no H.264 encoder exists the export says so and points to the lossless master. The lossless master (FFV1 + PCM) uses FFmpeg's own encoders only.
- **Codex**: `@openai/codex@0.155.1-win32-x64` (aliased `@openai/codex-win32-x64` in the lockfile; the unscoped alias name does not exist on npm), verified against the lockfile's integrity; only `codex.exe` and `codex-code-mode-host.exe` ship, with the Apache-2.0 licence and NOTICE. Claude Code is the user's own install (ADR 0018) and is not bundled.
- **Transcription**: the Windows `onnxruntime-node` and `sharp` binaries ship; the Whisper model (about 76 MiB, Hugging Face, pinned revision and hashes) downloads only when the user starts local transcription, into the app's data folder, as the transcription panel already says.
- **Installer**: NSIS, per user (no administrator prompt), `%LOCALAPPDATA%\Programs\AI Video Editor`, Start-menu shortcut, an Apps and features entry and an uninstaller that removes only the files the installer wrote. Projects, media library, recordings, exports and settings live in `%APPDATA%\ai-video-editor` and are never removed. Reinstalling over an existing install runs the previous uninstaller first.
- **Fuses**: release builds enable `OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation` and disable `EnableNodeCliInspectArguments`, `EnableNodeOptionsEnvironmentVariable` and `GrantFileProtocolExtraPrivileges`. `RunAsNode` stays enabled because the editor-tool child processes are this executable with `ELECTRON_RUN_AS_NODE`. Default builds keep the inspector for Playwright.
- **Signing and updates**: builds are unsigned until a certificate exists (`AI_VIDEO_EDITOR_SIGN_COMMAND` signs the installer and uninstaller when one is supplied). The app contains no updater and none is planned before a signed channel exists; a user installs a newer installer over the old one.

### Windows release gates

A Windows build is a candidate, not a release, until: the install, first-launch, Codex sign-in, import, recording, Magic Wand, manual edit, export, restart, uninstall-keeps-projects checks above pass on a clean Windows image; the exact FFmpeg source and build recipe are published beside the installer (LGPL); the installer is signed and the signature verified; and the checksum and signing status are recorded. None of these has happened yet.

## macOS later

Keep platform capture and packaging behind interfaces. Do not claim macOS support until a signed native build passes equivalent tests.

## Public development starts before release

Follow `docs/45_OPEN_SOURCE_DEVELOPMENT.md` from P0 onward. The product display name is **AI Video Editor**; repository, package, executable and working-folder identities use `ai-video-editor`. Public source commits happen throughout implementation. Binary releases remain subject to the installer, privacy, licensing, native acceptance, and lossless media gates.

## Already installed (2026-11-02)

When the installer finds an existing per-user install (the uninstall key with an `InstallLocation` that still holds the app), it says so and asks before replacing it: "Urushi X is already installed. Replace it with Y? Your projects and settings are kept." No answers the question by stopping the installer. Silent installs (`/S`) replace without asking. The installer and uninstaller use the Urushi icon (`apps/desktop/assets/icon.ico`, generated by `scripts/brand/make_icons.mjs`).

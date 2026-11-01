# ADR 0022: Windows release

- Status: Accepted engineering decision; cross-packaging, the installer payload and a Wine smoke test verified in the isolated Linux guest; nothing has run on real Windows
- Date: 2026-10-24
- Scope: Windows build and installer, bundled FFmpeg, Codex distribution, transcription runtime and model provisioning, Electron fuses, signing and updates

## Context

Until now the app was built only for Linux (`scripts/build_desktop.mjs` packaged `linux-x64` and bundled the Linux Codex binary) and had only run in a Linux test guest. The code already branches on `win32` for capture (`gdigrab`, `dshow`), process trees, the Codex runtime resolver and the Claude CLI lookup, but nothing produced a Windows build, FFmpeg was always taken from `PATH`, and no installer existed. A public Windows user needs a build, FFmpeg and ffprobe, a Codex client, an installer with a Start-menu entry and a project-preserving uninstall, an update plan and honest signing.

## Decisions

### 1. Build: cross-package from Linux, no Wine

`@electron/packager` 20.3.0 packages `win32-x64` from the Linux guest. Its Windows metadata, ASAR-integrity resource and exe edits use the pure-JavaScript `resedit` package (checked in `node_modules/@electron/packager/dist/win32.js`), so Wine is not needed to build. The build runs only in the isolated guest (`assertNativeTestEnvironment`), as before. `--platform win32` reuses the Linux staging code; `--release` flips the fuses (section 8).

The Windows native Node packages (`onnxruntime-node`, `sharp`) are not installed by `npm ci` on Linux. A staging project receives a lockfile cut from the root `package-lock.json` (same entries, workspaces removed) and is installed with `npm ci --omit=dev --os=win32 --cpu=x64 --ignore-scripts`; the result is then checked package by package against the root lockfile's version and integrity. A first attempt with a plain `npm install` resolved newer versions than the lockfile pins and the check refused it, which is why the staged lockfile exists. `onnxruntime-node` keeps only `bin/napi-v6/win32/x64` (the npm package carries every platform) and `onnxruntime-web` (browser WebAssembly, inlined by the Node build of transformers and not loaded at runtime) is not copied.

### 2. Installer: NSIS compiled with plain `makensis`, hand-written script

| Option | Builds on Linux inside the guest | Notes |
| --- | --- | --- |
| NSIS through electron-builder | Only with Wine. In `app-builder-lib` 26.18.0 (`out/targets/nsis/NsisTarget.js`) the uninstaller is produced by running the compiled installer through Wine on non-Windows hosts | Largest dependency tree; its updater would be unused |
| `@electron/windows-installer` (Squirrel.Windows) | The README states Wine and Mono are required on Linux/macOS | Squirrel installs per user into `%LOCALAPPDATA%` and expects an update feed this project does not have; no deterministic uninstall list |
| WiX Toolset | Unverified. Searches found no source establishing an MSI build on Linux without Wine/msi.dll; WiX 4+ is a .NET tool | MSI is attractive for managed fleets, which is not a first-release need |
| **NSIS `makensis` with our own script** | **Yes, no Wine.** `makensis` 3.08 (Debian bookworm `3.08-3+deb12u1`) ran from an unprivileged extraction of the `.deb` files, selected with `NSISDIR` | zlib/libpng licence; plain, reviewable script; the 32-bit stub runs on every 64-bit Windows |

Chosen: NSIS 3.08 with `scripts/windows/installer.nsi`, driven by `scripts/windows/installer.ts`.

- Per-user install (`RequestExecutionLevel user`) into `%LOCALAPPDATA%\Programs\AI Video Editor`: no administrator prompt, no `HKLM`. Refuses 32-bit Windows and anything older than Windows 10.
- Start-menu shortcut; an Apps and features entry under `HKCU`; `NoModify`/`NoRepair`.
- The uninstaller deletes exactly the files and folders the installer wrote (a generated list; folders with `RMDir`, never recursive), the shortcut and the registry key. It never touches `%APPDATA%\ai-video-editor`, the app's data folder (`app.getPath("userData")`) where projects, the media library, recordings, exports and settings live; the final dialog says where they were kept. Anything the user added to the install folder also survives.
- Reinstalling over an installed copy runs the previous uninstaller silently first, then installs.
- Signing hook: `AI_VIDEO_EDITOR_SIGN_COMMAND` signs the installer and uninstaller through `!finalize`/`!uninstfinalize` when a certificate exists. Nothing signs today.

### 3. FFmpeg and ffprobe: bundle an LGPL shared build

What the app needs, verified from the code: the lossless master is FFV1 video and PCM audio through FFmpeg's own encoders, with no external codec library. The explicit "Smaller file" MP4 (`packages/media-engine/src/render.ts`) and the preview copy (`proxy.ts`) used `libx264`, which is GPL; burned-in captions need libass (`ass` filter); audio cleanup needs `afftdn`/`loudnorm`; recording needs `gdigrab` and `dshow`.

Options considered:

1. **GPL build (libx264).** Legally possible as a separate executable run by an MIT application, but the GPL then covers the redistributed FFmpeg and x264 and requires offering their complete corresponding source; BtbN keeps only 14 daily builds and the last build of each month for two years. Rejected: more obligations for the project and its users, and H.264 only for one export profile.
2. **LGPL build (chosen).** FFmpeg's own legal page lists the conditions: no `--enable-gpl`/`--enable-nonfree`, dynamic linking, distribute the source and the configuration, credit and link the licence. The pinned build is BtbN's `win64-lgpl-shared` release `autobuild-2026-09-30-13-08` (FFmpeg `n8.1.3-9-g29e619e767`; recipe commit `6c9aec5f…`): LGPL-3.0-or-later (`--enable-version3`), shared DLLs, no libx264/libx265. Its configuration contains libass, FreeType, HarfBuzz, FriBidi, Fontconfig, libvpx, Opus, dav1d, OpenH264 and many other libraries statically inside the DLLs. The build fails if any forbidden flag appears (`assertLgplConfiguration`).
3. **Download on first run with disclosure.** Allowed by `docs/24_INSTALLER_RELEASE.md`, and it would move the redistribution burden to the upstream host, but it needs network access to install, a progress/consent screen and a download that must keep matching a pinned hash for years. Kept as the fallback if hosting the LGPL source is unwanted.
4. **Own minimal build** (mingw-w64 cross-compile, FFmpeg release tarball, libass and its dependencies only). Would give a much smaller binary and a short notice list but was not attempted; it is the recommended later improvement.

Consequences of choice 2:

- The "Smaller file" MP4 uses `libopenh264` when `libx264` is missing, with `-rc_mode bitrate`, High profile and about 0.12 bits per pixel clamped to 1–80 Mb/s (OpenH264 has no constant-quality mode). `libx264` stays the first choice wherever FFmpeg has it, so Linux output is unchanged. If neither exists the export says so and points to the lossless master. The preview copy already falls back to VP9/Opus. H.264 is subject to patent licensing independent of copyright licences, and the Cisco OpenH264 patent grant covers only Cisco's own binaries, not this build; **not assessed here, needs legal review before a public release.**
- The notices ship with the app (`resources/ffmpeg/NOTICE.txt`, `LICENSE.txt`) and in `THIRD_PARTY_NOTICES.md`. This project has not audited the licences of the ~60 libraries inside the DLLs beyond the recipe's own pins.
- **Release gate**: the exact FFmpeg source and the BtbN recipe at the pinned commits must be published beside the installer, on the same host, because BtbN's retention is finite. The first build's source mirror has not been made.
- At startup `apps/desktop/src/media-tools.ts` verifies every file of `resources/ffmpeg` against its manifest (size and SHA-256), refuses a missing or changed folder on Windows with a plain "reinstall" dialog, and never uses an FFmpeg from PATH there. The verified directory is also placed first on the app's PATH for the few child tools that look FFmpeg up by name. Where no `resources/ffmpeg` exists (the Linux guest, developer builds) the system FFmpeg is used as before.

### 4. Codex client distribution

The Windows package exists on npm, under the same package name with a platform version, not a separate name: **`@openai/codex@0.155.1-win32-x64`** (the lockfile aliases it as `@openai/codex-win32-x64`; the unscoped-looking `npm view @openai/codex-win32-x64` 404 is why that name seemed missing). It is Apache-2.0 and already pinned with its SHA-512 integrity in `package-lock.json`; the build asserts the pin file and the lockfile agree, downloads the tarball from the registry, checks size, SHA-256 and SHA-512, and extracts only `codex.exe` and `codex-code-mode-host.exe` (matching the Linux build; the package also holds `rg.exe` and Windows sandbox helpers that serve shell execution, which the editor disables). The Apache-2.0 text and the upstream NOTICE (Ratatui, MIT) ship next to them. The existing runtime resolver (`packages/codex-bridge/src/runtime.ts`) already handles `win32` and verifies the manifest; if the runtime is missing or damaged Codex shows its own plain "reinstall" message and the rest of the app, including Claude and manual editing, keeps working. Codex needs the user's own ChatGPT sign-in; the open-source client grants no subscription. Size: `codex.exe` is about 307 MB and the host 72 MB, the largest part of the installer. Not run on Windows.

Claude Code is not bundled (ADR 0018): it is the user's own installation. Its behaviour on Windows is not tested.

### 5. Transcription runtime and model

The runtime (`@huggingface/transformers` and the Windows `onnxruntime-node`/`sharp` binaries) ships, staged and verified as in section 1. The model is not bundled and is never downloaded silently: `packages/media-engine/src/transcription.ts` pins Whisper base q8 (Hugging Face repository `Xenova/whisper-base`, a fixed revision, two files with sizes and SHA-256 hashes, about 76 MiB) and downloads it only after the user starts local transcription; the panel states the size and source beforehand, the files go to the app-private data folder and are verified before use, and the host and redirects are pinned. Source audio never leaves the device. Windows behaviour (DirectML libraries ship in the `onnxruntime-node` Windows folder, CPU is configured) is untested.

### 6. Install location and data

Install folder `%LOCALAPPDATA%\Programs\AI Video Editor`; data folder `%APPDATA%\ai-video-editor` (or the legacy folder when it already exists, per ADR 0017). Uninstall removes only the former.

### 7. Updates

None. The app contains no updater (no `autoUpdater`, no update feed), and none is added before a signed, tested channel exists. A user installs a newer installer over the old one. Electron's own guidance for Windows updates (Squirrel.Windows feed) does not match this NSIS installer, so a future channel will either add an NSIS-compatible updater or move to one of the other installers; decide then, with signing in place.

### 8. Electron fuses (release builds only)

From the coordinator's security review, applied with `@electron/fuses` 2.1.3 when `--release` is passed: `OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation` on; `EnableNodeCliInspectArguments`, `EnableNodeOptionsEnvironmentVariable` and `GrantFileProtocolExtraPrivileges` off. `RunAsNode` stays on because the editor-tool child processes are this executable run with `ELECTRON_RUN_AS_NODE` (`apps/desktop/src/claude.ts`, `packages/codex-tools`). The default build keeps the fuses at Electron's stock values because Playwright launches Electron with `--inspect=0`. Electron enforces ASAR integrity on Windows and macOS only, so the Linux package records the setting but does not enforce it; the `resedit` step writes the integrity digest into the Windows exe. `tests/media/electron-fuses.test.ts` flips and reads a synthetic binary, and reads the real fuse wire of a release or default build when `AI_VIDEO_EDITOR_RELEASE_PACKAGE`/`AI_VIDEO_EDITOR_DEV_PACKAGE` name its executable. Fuses are applied before any signature, which must come last.

### 9. Signing

No code-signing certificate is available. Builds are labelled unsigned in `build.json` and in this ADR, and nothing may be described as signed, trusted or production-ready. SmartScreen and antivirus products can warn about an unsigned installer from a new publisher. Options to obtain a signature, from Microsoft's documentation: Artifact Signing (formerly Trusted Signing), about 10 US dollars a month, with identity validation; individual developers must be in the United States or Canada, organisations in a longer list of regions (per Microsoft's quickstart as retrieved 2026-10-24; verify before relying); or a commercial OV/EV certificate. Reputation with SmartScreen still builds over time even when signed. The user must choose and supply this.

## Results in the isolated guest (2026-10-24)

All of this ran inside the Docker guest (Debian 12, Node 24.15.0, Wine 11.20 from Kron4ek/Wine-Builds, a test-only tool, headless or under Xvfb). Wine is not Windows; none of it is clean-image evidence.

- `npm run typecheck`, `lint` and `format:check` pass. New unit tests (22 in `tests/media/`: `media-tools`, `delivery-encoder`, `windows-release`, `electron-fuses`) cover the manifest verifier, the encoder choice, the ZIP and tarball readers, pin and lockfile agreement, the LGPL gate, the staging lockfile, the uninstall list and fuse state.
- `node scripts/build_desktop.mjs --platform win32 --release` produced `ai-video-editor-win32-x64` (2,525 files, 1,040,555,206 bytes): `ai-video-editor.exe` with the Windows version resources, `resources/ffmpeg` (FFmpeg `n8.1.3-9-g29e619e767`: `ffmpeg.exe`, `ffprobe.exe`, seven DLLs, `LICENSE.txt`, `NOTICE.txt`, `manifest.json`), `resources/codex` (`codex.exe` 307,108,144 bytes, SHA-256 `eba0f32c…`; `codex-code-mode-host.exe` 72,473,904 bytes; licence, NOTICE, manifest), `resources/mcp`, `resources/capture`, and an `app.asar.unpacked` holding the win32 x64 `onnxruntime-node` and `sharp` binaries only. `build.json` records the manifests and "unsigned".
- The release installer `ai-video-editor-0.0.1-win32-x64-setup.exe` (NSIS 3.08, LZMA solid) is 264,326,221 bytes, SHA-256 `577a401199941d8d6a59bdf10304d405e9b8afdf1bc6c6d792380151610dac90`. Unsigned.
- **Wine install smoke test** of that installer: silent install in 241 s created 2,526 files (the payload plus `Uninstall.exe`) and the installed tree matched the packaged tree byte for byte (SHA-256 of all 2,525 files, 0 differences); the Start-menu shortcut and the Apps and features registry entry were written; the installed `ffmpeg.exe` and `ffprobe.exe` ran from the install folder; a second install over the first (upgrade path) left 2,526 files; the silent uninstall removed the whole install folder, the shortcut and the registry key and left a project file in `%APPDATA%\ai-video-editor` untouched.
- **Wine launch**: the packaged app (the `--fast-installer` build of the same tree) opened an "AI Video Editor" window, so the main process passed the bundled-FFmpeg verification at startup and created its window; a Chromium process then crashed under Wine (unhandled page fault), which is not evidence about Windows. A copy whose `ffprobe.exe` had one byte appended instead showed the dialog "Could not open AI Video Editor" and logged: "The video tools that come with AI Video Editor are missing or damaged. Reinstall the app to repair them."
- **Export with the Windows FFmpeg**: the app's real `exportDraft` ran against the bundled `ffmpeg.exe`/`ffprobe.exe` under Wine (fixture made by the guest's native FFmpeg): lossless master FFV1 + PCM `f32le`, 45 frames, decoded samples equal the canonical render (`samplesEqual: true`); "Smaller file" H.264/AAC MP4 via OpenH264, 45 frames, decodes. Wine cannot hand Node's socket-backed stdio to a Windows process, so the test shim routes stdin and stdout through `cat`, and the Wine server had to be started before the pipes were created; this is a Wine limitation of the harness, and whether Node pipes work with Windows processes on Windows is exactly what the app relies on (it did not run there).
- A Linux `--release` package carries the release fuse state of section 8 (read back from the real binary by `tests/media/electron-fuses.test.ts`), the default Linux build keeps the inspector fuse on, and the release-fused Linux package still opens its window under Xvfb.

## Not run

Everything below is untested: the items in "Not verified", plus the standard release checks of `docs/24_INSTALLER_RELEASE.md`.

## Not verified

- Anything on real Windows: installer UI, shortcut, per-user path rules, uninstall prompts, SmartScreen, antivirus behaviour, long paths, non-ASCII user names, install on a clean image.
- Launching the app on Windows (Electron main, preload, renderer, capture with `gdigrab`/`dshow`, WASAPI, camera), Codex and Claude on Windows, local transcription with the Windows ONNX runtime.
- Individual library licences and patent positions inside the FFmpeg DLLs; H.264 patent licensing.
- That the Windows `codex.exe` works without its sandbox helper files and `rg.exe`.
- WiX on Linux; electron-builder beyond reading its source.
- The legal sufficiency of the notices; this is engineering work, not legal advice.

## What the user must supply

- A code-signing certificate or signing service account, and the decision on identity/publisher name.
- A clean Windows 10/11 image for the release checks in `docs/24_INSTALLER_RELEASE.md`.
- An app icon (`.ico`); the exe currently carries Electron's default icon.
- Hosting for the FFmpeg source and recipe mirror beside releases; legal review of H.264 and notices.

## Addendum (2026-10-25): rebuilt from the final source

The release build was repeated from the committed tree after the interface redesign, sound layers and one-click edit (`node scripts/build_desktop.mjs --platform win32 --release` in the guest, installer 0.0.1). The Wine smoke test passed again: silent install of 2,526 files in 135 s, the installed tree equal to the packaged tree (2,525 files compared, 0 problems), the Start-menu shortcut and the Apps and features entry written, the installed `ffmpeg.exe` running, an upgrade install leaving 2,526 files, and the silent uninstall removing the folder, shortcut and registry key while leaving the user project folder untouched. Same limits as above: Wine only, nothing ran on real Windows, the installer is unsigned.

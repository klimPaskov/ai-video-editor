---
name: release-packaging
description: Build, install, test, and verify the Windows desktop release.
---

# Release packaging

## Use when

Changing installer, bundled tools, first-run setup, updates, uninstall, or release artifacts.

## Procedure

1. Pin and inventory dependencies.
2. Check redistribution and licence terms.
3. Package local renderer and sidecars.
4. Build installer and checksum.
5. Install on a clean isolated Windows image.
6. Run first launch, login, import, virtual recording, Magic Wand, manual edit, export, restart, and uninstall tests.
7. Verify uninstall preserves projects by default.
8. Record exact artifact hash and signing status.

## Windows build in the guest

Read `docs/adr/0022-windows-release.md` and the Windows section of `docs/24_INSTALLER_RELEASE.md` first. In the isolated Linux guest: `node scripts/build_desktop.mjs --platform win32 --release` (add `--fast-installer` for smoke tests; set `MAKENSIS` and `NSISDIR` for a relocated NSIS). Pins, hashes and licences are in `scripts/windows/windows-release.json`; change a pin only with its new size and SHA-256, a lockfile-consistent Codex entry, a fresh LGPL configuration check and updated `THIRD_PARTY_NOTICES.md`. Never bundle a GPL or nonfree FFmpeg. Never launch the exe or installer on the user's host; Wine in the guest is a smoke test, not Windows evidence. Label every item not run on real Windows as untested.

## Rule

Do not claim a signed or production-ready release without available signing credentials and a verified signature.

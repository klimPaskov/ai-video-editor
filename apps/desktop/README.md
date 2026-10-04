# apps/desktop

The packaged Electron app imports immutable source copies, creates persistent projects and draft timelines, navigates the five workflow stages, and exposes the guarded Codex account/thread/MCP foundation. It has a sandboxed preload, strict typed IPC, a local-only resource protocol, and main-owned local state. It is not yet the full recorder/editor or the complete P3/P6 project and editing system.

Preview currently accepts only verified native-resolution, full-range BGRA/GBR BT.709 SDR data. Other supported video containers can be preserved, but show an explicit unavailable-preview message. Source library reads use source time. Project reads bind the current draft head and map output time through the committed single main clip; a stale head returns no pixels. The frame transport performs an exact BGRA-to-RGBA channel permutation; the canvas fits that frame to the visible area and never supplies master inputs. No lossy preview file, audio playback, automatic edit, or export is implied.

Settings persists 100%, 125%, 150%, or 200% interface size through main-owned validated storage. Ctrl+, opens its modal; Escape or Cancel discards unsaved choices and returns focus. Source details and the Codex drawer are mutually exclusive beside the preview. A resumed real project thread restores only its bounded, redacted recent message/activity projection; main replaces server item identities before typed IPC, and an authoritative active turn remains interruptible. The five-stage project shell and signed-out Codex foundation have passed their scoped packaged native checks; authenticated history and turns and the later editor remain incomplete.

## Isolated development

Provision and verify `tests/desktop/README.md` first. Never build or launch this application directly on the host.

1. Run `python scripts/stage_desktop.py`. It audits an explicit source subset and prints a fresh guest workspace, without host mounts.
2. In that guest directory run `docker exec -w <guest-workspace> ai-video-editor-desktop npm ci --ignore-scripts`.
3. Run `docker exec -w <guest-workspace> ai-video-editor-desktop npm run desktop:build`. The builder outputs the packaged executable path. It refuses a host build.
4. Run `docker exec -w <guest-workspace> ai-video-editor-desktop npm run test:native -- <packaged-executable>`. It generates and verifies a lossless fixture, imports it via the native window, checks exact canvas pixels, security boundaries, reopening and source hashes. Native test evidence stays private in the guest workspace.
5. Inspect that packaged application through the native guest viewer as well. Playwright screenshots alone do not prove the computer-use pass.

FFmpeg/ffprobe are externally installed test dependencies. They are not bundled. The packaged binary is a development artifact, not a signed installer or a Windows release. Later phases add recording, full editing/playback, Magic Wand, review, export and release packaging.

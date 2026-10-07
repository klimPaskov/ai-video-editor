# Desktop app

The Electron application: `src/` holds the main process, preload scripts and services; `renderer/` holds the interface.

- **Main process** (`src/main.ts`): owns all files, devices, FFmpeg processes and AI connections. The renderer talks to it only through typed IPC channels (`src/bridge.ts`) whose requests and replies are validated on both sides.
- **Services**: recording (`recording.ts`), playback copies (`playback-proxies.ts`), export (`export.ts`), short clips (`short-clips.ts`), Magic Edit (`magic-wand.ts`), captions and audio settings, and the Claude, Codex and API-provider assistants (`claude.ts`, `codex.ts`, `api-thread.ts`).
- **Renderer** (`renderer/`): the five-step project screen, timeline strip, preview with zoom and caption overlays, and the dialogs. It loads only packaged local content under a strict Content Security Policy.
- **Area picker** (`renderer/region.*`, `src/region-preload.ts`): the overlay used to record part of the screen.

## Building

```bash
npm run desktop:build:local
```

This bundles the app with esbuild and packages it with Electron Packager. The output path of the executable is printed at the end. See the [getting started guide](../../docs/guide/getting-started.md).

Contributors and agents run native UI tests in an isolated desktop environment; see [native testing](../../tests/desktop/README.md).

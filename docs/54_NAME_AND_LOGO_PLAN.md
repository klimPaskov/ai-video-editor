# Product name and logo plan

Status (2026-11-02): the owner chose **Urushi** (Japanese lacquer) and approved the gold brush-stroke mark traced from the image-model draft (`docs/brand/imagegen/urushi-new-1-gold-stroke.png`, vectors in `docs/brand/urushi/`, regenerate with `docs/brand`'s trace script and `scripts/brand/make_icons.mjs`). The display name, window title, installer, Apps and features entry, header mark and app/installer icons use it. The internal slug `ai-video-editor`, the user-data folder, the registry key and `ai-video-editor.exe` are unchanged on purpose, so existing installs keep their projects. Still open: trademark and domain checks (owner), the wordmark typeface and outlined letters, a `.icns` for macOS, and renaming the repository.

## Why decide now

The working name describes the category, so it cannot be protected as a trademark, is hard to find in search and says nothing about the product. The icon is a placeholder play glyph on a blue square. A public release, a signed installer and the launch trailer all need a final name and mark, so this is decided before any of them.

## What the name must do

- Short (one or two words, at most three syllables each), easy to say and spell.
- Says "your screen and your face, edited by an assistant" without naming AI vendors: the app works with Claude, Codex and API providers, so no provider name appears in it.
- Free as a project name, an npm/GitHub name, a `.com` or `.app` domain and a trademark in the software classes (9 and 42) in the owner's market. These checks are the owner's: they need a search of the trademark register and a domain purchase.
- Reads well on a button, in a window title and in the installer.

## Directions to pick from

| Direction | Idea | Example shapes of a name |
| --- | --- | --- |
| Motion and cut | The assistant cuts and moves your footage | one-word verbs and nouns such as "Splice", "Reel", "Cutaway" |
| Presence | Face camera plus screen, the product's point | "Presenter", "Cameo", "Facetime-free" words such as "Overlay" |
| Craft | Calm, finished, handmade look | "Loom"-like crafts words: "Weave", "Thread", "Bench" |

These are directions, not checked candidates. Each candidate needs the register and domain check before it is shown as a real option.

## Logo brief

- One mark that works at 16 px (title bar, taskbar) and at 512 px (installer, store page), in one colour and in two.
- Built from simple geometry: a rounded square or circle that suggests a frame, with one cut or one spark. No play-button cliché, no robot, no brain, no chat bubble.
- A light and a dark version, and a monochrome version for the installer and the About screen.
- Matches the Light Canvas theme: clean white surfaces, one strong blue accent (the default), with the other themes recolouring it.

## Deliverables

1. Name decision (owner) and the one-line description used in the README, installer and store text.
2. Vector master of the mark (SVG), horizontal and stacked lockups, light/dark/mono.
3. App icon set from the master: `.ico` (16, 24, 32, 48, 64, 128, 256), `.icns` for macOS later, 512 and 1024 PNG.
4. Window and taskbar icon wired into Electron, the installer (`installer.nsi` icon and uninstaller icon), the Apps and features entry (`DisplayIcon`) and the shortcut.
5. Home screen and header mark in the renderer.
6. README and docs header, repository social image, trailer end card.

## Where the name lives in the code

The product name is concentrated, so renaming is a small, safe change once the name is chosen:

- `packages/domain/src/app-identity.ts`: `displayName` (shown everywhere). Do NOT change `slug` or `urlScheme` casually: the slug is the user-data folder and the installer registry key, and changing it moves users' projects. A rename that keeps the slug needs no migration; a slug change needs a one-time move of the user-data folder and an installer upgrade path.
- Installer: `PRODUCT_NAME`, `PUBLISHER` and the registry key in `scripts/windows/installer.nsi` and `installer.ts`.
- Packaging: `scripts/build_desktop.mjs`, `package.json` name and product strings.
- Docs: README, `docs/README.md`, THIRD_PARTY_NOTICES.md, LICENSE holder line.
- About 287 files contain the current slug; most are docs and tests that use the slug as a path, so a display-name rename touches far fewer.

## Order of work

1. Owner picks a direction and shortlists three names; owner runs the trademark and domain checks (about an hour with the official registers).
2. Owner picks the name. I update `displayName`, installer strings, docs and tests in one change and rebuild the installer.
3. Logo exploration: I can draft vector candidates in the chosen direction and, if wanted, use the image tool for visual exploration of style (raster only; the final mark is redrawn as SVG). The owner picks one.
4. I produce the icon set, wire it everywhere, and check it on the Home screen, the title bar and the installer.
5. The trailer and the repository page use the final name and mark.

## Not decided

The name, the mark, whether the slug changes, the publisher name shown by Windows (it must match the code-signing certificate when one exists), and the domain.

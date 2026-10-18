# ADR 0021: The editor is a harness for Claude, not a fixed tool pack

- Status: Accepted user requirement (2026-10-18); first slice implemented
- Scope: how Claude runs inside the app; amends ADR 0018's "built-in tools disabled" turn design

## User requirement

The video editor must act as a harness for Claude rather than a deterministic pack of tools. Claude should plan and work the way Claude Code does, with room to produce an impressive production and to keep taking direction from the user.

## Decision

1. **A workspace per project.** Every Claude turn runs in `claude/workspaces/<project_id>` under the app's data. Main keeps it current: `edit.md` (the edited transcript in timeline order with edit times), `project.md` (recordings, durations, canvas, current choices) and `guides/` (story editing, production, motion design). Claude keeps its own plans and notes there. It holds no source media and no paths outside the workspace.
2. **Claude Code's own tools, confined.** Turns run in Claude Code's `--restricted` mode with the built-in `Read`, `Write`, `Edit`, `Glob`, `Grep` and `Task` (subagents) tools. Restricted mode confines the file tools to the workspace, ignores the user's own Claude settings, and keeps command execution and web access off; the app never names `Bash`, `PowerShell` or `WebFetch`. Claude Code's generic skills stay off (`--disable-slash-commands`); the app's guidance lives in the workspace guides and in subagents it defines (`--agents`).
3. **The timeline still changes only through the guarded editor tools.** The 17 MCP tools keep their freshness checks, transaction origin, Undo and immutability rules; main still restricts the rough cut to cutting tools. Export, deletion and spending stay with the user.
4. **The authoritative tool inventory is still enforced.** The `system/init` check now expects exactly the editor tools plus the six built-in tools, with no skills.
5. **Guidance over scripts.** The system prompt is short: who Claude is, where things are, the rails. The playbooks become guides Claude reads and applies with its own judgement.

## Consequences

- Claude can read the whole edit as one file, plan in its workspace, delegate reviews to subagents and iterate, instead of paging through fixed tool calls.
- A Claude Code version without `--restricted` is no longer supported for turns (2.1.302 has it).
- Existing conversations started in the old shared working directory cannot be resumed; the next message starts a new session and says so.
- Later slices: a scriptable graphics runtime (JavaScript animation in the sealed stage, composition files in the workspace) and motion previews for Claude.

## Addendum (2026-10-18): the user's own skills

The user asked that every skill they use in Claude Code, such as HyperFrames, motion-graphics, music-to-video and remotion-to-hyperframes, be available to the app's Claude. Main mirrors the skills folder of the user's normal Claude Code profile (`~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills`) into an app-owned plugin (`claude/skills-plugin`, private data, regular files only, links never followed, size limits, copied only when changed) and each turn loads it with `--plugin-dir`, so they appear as `my-skills:<name>`. Loading skills needs slash commands on, so Claude Code's generic skills load too; skills only guide Claude, and the init check still enforces the exact tool list. A probe on Claude Code 2.1.302 listed all 22 mirrored skills with only the six built-in tools. Skills that say to run `npx hyperframes` cannot run commands here yet: the next slice runs HyperFrames compositions in the app's sealed stage and offers the CLI's check, lint, snapshot and render as app tools.

## Addendum (2026-10-18): HyperFrames compositions

A graphic can be a HyperFrames composition Claude writes in its workspace (`graphics.set` with `composition_path`). Main seals it: local scripts, styles, images and fonts are inlined; pinned jsDelivr files of gsap, lottie-web, three or animejs are rewritten to a local library cache (fetched once by exact URL, then served locally); any other network reference is refused with a reason; the vendored HyperFrames runtime (`@hyperframes/core` 0.8.170, Apache-2.0) and a stage bridge are injected; the page is stored by SHA-256 and the draft graphic carries `composition_sha256` with empty HTML and CSS. The stage plays it in a sandboxed frame (`allow-scripts` only, opaque origin) on the scheme's `composition` host under a policy with no network (`connect-src 'none'`, data: images and fonts). The stage drives it only by seek messages; the bridge seeks the runtime's player (`__player.renderSeek`, or `__hf.seek` when present) and confirms after two paints; export waits for every visible composition to confirm before capturing; a composition's own load or script error is returned to Claude as `composition_rejected` with the reason. The frame and the composition root share the normal color scheme, so the frame stays transparent over the video. GSAP is not vendored: its licence does not clearly cover bundling in a desktop app. The packaged `tests/native/composition.test.ts` places a GSAP composition through the scripted assistant and checks that the export-path picture at 1 s shows the box 100 px along its timeline over visible video, and that the preview uses the sealed frame.

## Addendum (2026-10-18): checking compositions

The skills ask Claude to run `npx hyperframes lint`, `check` and `snapshot`, which it cannot run in restricted mode. `composition.check`, a Claude-only editor tool, does that job in the app: it seals the workspace file as placement would, plays it in the same sealed stage at the exported video's size, audits it at moments across its duration (runtime readiness and errors, duration, timelines, canvas size, text cut off, outside the safe area or too small, motion that never moves) and returns a contact sheet of those moments. The audit runs inside the composition's own sandboxed frame through the stage bridge; the stage only relays it. The workspace's `project.json` now carries the video's `frame` (size and rate) so compositions are laid out for it. Codex and the API-key providers have no workspace and do not list the tool. A native test with the scripted CLI passed: a clean sweep reports no findings and motion in every interval, and a flawed composition's held cut-off headline and small type are found.

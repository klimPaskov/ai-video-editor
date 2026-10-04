# Public development

## Required repository

The project is `ai-video-editor`. During P0, resolve the authenticated GitHub owner, check for an existing repository with that exact name, and create it as public if absent. Inspect ownership, purpose, contents, and existing permissions before reusing one. Do not overwrite unrelated repositories or use the name of an earlier application.

The user has requested public development. Publish reviewed source, specifications, tests, safe UI mockups, and build configuration from the beginning. Do not wait until release. Never make account-wide settings changes or bypass repository protections. If the tool or account cannot create or write the repository, record the exact blocker and continue dependency-safe local work. Do not claim publication has happened.

## Licence and scope

The included MIT licence applies to original project code and documentation. Dependency licences remain their own. Keep an accurate THIRD_PARTY_NOTICES.md and verify redistribution permissions for FFmpeg builds, models, fonts, icons, and other runtime assets. Codex authentication and model access remain subject to their provider terms. An open-source client does not grant a free subscription.

Reference images are generated design mockups provided in this conversation. They are not production assets, real app screenshots, or proof that any depicted feature works. Publish them only as design documentation with the provided provenance. Do not extract depicted photos, faces, logos, fonts, or third-party interfaces as bundled stock assets.

## Every working slice

1. Implement a bounded task with tests and native evidence where applicable.
2. Update affected specs, contracts, skills, routing, prompts, and task state.
3. Review the entire staged diff and scan for private data and large binaries.
4. Commit and push the reviewed working change to a feature branch or the accepted repository workflow.
5. Use a pull request for integrated feature changes and wait for required checks before merging.
6. Record remote commit identity in the phase result. Leave unverified status as unverified.

Never force-push shared history or commit broken state just to show activity. Unfinished work can remain on a clearly labelled branch. The main agent reviews subagent patches before publication.

## Never publish by default

User recordings, project media, exported videos, ChatGPT or API-provider keys, authentication files, local Codex history, model checkpoints, device identifiers, unredacted logs, crash dumps, or example-video evidence. Keep synthetic public fixtures separate from private acceptance data. Generated run evidence belongs in ignored `test-results/`; user-media locators and other machine-local inputs belong in ignored `local-data/`. Neither directory is a publication source. `.gitignore` is only a first barrier: inspect staged paths and content too.

## CI and releases

The included workflow checks this workspace's contracts and reference integrity. Extend it with actual lint, type, unit, media, and Electron tests as those projects are implemented. Do not count the planning checks as app tests.

P9 must build an installable desktop release with verified checksums, correct dependency notices, clean-install tests, and project-preserving uninstall. Signing requires legitimate credentials. A missing signing key is reported honestly and must not be faked. Publish release assets only after their acceptance tests pass.

Public package validation checks accepted record structure and repository-contained artifact references without requiring private evidence in CI. This does not rerun or prove native/media acceptance. The phase-result writer always requires the actual nonempty local artifacts before writing, and reviewed source/remote revision checks remain mandatory. Never publish private artifacts to satisfy public CI.

Repository guidance under `.agents/skills/` and direct Markdown role prompts plus `routing.json` under `.codex/agents/` are reviewed source. The source scanner and staged-content audit permit that narrow agent catalog without permitting account files, sessions, nested runtime data or other `.codex` contents. Reference PNGs remain restricted to `docs/references/screenshots/`; moving their documentation does not authorize publishing other binaries.

Claude Code project source includes `CLAUDE.md` plus reviewed `.claude/settings.json`, direct `agents/` and `rules/` Markdown, and `skills/<name>/SKILL.md` adapters. The source enumerator and index audit admit only these layouts under `.claude/`; local settings, account files, sessions, worktrees and `CLAUDE.local.md` remain private. Credentials are never part of a project login implementation artifact.

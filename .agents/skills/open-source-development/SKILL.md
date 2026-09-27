---
name: open-source-development
description: Publish safe working slices to the public project throughout development.
---

# open-source-development

Read docs/45_OPEN_SOURCE_DEVELOPMENT.md. Resolve the authenticated owner and exact codex-video-edit remote before creating or updating it. Review staged paths and content for secrets, private recordings, models, and unlicensed assets. Commit working changes with current docs and tests. Push and verify the remote commit and checks. Do not force-push or bypass protections. Report access failures without claiming publication. Keep release signing and installer acceptance distinct from source publishing.

Update this reusable workflow when implementation reveals a repeatable failure or verified improvement. Keep project-specific footage and task transcripts out of the skill.

Run `npm run check:publication` after staging. It reads Git index blobs, so a clean worktree copy cannot hide a credential already staged. Review the complete staged diff as well. Keep validation scans bounded to source paths; never recurse through node_modules, Git objects, generated media, or private evidence when building a public integrity manifest.

On the Windows workspace, media test files run serially because concurrent file-level fixtures can make unrelated atomic project-directory renames fail intermittently with `EPERM`. If such a failure appears, rerun the exact fixture alone to classify it, but require the complete `npm run check` to pass before publishing.

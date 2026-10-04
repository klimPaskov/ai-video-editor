# ADR 0017: AI Video Editor product and repository identity

- Status: Accepted user requirement; package and native verification pending
- Date: 2026-10-03

## Decision

Use **AI Video Editor** as the product name and `ai-video-editor` as the package, executable, URL-scheme, public-repository, and working-folder slug. Keep the public repository under the existing authenticated owner and preserve its commit and pull-request history when changing its name.

The packaged desktop app prefers the existing per-user data directory when it is present. It does not move, merge, or delete project data during the identity change; a new install uses the new product slug. Retain the existing MCP server wire identifier and `codex_video_edit` tool namespace as a wire-protocol identifier so stored Codex threads remain compatible.

## Consequences

- Update user-facing names, build metadata, product URLs, schemas, examples, documentation, skills, tests, and publishing guidance together.
- The project remains a local-first standalone Electron app. Codex App Server and the explicit API providers remain distinct AI connections.
- Rename the local project folder only after verifying the destination is absent. Preserve unrelated workspaces and all private test data.
- Verify repository ownership, public visibility, remote URL, pushed revision, CI, packaged Electron identity, saved-data reopening, and isolated native-window behavior before recording completion.

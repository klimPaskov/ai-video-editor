# Claude continuation requirements, 2026-10-04

The user requested Claude account sign-in as the default app AI connection and a handoff for Claude with independent implementation decisions. ADR 0018, root requirements, onboarding/provider notes, active P2 scope/task and traceability now record that requirement. No Claude app auth/runtime/provider code, login completion or native editing evidence exists.

The repository now has `CLAUDE.md`, ignored `CLAUDE.local.md`, documented `.claude/settings.json`, 19 native skill adapters to canonical project guides, 12 native role definitions and a scoped source-guidance rule. Models, auth mechanisms and permission/tool overrides are left to the next Claude session. No agent was spawned and no Claude session was launched to prove discovery.

Spec-sync frontier: the Claude requirement is recorded, while detailed runtime/IPC/provider schemas, prompts, screens, migrations and integration/native tests remain pending the supported design chosen by the next implementer. Existing provider contracts are preserved; reference image bytes are unchanged. The source enumerator, publication auditor and source-transfer path check now admit only reviewed Claude guidance layouts and exclude local settings, credentials, sessions, worktrees and private notes. A regression verifies allowed guidance is scanned and excluded runtime data cannot be force-published.

All rename and handoff work remains uncommitted on the identity branch. Full renamed-package/native acceptance, publication audit, integrity refresh, commit/push and CI are still pending. No phase result or new feature completion is claimed.

Validation: 14 focused foundation tests passed; changed Python scripts compiled; package/delivery checks passed with 77 task IDs and 57 schema/example pairs. All 19 skill frontmatters/canonical references, 12 native agent headers/role references, memory imports and settings/rule structure validated. The worktree audit checked 789 source blobs without traversing private/generated state. Git-index publication audit and native Claude discovery were not performed; the Claude CLI was not available on the current PATH.

## Implementation update, 2026-10-04

The Claude connection is implemented as described in `docs/48_CLAUDE_CONNECTION.md` and ADR 0018's Decision section, with host and signed-out native evidence recorded in `docs/workflow/progress/P2.md`. The identity slice was validated (host check, publication audit, packaged identity and desktop smoke in the WSL2 guest) and published as PR #62. Remaining P2-11 gate: real signed-in acceptance after the user completes Anthropic's sign-in in the guest.


# AI Video Editor: Claude project context

You own the engineering decisions. Reassess prior assistant designs against the code, evidence and current user requirements; revise them when justified. Preserve existing work and report tested outcomes accurately.

The latest user requirement is supported Claude account sign-in as the editor's default AI connection. It is implemented through the user's unmodified Claude Code CLI (`docs/48_CLAUDE_CONNECTION.md`); signed-out native behavior is verified and signed-in acceptance needs a user-completed Anthropic sign-in. Codex and existing API routes remain supported alternatives. The Codex-only Luna/high preference does not select your Claude implementation model.

Read `HANDOFF_PROMPT.md` when taking over this current work. Machine-specific footage and guest context are in ignored `CLAUDE.local.md`/`local-data/HANDOFF_PRIVATE.md` when present. Native app launches stay in isolation, never on the user's host. Never use Astra agents.

Project skills are discoverable in `.claude/skills/`; their canonical guidance lives in `.agents/skills/`. Optional native Claude role definitions are in `.claude/agents/`. Choose whether and how to delegate; consult actual available Claude tools instead of assuming the prior agent's APIs exist.

@AGENTS.md
@adr/0018-claude-default-sign-in.md

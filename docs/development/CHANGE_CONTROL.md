# Change control

## Workflow change rule

A workflow change includes any change to recording, AI behavior, project state, editing, preview, export, screen flow, user approval, error recovery, or data sharing.

Before merge, update:

1. the main feature spec
2. affected screen specs
3. timeline or project schema
4. task IDs and dependencies
5. tests and fixtures
6. Codex tool contract and prompt when relevant
7. skill and subagent guidance
8. traceability
9. screenshot manifest when visual references change
10. migration notes for stored projects

## Decision record rule

Create or update an ADR when a change affects the desktop shell, storage model, Codex integration, media clock, security boundary, supported platform, or source immutability.

## Evidence rule

Do not check a task merely because code exists. Record the command, build revision, test environment, fixture hash, output hash, visual inspection, and known warnings in the phase result.

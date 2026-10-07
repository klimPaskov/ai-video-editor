# ADR 0003: Step-based quiet interface

- Status: Accepted starting decision
- Date: 2026-09-04

## Decision

Use five project stages: Record or Import, Auto Edit, Edit, Review, and Export. Show only the current stage and one selected tool inspector.

## Consequences

- No permanent feature sidebar with every section open.
- AI activity is concise and collapsible.
- Logs and process details live under Diagnostics.
- Advanced settings are hidden by default.
- Feature discovery uses contextual actions, tooltips, and the Magic Wand menu.

## Revision, 2026-09-05

The current user instruction supersedes the historical four-stage starting decision. Edit owns manual timeline refinement; Review owns watch-through, revision comparison and quality findings. QA remains an internal screen identifier within Review, not an additional project stage. Home, onboarding and settings remain outside the five project stages. Revisit stages without discarding the active draft. This contract correction is not evidence of implemented navigation.

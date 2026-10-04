# JSON Schemas

These versioned contracts define persistent project artifacts, live editing operations, UI state, Codex actions, QA, export, references, screens, tools, skills, routes, and phase results.

Schemas compose repository peers through stable `https://schemas.ai-video-editor.invalid/` identifiers. Package validation resolves those identifiers only from the checked-in `docs/schemas/` registry and never from the network. `x-uniqueBy` is an application annotation enforced by the matching strict runtime validator where JSON Schema's `uniqueItems` cannot express uniqueness of one object property.

Run `python scripts/validate_package.py` after changing a schema. Stored project data keeps its original version and requires an explicit migration when a breaking change is introduced.

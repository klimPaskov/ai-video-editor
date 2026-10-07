# Documentation

## Using the app

- [User guide](guide/README.md): getting started, recording, editing, the AI assistant, export and privacy.

## How it is built

The numbered documents are the product and engineering specifications. Many end with dated *Implemented* sections that record what exists and how it was verified.

### Product and workflow

- [Source brief](00_SOURCE_BRIEF.md)
- [Product requirements](01_PRODUCT_REQUIREMENTS.md)
- [User workflow](02_USER_WORKFLOW.md)
- [Simple UI specification](04_SIMPLE_UI_SPEC.md)
- [Screen specifications](05_SCREEN_SPECS.md)
- [Simple native design system](33_DESIGN_SYSTEM.md)
- [Screen acceptance criteria](35_SCREEN_ACCEPTANCE.md)

### Architecture and data

- [Native app architecture](03_NATIVE_APP_ARCHITECTURE.md)
- [Import and project specification](07_IMPORT_AND_PROJECTS.md)
- [Media pipeline](16_MEDIA_PIPELINE.md)
- [Project data and revisions](17_PROJECT_DATA_AND_REVISIONS.md)
- [Live state, transactions, and undo](31_LIVE_STATE_AND_UNDO.md)
- [AI selector and provider settings](39_AI_SELECTOR_AND_SETTINGS.md)
- [Claude connection](48_CLAUDE_CONNECTION.md)

### Recording

- [Recording engine specification](06_RECORDING_ENGINE.md)
- [Recording telemetry and privacy](36_RECORDING_TELEMETRY.md)

### Editing and automation

- [Magic Wand and automation specification](09_MAGIC_WAND_AND_AUTOMATIONS.md)
- [Simple timeline editor](10_TIMELINE_EDITOR.md)
- [Automatic zoom specification](11_AUTOMATIC_ZOOMS.md)
- [Speed and pacing specification](12_SPEED_AND_PACING.md)
- [Transcript and captions](13_TRANSCRIPT_AND_CAPTIONS.md)
- [B-roll, layouts, and elements](14_BROLL_LAYOUTS_AND_ELEMENTS.md)
- [Audio specification](15_AUDIO.md)
- [Magic Wand pipeline](32_MAGIC_WAND_PIPELINE.md)
- [Camera and layout specification](37_CAMERA_LAYOUTS.md)
- [Local B-roll matching](38_BROLL_MATCHING.md)
- [Editorial first-cut requirements](47_EDITORIAL_FIRST_CUT.md)
- [Short clips](49_SHORT_CLIPS.md)
- [Full AI edit](50_FULL_AI_EDIT.md)

### AI assistants and tools

- [Real Codex integration](08_CODEX_INTEGRATION.md)
- [Codex tool catalog](30_CODEX_TOOL_CATALOG.md)

### Export, release and quality

- [Export and delivery](18_EXPORT_AND_DELIVERY.md)
- [Quality assurance and acceptance](19_QA_AND_ACCEPTANCE.md)
- [Native computer-use testing](20_NATIVE_COMPUTER_USE_TESTING.md)
- [Accessibility](22_ACCESSIBILITY.md)
- [Performance targets](23_PERFORMANCE.md)
- [Installer and release](24_INSTALLER_RELEASE.md)
- [Error and recovery specification](25_ERROR_RECOVERY.md)
- [Test fixture matrix](34_TEST_FIXTURE_MATRIX.md)
- [User example sequence final acceptance](40_EXAMPLE_VIDEO_FINAL_ACCEPTANCE.md)
- [Lossless-first media policy](44_LOSSLESS_MEDIA_POLICY.md)

### Security and open source

- [Security and privacy](21_SECURITY_PRIVACY.md)
- [Public development](45_OPEN_SOURCE_DEVELOPMENT.md)

### Project management

- [Reference integration](26_REFERENCE_SCREENSHOT_PROCESS.md)
- [Traceability](27_TRACEABILITY.md)
- [Out of scope for first release](28_OUT_OF_SCOPE.md)
- [Glossary](29_GLOSSARY.md)
- [Specification update protocol](41_SPEC_UPDATE_PROTOCOL.md)
- [Risk register](42_RISK_REGISTER.md)
- [Open decisions](43_OPEN_DECISIONS.md)
- [P0 foundation slice](46_P0_FOUNDATION.md)

## Reference material

- [Architecture decision records](adr/)
- [JSON schemas](schemas/) and [examples](examples/)
- [Tool and protocol contracts](contracts/)
- [Research notes](research/)
- [UI reference images and notes](references/IMPLEMENTATION_NOTES.md)
- [Checklists](checklists/) and [templates](templates/)

## Development process

These files guide contributors and the AI agents that develop the app.

- [Task list](development/TASKS.md) and [workflow](development/WORKFLOW.md)
- [Planning package](development/PLANNING_PACKAGE.md), [goal prompt](development/GOAL_PROMPT.md) and [source priority](development/AUTHORITATIVE_ORDER.md)
- [Handoff prompt](development/HANDOFF_PROMPT.md) for continuing work in Claude Code
- [Phase prompts and progress](workflow/) and [agent prompts](prompts/)
- [Change control](development/CHANGE_CONTROL.md) and [subagent routing](development/SUBAGENT_ROUTING.md)

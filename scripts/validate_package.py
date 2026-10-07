#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from workspace_files import source_files

try:
    from jsonschema import Draft202012Validator, FormatChecker
    from referencing import Registry, Resource
except ImportError as exc:
    raise SystemExit('Install jsonschema to validate this package: python -m pip install jsonschema') from exc

ROOT = Path(__file__).resolve().parents[1]
errors: list[str] = []
warnings: list[str] = []


def fail(message: str) -> None:
    errors.append(message)


def warn(message: str) -> None:
    warnings.append(message)


def load_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:
        fail(f'{path.relative_to(ROOT)} is not valid JSON: {exc}')
        return {}


required_paths = [
    'GOAL_PROMPT.md', 'AGENTS.md', 'CLAUDE.md', 'HANDOFF_PROMPT.md', '.claude/settings.json',
    'AUTHORITATIVE_ORDER.md', 'PLANNING_PACKAGE.md',
    'WORKFLOW.md', 'TASKS.md', 'SUBAGENT_ROUTING.md', 'CHANGE_CONTROL.md',
    'docs/workflow/active-phase.md', 'docs/00_SOURCE_BRIEF.md', 'docs/03_NATIVE_APP_ARCHITECTURE.md',
    'docs/08_CODEX_INTEGRATION.md', 'docs/09_MAGIC_WAND_AND_AUTOMATIONS.md',
    'docs/10_TIMELINE_EDITOR.md', 'docs/19_QA_AND_ACCEPTANCE.md',
    'docs/20_NATIVE_COMPUTER_USE_TESTING.md', 'docs/26_REFERENCE_SCREENSHOT_PROCESS.md',
    'docs/research/RESEARCH.md', 'docs/examples/index.json', 'docs/references/manifest.json',
    '.agents/skills/index.json', '.codex/agents/routing.json', 'docs/contracts/screens.json',
    'docs/contracts/codex-tools.json',
]
for rel in required_paths:
    if not (ROOT / rel).is_file():
        fail(f'Missing required file: {rel}')

# Goal contract
goal_path = ROOT / 'GOAL_PROMPT.md'
if goal_path.exists():
    goal = goal_path.read_text(encoding='utf-8')
    goal_chars = len(goal)
    if goal_chars >= 4000:
        fail(f'GOAL_PROMPT.md has {goal_chars} characters and must stay under 4000')
    if goal_chars < 1800:
        warn(f'GOAL_PROMPT.md is only {goal_chars} characters and may omit material constraints')
    for phrase in ['standalone desktop', 'Codex', 'Magic Wand', 'isolated', 'user-supplied example video']:
        if phrase.lower() not in goal.lower():
            fail(f'GOAL_PROMPT.md is missing required concept: {phrase}')
else:
    goal_chars = 0

# JSON schema and example pairs
index = load_json(ROOT / 'docs/examples/index.json')
pairs = index.get('pairs', []) if isinstance(index, dict) else []
if len(pairs) < 20:
    fail(f'Expected at least 20 schema/example pairs, found {len(pairs)}')
format_checker = FormatChecker()
registry = Registry()
for reusable_schema_path in (ROOT / 'docs/schemas').glob('*.json'):
    reusable_schema = load_json(reusable_schema_path)
    if not isinstance(reusable_schema, dict):
        continue
    resource = Resource.from_contents(reusable_schema)
    registry = registry.with_resource(reusable_schema_path.resolve().as_uri(), resource)
    schema_id = reusable_schema.get('$id')
    if isinstance(schema_id, str):
        registry = registry.with_resource(schema_id, resource)
for pair in pairs:
    if not isinstance(pair, dict):
        fail('docs/examples/index.json contains a non-object pair')
        continue
    schema_path = ROOT / str(pair.get('schema', ''))
    example_path = ROOT / str(pair.get('example', ''))
    if not schema_path.is_file():
        fail(f'Missing schema: {schema_path.relative_to(ROOT)}')
        continue
    if not example_path.is_file():
        fail(f'Missing example: {example_path.relative_to(ROOT)}')
        continue
    schema = load_json(schema_path)
    example = load_json(example_path)
    try:
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema, format_checker=format_checker, registry=registry)
        for issue in validator.iter_errors(example):
            location = '.'.join(str(x) for x in issue.absolute_path) or '<root>'
            fail(f'{example_path.relative_to(ROOT)} at {location}: {issue.message}')
    except Exception as exc:
        fail(f'Could not validate {schema_path.relative_to(ROOT)}: {exc}')

# Validate live manifests against their schemas
live_pairs = [
    ('docs/references/manifest.json', 'docs/schemas/reference_manifest.schema.json'),
    ('docs/contracts/screens.json', 'docs/schemas/screen_manifest.schema.json'),
    ('docs/contracts/codex-tools.json', 'docs/schemas/tool_manifest.schema.json'),
    ('.agents/skills/index.json', 'docs/schemas/skill_manifest.schema.json'),
    ('.codex/agents/routing.json', 'docs/schemas/subagent_routing.schema.json'),
]
for data_rel, schema_rel in live_pairs:
    data_path, schema_path = ROOT / data_rel, ROOT / schema_rel
    if not data_path.exists() or not schema_path.exists():
        continue
    data, schema = load_json(data_path), load_json(schema_path)
    validator = Draft202012Validator(schema, format_checker=format_checker, registry=registry)
    for issue in validator.iter_errors(data):
        location = '.'.join(str(x) for x in issue.absolute_path) or '<root>'
        fail(f'{data_rel} at {location}: {issue.message}')

# Public checkouts validate records and safe artifact references, not absent private evidence.
# The result writer separately requires all actual local artifacts before acceptance.
from write_phase_result import validate_record
for result_path in (ROOT / 'docs/workflow/results').glob('P*.json'):
    try:
        result = load_json(result_path)
        validate_record(result, ROOT)
        if result_path.stem != result['phase_id']:
            fail(f'Phase result filename mismatch: {result_path.name}')
    except Exception as exc:
        fail(f'Invalid accepted phase result {result_path.name}: {exc}')

# Task IDs and phase prompt coverage
tasks_path = ROOT / 'TASKS.md'
tasks_text = tasks_path.read_text(encoding='utf-8') if tasks_path.exists() else ''
task_ids = re.findall(r'\bP(?:10|[0-9])-\d{2}\b', tasks_text)
if len(task_ids) != len(set(task_ids)):
    duplicates = sorted({x for x in task_ids if task_ids.count(x) > 1})
    fail(f'Duplicate task IDs: {duplicates}')
for phase in [f'P{i}' for i in range(11)]:
    if not any(task.startswith(phase + '-') for task in task_ids):
        fail(f'TASKS.md has no tasks for {phase}')
    phase_files = list((ROOT / 'docs/workflow/phases').glob(f'{phase}_*.md'))
    if len(phase_files) != 1:
        fail(f'Expected one phase prompt for {phase}, found {len(phase_files)}')
    elif phase not in phase_files[0].read_text(encoding='utf-8'):
        fail(f'{phase_files[0].relative_to(ROOT)} does not identify {phase}')

# Skills
skills = load_json(ROOT / '.agents/skills/index.json')
seen_skills: set[str] = set()
for item in skills.get('skills', []) if isinstance(skills, dict) else []:
    name = item.get('name')
    path = ROOT / str(item.get('path', ''))
    if name in seen_skills:
        fail(f'Duplicate skill name: {name}')
    seen_skills.add(name)
    if not path.is_file():
        fail(f'Missing skill file: {path.relative_to(ROOT)}')
        continue
    text = path.read_text(encoding='utf-8')
    if f'name: {name}' not in text:
        fail(f'{path.relative_to(ROOT)} front matter does not match skill name {name}')

# Subagent routes
routes = load_json(ROOT / '.codex/agents/routing.json')
seen_agents: set[str] = set()
for route in routes.get('routes', []) if isinstance(routes, dict) else []:
    agent = route.get('subagent')
    path = ROOT / str(route.get('path', ''))
    if agent in seen_agents:
        fail(f'Duplicate subagent route: {agent}')
    seen_agents.add(agent)
    if not path.is_file():
        fail(f'Missing subagent file: {path.relative_to(ROOT)}')
    for skill in route.get('skills', []):
        if skill not in seen_skills:
            fail(f'Subagent {agent} references unknown skill {skill}')

# Screen IDs and references
screens = load_json(ROOT / 'docs/contracts/screens.json')
screen_ids = [s.get('screen_id') for s in screens.get('screens', [])] if isinstance(screens, dict) else []
if len(screen_ids) != len(set(screen_ids)):
    fail('docs/contracts/screens.json has duplicate screen IDs')
screen_spec = (ROOT / 'docs/05_SCREEN_SPECS.md').read_text(encoding='utf-8')
for screen_id in screen_ids:
    if str(screen_id) not in screen_spec:
        fail(f'docs/05_SCREEN_SPECS.md is missing {screen_id}')
refs = load_json(ROOT / 'docs/references/manifest.json')
seen_refs: set[str] = set()
for ref in refs.get('references', []) if isinstance(refs, dict) else []:
    ref_id = ref.get('reference_id')
    if ref_id in seen_refs:
        fail(f'Duplicate reference ID: {ref_id}')
    seen_refs.add(ref_id)
    for screen_id in ref.get('screen_ids', []):
        if screen_id not in screen_ids:
            fail(f'Reference {ref_id} maps to unknown screen {screen_id}')
    ref_path = ROOT / str(ref.get('path', ''))
    if not ref_path.is_file():
        fail(f'Reference file does not exist: {ref_path.relative_to(ROOT)}')

# Guarded tools
tools = load_json(ROOT / 'docs/contracts/codex-tools.json')
tool_names = [t.get('name') for t in tools.get('tools', [])] if isinstance(tools, dict) else []
if len(tool_names) != len(set(tool_names)):
    fail('docs/contracts/codex-tools.json has duplicate tool names')
for forbidden in ['source.overwrite', 'project.delete', 'export.confirm', 'shell.run']:
    if forbidden in tool_names:
        fail(f'Forbidden Codex tool is exposed: {forbidden}')

# Style and package safety
text_extensions = {'.md', '.json', '.py', '.txt'}
for path in source_files(ROOT):
    if path.is_symlink():
        fail(f'Symlink is not allowed in package: {path.relative_to(ROOT)}')
    if path.is_file() and path.suffix.lower() in text_extensions:
        text = path.read_text(encoding='utf-8', errors='replace')
        if '\u2014' in text:
            warn(f'Em dash found in {path.relative_to(ROOT)}')
        if path.stat().st_size > 2_000_000:
            warn(f'Large text file: {path.relative_to(ROOT)}')

print(f'Goal characters: {goal_chars}')
print(f'Schema/example pairs: {len(pairs)}')
print(f'Task IDs: {len(task_ids)}')
print(f'Skills: {len(seen_skills)}')
print(f'Subagents: {len(seen_agents)}')
print(f'Screens: {len(screen_ids)}')
print(f'Codex tools: {len(tool_names)}')
for message in warnings:
    print(f'WARNING: {message}')
for message in errors:
    print(f'ERROR: {message}')
if errors:
    raise SystemExit(1)
print('Package validation passed.')

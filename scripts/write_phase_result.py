"""Validate phase evidence before atomically recording an accepted phase result.

Incomplete work belongs in docs/workflow/progress/, not in accepted
docs/workflow/results/.
This checks evidence structure and existence; it cannot replace human review.
"""
import argparse
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]


def validate_record(result, root: Path):
    """Validate a portable published record, without claiming local artifact access."""
    schema = json.loads((root / 'docs/schemas/phase_result.schema.json').read_text(encoding='utf-8'))
    Draft202012Validator(schema).validate(result)
    if result['status'] != 'complete':
        raise ValueError('Only accepted complete phases belong in results; use docs/workflow/progress for blockers')
    if not result['checks'] or any(check['status'] != 'pass' for check in result['checks']):
        raise ValueError('All acceptance checks must pass')
    if datetime.fromisoformat(result['ended_at'].replace('Z', '+00:00')) < datetime.fromisoformat(result['started_at'].replace('Z', '+00:00')):
        raise ValueError('Phase end precedes start')
    phase = result['phase_id']
    expected = set(re.findall(r'\b' + phase + r'-\d{2}\b', (root / 'docs/development/TASKS.md').read_text(encoding='utf-8')))
    if not expected or set(result['task_ids']) != expected:
        raise ValueError('Result must cover exactly all phase task IDs')
    if not result.get('spec_sync'):
        raise ValueError('A spec-sync record is required')
    if not re.fullmatch(r'[a-f0-9]{40}', result.get('code_revision') or ''):
        raise ValueError('A full reviewed Git commit is required')
    native = result.get('native_test', {})
    if not all(native.get(key) is True for key in ('launched', 'playwright', 'computer_use')) or not native.get('screenshot_paths'):
        raise ValueError('Native launch, Playwright and computer-use evidence are required')
    evidence = set(result['artifacts'])
    for check in result['checks']:
        evidence.update(check.get('evidence', []))
    evidence.update(native.get('screenshot_paths', []))
    evidence.update(native.get('recording_paths', []))
    if not evidence:
        raise ValueError('Acceptance evidence is required')
    for relative in evidence:
        path = root / relative
        if Path(relative).is_absolute() or root.resolve() not in path.resolve().parents:
            raise ValueError('Evidence must stay inside the repository')
    return evidence


def validate_result(result, root: Path):
    """Validate acceptance locally; writing never bypasses artifact existence."""
    for relative in validate_record(result, root):
        path = root / relative
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError('Evidence is missing or empty: ' + relative)


def write_result(result, root: Path):
    validate_result(result, root)
    destination = root / 'docs/workflow/results' / (result['phase_id'] + '.json')
    if destination.exists():
        raise ValueError('Phase result already exists; review it before replacement')
    dirty = subprocess.check_output(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd=root)
    if dirty:
        raise ValueError('Commit all source and index changes before binding evidence to a revision')
    revision = result['code_revision']
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if revision != head:
        raise ValueError('Evidence revision is not HEAD')
    remote = subprocess.check_output(['git', 'ls-remote', 'origin'], cwd=root, text=True, timeout=30)
    if not any(line.split()[0] == revision for line in remote.splitlines()):
        raise ValueError('Reviewed revision is not verified on origin')
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, staging = tempfile.mkstemp(dir=destination.parent, suffix='.tmp')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(result, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        # A hard link publishes only if destination does not already exist.
        os.link(staging, destination)
    finally:
        Path(staging).unlink(missing_ok=True)
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    print(write_result(json.loads(args.input.read_text(encoding='utf-8')), ROOT))

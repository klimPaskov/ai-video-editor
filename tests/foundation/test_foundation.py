import copy
import json
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from audit_publication import audit_blob, audit_index
from workspace_files import source_files, source_digest
from write_phase_result import validate_record, validate_result, write_result


class PublicationTests(unittest.TestCase):
    def test_audits_index_bytes_even_if_worktree_has_been_cleaned(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            path = root / 'notes.txt'
            path.write_text('safe source')
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            self.assertEqual(audit_index(root), 1)
            path.write_text('ghp_' + 'b' * 36)
            subprocess.run(['git', 'add', '.'], cwd=root, check=True)
            path.write_text('safe source')
            with self.assertRaisesRegex(ValueError, 'credential'):
                audit_index(root)

    def test_permitted_source_and_generated_reference(self):
        audit_blob('packages/domain/src/time.ts', b'export const value = 1;', '100644')
        audit_blob('docs/references/screenshots/current/example.png', b'\x89PNG\x00', '100644')

    def test_private_paths_and_renamed_credentials_rejected(self):
        for path in ('private/data.json', 'test-results/test.json', 'local-data/input.json', '.env.local', 'fixtures/user-example/video.txt', 'image.raw', 'app.exe', 'TEST-RESULTS/check.json', 'Recordings/project.json', '.ENV'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                audit_blob(path, b'data', '100644')
        with self.assertRaises(ValueError):
            audit_blob('innocent.txt', ('ghp_' + 'a' * 36).encode(), '100644')
        with self.assertRaises(ValueError):
            audit_blob('link', b'/private/file', '120000')

    def test_private_trees_are_not_traversed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for path in ('src/file.ts', 'node_modules/pkg/file.ts', '.git/config', 'test-results/private.json', 'local-data/input.json', 'Recordings/data.json', 'TEST-RESULTS/hidden.json', 'fixtures/user-example/nested/private.json'):
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('data')
            self.assertEqual([p.relative_to(root).as_posix() for p in source_files(root)], ['src/file.ts'])

    def test_moved_agent_guidance_is_scanned_without_runtime_data(self):
        public = ('.codex/agents/native-qa.md', '.codex/agents/routing.json',
                  '.agents/skills/native-electron/SKILL.md', 'docs/schemas/project.schema.json')
        private = ('.codex/auth.json', '.codex/config.toml', '.codex/sessions/turn.json',
                   '.codex/agents/auth.json', '.codex/agents/nested/prompt.md',
                   'other/.codex/agents/prompt.md')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for path in public + private:
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('safe source')
            self.assertEqual({p.relative_to(root).as_posix() for p in source_files(root)}, set(public))
        for path in public:
            audit_blob(path, b'safe source', '100644')
        for path in private:
            with self.subTest(path=path), self.assertRaises(ValueError):
                audit_blob(path, b'safe source', '100644')
        with self.assertRaisesRegex(ValueError, 'credential'):
            audit_blob('.codex/agents/native-qa.md', ('ghp_' + 'a' * 36).encode(), '100644')

    def test_reference_binary_allowance_stays_in_moved_reference_tree(self):
        audit_blob('docs/references/screenshots/current/example.png', b'\x89PNG\x00', '100644')
        for path in ('references/screenshots/current/example.png', 'docs/private/example.png',
                     'docs/references/example.png', '.codex/agents/example.md'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                audit_blob(path, b'\x89PNG\x00', '100644')

    def test_claude_guidance_is_scanned_without_account_or_local_runtime_data(self):
        public = ('CLAUDE.md', '.claude/README.md', '.claude/settings.json',
                  '.claude/agents/native-qa.md', '.claude/rules/agent-source.md',
                  '.claude/skills/native-electron/SKILL.md')
        private = ('CLAUDE.local.md', 'apps/CLAUDE.local.md', '.claude/auth.json',
                   '.claude/.credentials.json', '.claude/settings.local.json',
                   '.claude/sessions/turn.json', '.claude/worktrees/project/code.ts',
                   '.claude/agents/credentials.json', '.claude/agents/nested/prompt.md',
                   '.claude/skills/native-electron/account.json',
                   '.claude/skills/native-electron/references/private.md',
                   'other/.claude/agents/native-qa.md')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for path in public + private:
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('safe source')
            self.assertEqual({p.relative_to(root).as_posix() for p in source_files(root)}, set(public))
        for path in public:
            audit_blob(path, b'safe source', '100644')
        for path in private:
            with self.subTest(path=path), self.assertRaises(ValueError):
                audit_blob(path, b'safe source', '100644')
        with self.assertRaisesRegex(ValueError, 'credential'):
            audit_blob('.claude/settings.json', ('sk-ant-' + 'a' * 40).encode(), '100644')

    def test_source_integrity_is_portable_but_binary_bytes_remain_exact(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'source.txt'
            path.write_bytes(b'line\r\n')
            digest = source_digest(path)
            path.write_bytes(b'line\n')
            self.assertEqual(source_digest(path), digest)
            path.write_bytes(b'\x00\r\n')
            digest = source_digest(path)
            path.write_bytes(b'\x00\n')
            self.assertNotEqual(source_digest(path), digest)


class PhaseResultTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'docs/schemas').mkdir(parents=True)
        (self.root / 'docs/schemas/phase_result.schema.json').write_bytes((ROOT / 'docs/schemas/phase_result.schema.json').read_bytes())
        (self.root / 'TASKS.md').write_text('- [ ] P0-01 Test\n- [ ] P1-01 Native\n')
        (self.root / 'evidence.txt').write_text('synthetic test evidence')
        self.result = {
            'schema_version': '1.0', 'phase_id': 'P0', 'status': 'complete',
            'started_at': '2026-09-05T01:00:00Z', 'ended_at': '2026-09-05T01:01:00Z',
            'task_ids': ['P0-01'], 'summary': 'Unit fixture, not actual phase evidence',
            'checks': [{'name': 'fixture', 'status': 'pass', 'command_or_method': 'unit fixture'}],
            'artifacts': ['evidence.txt'], 'known_limits': [], 'code_revision': 'a' * 40,
            'spec_sync': {'changed': ['test fixture'], 'unchanged': ['product']},
            'native_test': {'launched': True, 'playwright': True, 'computer_use': True, 'screenshot_paths': ['evidence.txt']},
        }

    def test_valid_structural_evidence(self):
        validate_result(self.result, self.root)

    def test_public_record_does_not_require_private_artifacts_but_writer_does(self):
        self.result['artifacts'] = ['test-results/private-native.png']
        validate_record(self.result, self.root)
        with self.assertRaisesRegex(ValueError, 'Evidence is missing'):
            validate_result(self.result, self.root)
        with self.assertRaisesRegex(ValueError, 'Evidence is missing'):
            write_result(self.result, self.root)
        self.result['artifacts'] = ['../outside.png']
        with self.assertRaisesRegex(ValueError, 'inside the repository'):
            validate_record(self.result, self.root)
        self.result['artifacts'] = ['test-results/private-native.png']
        self.result['native_test']['computer_use'] = False
        with self.assertRaisesRegex(ValueError, 'Native launch'):
            validate_record(self.result, self.root)

    def test_cannot_accept_incomplete_checks_or_missing_evidence(self):
        for mutation in (
            {'status': 'partial'}, {'checks': []}, {'task_ids': ['P0-02']},
            {'artifacts': ['missing.txt']}, {'artifacts': ['../outside.txt']},
            {'code_revision': 'unknown'}, {'spec_sync': None},
            {'ended_at': '2026-09-04T01:00:00Z'},
            {'checks': [{'name': 'fixture', 'status': 'not_run', 'command_or_method': 'fixture'}]},
        ):
            result = copy.deepcopy(self.result)
            result.update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(Exception):
                validate_result(result, self.root)

    def test_later_phase_requires_native_evidence(self):
        self.result.update(phase_id='P1', task_ids=['P1-01'])
        self.result['native_test'] = {}
        with self.assertRaisesRegex(ValueError, 'Native'):
            validate_result(self.result, self.root)

    def test_foundation_media_acceptance_requires_native_evidence(self):
        self.result['native_test'] = {}
        with self.assertRaisesRegex(ValueError, 'Native'):
            validate_result(self.result, self.root)

    def test_writer_requires_published_revision_and_never_replaces_result(self):
        def git(*args):
            return subprocess.check_output(['git', *args], cwd=self.root, text=True, stderr=subprocess.DEVNULL).strip()
        git('init', '-b', 'main')
        git('config', 'user.name', 'Synthetic fixture')
        git('config', 'user.email', 'fixture@example.invalid')
        git('add', '.')
        git('commit', '-m', 'Synthetic phase writer test')
        self.result['code_revision'] = git('rev-parse', 'HEAD')
        origin = self.root / 'origin.git'
        git('init', '--bare', str(origin))
        (self.root / '.git/info/exclude').write_text('origin.git/\n')
        git('remote', 'add', 'origin', str(origin))
        with self.assertRaisesRegex(ValueError, 'not verified on origin'):
            write_result(self.result, self.root)
        self.assertFalse((self.root / 'docs/workflow/results/P0.json').exists())
        git('push', 'origin', 'main')
        evidence = self.root / 'evidence.txt'
        evidence.write_text('uncommitted test result')
        with self.assertRaisesRegex(ValueError, 'Commit all source'):
            write_result(self.result, self.root)
        git('add', 'evidence.txt')
        with self.assertRaisesRegex(ValueError, 'Commit all source'):
            write_result(self.result, self.root)
        git('restore', '--source=HEAD', '--staged', '--worktree', 'evidence.txt')
        untracked = self.root / 'untracked.py'
        untracked.write_text('uncommitted code')
        with self.assertRaisesRegex(ValueError, 'Commit all source'):
            write_result(self.result, self.root)
        untracked.unlink()
        destination = write_result(self.result, self.root)
        self.assertEqual(json.loads(destination.read_text()), self.result)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            write_result(self.result, self.root)
        self.assertEqual(list(destination.parent.glob('*.tmp')), [])


if __name__ == '__main__':
    unittest.main()

import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from desktop_environment import ROOT, start_arguments, validate_inspection


class DesktopBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.inspection = {
            'Config': {'User': '1000:1000', 'Labels': {
                'dev.ai-video-editor.environment': 'isolated-native-test'}},
            'HostConfig': {'CapDrop': ['ALL'], 'SecurityOpt': [
                'no-new-privileges:true', 'seccomp=' + json.dumps(json.loads(
                    (ROOT / 'tests/desktop/seccomp.json').read_text(encoding='utf-8')))],
                'PortBindings': {'5900/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '5909'}]}},
            'State': {'Running': True}, 'Mounts': []}

    def test_accepts_isolated_environment(self):
        validate_inspection(self.inspection)

    def test_guest_only_environment_publishes_no_host_ports(self):
        self.inspection['HostConfig']['PortBindings'] = {}
        validate_inspection(self.inspection)
        self.assertNotIn('--publish', start_arguments())
        self.assertNotIn('-p', start_arguments())
        self.inspection['HostConfig']['PortBindings'] = {'9222/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '9222'}]}
        with self.assertRaises(ValueError):
            validate_inspection(self.inspection)

    def test_rejects_host_access_and_security_downgrades(self):
        changes = [('Privileged', True), ('Devices', ['/dev/video0']),
                   ('CapAdd', ['SYS_ADMIN']), ('CapDrop', []),
                   ('NetworkMode', 'host'), ('IpcMode', 'host'), ('PidMode', 'host'),
                   ('IpcMode', 'container:other'), ('PidMode', 'container:other'),
                   ('NetworkMode', 'container:other'), ('DeviceRequests', [{'Driver': 'nvidia'}]),
                   ('SecurityOpt', ['seccomp=unconfined']),
                   ('SecurityOpt', ['no-new-privileges:true', 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}']),
                   ('PortBindings', {'5900/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '5909'}]})]
        for key, value in changes:
            with self.subTest(key=key), self.assertRaises(ValueError):
                changed = copy.deepcopy(self.inspection)
                changed['HostConfig'][key] = value
                validate_inspection(changed)
        with self.assertRaises(ValueError):
            self.inspection['Mounts'] = [{'Source': '/host'}]
            validate_inspection(self.inspection)

    def test_rejects_wrong_identity_and_stopped_container(self):
        for key, value in [('User', 'root'), ('Labels', {})]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                changed = copy.deepcopy(self.inspection)
                changed['Config'][key] = value
                validate_inspection(changed)
        with self.assertRaises(ValueError):
            self.inspection['State']['Running'] = False
            validate_inspection(self.inspection)

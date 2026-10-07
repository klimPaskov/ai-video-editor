"""Public IPC contract regression tests; no Electron launch or private media."""
from copy import deepcopy
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parents[2]


class DesktopIpcContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads((ROOT / 'docs/schemas/desktop_ipc.schema.json').read_text(encoding='utf8'))
        Draft202012Validator.check_schema(cls.schema)
        registry = Registry()
        for schema_path in (ROOT / 'docs/schemas').glob('*.json'):
            schema_value = json.loads(schema_path.read_text(encoding='utf8'))
            resource = Resource.from_contents(schema_value)
            registry = registry.with_resource(schema_path.resolve().as_uri(), resource)
            schema_id = schema_value.get('$id')
            if isinstance(schema_id, str):
                registry = registry.with_resource(schema_id, resource)
        cls.validator = Draft202012Validator(cls.schema, registry=registry)
        cls.frame = json.loads((ROOT / 'docs/examples/desktop_ipc.example.json').read_text(encoding='utf8'))
        cls.summary = json.loads((ROOT / 'docs/examples/media_library.example.json').read_text(encoding='utf8'))['summary']

    def valid(self, value):
        self.validator.validate(value)

    def invalid(self, value):
        self.assertFalse(self.validator.is_valid(value), repr(value)[:400])

    def test_each_channel_success_and_error(self):
        self.valid(self.frame)
        for channel, values in [('list', [[], [self.summary]]), ('import', [None, self.summary]), ('cancel', [None])]:
            for value in values:
                self.valid({'channel': 'library:' + channel, 'response': {'ok': True, 'value': value}})
        for channel in ['list', 'import', 'cancel', 'frame']:
            exchange = {'channel': 'library:' + channel, 'response': {'ok': False, 'message': 'Try another file.'}}
            if channel == 'frame':
                exchange['payload'] = self.frame['payload']
            self.valid(exchange)

    def test_thumbnail_is_small_and_requested_by_id_only(self):
        payload = {'id': self.frame['payload']['id']}
        picture = {'width': 2, 'height': 2, 'rgbaBase64': 'AAAAAAAAAAAAAAAAAAAAAA=='}
        self.valid({'channel': 'library:thumbnail', 'payload': payload, 'response': {'ok': True, 'value': picture}})
        self.valid({'channel': 'library:thumbnail', 'payload': payload, 'response': {'ok': False, 'message': 'No picture.'}})
        for wrong in [{}, {'id': '../x'}, dict(payload, timeUs=0), dict(payload, path='/private/video.mkv')]:
            self.invalid({'channel': 'library:thumbnail', 'payload': wrong, 'response': {'ok': True, 'value': picture}})
        for size in [{'width': 321}, {'height': 1281}]:
            self.invalid({'channel': 'library:thumbnail', 'payload': payload, 'response': {'ok': True, 'value': dict(picture, **size)}})

    def test_caption_settings_hold_only_style_choices(self):
        request = {'schema_version': '1.0', 'project_id': 'project-1'}
        settings = {'enabled': True, 'style': 'highlight', 'size': 'large', 'position': 'top'}
        self.valid({'channel': 'captions:get', 'payload': request, 'response': {'ok': True, 'value': settings}})
        self.valid({'channel': 'captions:set', 'payload': dict(request, settings=settings), 'response': {'ok': True, 'value': settings}})
        for wrong in [dict(settings, style='karaoke'), dict(settings, cues=[]), dict(settings, enabled='yes')]:
            self.invalid({'channel': 'captions:set', 'payload': dict(request, settings=wrong), 'response': {'ok': True, 'value': settings}})
        self.invalid({'channel': 'captions:get', 'payload': dict(request, path='/x.srt'), 'response': {'ok': True, 'value': settings}})

    def test_playback_view_is_path_free(self):
        request = {'schema_version': '1.0', 'project_id': 'project-1'}
        for value in [{'status': 'ready', 'progress': None, 'message': None},
                      {'status': 'preparing', 'progress': 0.4, 'message': None},
                      {'status': 'failed', 'progress': None, 'message': 'Playback could not be prepared for this video. Frame preview and export still work.'}]:
            self.valid({'channel': 'playback:get', 'payload': request, 'response': {'ok': True, 'value': value}})
        for wrong in [{'status': 'ready', 'progress': 1, 'message': None},
                      {'status': 'preparing', 'progress': 1.5, 'message': None},
                      {'status': 'failed', 'progress': None, 'message': 'ffmpeg: libx264 missing'},
                      {'status': 'ready', 'progress': None, 'message': None, 'path': '/home/user/proxy.mp4'}]:
            self.invalid({'channel': 'playback:get', 'payload': request, 'response': {'ok': True, 'value': wrong}})
        self.invalid({'channel': 'playback:get', 'payload': {'project_id': 'project-1'}, 'response': {'ok': False, 'message': 'x'}})

    def test_recording_channels_use_opaque_ids_and_fixed_messages(self):
        devices = {'displays': [{'id': 'display-1', 'label': 'Built-in display', 'width': 2560, 'height': 1600, 'primary': True}],
                   'microphones': [{'id': 'pulse-1', 'label': 'USB microphone'}], 'message': None}
        self.valid({'channel': 'recording:devices', 'response': {'ok': True, 'value': devices}})
        for wrong in [dict(devices, displays=[dict(devices['displays'][0], x=0)]),
                      dict(devices, microphones=[{'id': 'pulse-1', 'label': 'Mic', 'device': 'alsa_input.usb'}]),
                      dict(devices, message='ffmpeg: x11grab failed')]:
            self.invalid({'channel': 'recording:devices', 'response': {'ok': True, 'value': wrong}})
        self.invalid({'channel': 'recording:devices', 'payload': {}, 'response': {'ok': True, 'value': devices}})
        recording = {'status': 'recording', 'elapsedUs': 1000000, 'missedFrames': 0, 'media': None, 'message': None}
        finished = dict(recording, status='finished', media=self.summary)
        for channel in ['get', 'pause', 'resume', 'stop', 'cancel']:
            self.valid({'channel': 'recording:' + channel, 'response': {'ok': True, 'value': recording}})
        self.valid({'channel': 'recording:stop', 'response': {'ok': True, 'value': finished}})
        self.invalid({'channel': 'recording:stop', 'response': {'ok': True, 'value': dict(finished, media=None)}})
        self.invalid({'channel': 'recording:get', 'response': {'ok': True, 'value': dict(recording, media=self.summary)}})
        self.invalid({'channel': 'recording:get', 'response': {'ok': True, 'value': dict(recording, path='/home/user/take.mkv')}})
        start = {'schema_version': '1.0', 'display_id': 'display-1', 'microphone_id': None}
        self.valid({'channel': 'recording:start', 'payload': start, 'response': {'ok': True, 'value': recording}})
        self.valid({'channel': 'recording:start', 'payload': dict(start, microphone_id='pulse-1'), 'response': {'ok': False, 'message': 'A recording is already in progress.'}})
        for wrong in [dict(start, display_id=':0.0+0,0 -i /etc/passwd'), dict(start, microphone_id='alsa input'), {'display_id': 'display-1'}]:
            self.invalid({'channel': 'recording:start', 'payload': wrong, 'response': {'ok': True, 'value': recording}})

    def test_undefined_requests_are_absent_not_null_or_paths(self):
        for channel in ['list', 'import', 'cancel']:
            for payload in [None, {}, {'path': '/private/video.mkv'}]:
                self.invalid({'channel': 'library:' + channel, 'payload': payload, 'response': {'ok': False, 'message': ''}})
        value = deepcopy(self.frame)
        value['payload']['path'] = '/private/video.mkv'
        self.invalid(value)
        value = deepcopy(self.frame)
        value['payload']['id'] = '../private/video.mkv'
        self.invalid(value)

    def test_request_bounds_and_unknown_channels(self):
        for time in [-1, 0.5, 9007199254740992, '0', None]:
            value = deepcopy(self.frame)
            value['payload']['timeUs'] = time
            self.invalid(value)
        value = deepcopy(self.frame)
        value['channel'] = 'library:delete'
        self.invalid(value)

    def test_wrong_reply_types_and_excess_fields(self):
        for channel, wrong in [('list', None), ('import', []), ('cancel', {}), ('frame', self.summary)]:
            value = {'channel': 'library:' + channel, 'response': {'ok': True, 'value': wrong}}
            if channel == 'frame':
                value['payload'] = self.frame['payload']
            self.invalid(value)
        for extra in ['message', 'path', 'stderr']:
            value = deepcopy(self.frame)
            value['response'][extra] = '/private/example'
            self.invalid(value)
        value = deepcopy(self.frame)
        value['response']['value']['path'] = '/private/example'
        self.invalid(value)

    def test_transcription_exchange_is_path_free_and_job_bound(self):
        exchange = json.loads((ROOT / 'docs/examples/desktop_ipc_transcription.example.json').read_text(encoding='utf8'))
        self.valid(exchange)
        value = deepcopy(exchange)
        value['payload']['source_path'] = '/private/source.mkv'
        self.invalid(value)
        value = deepcopy(exchange)
        value['response']['value']['job']['job_id'] = '../other-job'
        self.invalid(value)
        value = deepcopy(exchange)
        value['response']['value']['results'] = [{'source_id': 'source-001', 'path': '/private/transcript.json'}]
        self.invalid(value)

    def test_transcript_correction_exchange_is_head_bound_and_path_free(self):
        exchange = json.loads((ROOT / 'docs/examples/desktop_ipc_transcript_correction.example.json').read_text(encoding='utf8'))
        self.valid(exchange)
        for request_patch in [
            {'audio_path': '/private/source.mkv'},
            {'expectedSequence': -1},
            {'replacementText': ''},
        ]:
            value = deepcopy(exchange)
            value['payload'].update(request_patch)
            self.invalid(value)
        value = deepcopy(exchange)
        value['response']['value']['transcriptEdits'][0]['word_id'] = '../private'
        self.invalid(value)

    def test_transcript_cut_exchange_is_head_bound_and_path_free(self):
        exchange = json.loads((ROOT / 'docs/examples/desktop_ipc_transcript_cut.example.json').read_text(encoding='utf8'))
        self.valid(exchange)
        for request_patch in [
            {'source_path': '/private/source.mkv'},
            {'expectedSequence': -1},
            {'startWordId': '../private'},
            {'endWordId': ''},
        ]:
            value = deepcopy(exchange)
            value['payload'].update(request_patch)
            self.invalid(value)
        value = deepcopy(exchange)
        value['response']['value']['clips'][0]['sourceStartUs'] = -1
        self.invalid(value)

    def test_frame_and_summary_limits(self):
        for field, bad in [('width', 16777217), ('height', 0), ('rgbaBase64', 'not base64!?')]:
            value = deepcopy(self.frame)
            value['response']['value'][field] = bad
            self.invalid(value)
        # Avoid allocating an 89 MB test string: test the declared string bound independently.
        frame_string = self.schema['$defs']['frame']['properties']['rgbaBase64']
        self.assertEqual(frame_string['maxLength'], 4 * ((16777216 * 4 + 2) // 3))
        for name in ['/private/video.mkv', 'C:\\private\\video.mkv', 'bad\x00name', 'x' * 256]:
            summary = deepcopy(self.summary)
            summary['name'] = name
            self.invalid({'channel': 'library:import', 'response': {'ok': True, 'value': summary}})
        self.invalid({'channel': 'library:list', 'response': {'ok': True, 'value': [self.summary, self.summary]}})

    def test_preferences_channels_and_schema_consistency(self):
        preferences_schema = json.loads((ROOT / 'docs/schemas/desktop_preferences.schema.json').read_text(encoding='utf8'))
        for field in ['type', 'additionalProperties', 'required', 'properties']:
            self.assertEqual(self.schema['$defs']['preferences'][field], preferences_schema[field])
        for scale in [1, 1.25, 1.5, 2]:
            value = {'interfaceScale': scale}
            self.valid({'channel': 'preferences:get', 'response': {'ok': True, 'value': value}})
            self.valid({'channel': 'preferences:set', 'payload': value, 'response': {'ok': True, 'value': value}})
        self.valid({'channel': 'preferences:get', 'response': {'ok': False, 'message': 'Settings could not be loaded.'}})
        self.valid({'channel': 'preferences:set', 'payload': {'interfaceScale': 1}, 'response': {'ok': False, 'message': 'Settings could not be saved.'}})

    def test_preferences_reject_payload_and_reply_drift(self):
        valid = {'interfaceScale': 1.25}
        for payload in [None, {}, {'interfaceScale': 1}]:
            self.invalid({'channel': 'preferences:get', 'payload': payload, 'response': {'ok': True, 'value': valid}})
        self.invalid({'channel': 'preferences:set', 'response': {'ok': True, 'value': valid}})
        for wrong in [None, {}, [], {'interfaceScale': 3}, {'interfaceScale': '1'}, {'interfaceScale': True}, {'interfaceScale': 1, 'path': '/private/settings.json'}]:
            self.invalid({'channel': 'preferences:set', 'payload': wrong, 'response': {'ok': True, 'value': valid}})
            self.invalid({'channel': 'preferences:get', 'response': {'ok': True, 'value': wrong}})
            self.invalid({'channel': 'preferences:set', 'payload': valid, 'response': {'ok': True, 'value': wrong}})

    def project_view(self):
        return {
            'id': '11111111-1111-4111-8111-111111111111', 'name': 'Synthetic project',
            'stage': 'record_import', 'revisionId': '22222222-2222-4222-8222-222222222222',
            'draft': {
                'id': 'draft-22222222-2222-4222-8222-222222222222',
                'baseRevisionId': '22222222-2222-4222-8222-222222222222',
                'sequence': 0, 'timelineSha256': 'a' * 64,
                'undoTransactionId': None, 'redoTransactionId': None,
            },
            'source': deepcopy(self.summary),
            'timeline': {'id': '33333333-3333-4333-8333-333333333333', 'durationUs': 1001000,
                         'frameRate': {'numerator': 30000, 'denominator': 1001}},
        }

    def project_exchange(self, channel, view=None):
        view = self.project_view() if view is None else view
        result = {'channel': 'projects:' + channel,
                  'response': {'ok': True, 'value': [view] if channel == 'list' else view}}
        if channel != 'list':
            result['payload'] = {'id': view['source']['id'] if channel == 'create' else view['id']}
            if channel == 'navigate':
                result['payload']['stage'] = view['stage']
        return result

    def test_project_channels_success_errors_and_five_stages(self):
        for channel in ['list', 'create', 'open', 'navigate']:
            exchange = self.project_exchange(channel)
            self.valid(exchange)
            exchange['response'] = {'ok': False, 'message': 'Project could not be opened.'}
            self.valid(exchange)
        self.valid({'channel': 'projects:list', 'response': {'ok': True, 'value': []}})
        for stage in ['record_import', 'auto_edit', 'edit', 'review', 'export']:
            view = self.project_view()
            view['stage'] = stage
            self.valid(self.project_exchange('navigate', view))

    def test_project_requests_require_exact_ids_and_no_paths(self):
        for channel in ['create', 'open', 'navigate']:
            for payload in [None, {}, {'id': '../private/project'}, {'path': '/private/project.json'}]:
                exchange = self.project_exchange(channel)
                exchange['payload'] = payload
                self.invalid(exchange)
            for key in ['path', 'projectRoot', 'originalPath']:
                exchange = self.project_exchange(channel)
                exchange['payload'][key] = '/private/project'
                self.invalid(exchange)
            exchange = self.project_exchange(channel)
            del exchange['payload']
            self.invalid(exchange)
        for payload in [None, {}, {'id': self.project_view()['id']}]:
            exchange = self.project_exchange('list')
            exchange['payload'] = payload
            self.invalid(exchange)
        for stage in ['home', 'qa', 'complete', 'delete', None, 0]:
            exchange = self.project_exchange('navigate')
            exchange['payload']['stage'] = stage
            self.invalid(exchange)

    def test_project_view_is_path_free_bounded_and_strict(self):
        for key in ['originalPath', 'managedPath', 'projectRoot', 'source_probe']:
            view = self.project_view()
            view[key] = '/private/source'
            self.invalid(self.project_exchange('open', view))
        for name in ['/private/video', 'C:\\private\\video', 'bad\x00name', '', 'x' * 161]:
            view = self.project_view()
            view['name'] = name
            self.invalid(self.project_exchange('open', view))
        for bad in [0, -1, 0.5, 9007199254740992, '30000', True, None]:
            for key in ['numerator', 'denominator']:
                view = self.project_view()
                view['timeline']['frameRate'][key] = bad
                self.invalid(self.project_exchange('open', view))
            view = self.project_view()
            view['timeline']['durationUs'] = bad
            self.invalid(self.project_exchange('open', view))
        for location in ['source', 'timeline']:
            view = self.project_view()
            view[location]['path'] = '/private/source'
            self.invalid(self.project_exchange('open', view))
        view = self.project_view()
        self.invalid({'channel': 'projects:list', 'response': {'ok': True, 'value': [view, view]}})
        listing = next(branch for branch in self.schema['oneOf'] if branch['properties']['channel'].get('const') == 'projects:list')
        self.assertEqual(listing['properties']['response']['oneOf'][1]['properties']['value']['maxItems'], 1000)
        self.invalid({'channel': 'projects:delete', 'payload': {'id': view['id']}, 'response': {'ok': True, 'value': view}})

    def test_project_frame_and_draft_event_are_head_bound_and_path_free(self):
        view = self.project_view()
        draft = {
            'projectId': view['id'],
            'draft': deepcopy(view['draft']),
            'timeline': deepcopy(view['timeline']),
        }
        request = {
            'projectId': view['id'],
            'draftId': view['draft']['id'],
            'baseRevisionId': view['revisionId'],
            'expectedSequence': 0,
            'expectedTimelineSha256': 'a' * 64,
            'timelineTimeUs': 0,
        }
        ready = {
            'status': 'ready',
            'projectId': view['id'],
            'draftId': view['draft']['id'],
            'baseRevisionId': view['revisionId'],
            'draftSequence': 0,
            'timelineSha256': 'a' * 64,
            'timelineTimeUs': 0,
            'frame': self.frame['response']['value'],
        }
        self.valid({'channel': 'projects:frame', 'payload': request,
                    'response': {'ok': True, 'value': ready}})
        self.valid({'channel': 'projects:frame', 'payload': request,
                    'response': {'ok': True, 'value': {'status': 'stale', 'draft': draft}}})
        self.valid({'channel': 'projects:draft-changed',
                    'event': {'ok': True, 'value': draft}})
        self.valid({'channel': 'projects:draft-changed',
                    'event': {'ok': False, 'message': 'Reopen the project.'}})
        for key, bad in [('expectedSequence', -1),
                         ('expectedTimelineSha256', 'bad'),
                         ('timelineTimeUs', 0.5)]:
            changed = deepcopy(request)
            changed[key] = bad
            self.invalid({'channel': 'projects:frame', 'payload': changed,
                          'response': {'ok': True, 'value': ready}})
        for leaked in ('path', 'sourceId', 'sourceTimeUs', 'threadId'):
            changed = deepcopy(request)
            changed[leaked] = '/private/source'
            self.invalid({'channel': 'projects:frame', 'payload': changed,
                          'response': {'ok': True, 'value': ready}})
        changed = deepcopy(draft)
        changed['draft']['baseRevisionId'] = 'bad'
        self.invalid({'channel': 'projects:draft-changed',
                      'event': {'ok': True, 'value': changed}})


    def test_codex_settings_channels_reject_credentials_urls_and_arbitrary_requests(self):
        fixture = json.loads((ROOT / 'docs/contracts/codex-settings-example.json').read_text(encoding='utf-8'))
        self.valid(fixture)
        for channel in ('codex:get', 'codex:reconnect', 'codex:login', 'codex:cancel-login', 'codex:logout'):
            exchange = dict(fixture, channel=channel)
            self.valid(exchange)
            self.invalid(dict(exchange, payload={'type': 'apiKey', 'apiKey': 'PRIVATE'}))
        for key in ('authUrl', 'loginId', 'email', 'token', 'path'):
            bad = json.loads(json.dumps(fixture))
            bad['response']['value'][key] = 'PRIVATE'
            self.invalid(bad)
        selection = dict(fixture, channel='codex:select', payload={'modelId': 'runtime-model', 'reasoning': 'runtime-effort'})
        self.valid(selection)
        selection['payload']['command'] = 'unsafe'
        self.invalid(selection)

    def test_project_close_and_codex_conversation_channels_are_explicit(self):
        project_id = '11111111-1111-4111-8111-111111111111'
        self.valid({
            'channel': 'projects:close',
            'payload': {'id': project_id},
            'response': {'ok': True, 'value': None},
        })
        thread = json.loads(
            (ROOT / 'docs/examples/codex_thread_view.example.json').read_text(encoding='utf-8')
        )
        request = {'schema_version': '1.0', 'project_id': 'project-1'}
        for channel in ('codex-thread:get', 'codex-thread:open', 'codex-thread:interrupt'):
            self.valid({
                'channel': channel,
                'payload': request,
                'response': {'ok': True, 'value': thread},
            })
        retryable_thread = deepcopy(thread)
        retryable_thread['retryable'] = True
        self.valid({
            'channel': 'codex-thread:get',
            'payload': request,
            'response': {'ok': True, 'value': retryable_thread},
        })
        running_retry = deepcopy(retryable_thread)
        running_retry['status'] = 'running'
        self.invalid({
            'channel': 'codex-thread:get',
            'payload': request,
            'response': {'ok': True, 'value': running_retry},
        })
        no_prompt_retry = deepcopy(retryable_thread)
        no_prompt_retry['messages'] = []
        self.invalid({
            'channel': 'codex-thread:get',
            'payload': request,
            'response': {'ok': True, 'value': no_prompt_retry},
        })
        self.valid({
            'channel': 'codex-thread:send',
            'payload': dict(request, text='Trim the false start.'),
            'response': {'ok': True, 'value': thread},
        })
        for key in ('path', 'threadId', 'command', 'token'):
            bad = dict(request, **{key: 'PRIVATE'})
            self.invalid({
                'channel': 'codex-thread:open',
                'payload': bad,
                'response': {'ok': True, 'value': thread},
            })
        leaked = deepcopy(thread)
        leaked['messages'][1]['path'] = '/private/project'
        self.invalid({
            'channel': 'codex-thread:get',
            'payload': request,
            'response': {'ok': True, 'value': leaked},
        })

    def test_manual_restore_range_uses_one_exact_path_free_source_interval(self):
        restore = json.loads(
            (ROOT / 'docs/examples/desktop_ipc_manual_restore_range.example.json').read_text(encoding='utf-8')
        )
        self.valid(restore)
        for key, value in [
            ('path', 'C:/private/source.mkv'),
            ('sourceId', '../private'),
            ('sourceStartUs', -1),
            ('sourceEndUs', 1.5),
        ]:
            bad = deepcopy(restore)
            bad['payload'][key] = value
            self.invalid(bad)

    def test_review_integrity_channel_returns_only_a_path_free_draft_head(self):
        integrity = json.loads(
            (ROOT / 'docs/examples/desktop_ipc_integrity_check.example.json').read_text(encoding='utf-8')
        )
        self.valid(integrity)
        leaked = deepcopy(integrity)
        leaked['response']['value']['draft']['sourcePath'] = 'C:/private/source.mkv'
        self.invalid(leaked)
        bad_payload = deepcopy(integrity)
        bad_payload['payload']['path'] = 'C:/private/source.mkv'
        self.invalid(bad_payload)
        bad_checkpoint = deepcopy(integrity)
        bad_checkpoint['response']['value']['structuralCheckpointRecorded'] = 'yes'
        self.invalid(bad_checkpoint)

    def test_magic_wand_channels_carry_counts_only(self):
        example = json.loads(
            (ROOT / 'docs/examples/desktop_ipc_magic_wand.example.json').read_text(encoding='utf-8')
        )
        self.valid(example)
        for key, value in [('ranges', [[0, 1]]), ('transcript', 'and so my fellow')]:
            leaked = deepcopy(example)
            leaked['response']['value'][key] = value
            self.invalid(leaked)
        raw = deepcopy(example)
        raw['response']['value']['message'] = 'TypeError: cannot read'
        self.invalid(raw)
        self.valid({'channel': 'magic:start',
                    'payload': {'schema_version': '1.0', 'project_id': 'project-1', 'preset': 'tight'},
                    'response': {'ok': True, 'value': example['response']['value']}})
        self.invalid({'channel': 'magic:start',
                      'payload': {'schema_version': '1.0', 'project_id': 'project-1', 'preset': 'extreme'},
                      'response': {'ok': True, 'value': example['response']['value']}})

    def test_export_channels_expose_file_names_only(self):
        example = json.loads(
            (ROOT / 'docs/examples/desktop_ipc_export.example.json').read_text(encoding='utf-8')
        )
        self.valid(example)
        for name in ['/home/user/Talk.mkv', 'C:\\Videos\\Talk.mkv', 'Talk.mov']:
            leaked = deepcopy(example)
            leaked['response']['value']['result']['fileName'] = name
            self.invalid(leaked)
        extra = deepcopy(example)
        extra['response']['value']['outputPath'] = '/home/user/Talk.mkv'
        self.invalid(extra)
        raw = deepcopy(example)
        raw['response']['value']['message'] = 'ffmpeg exited with code 1'
        self.invalid(raw)
        running = deepcopy(example)
        running['response']['value'].update(status='running', phase='rendering', fraction=0.25, result=None)
        self.valid(running)
        running['response']['value']['fraction'] = 1.5
        self.invalid(running)
        self.valid({'channel': 'export:start',
                    'payload': {'schema_version': '1.0', 'project_id': 'project-1', 'profile': 'smaller_mp4'},
                    'response': {'ok': True, 'value': running['response']['value'] | {'fraction': 0.0}}})
        self.invalid({'channel': 'export:start',
                      'payload': {'schema_version': '1.0', 'project_id': 'project-1', 'profile': 'prores'},
                      'response': {'ok': True, 'value': example['response']['value']}})
        self.invalid({'channel': 'export:start',
                      'payload': {'schema_version': '1.0', 'project_id': 'project-1',
                                  'profile': 'lossless_master', 'path': '/tmp/out.mkv'},
                      'response': {'ok': True, 'value': example['response']['value']}})
        self.valid({'channel': 'export:reveal', 'payload': {'schema_version': '1.0', 'project_id': 'project-1'},
                    'response': {'ok': True, 'value': None}})

    def test_claude_channels_expose_no_credentials_paths_or_prices(self):
        thread = json.loads(
            (ROOT / 'docs/examples/desktop_ipc_claude.example.json').read_text(encoding='utf-8')
        )
        self.valid(thread)
        for key, value in [('token', 'sk-ant-secret'), ('sessionId', '11111111-2222-4333-8444-555555555555')]:
            leaked = deepcopy(thread)
            leaked['response']['value'][key] = value
            self.invalid(leaked)
        raw = deepcopy(thread)
        raw['response']['value']['message'] = 'Not logged in · Please run /login'
        self.invalid(raw)
        ready = deepcopy(thread)
        ready['response']['value']['status'] = 'ready'
        self.invalid(ready)
        bad_payload = deepcopy(thread)
        bad_payload['payload']['cwd'] = '/home/user/project'
        self.invalid(bad_payload)
        signed_in = {
            'status': 'signed_in',
            'version': '2.1.285',
            'account': {'billing': 'subscription', 'plan': 'max'},
            'models': [{'value': 'default', 'label': 'Default (recommended)', 'detail': 'Opus 5.5', 'efforts': ['high']}],
            'selection': {'model': 'default', 'effort': None},
            'message': None,
        }
        self.valid({'channel': 'claude:get', 'response': {'ok': True, 'value': signed_in}})
        self.valid({'channel': 'claude:select', 'payload': {'model': 'sonnet', 'effort': 'high'},
                    'response': {'ok': True, 'value': signed_in}})
        self.valid({'channel': 'claude:install-guide', 'response': {'ok': True, 'value': None}})
        for key, value in [('email', 'person@example.com'), ('executable', '/usr/bin/claude')]:
            leaked = deepcopy(signed_in)
            leaked[key] = value
            self.invalid({'channel': 'claude:get', 'response': {'ok': True, 'value': leaked}})
        priced = deepcopy(signed_in)
        priced['models'][0]['detail'] = 'Opus 5.5 · $4/$20 per Mtok'
        self.invalid({'channel': 'claude:get', 'response': {'ok': True, 'value': priced}})
        signed_out = dict(signed_in, status='signed_out')
        self.invalid({'channel': 'claude:get', 'response': {'ok': True, 'value': signed_out}})
        signed_out.update(account=None, models=[], selection=None)
        self.valid({'channel': 'claude:get', 'response': {'ok': True, 'value': signed_out}})
        self.invalid({'channel': 'claude:sign-in', 'payload': {'code': '1234'},
                      'response': {'ok': True, 'value': signed_out}})
        self.invalid({'channel': 'claude:select', 'payload': {'model': 'default', 'effort': 'ultra'},
                      'response': {'ok': True, 'value': signed_in}})

if __name__ == '__main__':
    unittest.main()

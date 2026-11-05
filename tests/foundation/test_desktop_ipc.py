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
        settings = {'enabled': True, 'style': 'highlight', 'size': 'large', 'position': 'top', 'burnIn': True}
        self.valid({'channel': 'captions:get', 'payload': request, 'response': {'ok': True, 'value': settings}})
        self.valid({'channel': 'captions:set', 'payload': dict(request, settings=settings), 'response': {'ok': True, 'value': settings}})
        for wrong in [dict(settings, style='karaoke'), dict(settings, cues=[]), dict(settings, enabled='yes')]:
            self.invalid({'channel': 'captions:set', 'payload': dict(request, settings=wrong), 'response': {'ok': True, 'value': settings}})
        self.invalid({'channel': 'captions:get', 'payload': dict(request, path='/x.srt'), 'response': {'ok': True, 'value': settings}})

    def test_short_clips_are_path_free_with_fixed_messages(self):
        request = {'schema_version': '1.0', 'project_id': 'project-1'}
        clip = {'id': 'clip-1000000-31000000', 'title': 'Why do demos feel slow?', 'startUs': 1000000, 'endUs': 31000000,
                'score': 0.82, 'reasons': ['Opens with a question'], 'excerpt': 'Why do demos feel slow? Because...', 'origin': 'rules'}
        job = {'status': 'completed', 'clipId': clip['id'], 'fraction': None, 'fileName': 'Why do demos feel slow.mp4', 'message': None, 'batch': None}
        saved = {'id': 'export-6f1c2d3e-aaaa', 'title': 'Why do demos feel slow?', 'fileName': 'Why do demos feel slow.mp4',
                 'format': 'vertical', 'speed': 2, 'durationUs': 15000000, 'createdAt': '2026-10-25T12:00:00.000Z', 'exists': True}
        view = {'status': 'ready', 'candidates': [clip], 'job': job, 'message': None, 'library': [saved],
                'pick': {'running': False, 'message': None}}
        for channel in ['get', 'find', 'cancel', 'pick']:
            self.valid({'channel': 'shorts:' + channel, 'payload': request, 'response': {'ok': True, 'value': view}})
        self.valid({'channel': 'shorts:discard', 'payload': dict(request, clip_id=clip['id']), 'response': {'ok': True, 'value': view}})
        export = dict(request, clip_id=clip['id'], format='vertical', framing='fill', position=0.3, captions=True, title=True, speed=2)
        self.valid({'channel': 'shorts:export', 'payload': export, 'response': {'ok': False, 'message': 'A clip is already exporting.'}})
        for wrong in [dict(export, format='9:16'), dict(export, position=2), dict(export, clip_id='../x'), dict(export, path='/tmp/x.mp4'),
                      dict(export, speed=3), dict(export, speed=1.5), dict(export, title='yes')]:
            self.invalid({'channel': 'shorts:export', 'payload': wrong, 'response': {'ok': True, 'value': view}})
        export_all = {key: value for key, value in export.items() if key != 'clip_id'}
        self.valid({'channel': 'shorts:export-all', 'payload': export_all, 'response': {'ok': True, 'value': view}})
        for wrong in [dict(export_all, folder='/tmp'), dict(export_all, speed=4), dict(export, clip_id=clip['id'])]:
            self.invalid({'channel': 'shorts:export-all', 'payload': wrong, 'response': {'ok': True, 'value': view}})
        # The clips the user chose in Clips (ADR 0031): a short list of clip ids.
        self.valid({'channel': 'shorts:export-all', 'payload': dict(export_all, clip_ids=[clip['id']]), 'response': {'ok': True, 'value': view}})
        for wrong in [dict(export_all, clip_ids=[]), dict(export_all, clip_ids=['../x']), dict(export_all, clip_ids=[clip['id'], clip['id']]),
                      dict(export_all, clip_ids=clip['id'])]:
            self.invalid({'channel': 'shorts:export-all', 'payload': wrong, 'response': {'ok': True, 'value': view}})
        saved_request = dict(request, export_id=saved['id'])
        for channel in ['reveal', 'forget']:
            self.valid({'channel': 'shorts:' + channel, 'payload': saved_request, 'response': {'ok': True, 'value': view}})
            for wrong in [dict(saved_request, export_id='../x'), dict(saved_request, path='/tmp/x.mp4'), request]:
                self.invalid({'channel': 'shorts:' + channel, 'payload': wrong, 'response': {'ok': True, 'value': view}})
        batch = dict(view, job=dict(job, status='running', fraction=0.4, batch={'index': 1, 'total': 3}))
        self.valid({'channel': 'shorts:get', 'payload': request, 'response': {'ok': True, 'value': batch}})
        picking = dict(view, pick={'running': True, 'message': None}, candidates=[dict(clip, origin='ai')])
        self.valid({'channel': 'shorts:get', 'payload': request, 'response': {'ok': True, 'value': picking}})
        self.valid({'channel': 'shorts:get', 'payload': request,
                    'response': {'ok': True, 'value': dict(view, pick={'running': False, 'message': 'Claude did not choose any clips. Try again.'})}})
        for bad in [dict(view, job=dict(job, fileName='/home/user/x.mp4')), dict(view, message='ffmpeg failed'),
                    dict(view, candidates=[dict(clip, path='/x')]), dict(view, candidates=[dict(clip, origin='model')]),
                    dict(view, library=[dict(saved, path='/home/user/x.mp4')]), dict(view, library=[dict(saved, fileName='/x/y.mp4')]),
                    dict(view, pick={'running': False, 'message': 'the model said hello'}),
                    dict(view, job=dict(job, batch={'index': 3, 'total': 0}))]:
            self.invalid({'channel': 'shorts:get', 'payload': request, 'response': {'ok': True, 'value': bad}})

    def test_strip_pictures_are_small_cosmetic_and_bound_to_the_head(self):
        head = {'projectId': '8a9c7a44-5e4f-4c5e-9d2e-5c1f0b2a7e11', 'draftId': 'draft-1',
                'baseRevisionId': '1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8', 'expectedSequence': 3,
                'expectedTimelineSha256': 'a' * 64}
        request = dict(head, timesUs=[100000, 400000])
        ready = {'status': 'ready', 'projectId': head['projectId'], 'draftId': head['draftId'],
                 'baseRevisionId': head['baseRevisionId'], 'draftSequence': 3, 'timelineSha256': 'a' * 64,
                 'frames': [{'timelineTimeUs': 100000, 'frame': {'width': 2, 'height': 2, 'rgbaBase64': 'AAAAAAAAAAAAAAAAAAAAAA=='}},
                            {'timelineTimeUs': 400000, 'frame': None}]}
        self.valid({'channel': 'projects:strip', 'payload': request, 'response': {'ok': True, 'value': ready}})
        self.valid({'channel': 'projects:strip', 'payload': request, 'response': {'ok': False, 'message': 'Try again.'}})
        for wrong in [dict(request, timesUs=[]), dict(request, timesUs=[-1]), dict(request, timesUs=list(range(33))),
                      dict(request, path='/tmp/x'), {key: value for key, value in request.items() if key != 'timesUs'}]:
            self.invalid({'channel': 'projects:strip', 'payload': wrong, 'response': {'ok': True, 'value': ready}})
        for bad in [dict(ready, frames=[{'timelineTimeUs': 0, 'frame': {'width': 2, 'height': 2, 'rgbaBase64': 'AAAA', 'path': '/x'}}]),
                    dict(ready, frames=[{'timelineTimeUs': 0}]), dict(ready, source='/video.mkv')]:
            self.invalid({'channel': 'projects:strip', 'payload': request, 'response': {'ok': True, 'value': bad}})

    def test_audio_settings_are_two_choices(self):
        request = {'schema_version': '1.0', 'project_id': 'project-1'}
        settings = {'normalize': True, 'denoise': False}
        self.valid({'channel': 'audio:get', 'payload': request, 'response': {'ok': True, 'value': settings}})
        self.valid({'channel': 'audio:set', 'payload': dict(request, settings=settings), 'response': {'ok': True, 'value': settings}})
        for wrong in [dict(settings, gainDb=6), {'normalize': 'yes', 'denoise': False}, {'normalize': True}]:
            self.invalid({'channel': 'audio:set', 'payload': dict(request, settings=wrong), 'response': {'ok': True, 'value': settings}})

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
                   'microphones': [{'id': 'pulse-1', 'label': 'USB microphone'}],
                   'cameras': [{'id': 'dshow-video-1', 'label': 'Webcam'}], 'desktop_audio': True, 'message': None}
        self.valid({'channel': 'recording:devices', 'response': {'ok': True, 'value': devices}})
        for wrong in [dict(devices, displays=[dict(devices['displays'][0], x=0)]),
                      dict(devices, microphones=[{'id': 'pulse-1', 'label': 'Mic', 'device': 'alsa_input.usb'}]),
                      dict(devices, cameras=[{'id': 'dshow-video-1', 'label': 'Cam', 'device': 'video=Cam'}]),
                      dict(devices, desktop_audio='yes'),
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
        self.valid({'channel': 'recording:start', 'payload': dict(start, camera_id='dshow-video-1'), 'response': {'ok': True, 'value': recording}})
        self.valid({'channel': 'recording:start', 'payload': dict(start, camera_id=None), 'response': {'ok': True, 'value': recording}})
        self.valid({'channel': 'recording:start', 'payload': dict(start, desktop_audio=True), 'response': {'ok': True, 'value': recording}})
        self.invalid({'channel': 'recording:start', 'payload': dict(start, desktop_audio='yes'), 'response': {'ok': True, 'value': recording}})
        self.invalid({'channel': 'recording:start', 'payload': dict(start, camera_id='video=Cam 0'), 'response': {'ok': True, 'value': recording}})
        for wrong in [dict(start, display_id=':0.0+0,0 -i /etc/passwd'), dict(start, microphone_id='alsa input'), {'display_id': 'display-1'}]:
            self.invalid({'channel': 'recording:start', 'payload': wrong, 'response': {'ok': True, 'value': recording}})

    def test_camera_and_layout_channels_carry_no_paths(self):
        view = {'schema_version': '1.0', 'project_id': 'project-1', 'linked': True, 'file_name': 'Camera.mkv',
                'offset_us': 100000, 'width': 1280, 'height': 720}
        idle = dict(view, linked=False, file_name=None, offset_us=0, width=None, height=None)
        request = {'schema_version': '1.0', 'project_id': 'project-1'}
        for channel in ['camera:get', 'camera:choose', 'camera:remove']:
            self.valid({'channel': channel, 'payload': request, 'response': {'ok': True, 'value': view}})
            self.valid({'channel': channel, 'payload': request, 'response': {'ok': True, 'value': idle}})
        self.valid({'channel': 'camera:offset', 'payload': dict(request, offset_us=-100000), 'response': {'ok': True, 'value': view}})
        for wrong in [dict(request, path='/home/user/camera.mkv'), dict(request, offset_us=900000000)]:
            self.invalid({'channel': 'camera:offset', 'payload': wrong, 'response': {'ok': True, 'value': view}})
        self.invalid({'channel': 'camera:get', 'payload': request, 'response': {'ok': True, 'value': dict(view, path='/x.mkv')}})
        draft = {'schema_version': '1.0', 'projectId': '3f2b9d1e-6c4a-4b7e-8a15-2d9c1e7f4a60',
                 'draftId': 'draft-1', 'baseRevisionId': '4a1c8e2f-7d3b-4c9a-9b26-3e8d2f1a5b71',
                 'expectedSequence': 3, 'expectedTimelineSha256': 'a' * 64, 'layoutId': None,
                 'atUs': 1000000, 'kind': 'pip', 'corner': 'bottom_right', 'size': 0.24, 'shape': 'circle',
                 'faceZoom': 1, 'focusX': 0.5, 'focusY': 0.5, 'moveUs': 600000}
        for wrong in [dict(draft, kind='carousel'), dict(draft, size=0.9), dict(draft, corner='middle'), dict(draft, extra=1)]:
            self.invalid({'channel': 'projects:manual-layout', 'payload': wrong, 'response': {'ok': False, 'message': 'x'}})
        self.valid({'channel': 'projects:manual-layout', 'payload': draft, 'response': {'ok': False, 'message': 'The draft changed. Try again.'}})

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
        for policy in ['any', 'copyright_free']:
            value = {'interfaceScale': 1, 'assetPolicy': policy}
            self.valid({'channel': 'preferences:set', 'payload': value, 'response': {'ok': True, 'value': value}})
        for policy in ['', 'none', None, True]:
            self.invalid({'channel': 'preferences:set', 'payload': {'interfaceScale': 1, 'assetPolicy': policy}, 'response': {'ok': True, 'value': {'interfaceScale': 1}}})
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

    def test_project_channels_success_errors_and_six_stages(self):
        for channel in ['list', 'create', 'open', 'navigate']:
            exchange = self.project_exchange(channel)
            self.valid(exchange)
            exchange['response'] = {'ok': False, 'message': 'Project could not be opened.'}
            self.valid(exchange)
        self.valid({'channel': 'projects:list', 'response': {'ok': True, 'value': []}})
        for stage in ['record_import', 'auto_edit', 'edit', 'clips', 'export', 'done']:
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
        for stage in ['home', 'qa', 'complete', 'review', 'delete', None, 0]:
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

    def test_project_rename_and_delete_are_path_free_and_bounded(self):
        view = self.project_view()
        project_id = view['id']
        renamed = deepcopy(view)
        renamed['name'] = 'Weekly update'
        self.valid({'channel': 'projects:rename', 'payload': {'id': project_id, 'name': 'Weekly update'},
                    'response': {'ok': True, 'value': renamed}})
        self.valid({'channel': 'projects:rename', 'payload': {'id': project_id, 'name': 'x' * 160},
                    'response': {'ok': False, 'message': 'The project could not be renamed.'}})
        for name in ['', ' lead', 'trail ', 'a/b', 'a\\b', 'line\nbreak', 'x' * 161, None, 7]:
            self.invalid({'channel': 'projects:rename', 'payload': {'id': project_id, 'name': name},
                          'response': {'ok': True, 'value': renamed}})
        for payload in [{'id': project_id}, {'id': '../project', 'name': 'A'},
                        {'id': project_id, 'name': 'A', 'path': '/private/project'}]:
            self.invalid({'channel': 'projects:rename', 'payload': payload,
                          'response': {'ok': True, 'value': renamed}})
        self.valid({'channel': 'projects:delete', 'payload': {'id': project_id},
                    'response': {'ok': True, 'value': None}})
        self.valid({'channel': 'projects:delete', 'payload': {'id': project_id},
                    'response': {'ok': False, 'message': 'Close the project before deleting it.'}})
        for payload in [{}, {'id': '../project'}, {'id': project_id, 'path': '/private/project'}, None]:
            self.invalid({'channel': 'projects:delete', 'payload': payload,
                          'response': {'ok': True, 'value': None}})
        self.invalid({'channel': 'projects:delete', 'payload': {'id': project_id},
                      'response': {'ok': True, 'value': view}})

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

    def test_edit_summary_channels_carry_plain_rows_and_no_paths(self):
        summary = json.loads(
            (ROOT / 'docs/examples/desktop_ipc_edit_summary.example.json').read_text(encoding='utf-8')
        )
        self.valid(summary)
        for kind in ['everything', 'Zooms', None]:
            bad = deepcopy(summary)
            bad['response']['value']['rows'][0]['kind'] = kind
            self.invalid(bad)
        leaked = deepcopy(summary)
        leaked['response']['value']['rows'][0]['path'] = 'C:/private/source.mkv'
        self.invalid(leaked)
        bad_payload = deepcopy(summary)
        bad_payload['payload']['path'] = 'C:/private/source.mkv'
        self.invalid(bad_payload)
        put_back = deepcopy(summary)
        put_back['response']['value']['putBack'] = {'kind': 'zooms', 'label': '5 zooms removed'}
        self.valid(put_back)
        undo = {
            'channel': 'edit-summary:undo',
            'payload': {'schema_version': '1.0', 'project_id': summary['payload']['project_id'], 'kind': 'zooms'},
            'response': {'ok': False, 'message': 'That change is already gone.'},
        }
        self.valid(undo)
        undo['payload']['kind'] = 'all'
        self.invalid(undo)
        put = {
            'channel': 'edit-summary:put-back',
            'payload': {'schema_version': '1.0', 'project_id': summary['payload']['project_id']},
            'response': {'ok': False, 'message': 'The edit changed. Try again.'},
        }
        self.valid(put)
        put['payload']['kind'] = 'zooms'
        self.invalid(put)

    def test_draft_integrity_channel_returns_only_a_path_free_draft_head(self):
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
        for provider in ['claude', 'codex', 'deepseek', 'openai', 'gemini']:
            self.valid({'channel': 'magic:start',
                        'payload': {'schema_version': '1.0', 'project_id': 'project-1', 'preset': 'tight',
                                    'provider': provider},
                        'response': {'ok': True, 'value': example['response']['value']}})
        self.invalid({'channel': 'magic:start',
                      'payload': {'schema_version': '1.0', 'project_id': 'project-1', 'preset': 'extreme',
                                  'provider': 'claude'},
                      'response': {'ok': True, 'value': example['response']['value']}})
        # The chosen connection is required and must be one the app offers.
        for payload in [
            {'schema_version': '1.0', 'project_id': 'project-1', 'preset': 'tight'},
            {'schema_version': '1.0', 'project_id': 'project-1', 'preset': 'tight', 'provider': 'astra'},
            {'schema_version': '1.0', 'project_id': 'project-1', 'preset': 'tight', 'provider': 'claude',
             'apiKey': 'sk-test'},
        ]:
            self.invalid({'channel': 'magic:start', 'payload': payload,
                          'response': {'ok': True, 'value': example['response']['value']}})
        # A skipped story edit explains how to fix it, in one of the fixed messages.
        skipped = deepcopy(example)
        skipped['response']['value']['message'] = (
            'The story edit was skipped. Claude Code is too old (2.1.302 or newer is needed): install the latest from claude.com/claude-code, '
            'choose Check again in Settings, then run the rough cut again.')
        self.valid(skipped)

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
            'roughCutSelection': {'model': 'haiku', 'effort': None},
            'message': None,
        }
        self.valid({'channel': 'claude:get', 'response': {'ok': True, 'value': signed_in}})
        self.valid({'channel': 'claude:select', 'payload': {'model': 'sonnet', 'effort': 'high'},
                    'response': {'ok': True, 'value': signed_in}})
        self.valid({'channel': 'claude:select-rough-cut', 'payload': {'model': 'haiku', 'effort': None},
                    'response': {'ok': True, 'value': signed_in}})
        missing = deepcopy(signed_in)
        del missing['roughCutSelection']
        self.invalid({'channel': 'claude:get', 'response': {'ok': True, 'value': missing}})
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
        signed_out.update(account=None, models=[], selection=None, roughCutSelection=None)
        self.valid({'channel': 'claude:get', 'response': {'ok': True, 'value': signed_out}})
        self.invalid({'channel': 'claude:sign-in', 'payload': {'code': '1234'},
                      'response': {'ok': True, 'value': signed_out}})
        self.invalid({'channel': 'claude:select', 'payload': {'model': 'default', 'effort': 'ultra'},
                      'response': {'ok': True, 'value': signed_in}})

    def test_sound_layers_are_path_free_and_bounded(self):
        request = {'schema_version': '1.0', 'project_id': 'project-1'}
        layer = {'sound_id': 'sound-1', 'name': 'Theme', 'kind': 'music', 'file_name': 'theme',
                 'asset_id': 'asset-1', 'asset_start_us': 0, 'fade_in_us': 1000000, 'fade_out_us': 2000000,
                 'gain_db': -18, 'duck_db': 12, 'loop': True, 'timeline_range': {'start_us': 0, 'end_us': 9000000}}
        view = dict(request, layers=[layer, dict(layer, sound_id='sound-2', kind='effect', timeline_range=None)])
        calls = [('sounds:get', request),
                 ('sounds:add', dict(request, kind='effect', start_us=2500000)),
                 ('sounds:update', dict(request, sound_id='sound-1', gain_db=-24, duck_db=0)),
                 ('sounds:remove', dict(request, sound_id='sound-1'))]
        for channel, payload in calls:
            self.valid({'channel': channel, 'payload': payload, 'response': {'ok': True, 'value': view}})
            self.valid({'channel': channel, 'payload': payload, 'response': {'ok': False, 'message': 'Open this project first.'}})
        for wrong in [dict(request, kind='ambience', start_us=0), dict(request, kind='music', start_us=-1),
                      dict(request, kind='music', start_us=0, path='/music/x.mp3'),
                      dict(request, sound_id='sound-1', gain_db=40, duck_db=0),
                      dict(request, sound_id='sound-1', gain_db=-6, duck_db=31),
                      dict(request, sound_id='../x')]:
            self.invalid({'channel': 'sounds:add', 'payload': wrong, 'response': {'ok': True, 'value': view}})
        for bad in [dict(view, layers=[dict(layer, path='/music/theme.mp3')]),
                    dict(view, layers=[dict(layer, gain_db=-6.5)]),
                    dict(view, layers=[dict(layer, kind='ambience')]),
                    dict(view, layers=[dict(layer, timeline_range={'start_us': 5, 'end_us': 5, 'x': 1})])]:
            self.invalid({'channel': 'sounds:get', 'payload': request, 'response': {'ok': True, 'value': bad}})

if __name__ == '__main__':
    unittest.main()

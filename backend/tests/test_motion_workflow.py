import base64
import tempfile
import unittest
import subprocess
import imageio_ffmpeg
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from api.app import app
from config import settings
from models.image_client import ImageClient
from models.image_gpt import ImageGPT
from models.video_client import VideoClient
from models.video_seedance import SeedanceVideoClient


class ReferenceContractTests(unittest.TestCase):
    def test_gpt_uses_settings_endpoint_unless_explicitly_overridden(self):
        with patch('models.image_gpt.Config.OPENAI_BASE_URL', 'https://configured.example/v1'), patch('models.image_gpt.OpenAI') as sdk:
            ImageGPT(api_key='test', proxy='')
            self.assertEqual(sdk.call_args.kwargs.get('base_url'), 'https://configured.example/v1')
            ImageGPT(api_key='test', base_url='https://explicit.example/v1', proxy='')
            self.assertEqual(sdk.call_args.kwargs.get('base_url'), 'https://explicit.example/v1')

    def test_seedance_25_keeps_requested_clip_duration(self):
        from pipelines.api_media import generate_video_api
        with patch('pipelines.api_media.VideoClient') as factory:
            generate_video_api(prompt='dance', model='doubao-seedance-2-5-260628',
                               output_path='out.mp4', duration=12)
            self.assertEqual(factory.return_value.generate_video.call_args.kwargs['duration'], 12)

    def test_seedance_router_preserves_character_action_and_optional_music(self):
        client = VideoClient()
        received = {}
        client._seedance_client = SimpleNamespace(generate_video=lambda **kw: received.update(kw) or 'done')
        client.generate_video('dance', None, 'out.mp4', model='doubao-seedance-2-0-260128',
                              reference_image_path='actor.png', first_clip_path='dance.mp4',
                              reference_audio_path='beat.wav')
        self.assertEqual(received.get('reference_image_paths'), ['actor.png'])
        self.assertEqual(received.get('reference_video_paths'), ['dance.mp4'])
        self.assertEqual(received.get('reference_audio_path'), 'beat.wav')

    def test_seedance_multimodal_payload_has_explicit_roles_without_first_frame(self):
        with tempfile.TemporaryDirectory() as temp:
            paths = []
            for name in ['actor.png', 'motion.mp4', 'beat.wav']:
                p = Path(temp) / name
                p.write_bytes(b'fixture')
                paths.append(str(p))
            sent = {}
            def post(url, **kw):
                sent.update(kw['json'])
                return SimpleNamespace(ok=True, json=lambda: {'id': 'remote-123'})
            with patch('models.video_seedance.requests.post', side_effect=post):
                try:
                    SeedanceVideoClient(api_key='test')._submit_task(
                        'dance', None, 'doubao-seedance-2-0-260128', 5,
                        reference_image_paths=[paths[0]], reference_video_paths=[paths[1]],
                        reference_audio_path=paths[2], generate_audio=False)
                except Exception as exc:
                    self.fail(f'Multimodal references did not reach the API: {exc}')
            self.assertEqual([x.get('role') for x in sent['content'][1:]],
                             ['reference_image', 'reference_video', 'reference_audio'])
            self.assertFalse(sent['generate_audio'])
            self.assertTrue(sent['content'][3]['audio_url']['url'].startswith('data:audio/wav;base64,'))

    def test_gpt_unified_route_keeps_approved_reference(self):
        with tempfile.TemporaryDirectory() as temp:
            result = Path(temp) / 'result.png'
            result.write_bytes(b'image')
            received = {}
            client = ImageClient()
            client._gpt_client = SimpleNamespace(generate_image=lambda **kw: received.update(kw) or str(result))
            client.generate_image('same teacher', model='gpt-image-2', image_paths=['teacher.png'], save_dir=temp)
            self.assertEqual(received.get('image_urls'), ['teacher.png'])

    def test_gpt_reference_uses_edit_endpoint_and_plain_prompt_uses_generate(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'ref.png'
            p.write_bytes(b'approved-image')
            calls = []
            response = SimpleNamespace(data=[SimpleNamespace(b64_json=base64.b64encode(b'output').decode())])
            def edit(**kw):
                calls.append(('edit', kw['image'][0].read()))
                return response
            def generate(**kw):
                calls.append(('generate', None))
                return response
            client = ImageGPT(api_key='test', proxy='')
            client.client = SimpleNamespace(images=SimpleNamespace(edit=edit, generate=generate))
            client.generate_image('turn', image_urls=[str(p)], save_dir=temp)
            client.generate_image('new', save_dir=temp)
            self.assertEqual(calls, [('edit', b'approved-image'), ('generate', None)])


class MotionProjectTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for name, folder in [('TASK_DATA_DIR', 'data'), ('TASK_RESULT_DIR', 'result')]:
            patcher = patch('pipelines.storage.' + name, str(Path(temp.name) / folder))
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_optional_music_is_sent_only_when_this_shot_enables_it(self):
        from pipelines.motion import MotionProject, Shot
        with tempfile.TemporaryDirectory() as temp, patch.object(settings, 'CODE_DIR', temp):
            root = Path(temp)
            actor = root / 'actor.png'
            actor.write_bytes(b'image')
            music = root / 'music.wav'
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-f', 'lavfi', '-i',
                            'sine=frequency=440:duration=8', str(music)], check=True)
            project = MotionProject(reference_music_path=str(music), shots=[Shot(
                id='dance', prompt='raise hand', character_image=str(actor), duration=4,
                reference_start=2)]).model_dump()
            client = TestClient(app)
            project = client.post('/api/pipelines/motion/projects', json=project).json()
            endpoint = '/api/pipelines/motion/projects/' + project['id']
            with patch('pipelines.api_media.generate_video_api') as generate:
                response = client.post(endpoint + '/shots/dance/generate', json={'kind': 'video'})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIsNone(generate.call_args.kwargs['reference_audio_path'])
                project = client.get(endpoint).json()
                project['shots'][0]['use_reference_music'] = True
                client.put(endpoint, json=project)
                response = client.post(endpoint + '/shots/dance/generate', json={'kind': 'video'})
                self.assertEqual(response.status_code, 200, response.text)
                audio = generate.call_args.kwargs['reference_audio_path']
                pcm = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-v', 'error', '-i', audio,
                                      '-f', 's16le', '-ac', '1', '-ar', '8000', '-'], capture_output=True, check=True).stdout
                self.assertAlmostEqual(len(pcm) / 16000, 4, delta=.05)
                self.assertFalse(generate.call_args.kwargs['generate_audio'])
                self.assertEqual(client.get(endpoint).json()['final_music_path'], '')

    def test_uploads_survive_temporary_cache_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            uploads = root / 'uploads'
            uploads.mkdir()
            source = uploads / 'actor.png'
            source.write_bytes(b'approved reference')
            with patch.object(settings, 'CODE_DIR', str(root / 'code')), patch.object(settings, 'TEMP_DIR', str(uploads)):
                client = TestClient(app)
                response = client.post('/api/pipelines/motion/projects', json={
                    'shots': [{'character_image': str(source)}]})
                self.assertEqual(response.status_code, 200, response.text)
                pinned = Path(response.json()['shots'][0]['character_image'])
                source.unlink()
                self.assertEqual(pinned.read_bytes(), b'approved reference')

    def test_project_can_save_without_music_and_roundtrip_shot_order(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(settings, 'CODE_DIR', temp):
            client = TestClient(app)
            created = client.post('/api/pipelines/motion/projects', json={'title': '求学'} )
            self.assertEqual(created.status_code, 200, created.text)
            project = created.json()
            project['shots'] = [{'id': 'walk', 'title': '山里走', 'prompt': '向前走'},
                                {'id': 'dance', 'title': '老师起舞', 'prompt': '跳舞'}]
            saved = client.put('/api/pipelines/motion/projects/' + project['id'], json=project)
            self.assertEqual(saved.status_code, 200, saved.text)
            loaded = client.get('/api/pipelines/motion/projects/' + project['id']).json()
            self.assertEqual([x['id'] for x in loaded['shots']], ['walk', 'dance'])
            self.assertEqual(loaded['reference_music_path'], '')
            self.assertEqual(loaded['final_music_path'], '')

    def test_export_trims_orders_and_mixes_without_a_cloud_call(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(settings, 'CODE_DIR', temp):
            ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            root = Path(temp)
            for color in ['red', 'blue']:
                subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', f'color={color}:s=160x90:r=24:d=3',
                                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(root / f'{color}.mp4')], check=True)
            subprocess.run([ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
                            str(root / 'music.wav')], check=True)
            client = TestClient(app)
            created = client.post('/api/pipelines/motion/projects', json={'title': 'export check'})
            self.assertEqual(created.status_code, 200, created.text)
            project = created.json()
            project['shots'] = [
                {'id': 'a', 'selected_video': str(root / 'red.mp4'), 'trim_start': 1, 'trim_duration': 2, 'speed': 2},
                {'id': 'b', 'selected_video': str(root / 'blue.mp4'), 'trim_duration': 1},
            ]
            project['final_music_path'] = str(root / 'music.wav')
            project['music_start'] = 1
            saved = client.put('/api/pipelines/motion/projects/' + project['id'], json=project)
            self.assertEqual(saved.status_code, 200, saved.text)
            exported = client.post('/api/pipelines/motion/projects/' + project['id'] + '/export')
            self.assertEqual(exported.status_code, 200, exported.text)
            task = client.get('/api/tasks/' + exported.json()['task_id']).json()
            self.assertEqual(task['status'], 'completed', task.get('error'))
            video = task['output']['video_path']
            pcm = subprocess.run([ffmpeg, '-v', 'error', '-i', video, '-vn', '-f', 's16le', '-ac', '1', '-ar', '8000', '-'], capture_output=True, check=True).stdout
            self.assertAlmostEqual(len(pcm) / 16000, 2, delta=.15)
            self.assertNotEqual(set(pcm), {0})
            for second, channel in [(.3, 0), (1.4, 2)]:
                pixel = subprocess.run([ffmpeg, '-v', 'error', '-ss', str(second), '-i', video, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
                self.assertGreater(pixel[channel], 180)

    def test_missing_shot_is_not_silently_skipped_on_export(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(settings, 'CODE_DIR', temp):
            client = TestClient(app)
            response = client.post('/api/pipelines/motion/projects', json={'title': 'missing', 'shots': [{'id': 'a'}]})
            self.assertEqual(response.status_code, 200, response.text)
            exported = client.post('/api/pipelines/motion/projects/' + response.json()['id'] + '/export')
            self.assertEqual(exported.status_code, 400)

    def test_seedance_resume_uses_saved_task_without_resubmitting(self):
        with tempfile.TemporaryDirectory() as temp:
            client = SeedanceVideoClient(api_key='test')
            with patch.object(client, '_submit_task', side_effect=AssertionError('duplicate submission')), patch.object(client, '_poll_until_done', return_value='https://example.com/video') as poll, patch.object(client, '_download_video'):
                result = client.generate_video('dance', None, str(Path(temp) / 'out.mp4'), remote_task_id='existing')
            self.assertEqual(result, 'https://example.com/video')
            poll.assert_called_once_with('existing')

    def test_audio_upload_is_supported(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(settings, 'TEMP_DIR', temp):
            response = TestClient(app).post('/api/upload_media', files={'file': ('music.wav', b'RIFF-test', 'audio/wav')})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(Path(response.json()['file_path']).exists())


if __name__ == '__main__':
    unittest.main()

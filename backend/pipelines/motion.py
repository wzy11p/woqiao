"""Small, local shot workspace. Music references and final soundtrack are independent."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ConfigDict
from config import settings
from path_security import resolve_allowed_local_file
from .storage import task_output_dir, update_task
from .utils import artifact, run_blocking

LOCK = threading.RLock()
CAMERAS = {
    'fixed': '固定全身镜头，人物完整入画，机位和构图保持稳定。',
    'follow': '平稳跟拍，与人物保持距离，人物在画面中的大小稳定。',
    'push': '缓慢推近，从中景靠近人物，在动作结束时停稳。',
    'reveal': '缓慢向上抬镜，逐步揭示环境，最后停在全景。',
    'arc': '围绕人物做小幅平稳弧线移动，保持人物完整可见。',
}


class Shot(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    id: str = Field(default_factory=lambda: uuid.uuid4().hex, pattern=r'^[\w-]{1,64}$')
    title: str = Field('新镜头', max_length=120)
    prompt: str = Field('', max_length=8000)
    camera: Literal['fixed', 'follow', 'push', 'reveal', 'arc'] = 'fixed'
    character_image: str = ''
    scene_image: str = ''
    frame_image: str = ''
    action_video: str = ''
    use_reference_music: bool = False
    reference_start: float = Field(0, ge=0, le=7200)
    action_start: float = Field(0, ge=0, le=7200)
    duration: int = Field(5, ge=4, le=12)
    selected_video: str = ''
    trim_start: float = Field(0, ge=0, le=7200)
    trim_duration: float = Field(5, gt=0, le=120)
    speed: float = Field(1, ge=.5, le=2)
    original_volume: float = Field(0, ge=0, le=2)
    dialogue_path: str = ''
    dialogue_delay: float = Field(0, ge=0, le=120)
    candidates: list[str] = Field(default_factory=list, max_length=100)


class MotionProject(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    id: str = Field(default_factory=lambda: uuid.uuid4().hex, pattern=r'^[a-f0-9]{32}$')
    title: str = Field('我的漫剧', max_length=120)
    idea: str = Field('', max_length=20000)
    ratio: Literal['16:9', '9:16', '1:1'] = '16:9'
    video_model: str = 'doubao-seedance-2-0-260128'
    image_model: str = 'gpt-image-2'
    reference_music_path: str = ''
    final_music_path: str = ''
    music_start: float = Field(0, ge=0, le=7200)
    music_delay: float = Field(0, ge=0, le=7200)
    music_volume: float = Field(.7, ge=0, le=2)
    markers: list[float] = Field(default_factory=list, max_length=200)
    shots: list[Shot] = Field(default_factory=list, max_length=40)
    export_task_id: str = ''


def project_path(project_id):
    if not re.fullmatch(r'[a-f0-9]{32}', project_id):
        raise ValueError('项目编号无效')
    return Path(settings.CODE_DIR) / 'data' / 'motion' / f'{project_id}.json'


def local_media(path):
    return resolve_allowed_local_file(path, [settings.CODE_DIR, settings.TEMP_DIR])


def save_project(project: MotionProject):
    """Pin uploaded assets outside the disposable upload cache, then save atomically."""
    data = project.model_dump()
    if any(not 0 <= value <= 7200 for value in data['markers']):
        raise ValueError('时间标记必须在 0–7200 秒之间')
    if len({s['id'] for s in data['shots']}) != len(data['shots']):
        raise ValueError('镜头编号不能重复')
    with LOCK:
        asset_dir = Path(settings.CODE_DIR) / 'result' / 'motion' / project.id / 'assets'
        def pin(value):
            if not value:
                return ''
            source = Path(local_media(value))
            if source.is_relative_to(Path(settings.TEMP_DIR).resolve()):
                with source.open('rb') as file:
                    digest = hashlib.file_digest(file, 'sha256').hexdigest()[:24]
                asset_dir.mkdir(parents=True, exist_ok=True)
                target = asset_dir / (digest + source.suffix.lower())
                if not target.exists():
                    shutil.copy2(source, target)
                return str(target.resolve())
            return str(source)
        for field in ['reference_music_path', 'final_music_path']:
            data[field] = pin(data[field])
        for shot in data['shots']:
            for field in ['character_image', 'scene_image', 'frame_image', 'action_video', 'selected_video', 'dialogue_path']:
                shot[field] = pin(shot[field])
        path = project_path(project.id)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(f'.{uuid.uuid4().hex}.tmp')
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        os.replace(temp, path)
    return data


def load_project(project_id):
    path = project_path(project_id)
    if not path.exists():
        raise FileNotFoundError('项目不存在')
    return json.loads(path.read_text())


def ffmpeg():
    found = shutil.which('ffmpeg')
    if found:
        return found
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError) as exc:
        raise RuntimeError('缺少视频处理组件，请安装 requirements.txt 中的 imageio-ffmpeg') from exc


def run_ffmpeg(args):
    result = subprocess.run([ffmpeg(), '-nostdin', '-hide_banner', '-v', 'error', '-y', *args],
                            capture_output=True, timeout=600)
    if result.returncode:
        raise ValueError('媒体处理失败：' + result.stderr.decode(errors='replace')[-1500:])


def media_info(path):
    path = local_media(path)
    result = subprocess.run([ffmpeg(), '-nostdin', '-hide_banner', '-i', path], capture_output=True, timeout=20)
    info = result.stderr.decode(errors='replace')
    match = re.search(r'Duration: (\d+):(\d+):([\d.]+)', info)
    if not match:
        raise ValueError('无法读取媒体时长，请检查文件是否有效')
    duration = int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3])
    return {'duration': duration, 'has_audio': 'Audio:' in info, 'has_video': 'Video:' in info}


def excerpt(path, output, start, duration, kind):
    info = media_info(path)
    if start + duration > info['duration'] + .08:
        raise ValueError(f'参考片段超出素材时长（素材 {info["duration"]:.2f} 秒）')
    if kind == 'audio' and not info['has_audio']:
        raise ValueError('参考音乐没有音轨')
    args = ['-ss', str(start), '-i', local_media(path), '-t', str(duration)]
    if kind == 'audio':
        args += ['-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le']
    else:
        args += ['-an', '-vf', "scale='if(gte(iw,ih),960,-2)':'if(gte(iw,ih),-2,960)'", '-r', '24', '-c:v', 'libx264', '-crf', '24']
    run_ffmpeg([*args, output])
    return output


def validate_video(project, shot):
    if not shot['prompt'].strip():
        raise ValueError('请描述这一镜的人物动作')
    if not (shot['frame_image'] or shot['character_image']):
        raise ValueError('请先上传人物图或选择镜头图')
    if not re.search(r'seedance-2-(0|5)', project['video_model']):
        raise ValueError('人物动作工作台目前支持 Seedance 2.0 / 2.5，请在设置中配置方舟接口')
    if shot['use_reference_music'] and not project['reference_music_path']:
        raise ValueError('请先导入参考音乐，或关闭这一镜的节奏参考')


async def generate_shot(task_id, params):
    from .api_media import generate_image_api, generate_video_api
    project, shot = params['project'], params['shot']
    output_dir = task_output_dir(task_id)
    refs = list(dict.fromkeys(p for p in [shot['character_image'], shot['scene_image']] if p))
    if params['kind'] == 'image':
        prompt = shot['prompt'] + '\n' + CAMERAS[shot['camera']]
        if shot['character_image']:
            prompt += '\n第一张参考图提供人物外貌和服装，保持同一角色。'
        if shot['scene_image']:
            prompt += '\n最后一张参考图提供场景空间和画风。'
        path = await run_blocking(generate_image_api, prompt=prompt, model=project['image_model'],
                                 output_dir=output_dir, task_id=task_id, image_paths=refs,
                                 video_ratio=project['ratio'])
        return {'image_path': path}, [artifact(path, 'image', '镜头图')]
    validate_video(project, shot)
    from .storage import load_task
    remote_id = (load_task(task_id) or {}).get('remote_task_id')
    prompt = shot['prompt'] + '\n' + CAMERAS[shot['camera']]
    frame = shot['frame_image'] or shot['character_image']
    refs = list(dict.fromkeys([frame, *refs]))
    prompt += '\n@图片1 提供本镜头的构图或角色外观。'
    if shot['character_image']:
        prompt += f'\n@图片{refs.index(shot["character_image"]) + 1} 是人物身份参考，保持同一身份、发型与服装。'
    if shot['scene_image']:
        prompt += f'\n@图片{refs.index(shot["scene_image"]) + 1} 只参考场景空间和画风。'
    videos, audio = [], None
    if shot['action_video']:
        videos = [await run_blocking(excerpt, shot['action_video'], os.path.join(output_dir, 'action.mp4'),
                                     shot['action_start'], shot['duration'], 'video')]
        prompt += '\n@视频1 只参考人物动作和动作顺序，镜头运动按文字要求。'
    if shot['use_reference_music']:
        audio = await run_blocking(excerpt, project['reference_music_path'], os.path.join(output_dir, 'rhythm.wav'),
                                   shot['reference_start'], shot['duration'], 'audio')
        prompt += '\n@音频1 只用于动作节奏参考，让明显的动作重音跟随音乐节奏。'
    path = os.path.join(output_dir, 'video.mp4')
    await run_blocking(generate_video_api, prompt=prompt, model=project['video_model'], output_path=path,
                       image_path=None, reference_image_paths=refs, reference_video_paths=videos,
                       reference_audio_path=audio, duration=shot['duration'], video_ratio=project['ratio'],
                       video_resolution='720p', generate_audio=False, remote_task_id=remote_id,
                       on_submitted=lambda value: update_task(task_id, remote_task_id=value, message='云端已接收，等待视频生成'))
    return {'video_path': path}, [artifact(path, 'video', '动作候选')]


def validate_export(project):
    if not project['shots']:
        raise ValueError('请至少添加一个镜头')
    for index, shot in enumerate(project['shots'], 1):
        if not shot['selected_video']:
            raise ValueError(f'第 {index} 镜还没有选定视频，请先生成或导入')
        info = media_info(shot['selected_video'])
        if not info['has_video']:
            raise ValueError(f'第 {index} 镜不是视频')
        if shot['trim_start'] + shot['trim_duration'] > info['duration'] + .08:
            raise ValueError(f'第 {index} 镜裁切超出视频长度（{info["duration"]:.2f} 秒）')


def render_project(task_id, project):
    validate_export(project)
    output_dir = Path(task_output_dir(task_id))
    output_dir.mkdir(parents=True, exist_ok=True)
    width, height = {'16:9': (1280, 720), '9:16': (720, 1280), '1:1': (720, 720)}[project['ratio']]
    segments = []
    total = 0
    for index, shot in enumerate(project['shots']):
        info = media_info(shot['selected_video'])
        length = shot['trim_duration'] / shot['speed']
        args = ['-ss', str(shot['trim_start']), '-t', str(shot['trim_duration']), '-i', local_media(shot['selected_video']),
                '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
        filters = [f'[0:v]setpts=(PTS-STARTPTS)/{shot["speed"]},scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v]',
                   f'[1:a]atrim=duration={length},asetpts=PTS-STARTPTS[silence]']
        audio_labels = ['[silence]']
        if info['has_audio'] and shot['original_volume']:
            filters.append(f'[0:a]asetpts=PTS-STARTPTS,atempo={shot["speed"]},volume={shot["original_volume"]}[original]')
            audio_labels.append('[original]')
        if shot['dialogue_path']:
            args += ['-i', local_media(shot['dialogue_path'])]
            filters.append(f'[2:a]asetpts=PTS-STARTPTS,adelay={round(shot["dialogue_delay"] * 1000)}:all=1[dialogue]')
            audio_labels.append('[dialogue]')
        filters.append(''.join(audio_labels) + f'amix=inputs={len(audio_labels)}:duration=first:normalize=0,alimiter=limit=0.95:latency=1[a]')
        segment = output_dir / f'part_{index:03d}.mp4'
        run_ffmpeg([*args, '-filter_complex', ';'.join(filters), '-map', '[v]', '-map', '[a]', '-t', str(length),
                    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(segment)])
        segments.append(segment)
        total += length
        update_task(task_id, progress=10 + round(65 * (index + 1) / len(project['shots'])), message=f'已剪辑 {index + 1}/{len(project["shots"])} 镜')
    listing = output_dir / 'clips.txt'
    listing.write_text(''.join(f"file '{p.name}'\n" for p in segments))
    joined = output_dir / 'picture.mp4'
    run_ffmpeg(['-f', 'concat', '-safe', '1', '-i', str(listing), '-c', 'copy', str(joined)])
    final = output_dir / 'final.mp4'
    if project['final_music_path']:
        music = local_media(project['final_music_path'])
        if project['music_start'] >= media_info(music)['duration']:
            raise ValueError('配乐开始位置超出音频长度')
        filters = f'[1:a]asetpts=PTS-STARTPTS,volume={project["music_volume"]},adelay={round(project["music_delay"] * 1000)}:all=1[bgm];[0:a][bgm]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:latency=1[a]'
        run_ffmpeg(['-i', str(joined), '-ss', str(project['music_start']), '-i', music,
                    '-filter_complex', filters, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac',
                    '-t', str(total), '-movflags', '+faststart', str(final)])
    else:
        shutil.copy2(joined, final)
    (output_dir / 'edit.json').write_text(json.dumps(project, ensure_ascii=False, indent=2))
    return {'video_path': str(final), 'duration': total}, [artifact(str(final), 'video', '成片')]


async def export_project(task_id, params):
    return await run_blocking(render_project, task_id, params['project'])

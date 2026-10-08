import threading
from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pipelines.motion import (MotionProject, load_project, save_project, project_path, local_media,
                              validate_export, validate_video, media_info)
from pipelines.storage import create_task, load_task, update_task
from pipelines.runner import run_pipeline_task

router = APIRouter(prefix='/api/pipelines/motion', tags=['Motion workspace'])
_running = set()
_lock = threading.RLock()


def read(project_id):
    try:
        return load_project(project_id)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(404, str(exc)) from exc


async def run_once(task_id, pipeline, params):
    try:
        await run_pipeline_task(task_id, pipeline, params)
    finally:
        with _lock:
            _running.discard(task_id)


def enqueue(background, pipeline, params):
    task = create_task(pipeline, params)
    with _lock:
        _running.add(task['task_id'])
    background.add_task(run_once, task['task_id'], pipeline, params)
    return task


@router.get('/projects')
def projects():
    folder = project_path('0' * 32).parent
    if not folder.exists():
        return []
    return [read(path.stem) for path in sorted(folder.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)]


@router.post('/projects')
def create(project: MotionProject):
    try:
        return save_project(project)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/projects/{project_id}')
def get(project_id: str):
    return read(project_id)


@router.put('/projects/{project_id}')
def save(project_id: str, project: MotionProject):
    read(project_id)
    if project.id != project_id:
        raise HTTPException(400, '项目编号不一致')
    try:
        return save_project(project)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


class Generation(BaseModel):
    kind: str = 'video'


@router.post('/projects/{project_id}/shots/{shot_id}/generate')
def generate(project_id: str, shot_id: str, request: Generation, background: BackgroundTasks):
    project = read(project_id)
    shot = next((item for item in project['shots'] if item['id'] == shot_id), None)
    if not shot:
        raise HTTPException(404, '镜头不存在')
    if request.kind not in ['image', 'video']:
        raise HTTPException(400, '生成类型无效')
    try:
        if request.kind == 'video':
            validate_video(project, shot)
        elif not shot['prompt'].strip():
            raise ValueError('请先描述镜头内容')
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    task = enqueue(background, 'motion_shot', {'project': project, 'shot': shot, 'kind': request.kind})
    shot['candidates'].append(task['task_id'])
    save_project(MotionProject(**project))
    return task


@router.post('/projects/{project_id}/export')
def export(project_id: str, background: BackgroundTasks):
    project = read(project_id)
    try:
        validate_export(project)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    task = enqueue(background, 'motion_export', {'project': project})
    project['export_task_id'] = task['task_id']
    save_project(MotionProject(**project))
    return task


@router.post('/tasks/{task_id}/resume')
def resume(task_id: str, background: BackgroundTasks):
    if len(task_id) > 80 or not all(c.isalnum() or c == '_' for c in task_id):
        raise HTTPException(400, '任务编号无效')
    task = load_task(task_id)
    if not task or task['pipeline'] != 'motion_shot' or not task.get('remote_task_id'):
        raise HTTPException(400, '没有可继续查询的云端任务')
    with _lock:
        if task_id in _running or task['status'] == 'completed':
            return task
        _running.add(task_id)
    update_task(task_id, status='pending', error=None, message='继续查询原云端任务')
    background.add_task(run_once, task_id, task['pipeline'], task['input'])
    return load_task(task_id)


@router.get('/media')
def media(path: str):
    try:
        resolved = local_media(path)
        if not resolved.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.bmp', '.mp4', '.mov', '.webm', '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg')):
            raise ValueError('不支持的媒体类型')
        return FileResponse(resolved)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/media-info')
def info(path: str):
    try:
        return media_info(path)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc

import asyncio
import json
import queue
import threading
import time
from typing import Any, AsyncIterator, Callable, Dict, Optional

from fastapi import Request

from core.orchestrator import WorkflowStage

STAGE_NAME_MAP = {
    "script_generation": "剧本生成",
    "character_design": "角色/场景设计",
    "storyboard": "分镜设计",
    "reference_generation": "参考图生成",
    "video_generation": "视频生成",
    "post_production": "后期剪辑",
}


def build_openclaw_message(stage: str, result: Dict[str, Any]) -> str:
    openclaw_msg = result.get("openclaw_hint", "")
    if not openclaw_msg and result.get("requires_intervention", False):
        stage_name = STAGE_NAME_MAP.get(stage, stage)
        openclaw_msg = f"{stage_name}完成，需要用户确认。请展示给用户并等待用户确认后才能调用 /continue。"
    return openclaw_msg


def make_progress_channel():
    progress_events = queue.Queue()
    event_trigger = asyncio.Event()
    loop = asyncio.get_running_loop()

    def progress_callback(phase, step, percent, data=None):
        event = {"phase": phase, "step": step, "percent": percent}
        if data:
            event["data"] = data
        progress_events.put(event)
        try:
            loop.call_soon_threadsafe(event_trigger.set)
        except RuntimeError:
            pass

    return progress_events, event_trigger, progress_callback


def serialize_progress_event(progress: Dict[str, Any]) -> str:
    event = {
        "type": "progress",
        "message": f"{progress['phase']}: {progress['step']}",
        "phase": progress["phase"],
        "step_desc": progress["step"],
        "percent": progress["percent"],
    }
    if progress.get("data"):
        event["data"] = progress["data"]
    return json.dumps(event) + "\n"


async def stream_workflow_task(
    *,
    request: Request,
    workflow_engine,
    state,
    stage: str,
    input_data: Dict[str, Any],
    cancellation_check: Callable[[], bool],
    progress_callback: Callable[..., None],
    progress_events,
    event_trigger: asyncio.Event,
    intervention: Optional[Dict[str, Any]] = None,
    include_payload_summary: bool = False,
    on_disconnect: Optional[Callable[[], None]] = None,
) -> AsyncIterator[str]:
    stage_enum = WorkflowStage(stage)

    try:
        task = asyncio.create_task(
            workflow_engine.execute_stage(
                state,
                stage_enum,
                input_data,
                cancellation_check=cancellation_check,
                progress_callback=progress_callback,
                intervention=intervention,
            )
        )

        while not task.done():
            try:
                await asyncio.wait_for(event_trigger.wait(), timeout=15.0)
            except asyncio.TimeoutError:
                yield json.dumps({"type": "heartbeat", "time": time.time()}) + "\n"

            event_trigger.clear()

            while not progress_events.empty():
                try:
                    yield serialize_progress_event(progress_events.get_nowait())
                except queue.Empty:
                    break

            if await request.is_disconnected():
                workflow_engine.track_background_task(task)
                return

        while not progress_events.empty():
            try:
                yield serialize_progress_event(progress_events.get_nowait())
                await asyncio.sleep(0)
            except queue.Empty:
                break

        result = task.result()
        status_snapshot = workflow_engine.persist_session_snapshot(state.session_id)

        payload = {
            "type": "stage_complete",
            "stage": stage,
            "status": status_snapshot,
            "requires_intervention": result.get("requires_intervention", False),
            "openclaw": build_openclaw_message(stage, result),
        }
        if include_payload_summary:
            payload["payload_summary"] = result.get("payload")
        yield json.dumps(payload) + "\n"

    except Exception as e:
        try:
            workflow_engine.persist_session_snapshot(state.session_id)
        except Exception:
            pass
        yield json.dumps({"type": "error", "content": str(e)}) + "\n"


def make_cancellation(workflow_engine, session_id: str):
    workflow_engine.reset_stop_event(session_id)
    session_stop = workflow_engine.get_stop_event(session_id)
    request_stop = threading.Event()
    return lambda: request_stop.is_set() or session_stop.is_set(), request_stop.set

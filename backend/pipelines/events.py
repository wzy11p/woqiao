import asyncio
import json
from collections import defaultdict
from typing import Any, AsyncIterator, Dict, Set

_subscribers: Dict[str, Set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)


def publish_task_event(task_id: str, event: dict[str, Any]) -> None:
    queues = list(_subscribers.get(task_id, set()))
    if not queues:
        return
    payload = {"task_id": task_id, **event}
    for queue in queues:
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        queue.put_nowait(payload)


async def task_event_stream(task_id: str, initial_event: dict[str, Any] | None = None) -> AsyncIterator[str]:
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
    _subscribers[task_id].add(queue)
    try:
        if initial_event:
            yield _format_sse(initial_event)
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=20)
                yield _format_sse(event)
                if event.get("type") in {"completed", "failed"}:
                    return
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
    finally:
        _subscribers[task_id].discard(queue)
        if not _subscribers[task_id]:
            _subscribers.pop(task_id, None)


def _format_sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

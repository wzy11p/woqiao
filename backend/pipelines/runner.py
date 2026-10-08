import logging
import traceback

from . import action_transfer, digital_human, standard, motion
from .storage import mark_completed, mark_failed, mark_running, update_task

logger = logging.getLogger(__name__)

PIPELINE_REGISTRY = {
    "motion_shot": motion.generate_shot,
    "motion_export": motion.export_project,
    "standard": standard.run,
    "quick_create": standard.run,
    "action_transfer": action_transfer.run,
    "digital_human": digital_human.run,
}


async def run_pipeline_task(task_id: str, pipeline: str, params: dict) -> None:
    runner = PIPELINE_REGISTRY[pipeline]
    try:
        logger.info("Pipeline task started: task_id=%s pipeline=%s", task_id, pipeline)
        mark_running(task_id)
        output, artifacts = await runner(task_id, params)
        mark_completed(task_id, output=output, artifacts=artifacts)
        logger.info(
            "Pipeline task completed: task_id=%s pipeline=%s artifacts=%d",
            task_id,
            pipeline,
            len(artifacts or []),
        )
    except Exception as exc:
        logger.exception("Pipeline task failed: task_id=%s pipeline=%s", task_id, pipeline)
        update_task(task_id, progress=0)
        mark_failed(task_id, f"{exc}\n{traceback.format_exc()}")

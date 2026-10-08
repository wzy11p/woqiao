import logging
from typing import Any, Optional

from models.image_client import ImageClient
from models.config_model import (
    image_capabilities,
    list_api_models,
    media_capabilities,
    model_ability_tags,
    parse_api_model,
    video_capabilities,
)
from models.video_client import VideoClient

logger = logging.getLogger(__name__)


def list_api_workflows(
    media_type: Optional[str] = None,
    required_adapter_abilities: Optional[list[str]] = None,
    verified_only: bool = False,
) -> list[dict[str, Any]]:
    return list_api_models(
        media_type=media_type,
        required_adapter_abilities=required_adapter_abilities,
        verified_only=verified_only,
    )


def parse_api_workflow(workflow: str, media_type: str) -> tuple[str, str]:
    return parse_api_model(workflow, media_type)


def normalize_video_duration(provider: str, model: str, duration: int) -> int:
    # Seedance 2.5 accepts 2–30 seconds, unlike the legacy 5/10 second clamp.
    if 'seedance-2-5' in (model or '').lower():
        return min(max(int(duration), 2), 30)
    contract = video_capabilities(provider, model).get("duration") or {}
    if contract.get("verified"):
        return min(max(int(duration), int(contract.get("min", duration))), int(contract.get("max", duration)))
    if provider == "dashscope":
        return 10 if duration >= 8 else 5
    if provider == "seedance" or "seedance" in (model or "").lower():
        return min(max(duration, 5), 10)
    return max(duration, 1)


def generate_image_api(
    *,
    prompt: str,
    model: str,
    output_dir: str,
    task_id: str,
    image_paths: Optional[list[str]] = None,
    video_ratio: str = "9:16",
    resolution: str = "1080P",
) -> str:
    _, resolved_model = parse_api_workflow(model, "image")
    logger.info(
        "Generating API image: model=%s refs=%d ratio=%s resolution=%s",
        resolved_model,
        len(image_paths or []),
        video_ratio,
        resolution,
    )
    paths = ImageClient().generate_image(
        prompt=prompt,
        image_paths=image_paths,
        model=resolved_model,
        save_dir=output_dir,
        session_id=task_id,
        video_ratio=video_ratio,
        resolution=resolution,
    )
    if not paths:
        raise RuntimeError(f"Image API returned no result for model={resolved_model}")
    return paths[0]


def generate_video_api(
    *,
    prompt: str,
    model: str,
    output_path: str,
    image_path: Optional[str] = None,
    duration: int = 5,
    video_ratio: str = "9:16",
    video_resolution: Optional[str] = None,
    **params,
) -> str:
    provider, resolved_model = parse_api_workflow(model, "video")
    safe_duration = normalize_video_duration(provider, resolved_model, int(duration))
    logger.info(
        "Generating API video: provider=%s model=%s duration=%ss ratio=%s output=%s",
        provider or "unknown",
        resolved_model,
        safe_duration,
        video_ratio,
        output_path,
    )
    VideoClient().generate_video(
        prompt=prompt,
        image_path=image_path,
        save_path=output_path,
        model=resolved_model,
        duration=safe_duration,
        video_ratio=video_ratio,
        resolution=video_resolution or params.pop("resolution", None),
        **params,
    )
    return output_path

import os

from .api_media import generate_video_api
from .storage import append_artifact, task_output_dir, update_task
from .utils import artifact, copy_input_file, run_blocking, write_json


def required_param(params: dict, key: str) -> str:
    value = params.get(key)
    if not value:
        raise ValueError(f"action_transfer pipeline requires {key}")
    return str(value)


async def run(task_id: str, params: dict) -> tuple[dict, list[dict]]:
    output_dir = task_output_dir(task_id)
    os.makedirs(output_dir, exist_ok=True)

    prompt = params.get("prompt_text") or params.get("prompt") or ""
    image_path = params.get("image_path") or params.get("image_asset")
    video_path = params.get("video_path") or params.get("video_asset")
    if not prompt.strip():
        raise ValueError("action_transfer requires prompt_text")
    if not image_path:
        raise ValueError("action_transfer requires image_path")
    if not video_path:
        raise ValueError("action_transfer requires video_path")

    image_path = copy_input_file(image_path, output_dir, "input_image")
    video_path = copy_input_file(video_path, output_dir, "input_video")
    final_video_path = os.path.join(output_dir, "final.mp4")
    video_model = required_param(params, "video_model")

    update_task(task_id, progress=20, message="Calling action-transfer video API")
    await run_blocking(
        generate_video_api,
        prompt=prompt,
        model=video_model,
        output_path=final_video_path,
        image_path=None,
        duration=int(params.get("duration") or 5),
        video_ratio=params.get("video_ratio") or "9:16",
        first_clip_path=video_path,
        reference_image_path=image_path,
        negative_prompt=params.get("negative_prompt"),
        video_resolution=params.get("video_resolution") or params.get("resolution"),
        watermark=params.get("watermark"),
        prompt_extend=params.get("prompt_extend"),
    )

    request_path = write_json(os.path.join(output_dir, "request.json"), {
        "prompt": prompt,
        "image_path": image_path,
        "video_path": video_path,
        "video_model": video_model,
    })
    artifacts = [
        artifact(request_path, "text", "request"),
        artifact(image_path, "image", "input_image"),
        artifact(video_path, "video", "input_video"),
        artifact(final_video_path, "video", "final"),
    ]
    for item in artifacts:
        append_artifact(task_id, item)
    return {"video_path": final_video_path, "request_path": request_path}, artifacts

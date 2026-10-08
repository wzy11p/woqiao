import json
import logging
import os
import re
from typing import Optional

from models.llm_client import LLM
from prompts.loader import format_prompt, load_prompt

from .api_media import generate_image_api, generate_video_api
from .storage import append_artifact, task_output_dir, update_task
from .tts import generate_edge_tts
from .utils import (
    artifact,
    concat_videos,
    create_static_image_clip,
    media_duration_seconds,
    render_static_text_image,
    render_template_media_video,
    render_template_text_image,
    replace_video_audio,
    run_blocking,
    template_media_spec,
    write_json,
    write_text,
)

DEFAULT_STYLE_CONTROL = (
    "Minimalist black-and-white matchstick figure style illustration, clean lines, simple sketch style"
)

logger = logging.getLogger(__name__)


def required_param(params: dict, key: str) -> str:
    value = params.get(key)
    if not value:
        raise ValueError(f"standard pipeline requires {key}")
    return str(value)


def split_by_periods(text: str) -> list[str]:
    parts = re.findall(r"[^。．.]+[。．.]?|[^。．.]+$", text.strip())
    return [part.strip() for part in parts if part.strip()]


def clamp_segment_count(value, default: int = 6) -> int:
    try:
        count = int(value)
    except (TypeError, ValueError):
        count = default
    return max(1, min(20, count))


def parse_json_object_response(text: str) -> dict:
    response = text.strip()
    try:
        return json.loads(response)
    except json.JSONDecodeError:
        match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", response, re.S)
        if not match:
            match = re.search(r"(\{.*\})", response, re.S)
        if not match:
            raise ValueError("Model response did not contain a JSON object.")
        return json.loads(match.group(1))


def parse_narrations_response(text: str, expected_count: int) -> list[str]:
    data = parse_json_object_response(text)
    narrations = data.get("narrations") if isinstance(data, dict) else None
    if not isinstance(narrations, list):
        raise ValueError("Model response missing narrations array.")

    segments = [str(item).strip() for item in narrations if str(item).strip()]
    if len(segments) != expected_count:
        raise ValueError(f"Expected {expected_count} narrations, got {len(segments)}.")
    return segments


def parse_image_prompts_response(text: str, expected_count: int) -> list[str]:
    data = parse_json_object_response(text)

    prompts = data.get("image_prompts") if isinstance(data, dict) else None
    if not isinstance(prompts, list):
        raise ValueError("Model response missing image_prompts array.")

    image_prompts = [str(prompt).strip() for prompt in prompts if str(prompt).strip()]
    if len(image_prompts) != expected_count:
        raise ValueError(
            f"Expected {expected_count} image prompts, got {len(image_prompts)}."
        )
    return image_prompts


def build_image_prompt(
    visual_prompt: str,
    style_control: str,
    *,
    subtitle: Optional[str] = None,
    render_subtitle_in_image: bool = False,
) -> str:
    style = style_control.strip()
    no_text_instruction = (
        "Do not include any text, captions, logos, watermarks, labels, typography, "
        "or written characters in the image."
    )
    text_in_pic_instruction = (
        "Render exactly one subtitle directly inside the image: "
        f"\"{subtitle or ''}\". Place this subtitle in a visually appropriate area "
        "that does not cover the main subject, using readable typography that matches "
        "the image style, strong contrast, balanced spacing, and clean composition. "
        "Copy the subtitle text exactly, preserving language, characters, and punctuation. "
        "Do not add a title. Do not add logos, watermarks, labels, or any other text."
    )
    text_instruction = text_in_pic_instruction if render_subtitle_in_image else no_text_instruction
    if not style:
        return f"{text_instruction}\n{visual_prompt}"
    return f"{style}\n{text_instruction}\n{visual_prompt}"


async def generate_image_prompts(
    narrations: list[str],
    style_control: str,
    llm: LLM,
    llm_model: str,
    *,
    render_subtitle_in_image: bool = False,
) -> list[str]:
    template = load_prompt("pipelines", "standard_image_prompt_generation", "en")
    prompt = format_prompt(
        template,
        narrations_count=len(narrations),
        narrations_json=json.dumps({"narrations": narrations}, ensure_ascii=False, indent=2),
    )
    response = await run_blocking(llm.query, prompt, model=llm_model)
    visual_prompts = parse_image_prompts_response(response, len(narrations))
    return [
        build_image_prompt(
            visual_prompt,
            style_control,
            subtitle=narrations[idx],
            render_subtitle_in_image=render_subtitle_in_image,
        )
        for idx, visual_prompt in enumerate(visual_prompts)
    ]


async def generate_narrations_from_inspiration(
    inspiration: str,
    segment_count: int,
    llm: LLM,
    llm_model: str,
) -> list[str]:
    template = load_prompt("pipelines", "standard_narration_generation", "zh")
    prompt = format_prompt(
        template,
        inspiration=inspiration,
        segment_count=segment_count,
    )
    response = await run_blocking(llm.query, prompt, model=llm_model)
    return parse_narrations_response(response, segment_count)


async def run(task_id: str, params: dict) -> tuple[dict, list[dict]]:
    output_dir = task_output_dir(task_id)
    os.makedirs(output_dir, exist_ok=True)

    text = params.get("text") or params.get("topic") or ""
    if not text.strip():
        raise ValueError("standard pipeline requires narration text")

    mode = params.get("mode") or "copy"
    source_text = text.strip()
    llm = None
    llm_model = required_param(params, "llm_model")
    if mode == "inspiration":
        segment_count = clamp_segment_count(params.get("segment_count"))
        update_task(task_id, progress=6, message="Writing narration from inspiration")
        llm = LLM()
        narrations = await generate_narrations_from_inspiration(
            source_text,
            segment_count,
            llm,
            llm_model,
        )
        source_text = "\n".join(narrations)
    else:
        narrations = split_by_periods(source_text)

    if not narrations:
        raise RuntimeError("No narration segments were generated.")

    title = (params.get("title") or "").strip()
    if not title:
        update_task(task_id, progress=8, message="Generating title")
        if llm is None:
            llm = LLM()
        title = await run_blocking(
            llm.query,
            f"为下面的文艺短视频旁白生成一个简短中文标题，只输出标题：\n{source_text}",
            model=llm_model,
        )
        title = title.strip().splitlines()[0]

    style_control = (params.get("style_control") or params.get("negative_prompt") or DEFAULT_STYLE_CONTROL).strip()
    video_ratio = params.get("video_ratio") or "9:16"
    image_model = params.get("image_model") or params.get("image_workflow")
    if not image_model:
        raise ValueError("standard pipeline requires image_model")
    image_resolution = params.get("image_resolution") or "1080P"
    enable_subtitles = bool(params.get("enable_subtitles", False))
    subtitle_render_mode = params.get("subtitle_render_mode") or "postprocess"
    if subtitle_render_mode not in {"postprocess", "image_model"}:
        subtitle_render_mode = "postprocess"
    render_subtitle_in_image = (
        enable_subtitles
        and subtitle_render_mode == "image_model"
        and not params.get("subtitle_template")
    )
    subtitle_template = params.get("subtitle_template")
    subtitle_template_fields = params.get("subtitle_template_fields") or {}
    template_media = template_media_spec(subtitle_template, video_ratio) if subtitle_template else None
    template_media_kind = params.get("template_media_kind") or "image"
    if template_media_kind not in {"image", "video"}:
        template_media_kind = "image"
    template_video_mode = bool(subtitle_template and template_media_kind == "video")
    if template_video_mode and template_media and not template_media.get("supports_video"):
        raise ValueError(f"Subtitle template does not support video media: {subtitle_template}")
    media_video_ratio = template_media["media_ratio"] if template_media else video_ratio
    media_resolution = template_media["media_resolution"] if template_media else image_resolution
    video_mode = params.get("video_mode") or "image_concat"
    dynamic_video = video_mode == "dynamic_video" or bool(params.get("generate_videos", False))
    video_model = params.get("video_model")
    video_resolution = params.get("video_resolution") or params.get("resolution") or "720P"
    if (dynamic_video or template_video_mode) and not video_model:
        raise ValueError("standard pipeline video generation requires video_model")
    video_duration = clamp_segment_count(params.get("video_duration") or params.get("duration") or 5, default=5)

    update_task(task_id, progress=9, message="Generating image prompts")
    if llm is None:
        llm = LLM()
    try:
        image_prompts = await generate_image_prompts(
            narrations,
            style_control,
            llm,
            llm_model,
            render_subtitle_in_image=render_subtitle_in_image,
        )
    except Exception as exc:
        logger.warning(
            "Failed to generate structured image prompts, fallback to narration prompts: task_id=%s error=%s",
            task_id,
            exc,
        )
        image_prompts = [
            build_image_prompt(
                narration,
                style_control,
                subtitle=narration,
                render_subtitle_in_image=render_subtitle_in_image,
            )
            for narration in narrations
        ]

    storyboard = {
        "title": title,
        "mode": mode,
        "input_text": text,
        "segment_count": len(narrations),
        "video_mode": "template_video" if template_video_mode else ("dynamic_video" if dynamic_video else "image_concat"),
        "style_control": style_control,
        "subtitle_render_mode": subtitle_render_mode,
        "subtitle_template": subtitle_template,
        "subtitle_template_fields": subtitle_template_fields,
        "template_media_kind": template_media_kind,
        "template_media": template_media,
        "frames": [
            {"index": idx + 1, "narration": narration, "image_prompt": image_prompts[idx]}
            for idx, narration in enumerate(narrations)
        ],
    }
    storyboard_path = write_json(os.path.join(output_dir, "storyboard.json"), storyboard)
    narration_path = write_text(os.path.join(output_dir, "narration.txt"), "\n".join(narrations))

    artifacts = [artifact(storyboard_path, "text", "storyboard"), artifact(narration_path, "text", "narration")]
    for item in artifacts:
        append_artifact(task_id, item)

    images = []
    for idx, prompt in enumerate(image_prompts, 1):
        update_task(
            task_id,
            progress=10 + int(40 * idx / len(image_prompts)),
            message=f"Generating image {idx}/{len(image_prompts)}",
        )
        image_path = await run_blocking(
            generate_image_api,
            prompt=prompt,
            model=image_model,
            output_dir=output_dir,
            task_id=task_id,
            video_ratio=media_video_ratio,
            resolution=media_resolution,
        )
        images.append(image_path)
        image_artifact = artifact(image_path, "image", f"image_{idx:02d}")
        artifacts.append(image_artifact)
        append_artifact(task_id, image_artifact)
        storyboard["frames"][idx - 1]["image_path"] = image_path
        write_json(storyboard_path, storyboard)

    audios = []
    for idx, narration in enumerate(narrations, 1):
        update_task(
            task_id,
            progress=50 + int(20 * idx / len(narrations)),
            message=f"Generating audio {idx}/{len(narrations)}",
        )
        audio_path = os.path.join(output_dir, f"audio_{idx:02d}.mp3")
        await generate_edge_tts(
            narration,
            output_path=audio_path,
            voice=params.get("tts_voice", "zh-CN-YunjianNeural"),
            speed=float(params.get("tts_speed", 1.0)),
        )
        audios.append(audio_path)
        audio_artifact = artifact(audio_path, "audio", f"audio_{idx:02d}")
        artifacts.append(audio_artifact)
        append_artifact(task_id, audio_artifact)
        storyboard["frames"][idx - 1]["audio_path"] = audio_path
        write_json(storyboard_path, storyboard)

    videos = []
    for idx, (image_path, audio_path) in enumerate(zip(images, audios), 1):
        update_task(
            task_id,
            progress=70 + int(20 * idx / len(images)),
            message=f"{'Rendering template video' if template_video_mode else ('Generating dynamic video' if dynamic_video else 'Creating static clip')} {idx}/{len(images)}",
        )
        duration = media_duration_seconds(audio_path) or 3.0
        clip_image_path = image_path
        video_path = os.path.join(output_dir, f"video_{idx:02d}.mp4")
        if enable_subtitles or (subtitle_template and template_video_mode):
            if subtitle_template and template_video_mode:
                media_video_path = os.path.join(output_dir, f"template_media_{idx:02d}.mp4")
                await run_blocking(
                    generate_video_api,
                    prompt=image_prompts[idx - 1],
                    model=video_model,
                    output_path=media_video_path,
                    image_path=image_path,
                    duration=max(video_duration, int(duration + 0.999)),
                    video_ratio=media_video_ratio,
                    video_resolution=video_resolution,
                )
                storyboard["frames"][idx - 1]["template_media_video_path"] = media_video_path

                template_video_path = os.path.join(output_dir, f"video_{idx:02d}_template.mp4")
                await run_blocking(
                    render_template_media_video,
                    media_video_path,
                    template_video_path,
                    poster_image_path=image_path,
                    subtitle=narrations[idx - 1],
                    title=title or None,
                    video_ratio=video_ratio,
                    template_id=subtitle_template,
                    template_values=subtitle_template_fields,
                    index=idx,
                    duration=duration,
                )
                storyboard["frames"][idx - 1]["template_video_path"] = template_video_path
                video_path = await run_blocking(
                    replace_video_audio,
                    template_video_path,
                    audio_path,
                    video_path,
                )
            elif subtitle_template:
                captioned_image_path = os.path.join(output_dir, f"captioned_image_{idx:02d}.jpg")
                clip_image_path = await run_blocking(
                    render_template_text_image,
                    image_path,
                    captioned_image_path,
                    subtitle=narrations[idx - 1],
                    title=title or None,
                    video_ratio=video_ratio,
                    template_id=subtitle_template,
                    template_values=subtitle_template_fields,
                    index=idx,
                )
            elif subtitle_render_mode == "postprocess":
                captioned_image_path = os.path.join(output_dir, f"captioned_image_{idx:02d}.jpg")
                clip_image_path = await run_blocking(
                    render_static_text_image,
                    image_path,
                    captioned_image_path,
                    subtitle=narrations[idx - 1],
                    title=title or None,
                    video_ratio=video_ratio,
                )
            else:
                storyboard["frames"][idx - 1]["captioned_image_path"] = clip_image_path
                storyboard["frames"][idx - 1]["subtitle_rendered_in_image"] = True
            if not template_video_mode and (subtitle_template or subtitle_render_mode == "postprocess"):
                captioned_artifact = artifact(clip_image_path, "image", f"captioned_image_{idx:02d}")
                artifacts.append(captioned_artifact)
                append_artifact(task_id, captioned_artifact)
                storyboard["frames"][idx - 1]["captioned_image_path"] = clip_image_path
        if subtitle_template and template_video_mode:
            pass
        elif dynamic_video:
            video_only_segment_path = os.path.join(output_dir, f"video_{idx:02d}_motion.mp4")
            await run_blocking(
                generate_video_api,
                prompt=image_prompts[idx - 1],
                model=video_model,
                output_path=video_only_segment_path,
                image_path=clip_image_path,
                duration=max(video_duration, int(duration + 0.999)),
                video_ratio=video_ratio,
                video_resolution=video_resolution,
            )
            motion_artifact = artifact(video_only_segment_path, "video", f"video_{idx:02d}_motion")
            artifacts.append(motion_artifact)
            append_artifact(task_id, motion_artifact)
            storyboard["frames"][idx - 1]["motion_video_path"] = video_only_segment_path
            video_path = await run_blocking(
                replace_video_audio,
                video_only_segment_path,
                audio_path,
                video_path,
            )
        else:
            await run_blocking(
                create_static_image_clip,
                clip_image_path,
                audio_path,
                video_path,
                video_ratio=video_ratio,
                duration=duration,
            )
        videos.append(video_path)
        video_artifact = artifact(video_path, "video", f"video_{idx:02d}")
        artifacts.append(video_artifact)
        append_artifact(task_id, video_artifact)
        storyboard["frames"][idx - 1]["video_path"] = video_path
        storyboard["frames"][idx - 1]["duration"] = duration
        write_json(storyboard_path, storyboard)

    video_only_path = None
    video_only_path = concat_videos(videos, os.path.join(output_dir, "final.mp4"))
    if not video_only_path:
        raise RuntimeError("Static short-video generation did not produce a final video.")

    final_path = video_only_path

    final_artifact = artifact(final_path, "video", "final")
    artifacts.append(final_artifact)
    append_artifact(task_id, final_artifact)

    write_json(storyboard_path, storyboard)
    output = {
        "title": title,
        "storyboard_path": storyboard_path,
        "narration_path": narration_path,
        "images": images,
        "audios": audios,
        "videos": videos,
        "video_mode": "template_video" if template_video_mode else ("dynamic_video" if dynamic_video else "image_concat"),
        "video_model": video_model if (dynamic_video or template_video_mode) else None,
        "subtitle_render_mode": subtitle_render_mode,
        "subtitle_template": subtitle_template,
        "subtitle_template_fields": subtitle_template_fields,
        "template_media_kind": template_media_kind,
        "template_media": template_media,
        "video_only_path": video_only_path,
        "final_video": final_path,
    }
    return output, artifacts

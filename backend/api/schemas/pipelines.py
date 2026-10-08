from typing import Any, Dict, Literal, Optional

from pydantic import BaseModel, Field


class StandardPipelineRequest(BaseModel):
    text: str = Field(..., description="Topic or fixed narration script")
    mode: str = "copy"
    title: Optional[str] = None
    segment_count: Optional[int] = Field(None, ge=1, le=20, description="Target narration segment count for inspiration mode")
    n_scenes: int = 5
    split_mode: str = "paragraph"
    llm_model: str
    image_model: str
    video_model: Optional[str] = None
    video_mode: str = Field("image_concat", description="image_concat or dynamic_video")
    video_ratio: str = "9:16"
    image_resolution: str = "1080P"
    video_resolution: Optional[str] = None
    style_control: Optional[str] = None
    generate_audio: bool = True
    generate_videos: bool = False
    enable_subtitles: bool = False
    subtitle_render_mode: Literal["postprocess", "image_model"] = "postprocess"
    subtitle_template: Optional[str] = None
    subtitle_template_fields: Optional[Dict[str, str]] = None
    template_media_kind: Literal["image", "video"] = "image"
    video_duration: int = 5
    tts_voice: str = "zh-CN-YunjianNeural"
    tts_speed: float = 1.0
    negative_prompt: Optional[str] = None
    watermark: Optional[bool] = None
    generate_audio_native: Optional[bool] = None


class ActionTransferPipelineRequest(BaseModel):
    prompt_text: str
    image_path: str
    video_path: str
    video_model: str
    duration: int = 5
    video_ratio: str = "9:16"
    video_resolution: Optional[str] = None
    resolution: Optional[str] = None
    negative_prompt: Optional[str] = None
    watermark: Optional[bool] = None
    prompt_extend: Optional[bool] = None


class DigitalHumanPipelineRequest(BaseModel):
    mode: str = "customize"
    character_image_path: str
    goods_image_path: Optional[str] = None
    goods_title: Optional[str] = None
    goods_text: Optional[str] = None
    llm_model: str
    image_model: str
    image_resolution: str = "1080P"
    video_model: str
    duration: int = 5
    video_ratio: str = "9:16"
    video_resolution: Optional[str] = None
    resolution: Optional[str] = None
    tts_voice: str = "zh-CN-YunjianNeural"
    tts_speed: float = 1.0
    negative_prompt: Optional[str] = None
    watermark: Optional[bool] = None
    prompt_extend: Optional[bool] = None


class GenericPipelineRequest(BaseModel):
    params: Dict[str, Any]

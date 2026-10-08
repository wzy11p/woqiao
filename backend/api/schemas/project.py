from typing import Any, Dict, Optional

from pydantic import BaseModel


class ProjectStartRequest(BaseModel):
    idea: str
    file_path: Optional[str] = None
    style: Optional[str] = None
    video_ratio: Optional[str] = "9:16"
    video_resolution: Optional[str] = "720P"
    expand_idea: Optional[bool] = True
    llm_model: Optional[str] = None
    vlm_model: Optional[str] = None
    image_t2i_model: Optional[str] = None
    image_it2i_model: Optional[str] = None
    video_model: Optional[str] = None
    video_first_frame_model: Optional[str] = None
    video_start_end_model: Optional[str] = None
    video_reference_model: Optional[str] = None
    video_generation_mode: Optional[str] = "first_frame"
    enable_concurrency: Optional[bool] = True
    web_search: Optional[bool] = False
    episodes: Optional[int] = None


class InterventionRequest(BaseModel):
    stage: str
    modifications: Dict[str, Any]

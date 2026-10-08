from typing import List, Optional

from pydantic import BaseModel


class SandboxLLMRequest(BaseModel):
    model: str
    prompt: str
    temperature: Optional[float] = 0.7
    web_search: Optional[bool] = False


class SandboxVLMRequest(BaseModel):
    model: str
    prompt: str
    images: List[str]


class SandboxT2IRequest(BaseModel):
    model: str
    prompt: str
    style: Optional[str] = "anime"
    ratio: Optional[str] = "16:9"


class SandboxI2IRequest(BaseModel):
    model: str
    prompt: str
    image: str
    ratio: Optional[str] = "16:9"


class SandboxVideoRequest(BaseModel):
    model: str
    prompt: str
    image: Optional[str] = None

import os
import sys

models_dir = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.dirname(models_dir)
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import logging
import os
from typing import List, Optional
from config import Config

try:
    from models.vlm_dashscope import QwenVLClient
    from models.vlm_gemini import GeminiVLClient
    from models.vlm_gpt import GPTVLClient
except ImportError:
    from vlm_dashscope import QwenVLClient
    from vlm_gemini import GeminiVLClient
    from vlm_gpt import GPTVLClient

logger = logging.getLogger(__name__)


class VLM:
    def __init__(self,
                 dashscope_api_key: Optional[str] = None,
                 dashscope_base_url: Optional[str] = None,
                 gemini_api_key: Optional[str] = None,
                 gemini_base_url: Optional[str] = None,
                 gpt_api_key: Optional[str] = None,
                 gpt_base_url: Optional[str] = None,
                 proxy: Optional[str] = None):
        """
        Unified VLM (Vision Language Model) Client
        Routes requests to DashScope (QwenVL) or Gemini based on model name.
        """
        self._dashscope_api_key = dashscope_api_key
        self._dashscope_base_url = dashscope_base_url
        self._gemini_api_key = gemini_api_key
        self._gemini_base_url = gemini_base_url
        self._gpt_api_key = gpt_api_key
        self._gpt_base_url = gpt_base_url
        self._proxy = Config.provider_proxy("openai") if proxy is None else proxy

        self._dashscope_client = None
        self._gemini_client = None
        self._gpt_client = None

    @property
    def dashscope_client(self):
        if self._dashscope_client is None:
            self._dashscope_client = QwenVLClient(
                api_key=self._dashscope_api_key,
                base_url=self._dashscope_base_url,
            )
        return self._dashscope_client

    @property
    def gemini_client(self):
        if self._gemini_client is None:
            self._gemini_client = GeminiVLClient(
                api_key=self._gemini_api_key,
                base_url=self._gemini_base_url,
            )
        return self._gemini_client

    @property
    def gpt_client(self):
        if self._gpt_client is None:
            self._gpt_client = GPTVLClient(
                api_key=self._gpt_api_key,
                base_url=self._gpt_base_url,
                proxy=self._proxy,
            )
        return self._gpt_client

    def query(self,
             prompt: str,
             image_paths: Optional[List[str]] = None,
             model: str = "qwen3.6-plus",
             session_id: Optional[str] = None) -> str:
        if Config.PRINT_MODEL_INPUT:
            lines = [
                "---- VLM REQUEST ----",
                f"Prompt: {prompt}",
            ]
            if image_paths:
                lines.append(f"Images: {len(image_paths)}")
                for p in image_paths:
                    lines.append(" - [Base64图片]" if p.startswith("data:") else f" - {p}")
            lines.append(f"Model: {model}")
            if session_id:
                lines.append(f"Session ID: {session_id}")
            lines.append("-" * 30)
            logger.info("\n%s", "\n".join(lines))

        # Determine backend provider
        model_lower = model.lower()
        is_gemini = "gemini" in model_lower
        is_gpt = "gpt" in model_lower

        if is_gemini:
            # 处理图片路径
            processed_images = []
            for p in image_paths or []:
                if p.startswith("data:") or p.startswith("http") or p.startswith("file://"):
                    processed_images.append(p)
                else:
                    processed_images.append(p)  # 传递原始路径，内部会处理
            return self.gemini_client.chat(text=prompt, images=processed_images, model=model)
        elif is_gpt:
            return self.gpt_client.chat(text=prompt, images=image_paths or [], model=model)
        else:
            # DashScope (Qwen/Kimi) - 需要将 base64 保存为临时文件
            file_urls = []
            import tempfile
            import base64 as b64

            for p in image_paths or []:
                if p.startswith("data:"):
                    # Base64 数据 URL，需要解码并保存为临时文件
                    try:
                        # 解析 data URL: data:image/png;base64,xxxxx
                        header, b64_data = p.split(",", 1)
                        mime_type = header.split(";")[0].replace("data:", "")
                        image_data = b64.b64decode(b64_data)

                        # 创建临时文件
                        suffix = f".{mime_type.split('/')[-1]}" if '/' in mime_type else ".png"
                        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                            tmp.write(image_data)
                            temp_path = tmp.name

                        abs_path = os.path.abspath(temp_path)
                        file_urls.append(f"file://{abs_path}")
                    except Exception as e:
                        logger.exception("Failed to process base64 image")
                        raise ValueError(f"无法解析 base64 图片: {e}")
                elif p.startswith("http") or p.startswith("file://"):
                    file_urls.append(p)
                else:
                    abs_path = os.path.abspath(p)
                    file_urls.append(f"file://{abs_path}")
            return self.dashscope_client.chat(text=prompt, images=file_urls, model=model, stream=False)

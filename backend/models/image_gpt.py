import os
import sys

models_dir = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.dirname(models_dir)
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import time
import uuid
import base64
from contextlib import ExitStack
import httpx
import logging
from openai import OpenAI
from config import Config
try:
    from models.image_processor import ImageProcessor
except ImportError:
    from image_processor import ImageProcessor

logger = logging.getLogger(__name__)


class ImageGPT:
    """
    OpenAI 图片生成客户端
    支持模型：
        - sora_image → Images API
        - GPT Image → Images API (generate / edit)
    """
    def __init__(self,
                 api_key: str = None,
                 base_url: str = None,
                 proxy: str = None,
                 timeout: float = 300.0):
        """
        OpenAI 图片生成客户端
        :param api_key: API Key
        :param base_url: 自定义 Base URL
        :param proxy: 当前 provider 显式启用时使用的代理
        :param timeout: 超时时间
        """
        self.api_key = api_key or Config.OPENAI_API_KEY
        self.timeout = timeout
        
        kwargs = {"api_key": self.api_key, "timeout": self.timeout}
        
        self.base_url = base_url or Config.OPENAI_BASE_URL
        if proxy is None:
            proxy = Config.provider_proxy("openai")
        if proxy:
            kwargs["http_client"] = httpx.Client(
                proxy=proxy,
                timeout=self.timeout,
            )
        if self.base_url:
            kwargs["base_url"] = self.base_url
            
        self.client = OpenAI(**kwargs)
        self.max_attempts = 10
        self.image_processor = ImageProcessor()

    def _encode_image_to_base64(self, image_path: str) -> str:
        """将本地图片转换为 Base64 编码"""
        if not image_path or not os.path.exists(image_path):
            return image_path
        
        try:
            with open(image_path, "rb") as f:
                img_data = base64.b64encode(f.read()).decode("utf-8")
            ext = os.path.splitext(image_path)[1].lower().replace(".", "")
            if ext not in ["png", "jpg", "jpeg", "webp"]:
                ext = "png"
            return f"data:image/{ext};base64,{img_data}"
        except Exception as e:
            logger.warning("Failed to encode image %s: %s", image_path, e)
            return image_path

    def generate_image(self, prompt, size="1024x1024", quality="high", model="gpt-image-2",
                       save_dir=None, image_urls=None):
        """Generate a single image, download it, and return the local file path.

        Args:
            prompt: 图片描述提示词
            size: 图片尺寸
            quality: 图片质量
            model: 模型名称 (sora_image / gpt-image-2)
            save_dir: 保存目录（不传则返回 URL 或 base64）
            image_urls: 参考图片 URL 列表（仅 gpt-image-2 支持）
        """

        attempts = 0
        last_error = None
        
        while attempts < self.max_attempts:
            try:
                options = dict(model=model, prompt=prompt, size=size, quality=quality, n=1)
                if image_urls:
                    # Use the documented multipart edit contract; never drop identity refs.
                    with ExitStack() as stack:
                        refs = [stack.enter_context(open(path, "rb")) for path in image_urls]
                        response = self.client.images.edit(image=refs, **options)
                else:
                    response = self.client.images.generate(**options)

                if not response or not response.data:
                    raise RuntimeError("OpenAI API 返回数据为空")

                img_data = response.data[0]
                file_path = None

                # 1. 处理 Base64 格式 (中转站常用)
                if hasattr(img_data, 'b64_json') and img_data.b64_json:
                    if save_dir:
                        os.makedirs(save_dir, exist_ok=True)
                        file_name = f"gpt_{int(time.time())}_{uuid.uuid4().hex[:6]}.png"
                        file_path = os.path.join(save_dir, file_name)
                        with open(file_path, "wb") as f:
                            f.write(base64.b64decode(img_data.b64_json))
                        return file_path
                    return img_data.b64_json

                # 2. 处理 URL 格式
                elif hasattr(img_data, 'url') and img_data.url:
                    url = img_data.url
                    if save_dir:
                        os.makedirs(save_dir, exist_ok=True)
                        file_name = f"gpt_{int(time.time())}_{uuid.uuid4().hex[:6]}.png"
                        file_path = os.path.join(save_dir, file_name)
                        if self.image_processor.download_image(url, file_path, proxies=Config.requests_proxies("openai")):
                            return file_path
                        return url
                
                raise RuntimeError("未在响应中找到 url 或 b64_json")
            except Exception as e:
                last_error = e
                logger.warning("OpenAI image generation failed: %s", e)
                break  # Let the caller explicitly retry; avoid duplicate paid requests.
            attempts += 1
        raise Exception(f"Max attempts reached, failed to generate image. Last error: {last_error}")

    def generate_images(self, prompt, count=4, size="1024x1024", quality="standard", model=None):
        """Generate multiple image URLs by calling Images API 'count' times."""
        urls = []
        for _ in range(count):
            url = self.generate_image(prompt=prompt, size=size, quality=quality, model=model)
            urls.append(url)
        return urls


if __name__ == "__main__":
    import sys
    import tempfile
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from config import Config

    MODELS = ["gpt-image-2"]
    save_dir = "code/result/image/test_avail"
    api_key = Config.OPENAI_API_KEY
    base_url = Config.OPENAI_BASE_URL
    if not api_key:
        print("✗ OPENAI_API_KEY 未设置，跳过")
        sys.exit(1)
    print("=== GPT 图片生成测试 ===")
    print(f"  API Key: {api_key[:6]}***")
    print(f"  Base URL: {base_url}")


    # 文生图
    print("\n=== GPT 文生图可用性测试 ===")
    img_prompt = "A cute orange cat lying on a sunny windowsill, watercolor style"
    img_path = ""
    client = ImageGPT(api_key=api_key, base_url=Config.OPENAI_BASE_URL, proxy=Config.provider_proxy("openai"))
    for model in MODELS:
        print(f"\nTesting model: {model}")
        print(f"Prompt: {img_prompt}")
        print(f"Image path: {img_path}")
        client.max_attempts = 1
        t0 = time.time()
        os.makedirs(save_dir, exist_ok=True)
        try:
            path = client.generate_image(prompt=img_prompt, size="1024x1024",
                                                model=model, save_dir=save_dir)
            elapsed = time.time() - t0
            print(f"✓ 生成成功 ({elapsed:.1f}s): {path}")
        except Exception as e:
            elapsed = time.time() - t0
            print(f"✗ 失败 ({elapsed:.1f}s): {e}")

    # 图生图
    print("\n=== GPT 图生图可用性测试 ===")
    img_prompt = "Turn this cat into a cute cartoon character with big eyes and a playful expression"
    img_path = "code/result/image/test_avail/test_input.jpg"
    for model in MODELS:
        print(f"\nTesting model: {model}")
        print(f"Prompt: {img_prompt}")
        print(f"Image path: {img_path}")
        client.max_attempts = 1
        t0 = time.time()
        os.makedirs(save_dir, exist_ok=True)
        try:
            path = client.generate_image(prompt=img_prompt, size="1024x1024",
                                                model=model, save_dir=save_dir, image_urls=[img_path])
            elapsed = time.time() - t0
            print(f"✓ 生成成功 ({elapsed:.1f}s): {path}")
        except Exception as e:
            elapsed = time.time() - t0
            print(f"✗ 失败 ({elapsed:.1f}s): {e}") 

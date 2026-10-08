"""
Seedance 视频生成 API 客户端 (字节跳动 ARK)

"""

import os
import sys

models_dir = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.dirname(models_dir)
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import time
import logging
import requests
import base64
import json
import mimetypes
from typing import Optional
from config import Config

logger = logging.getLogger(__name__)

class SeedanceVideoClient:
    """
    Seedance 视频生成客户端（字节跳动 ARK）
    支持图生视频功能，采用 提交任务 -> 轮询 -> 下载 的异步流程
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: int = 120,
    ) -> None:
        self.api_key = api_key or Config.ARK_API_KEY
        self.base_url = (base_url or Config.ARK_BASE_URL or "https://ark.cn-beijing.volces.com/api/v3").rstrip("/")
        self.timeout = timeout

        if not self.api_key:
            logger.warning("SeedanceVideoClient: ARK_API_KEY 未设置")

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def generate_video(
        self,
        prompt: str,
        image_path: str,
        save_path: str,
        model: str = "doubao-seedance-2-0-260128",
        duration: int = 5,
        **kwargs
    ) -> str:
        """
        图生视频完整流程

        Args:
            prompt: 提示词
            image_path: 输入图片本地路径
            save_path: 输出视频保存路径
            model: 模型名称
            duration: 视频时长
        """
        if not self.api_key:
            raise RuntimeError("ARK_API_KEY not set.")

        # 1. 提交任务
        task_id = kwargs.pop("remote_task_id", None)
        on_submitted = kwargs.pop("on_submitted", None)
        if not task_id:
            task_id = self._submit_task(prompt, image_path, model, duration, **kwargs)
            if on_submitted:
                on_submitted(task_id)
        
        # 2. 轮询等待
        video_url = self._poll_until_done(task_id)
        
        # 3. 下载视频
        self._download_video(video_url, save_path)
        
        return video_url

    def _submit_task(self, prompt: str, image_path: str, model: str, duration: int, **kwargs) -> str:
        # 根据 Seedance 2.0 文档更新接口路径
        url = f"{self.base_url}/contents/generations/tasks"
        
        refs = kwargs.get("reference_image_paths") or []
        videos = kwargs.get("reference_video_paths") or []
        audio = kwargs.get("reference_audio_path")
        last_frame = kwargs.get("last_image_path")
        reference_mode = bool(refs or videos or audio)
        if reference_mode and last_frame:
            raise ValueError("首尾帧模式不能与多模态参考混用，请选择一种生成方式")
        if reference_mode and not any(v in model for v in ("2-0", "2-5")):
            raise ValueError("当前多模态参考仅适用于 Seedance 2.0 / 2.5")
        content = [{"type": "text", "text": prompt}] if prompt else []

        def add(kind, path, role):
            if str(path).startswith(("https://", "http://", "asset://", "data:")):
                media_url = path
            else:
                if not os.path.isfile(path):
                    raise FileNotFoundError(f"参考素材不存在: {path}")
                if os.path.getsize(path) > 40 * 1024 * 1024:
                    raise ValueError("参考素材过大，请上传裁短、压缩后的参考片段")
                mime = mimetypes.guess_type(path)[0] or f"{kind}/octet-stream"
                if kind == "audio":
                    mime = "audio/wav" if path.lower().endswith(".wav") else "audio/mp3"
                with open(path, "rb") as file:
                    media_url = f"data:{mime};base64," + base64.b64encode(file.read()).decode()
            content.append({"type": f"{kind}_url", f"{kind}_url": {"url": media_url}, "role": role})

        if reference_mode:
            for path in dict.fromkeys(([image_path] if image_path else []) + refs):
                add("image", path, "reference_image")
            for path in videos:
                add("video", path, "reference_video")
            if audio:
                add("audio", audio, "reference_audio")
        else:
            if not image_path:
                raise ValueError("请先提供镜头图片或人物参考图")
            add("image", image_path, "first_frame")
            if last_frame:
                add("image", last_frame, "last_frame")

        payload = {
            "model": model,
            "content": content,
            "duration": duration,
            "ratio": kwargs.get("ratio", "adaptive"),
            "resolution": kwargs.get("resolution", "720p")
        }

        # 合并其他可选参数 (如 seed, watermark)
        for key in ["seed", "watermark", "generate_audio"]:
            if kwargs.get(key) is not None:
                payload[key] = kwargs[key]

        if len(json.dumps(payload).encode()) > 63 * 1024 * 1024:
            raise ValueError("参考素材总量过大，请缩短动作视频后重试")

        logger.info(f"SeedanceVideoClient: 提交任务 model={model}, duration={duration}s")
        resp = requests.post(
            url,
            headers=self._headers(),
            json=payload,
            timeout=self.timeout,
            proxies=Config.requests_proxies("ark"),
        )
        
        if not resp.ok:
            logger.error(f"Seedance 提交失败: {resp.text}")
            resp.raise_for_status()
            
        data = resp.json()
        task_id = data.get("id")
        if not task_id:
            raise RuntimeError(f"Seedance API 未返回任务 ID: {data}")
            
        return task_id

    def _poll_until_done(self, task_id: str, max_polls: int = 120, interval: int = 5) -> str:
        # 同步更新查询接口路径
        url = f"{self.base_url}/contents/generations/tasks/{task_id}"
        
        for i in range(max_polls):
            resp = requests.get(
                url,
                headers=self._headers(),
                timeout=30,
                proxies=Config.requests_proxies("ark"),
            )
            resp.raise_for_status()
            data = resp.json()
            
            status = data.get("status")
            if status == "succeeded":
                # 根据实际返回体，URL 位于 content.video_url 或 video_url
                video_url = data.get("content", {}).get("video_url") or data.get("video_url")
                if not video_url:
                    raise RuntimeError(f"Seedance 任务成功但未返回视频 URL: {data}")
                return video_url
            elif status in ("failed", "expired", "cancelled"):
                error_msg = data.get("error", {}).get("message") or data.get("status_msg") or "未知错误"
                raise RuntimeError(f"Seedance 视频生成{status}: {error_msg}")
            
            logger.debug(f"SeedanceVideoClient: 任务进行中 {task_id}, status={status}, poll={i+1}")
            time.sleep(interval)
            
        raise TimeoutError(f"Seedance 视频生成超时 (task_id={task_id})")

    def _download_video(self, url: str, save_path: str):
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        resp = requests.get(url, stream=True, timeout=120, proxies=Config.requests_proxies("ark"))
        resp.raise_for_status()
        with open(save_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        logger.info(f"SeedanceVideoClient: 视频已保存: {save_path}")

if __name__ == "__main__":
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from config import Config

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    # ── 测试参数（按需修改） ──
    # IMAGE_PATH = "code/result/image/test_avail/test_input.png"
    IMAGE_PATH = "code/result/image/test_avail/test_input_human.jpg"
    OUTPUT_PATH = "code/result/video/test_avail/seedance_test_output.mp4"
    PROMPT = "女生把财务报表交给男生，男生看到后喜极而泣"
    # MODELS = ["doubao-seedance-2-0-fast-260128", "doubao-seedance-2-0-260128"]
    MODELS = ["doubao-seedance-2-0-fast-260128"]
    DURATION = 5

    print("=== Seedance (ARK) 图生视频测试 ===")
    api_key = Config.ARK_API_KEY
    base_url = Config.ARK_BASE_URL
    
    if not api_key:
        print("✗ ARK_API_KEY 未设置，请检查 config.yaml 配置")
        sys.exit(1)

    if not os.path.exists(IMAGE_PATH):
        print(f"✗ 输入图片不存在: {IMAGE_PATH}")
        sys.exit(1)

    print(f"  API Key    : {api_key[:6]}***{api_key[-4:]}")
    print(f"  Base URL   : {base_url}")

    for model in MODELS:
        print("\n" + "="*40)
        print(f"  输入图片   : {IMAGE_PATH}")
        print(f"  输出路径   : {OUTPUT_PATH}")
        print(f"  模型       : {model}")
        print(f"  时长       : {DURATION}s")
        if PROMPT:
            print(f"  提示词     : {PROMPT[:80]}")

        try:
            client = SeedanceVideoClient(api_key=api_key, base_url=base_url)
            print("✓ 客户端初始化成功")

            start = time.time()
            video_url = client.generate_video(
                prompt=PROMPT,
                image_path=IMAGE_PATH,
                save_path=OUTPUT_PATH,
                model=model,
                duration=DURATION,
            )
            elapsed = time.time() - start

            print(f"✓ 视频生成完成！耗时 {elapsed:.1f}s")
            print(f"  远端 URL : {video_url}")
            print(f"  本地文件 : {os.path.abspath(OUTPUT_PATH)}")
            print(f"  文件大小 : {os.path.getsize(OUTPUT_PATH) / 1024 / 1024:.2f} MB")
        except Exception as e:
            print(f"✗ 失败: {e}")
            sys.exit(1)
        break  # 只测试第一个模型

import os
import sys

models_dir = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.dirname(models_dir)
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import time
import logging
from openai import OpenAI
from config import Config

logger = logging.getLogger(__name__)


class GPT:
    """
    OpenAI 文本生成客户端
    可选模型：gpt-4o, 
    """
    def __init__(self, base_url="", api_key="", proxy=None, timeout=300):
        import httpx
        self.api_key = api_key or Config.OPENAI_API_KEY
        self.timeout = timeout
        
        kwargs = {"api_key": self.api_key, "timeout": self.timeout}

        self.base_url = base_url
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
        self.max_tokens = 8000

    def query(self, prompt, image_urls=[], model="", web_search=False):
        self.model = model
        if self.model == "":
            self.model = "gpt-5"

        # Switch to search model if web_search is enabled
        # OpenAI uses gpt-4o-search-preview for web search
        if web_search and not self.model.endswith("-search"):
            search_model_map = {
                "gpt-4o": "gpt-4o-search-preview",
                "gpt-4": "gpt-4-search-preview",
                "gpt-5": "gpt-5-search",
            }
            self.model = search_model_map.get(self.model, self.model + "-search")

        messages = [{"role": "system", "content": "You are a helpful assistant."}]
        content = [{"type": "text", "text": prompt}]
        if image_urls:
            content.extend([{"type": "image_url", "image_url": {"url": url}} for url in image_urls])
        messages.append({"role": "user", "content": content})

        attempts = 0
        while attempts < self.max_attempts:
            try:
                # Build request parameters
                request_params = {
                    "model": self.model,
                    "messages": messages,
                    "max_tokens": self.max_tokens
                }
                # Add search tool if web_search is enabled
                if web_search:
                    request_params["search_tool"] = "auto"

                response = self.client.chat.completions.create(**request_params)
                if response.choices[0].message.content.strip():
                    return response.choices[0].message.content
                else:
                    logger.warning("OpenAI returned an empty response; retrying in 10 seconds")
            except Exception as e:
                logger.warning("OpenAI request failed; retrying in 10 seconds: %s", e)
                logger.debug("OpenAI request messages: %s", messages)
                time.sleep(10)
                attempts += 1

        raise Exception("Max attempts reached, failed to get a response from OpenAI.") 


if __name__ == "__main__":
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from config import Config

    # 支持的模型列表
    MODELS = ["gpt-4o", "gpt-5", "gpt-5.4"]

    print("=== GPT 文本生成可用性测试 ===")
    api_key = Config.OPENAI_API_KEY
    base_url = Config.OPENAI_BASE_URL
    if not api_key:
        print("✗ OPENAI_API_KEY 未设置，跳过")
        sys.exit(1)
    print(f"  API Key: {api_key[:6]}***{api_key[-4:]}")
    print(f"  Base URL: {base_url}")
    client = GPT(api_key=api_key, base_url=base_url)

    prompt = "用一句话介绍你自己。"
    print(f"  Prompt: {prompt}")

    for model in MODELS:
        print(f"\n--- 测试模型: {model} ---")
        t0 = time.time()
        try:
            resp = client.query(prompt, model=model)
            elapsed = time.time() - t0
            print(f"✓ 响应 ({elapsed:.1f}s): {resp.strip()[:200]}")
        except Exception as e:
            print(f"✗ 失败: {e}")

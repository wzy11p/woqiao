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

DEFAULT_DEEPSEEK_TIMEOUT = 300
DEFAULT_DEEPSEEK_MAX_ATTEMPTS = 5
DEFAULT_DEEPSEEK_MAX_TOKENS = 20000


class DeepSeek:
    """
    deepseek-chat: DeepSeek-V3.2 非思考模式
    deepseek-reasoner: DeepSeek-V3.2 思考模式
    deepseek-v4-flash: DeepSeek-V4 Flash
    deepseek-v4-pro: DeepSeek-V4 Pro
    """
    def __init__(self, base_url="", api_key="", timeout=None, max_attempts=None):
        import httpx
        self.base_url = base_url or Config.DEEPSEEK_BASE_URL or "https://api.deepseek.com/v1"
        self.api_key = api_key or Config.DEEPSEEK_API_KEY
        self.timeout = self._as_int(timeout, DEFAULT_DEEPSEEK_TIMEOUT)
        self.max_attempts = self._as_int(max_attempts, DEFAULT_DEEPSEEK_MAX_ATTEMPTS)
        
        if not self.api_key:
            logger.warning("DEEPSEEK_API_KEY is not set")

        kwargs = {"api_key": self.api_key, "base_url": self.base_url, "timeout": self.timeout}
        proxy = Config.provider_proxy("deepseek")
        if proxy:
            kwargs["http_client"] = httpx.Client(proxy=proxy, timeout=self.timeout)
        self.client = OpenAI(**kwargs)
        self.max_tokens = DEFAULT_DEEPSEEK_MAX_TOKENS

    @staticmethod
    def _as_int(value, default: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _usage_value(usage, key: str, default=0):
        if usage is None:
            return default
        value = getattr(usage, key, None)
        if value is None and isinstance(usage, dict):
            value = usage.get(key)
        return value if value is not None else default

    @classmethod
    def _completion_detail_value(cls, usage, key: str, default=0):
        details = cls._usage_value(usage, "completion_tokens_details", None)
        if details is None:
            return default
        value = getattr(details, key, None)
        if value is None and isinstance(details, dict):
            value = details.get(key)
        return value if value is not None else default

    def _log_empty_response(self, model: str, attempt: int, response):
        choice = response.choices[0] if response.choices else None
        message = getattr(choice, "message", None) if choice else None
        finish_reason = getattr(choice, "finish_reason", None) if choice else None
        usage = getattr(response, "usage", None)
        completion_tokens = self._usage_value(usage, "completion_tokens")
        prompt_tokens = self._usage_value(usage, "prompt_tokens")
        total_tokens = self._usage_value(usage, "total_tokens")
        reasoning_tokens = self._completion_detail_value(usage, "reasoning_tokens")

        reasoning_content = getattr(message, "reasoning_content", "") if message else ""
        reasoning_chars = len(reasoning_content or "")
        token_budget_exhausted = finish_reason == "length" or completion_tokens >= max(self.max_tokens - 8, 1)
        reasoning_used_output = reasoning_tokens and completion_tokens and reasoning_tokens >= completion_tokens * 0.9

        if token_budget_exhausted and reasoning_used_output:
            reason = "output_token_budget_exhausted_by_reasoning"
            suggestion = "increase max_tokens, reduce prompt/output length, or use a non-reasoning/flash model"
        elif token_budget_exhausted:
            reason = "output_token_budget_exhausted"
            suggestion = "increase max_tokens or reduce requested output length"
        elif reasoning_content and not getattr(message, "content", None):
            reason = "reasoning_only_no_final_content"
            suggestion = "retry may succeed; consider reducing reasoning-heavy model usage for long generation"
        else:
            reason = "empty_final_content"
            suggestion = "retrying"

        logger.warning(
            "DeepSeek empty final content; retrying. reason=%s suggestion=%s model=%s attempt=%s/%s "
            "finish_reason=%s max_tokens=%s prompt_tokens=%s completion_tokens=%s reasoning_tokens=%s "
            "total_tokens=%s reasoning_chars=%s",
            reason,
            suggestion,
            model,
            attempt,
            self.max_attempts,
            finish_reason,
            self.max_tokens,
            prompt_tokens,
            completion_tokens,
            reasoning_tokens,
            total_tokens,
            reasoning_chars,
        )

    def query(self, prompt, image_urls=[], model="deepseek-chat", web_search=False):
        """
        Query DeepSeek model.

        :param web_search: If True, adds enable_web_search: True to API call
        """
        if not model:
            model = "deepseek-chat"

        messages = [{"role": "system", "content": "You are a helpful assistant."}]
        messages.append({"role": "user", "content": prompt})

        attempts = 0
        while attempts < self.max_attempts:
            try:
                # Build request parameters
                request_params = {
                    "model": model,
                    "messages": messages,
                    "stream": False,
                    "max_tokens": self.max_tokens
                }

                response = self.client.chat.completions.create(**request_params)
                
                # DeepSeek might return reasoning_content for reasoner models, 
                # but standard content is what we return conform to other interfaces.
                if response.choices and response.choices[0].message.content:
                    return response.choices[0].message.content
                else:
                    self._log_empty_response(model, attempts + 1, response)
                    time.sleep(2)
            except Exception as e:
                logger.warning(
                    "DeepSeek request failed; retrying. model=%s attempt=%s/%s timeout=%ss error=%s",
                    model,
                    attempts + 1,
                    self.max_attempts,
                    self.timeout,
                    e,
                )
                time.sleep(5)
            attempts += 1
                
        raise Exception("Max attempts reached, failed to get a response from DeepSeek.")


if __name__ == "__main__":
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from config import Config

    # 支持的模型列表
    MODELS = ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro"]

    print("=== DeepSeek 可用性测试 ===")
    api_key = Config.DEEPSEEK_API_KEY
    base_url = Config.DEEPSEEK_BASE_URL
    if not api_key:
        print("✗ DEEPSEEK_API_KEY 未设置，跳过")
        sys.exit(1)
    print(f"  API Key: {api_key[:6]}***{api_key[-4:]}")
    if base_url:
        print(f"  Base URL: {base_url}")

    client = DeepSeek(api_key=api_key, base_url=base_url)
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

"""LLM adapters. DeepSeek and other OpenAI-compatible JSON endpoints share one client."""

from __future__ import annotations

import json
import re
import time
from typing import Any

import httpx

from ..config import (
    BAILIAN_COMPAT_BASE,
    BAILIAN_DEFAULT_LLM_MODEL,
    DEEPSEEK_DEFAULT_BASE,
    DEEPSEEK_DEFAULT_MODEL,
    Settings,
)


class LLMError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class LLMProvider:
    provider_id = "base"
    model = ""
    is_heuristic = False

    @property
    def configured(self) -> bool:
        return True

    def chat_json(self, system: str, user: str, max_tokens: int | None = None) -> dict[str, Any]:
        raise NotImplementedError


    def _record_usage(self, usage: dict[str, Any] | None) -> None:
        if not isinstance(usage, dict):
            return
        self.usage_totals["calls"] += 1
        self.usage_totals["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
        self.usage_totals["completion_tokens"] += int(usage.get("completion_tokens") or 0)
        details = usage.get("completion_tokens_details") or {}
        self.usage_totals["reasoning_tokens"] += int(details.get("reasoning_tokens") or 0)


class HeuristicLLM(LLMProvider):
    """Offline fallback: deterministic rules only, no semantic rewriting."""

    provider_id = "local-heuristic"
    model = "rule-based"
    is_heuristic = True

    def chat_json(self, system: str, user: str, max_tokens: int | None = None) -> dict[str, Any]:
        raise LLMError("llm_not_configured", "未配置文本模型，使用本地规则清洗", retryable=False)


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
        raise LLMError("invalid_json", "模型返回的 JSON 不是对象")
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            try:
                value = json.loads(text[start : end + 1])
                if isinstance(value, dict):
                    return value
            except json.JSONDecodeError:
                pass
        raise LLMError("invalid_json", "模型返回内容不是有效 JSON")


class OpenAICompatLLM(LLMProvider):
    """Works with DeepSeek, OpenAI, SiliconFlow and similar chat completion APIs."""

    provider_id = "openai-compatible"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        temperature: float = 0.1,
        timeout: float = 180.0,
        enable_thinking: bool | None = None,
        default_max_tokens: int = 4096,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.temperature = temperature
        self.timeout = timeout
        self.enable_thinking = enable_thinking
        self.default_max_tokens = default_max_tokens
        self.last_usage: dict[str, Any] | None = None
        self.usage_totals: dict[str, int] = {
            "calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "reasoning_tokens": 0,
        }

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.model)

    def chat_json(self, system: str, user: str, max_tokens: int | None = None) -> dict[str, Any]:
        if not self.configured:
            raise LLMError("llm_not_configured", "文本模型未配置 API Key", retryable=False)
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": self.temperature,
            "max_tokens": max_tokens or self.default_max_tokens,
            "response_format": {"type": "json_object"},
            "stream": False,
        }
        if self.enable_thinking is not None:
            # Bailian-hosted DeepSeek honours this switch; official DeepSeek ignores/does not need it.
            payload["enable_thinking"] = bool(self.enable_thinking)
        url = f"{self.base_url}/chat/completions"
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                with httpx.Client(timeout=self.timeout) as client:
                    resp = client.post(
                        url,
                        headers={
                            "Authorization": f"Bearer {self.api_key}",
                            "Content-Type": "application/json",
                        },
                        json=payload,
                    )
                if resp.status_code == 429 or resp.status_code >= 500:
                    retry_after = resp.headers.get("Retry-After")
                    wait = float(retry_after) if retry_after else 2 ** attempt
                    last_error = LLMError(
                        "llm_unavailable",
                        f"文本模型暂时不可用（HTTP {resp.status_code}）",
                        retryable=True,
                    )
                    time.sleep(min(wait, 20))
                    continue
                if resp.status_code in (401, 403):
                    raise LLMError("llm_auth", "文本模型鉴权失败，请检查 API Key", retryable=False)
                if resp.status_code == 402:
                    raise LLMError("llm_balance", "文本模型账户余额不足", retryable=False)
                if resp.status_code >= 400:
                    raise LLMError(
                        "llm_error",
                        f"文本模型返回错误（HTTP {resp.status_code}）：{resp.text[:300]}",
                        retryable=False,
                    )
                data = resp.json()
                choice = (data.get("choices") or [{}])[0]
                finish = choice.get("finish_reason")
                content = (choice.get("message") or {}).get("content") or ""
                self.last_usage = data.get("usage")
                self._record_usage(self.last_usage)
                if finish == "length":
                    raise LLMError("llm_truncated", "模型输出被截断，请缩小处理块或调大输出上限", retryable=True)
                if not content.strip():
                    raise LLMError("llm_empty", "模型返回空内容", retryable=True)
                return _extract_json(content)
            except LLMError as exc:
                if not exc.retryable or attempt == 3:
                    raise
                last_error = exc
                time.sleep(2 ** attempt)
            except httpx.TimeoutException:
                last_error = LLMError("llm_timeout", "文本模型请求超时", retryable=True)
                time.sleep(2 ** attempt)
            except httpx.HTTPError as exc:
                last_error = LLMError("llm_network", f"文本模型网络错误：{exc}", retryable=True)
                time.sleep(2 ** attempt)
        if isinstance(last_error, LLMError):
            raise last_error
        raise LLMError("llm_error", "文本模型调用失败", retryable=True)


def build_llm(settings: Settings) -> LLMProvider:
    if settings.llm_disabled:
        return HeuristicLLM()
    api_key = settings.llm_api_key
    base_url = settings.llm_base_url
    model = settings.llm_model
    if not api_key and settings.llm_use_bailian and settings.dashscope_api_key:
        # Opt-in only: reuse the Bailian key against Bailian's OpenAI-compatible endpoint.
        api_key = settings.dashscope_api_key
        if base_url.rstrip("/") == DEEPSEEK_DEFAULT_BASE:
            base_url = BAILIAN_COMPAT_BASE
        if model == DEEPSEEK_DEFAULT_MODEL:
            model = BAILIAN_DEFAULT_LLM_MODEL
    if api_key:
        enable_thinking = settings.llm_enable_thinking
        if enable_thinking is None and "dashscope.aliyuncs.com" in base_url:
            # Bailian-hosted DeepSeek reasons by default and can spend the whole max_tokens
            # budget on reasoning, truncating the JSON answer. Disable it unless asked.
            enable_thinking = False
        return OpenAICompatLLM(
            base_url=base_url,
            api_key=api_key,
            model=model,
            temperature=settings.llm_temperature,
            enable_thinking=enable_thinking,
            default_max_tokens=settings.llm_max_tokens,
        )
    return HeuristicLLM()

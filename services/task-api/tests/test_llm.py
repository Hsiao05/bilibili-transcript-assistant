"""LLM adapter tests: request payload, thinking switch and provider defaults."""

from __future__ import annotations

from taskapi.config import Settings
from taskapi.providers.llm import OpenAICompatLLM, build_llm


class _FakeResponse:
    status_code = 200
    text = ""

    def json(self):
        return {
            "choices": [{"message": {"content": '{"ok": true}'}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "completion_tokens_details": {"reasoning_tokens": 0},
            },
        }


class _FakeClient:
    last_payload: dict | None = None

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, url, headers=None, json=None):
        _FakeClient.last_payload = json
        return _FakeResponse()


def test_thinking_switch_and_default_max_tokens_are_sent(monkeypatch):
    monkeypatch.setattr("taskapi.providers.llm.httpx.Client", _FakeClient)
    llm = OpenAICompatLLM(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "fake-key",
        "deepseek-v4.1-flash",
        enable_thinking=False,
        default_max_tokens=1234,
    )
    result = llm.chat_json("system", "user")

    assert result == {"ok": True}
    payload = _FakeClient.last_payload
    assert payload["enable_thinking"] is False
    assert payload["max_tokens"] == 1234
    assert payload["response_format"] == {"type": "json_object"}
    assert llm.usage_totals["calls"] == 1
    assert llm.usage_totals["prompt_tokens"] == 10
    assert llm.usage_totals["completion_tokens"] == 20


def test_bailian_key_alone_does_not_configure_llm():
    settings = Settings(dashscope_api_key="fake-dashscope-key", data_dir="data")
    llm = build_llm(settings)
    assert llm.is_heuristic is True


def test_bailian_llm_is_opt_in_and_disables_thinking():
    settings = Settings(
        dashscope_api_key="fake-dashscope-key",
        data_dir="data",
        llm_use_bailian=True,
    )
    llm = build_llm(settings)
    assert llm.provider_id == "openai-compatible"
    assert llm.base_url == "https://dashscope.aliyuncs.com/compatible-mode/v1"
    assert llm.model == "deepseek-v4.1-flash"
    assert llm.enable_thinking is False


def test_explicit_llm_key_keeps_provider_default_thinking():
    settings = Settings(
        llm_api_key="fake-deepseek-key",
        data_dir="data",
        llm_base_url="https://api.deepseek.com",
        llm_model="deepseek-chat",
    )
    llm = build_llm(settings)
    assert llm.base_url == "https://api.deepseek.com"
    assert llm.model == "deepseek-chat"
    assert llm.enable_thinking is None


def test_thinking_can_be_enabled_explicitly():
    settings = Settings(
        dashscope_api_key="fake-dashscope-key",
        data_dir="data",
        llm_use_bailian=True,
        llm_enable_thinking=True,
        llm_max_tokens=8192,
    )
    llm = build_llm(settings)
    assert llm.enable_thinking is True
    assert llm.default_max_tokens == 8192

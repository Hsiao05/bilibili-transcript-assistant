"""ASR adapter tests that do not need a real cloud provider or audio stack."""

from __future__ import annotations

from typing import ClassVar

import pytest

from taskapi.config import Settings
from taskapi.providers.asr import ASRError, OpenAICompatASR, build_dashscope_asr


class _FakeResponse:
    status_code = 200
    text = ""

    def json(self):
        return {
            "text": "模拟云识别",
            "language": "zh",
            "duration": 4.2,
            "segments": [
                {"start": 0.0, "end": 3.2, "text": "模拟云识别", "avg_logprob": -0.2},
            ],
        }


class _FakeClient:
    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, url, headers=None, data=None, files=None):
        _FakeClient.last_call = {"url": url, "headers": headers, "data": data, "files": files}
        return _FakeResponse()


def test_openai_compat_asr_sends_mapping_form_data(monkeypatch, tmp_path):
    """Regression: httpx>=0.28 breaks when form fields are a list of tuples."""
    monkeypatch.setattr("taskapi.providers.asr.httpx.Client", _FakeClient)
    audio = tmp_path / "speech.wav"
    audio.write_bytes(b"RIFF-fake-wav-bytes")

    provider = OpenAICompatASR("http://127.0.0.1:9/v1", "fake-key", "mock-asr")
    result = provider.transcribe(audio, "zh-CN")

    call = _FakeClient.last_call
    assert call["url"].endswith("/audio/transcriptions")
    assert isinstance(call["data"], dict), "form fields must be a mapping for httpx>=0.28"
    assert call["data"]["model"] == "mock-asr"
    assert call["data"]["language"] == "zh"
    assert call["data"]["response_format"] == "verbose_json"
    assert "file" in call["files"]
    assert result.provider_id == "openai-compatible"
    assert result.segments[0].text == "模拟云识别"
    assert result.segments[0].start_ms == 0
    assert result.segments[0].end_ms == 3200


class _JsonResponse:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


class _DashScopeFakeClient:
    """Scripted HTTP client for the Bailian upload/submit/poll/download flow."""

    calls: ClassVar[list[dict]] = []
    poll_count = 0
    submit_status = 200

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    @classmethod
    def reset(cls):
        cls.calls = []
        cls.poll_count = 0
        cls.submit_status = 200

    def get(self, url, headers=None, params=None, timeout=None):
        type(self).calls.append({"method": "GET", "url": url, "headers": headers, "params": params})
        if url.endswith("/api/v1/uploads"):
            return _JsonResponse(
                200,
                {
                    "data": {
                        "upload_dir": "dashscope-instant/abc/2026-01-01/xyz",
                        "upload_host": "https://upload.example.com",
                        "oss_access_key_id": "ak",
                        "signature": "sig",
                        "policy": "pol",
                        "x_oss_object_acl": "private",
                        "x_oss_forbid_overwrite": "true",
                    }
                },
            )
        if "/api/v1/tasks/" in url:
            type(self).poll_count += 1
            if type(self).poll_count == 1:
                return _JsonResponse(200, {"output": {"task_status": "RUNNING"}})
            return _JsonResponse(
                200,
                {
                    "output": {
                        "task_status": "SUCCEEDED",
                        "results": [
                            {
                                "file_url": "oss://dashscope-instant/abc/2026-01-01/xyz/speech.wav",
                                "transcription_url": "https://results.example/one.json",
                            }
                        ],
                    }
                },
            )
        if url.startswith("https://results.example/"):
            return _JsonResponse(
                200,
                {
                    "properties": {"language": "zh"},
                    "transcripts": [
                        {
                            "sentences": [
                                {"begin_time": 100, "end_time": 3820, "text": "你好，今天讨论项目进度。"},
                                {"begin_time": 3820, "end_time": 6500, "text": "好的，我先汇报一下。"},
                            ]
                        }
                    ],
                },
            )
        return _JsonResponse(404, {"message": "unexpected GET"})

    def post(self, url, headers=None, files=None, json=None, data=None, timeout=None):
        type(self).calls.append({"method": "POST", "url": url, "headers": headers, "json": json, "files": files})
        if url == "https://upload.example.com":
            return _JsonResponse(200, {})
        if url.endswith("/api/v1/services/audio/asr/transcription"):
            if type(self).submit_status != 200:
                return _JsonResponse(type(self).submit_status, {"message": "bad api key"})
            return _JsonResponse(200, {"output": {"task_id": "task-1", "task_status": "PENDING"}})
        return _JsonResponse(404, {"message": "unexpected POST"})


def _dashscope_settings(tmp_path):
    return Settings(
        data_dir=tmp_path / "data",
        dashscope_api_key="fake-dashscope-key",
        dashscope_poll_interval=0.01,
        dashscope_poll_timeout=5,
    )


def test_dashscope_filetrans_upload_submit_poll_and_parse(monkeypatch, tmp_path):
    _DashScopeFakeClient.reset()
    monkeypatch.setattr("taskapi.providers.asr.httpx.Client", _DashScopeFakeClient)
    audio = tmp_path / "speech.wav"
    audio.write_bytes(b"RIFF-fake-wav-bytes")
    progress: list[float] = []

    provider = build_dashscope_asr(_dashscope_settings(tmp_path))
    assert provider.provider_id == "dashscope-filetrans"
    result = provider.transcribe(audio, "zh-CN", progress=progress.append)

    # Parsed sentence timestamps and language.
    assert result.provider_id == "dashscope-filetrans"
    assert result.model == "qwen-audio-3.1-asr-flash-filetrans"
    assert result.language == "zh"
    assert [segment.text for segment in result.segments] == ["你好，今天讨论项目进度。", "好的，我先汇报一下。"]
    assert result.segments[0].start_ms == 100
    assert result.segments[1].end_ms == 6500
    assert progress[-1] == 1.0

    # Upload policy request targets the configured model.
    policy_call = next(call for call in _DashScopeFakeClient.calls if call["url"].endswith("/api/v1/uploads"))
    assert policy_call["params"] == {"action": "getPolicy", "model": "qwen-audio-3.1-asr-flash-filetrans"}

    # Audio was uploaded with the OSS policy form fields and the expected object key.
    upload_call = next(call for call in _DashScopeFakeClient.calls if call["url"] == "https://upload.example.com")
    files = upload_call["files"]
    assert files["key"] == (None, "dashscope-instant/abc/2026-01-01/xyz/speech.wav")
    assert files["OSSAccessKeyId"] == (None, "ak")
    assert files["file"][0] == "speech.wav"

    # Async submit carries the oss:// URL and the required DashScope headers.
    submit_call = next(
        call for call in _DashScopeFakeClient.calls if call["url"].endswith("/services/audio/asr/transcription")
    )
    assert submit_call["json"]["model"] == "qwen-audio-3.1-asr-flash-filetrans"
    assert submit_call["json"]["input"]["file_urls"] == [
        "oss://dashscope-instant/abc/2026-01-01/xyz/speech.wav"
    ]
    assert submit_call["json"]["parameters"]["language_hints"] == ["zh"]
    assert submit_call["json"]["parameters"]["enable_words"] is False
    assert submit_call["headers"]["X-DashScope-Async"] == "enable"
    assert submit_call["headers"]["X-DashScope-OssResourceResolve"] == "enable"


def test_dashscope_filetrans_auth_error_is_actionable(monkeypatch, tmp_path):
    _DashScopeFakeClient.reset()
    _DashScopeFakeClient.submit_status = 401
    monkeypatch.setattr("taskapi.providers.asr.httpx.Client", _DashScopeFakeClient)
    audio = tmp_path / "speech.wav"
    audio.write_bytes(b"RIFF-fake-wav-bytes")

    provider = build_dashscope_asr(_dashscope_settings(tmp_path))
    with pytest.raises(ASRError) as excinfo:
        provider.transcribe(audio, None)
    assert excinfo.value.code == "asr_auth"


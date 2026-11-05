"""ASR adapters: local faster-whisper, DashScope Filetrans, OpenAI-compatible cloud, selection."""

from __future__ import annotations

import importlib.util
import shutil
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar

import httpx

from ..config import Settings


class ASRError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


class ASRCancelled(Exception):
    pass


@dataclass
class ASRSegment:
    start_ms: int
    end_ms: int
    text: str
    confidence: float | None = None


@dataclass
class ASRResult:
    language: str
    segments: list[ASRSegment]
    provider_id: str
    model: str


@dataclass
class ASRCapability:
    id: str
    label: str
    available: bool
    detail: str = ""
    timestamps: bool = True


ProgressCallback = Callable[[float], None]
CancelCheck = Callable[[], bool]


class ASRProvider:
    provider_id = "base"
    label = "ASR"
    model = ""

    def available(self) -> bool:
        return False

    def describe(self) -> ASRCapability:
        return ASRCapability(self.provider_id, self.label, self.available(), self.model)

    def transcribe(
        self,
        path: Path,
        language: str | None,
        progress: ProgressCallback | None = None,
        should_cancel: CancelCheck | None = None,
    ) -> ASRResult:
        raise NotImplementedError


def _lang_code(language: str | None) -> str | None:
    if not language:
        return None
    value = language.lower()
    if value.startswith("zh"):
        return "zh"
    if value.startswith("en"):
        return "en"
    if value.startswith("ja"):
        return "ja"
    if value.startswith("ko"):
        return "ko"
    return value.split("-")[0][:8]


class LocalWhisperProvider(ASRProvider):
    provider_id = "faster-whisper"
    label = "本机 faster-whisper"
    _models: ClassVar[dict[tuple[str, str, str], object]] = {}
    _lock = threading.Lock()

    def __init__(self, model_name: str = "small", device: str = "auto"):
        self.model = model_name
        self.device = device

    def available(self) -> bool:
        return importlib.util.find_spec("faster_whisper") is not None

    def describe(self) -> ASRCapability:
        detail = f"{self.model} · {self.device}" if self.available() else "未安装 faster-whisper"
        return ASRCapability(self.provider_id, self.label, self.available(), detail)

    def _load(self):
        from faster_whisper import WhisperModel

        key = (self.model, self.device, "auto")
        with self._lock:
            if key not in self._models:
                self._models[key] = WhisperModel(self.model, device=self.device, compute_type="auto")
            return self._models[key]

    def transcribe(
        self,
        path: Path,
        language: str | None,
        progress: ProgressCallback | None = None,
        should_cancel: CancelCheck | None = None,
    ) -> ASRResult:
        if not self.available():
            raise ASRError(
                "asr_not_installed",
                "未安装 faster-whisper。运行 pip install -e '.[asr]' 后重试，或配置云 ASR。",
            )
        model = self._load()
        segments_iter, info = model.transcribe(
            str(path),
            language=_lang_code(language),
            vad_filter=True,
            beam_size=5,
            word_timestamps=False,
        )
        duration = float(getattr(info, "duration", 0) or 0)
        result: list[ASRSegment] = []
        for seg in segments_iter:
            if should_cancel and should_cancel():
                raise ASRCancelled()
            text = (seg.text or "").strip()
            start_ms = max(0, round(float(seg.start) * 1000))
            end_ms = max(start_ms, round(float(seg.end) * 1000))
            if text:
                result.append(ASRSegment(start_ms, end_ms, text))
            if progress:
                progress(min(1.0, (end_ms / 1000) / duration) if duration else 0.0)
        if progress:
            progress(1.0)
        return ASRResult(
            language=_lang_code(getattr(info, "language", None) or language) or "unknown",
            segments=result,
            provider_id=self.provider_id,
            model=self.model,
        )


class OpenAICompatASR(ASRProvider):
    provider_id = "openai-compatible"
    label = "云 ASR（OpenAI 兼容接口）"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float = 900.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.api_key and self.base_url and self.model)

    def describe(self) -> ASRCapability:
        detail = self.model if self.available() else "未配置 API Key"
        return ASRCapability(self.provider_id, self.label, self.available(), detail)

    def transcribe(
        self,
        path: Path,
        language: str | None,
        progress: ProgressCallback | None = None,
        should_cancel: CancelCheck | None = None,
    ) -> ASRResult:
        if not self.available():
            raise ASRError("asr_not_configured", "云 ASR 未配置 API Key")
        if should_cancel and should_cancel():
            raise ASRCancelled()
        # httpx>=0.28 only accepts a mapping for form fields (a list of tuples is sent as a
        # broken body), so build a regular dict here.
        data: dict[str, str] = {
            "model": self.model,
            "response_format": "verbose_json",
            "timestamp_granularities[]": "segment",
        }
        if _lang_code(language):
            data["language"] = _lang_code(language) or ""
        if progress:
            progress(0.02)
        try:
            with open(path, "rb") as fh, httpx.Client(timeout=self.timeout) as client:
                resp = client.post(
                    f"{self.base_url}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    data=data,
                    files={"file": (path.name, fh, "application/octet-stream")},
                )
        except httpx.TimeoutException as exc:
            raise ASRError("asr_timeout", "云 ASR 请求超时", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise ASRError("asr_network", f"云 ASR 网络错误：{exc}", retryable=True) from exc
        if resp.status_code in (401, 403):
            raise ASRError("asr_auth", "云 ASR 鉴权失败，请检查 API Key")
        if resp.status_code == 429 or resp.status_code >= 500:
            raise ASRError("asr_unavailable", f"云 ASR 暂时不可用（HTTP {resp.status_code}）", retryable=True)
        if resp.status_code >= 400:
            raise ASRError("asr_error", f"云 ASR 返回错误（HTTP {resp.status_code}）：{resp.text[:300]}")
        if progress:
            progress(0.9)
        payload = resp.json()
        raw_segments = payload.get("segments") or []
        segments: list[ASRSegment] = []
        for item in raw_segments:
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            start_ms = max(0, round(float(item.get("start", 0)) * 1000))
            end_ms = max(start_ms, round(float(item.get("end", item.get("start", 0))) * 1000))
            confidence = item.get("avg_logprob")
            segments.append(
                ASRSegment(start_ms, end_ms, text, float(confidence) if confidence is not None else None)
            )
        if not segments:
            text = str(payload.get("text") or "").strip()
            if not text:
                raise ASRError("asr_empty", "云 ASR 未返回识别文本")
            duration_ms = int(float(payload.get("duration", 0) or 0) * 1000)
            segments = [ASRSegment(0, duration_ms, text)]
        if progress:
            progress(1.0)
        return ASRResult(
            language=str(payload.get("language") or language or "unknown"),
            segments=segments,
            provider_id=self.provider_id,
            model=self.model,
        )


class DashScopeFiletransASR(ASRProvider):
    """Alibaba Cloud Bailian / DashScope asynchronous file transcription.

    Flow: temporary upload policy -> upload local audio (oss:// URL) -> submit async task ->
    poll -> download the result JSON -> map sentence-level timestamps to ASRSegment.

    The temporary upload keeps local deployments free of an extra OSS bucket. Files expire
    after 48 hours; production/high-volume deployments should configure Alibaba OSS instead.
    """

    provider_id = "dashscope-filetrans"
    label = "阿里云百炼 Filetrans"
    _REQUIRED_POLICY_FIELDS = (
        "upload_dir",
        "upload_host",
        "oss_access_key_id",
        "signature",
        "policy",
        "x_oss_object_acl",
        "x_oss_forbid_overwrite",
    )

    def __init__(
        self,
        api_key: str,
        base_url: str,
        upload_base_url: str,
        model: str,
        language_hints: str = "zh,en",
        enable_words: bool = False,
        poll_interval: float = 3.0,
        poll_timeout: float = 1800.0,
    ):
        self.api_key = (api_key or "").strip()
        self.base_url = (base_url or "https://dashscope.aliyuncs.com").rstrip("/")
        self.upload_base_url = (upload_base_url or "").rstrip("/")
        self.model = (model or "qwen3-asr-flash-filetrans").strip()
        self.language_hints = [item.strip() for item in (language_hints or "").split(",") if item.strip()]
        self.enable_words = enable_words
        self.poll_interval = max(0.05, float(poll_interval or 3.0))
        self.poll_timeout = max(10.0, float(poll_timeout or 1800.0))

    def available(self) -> bool:
        return bool(self.api_key and self.model)

    def describe(self) -> ASRCapability:
        detail = f"{self.model} · {self.base_url}" if self.available() else "未配置 DASHSCOPE_API_KEY"
        return ASRCapability(self.provider_id, self.label, self.available(), detail)

    @property
    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    def _upload_base(self) -> str:
        if self.upload_base_url:
            return self.upload_base_url
        # Workspace-specific MaaS endpoints only serve model calls; temporary uploads use the
        # classic regional endpoint.
        if "maas.aliyuncs.com" in self.base_url:
            return "https://dashscope.aliyuncs.com"
        return self.base_url

    def _check(self, response: httpx.Response, stage: str) -> None:
        code = response.status_code
        if code in (401, 403):
            raise ASRError("asr_auth", "百炼鉴权失败，请检查 DASHSCOPE_API_KEY 与地域")
        if code == 429 or code >= 500:
            raise ASRError("asr_unavailable", f"百炼{stage}暂时不可用（HTTP {code}）", retryable=True)
        if code >= 400:
            raise ASRError("asr_error", f"百炼{stage}失败（HTTP {code}）：{response.text[:300]}")

    def _get_upload_policy(self) -> dict:
        with httpx.Client(timeout=60.0) as client:
            response = client.get(
                f"{self._upload_base()}/api/v1/uploads",
                headers=self._auth_headers,
                params={"action": "getPolicy", "model": self.model},
            )
        self._check(response, "获取上传凭证")
        try:
            policy = response.json()["data"]
        except (KeyError, ValueError) as exc:
            raise ASRError("asr_error", "百炼上传凭证响应格式无效") from exc
        for required in self._REQUIRED_POLICY_FIELDS:
            if required not in policy:
                raise ASRError("asr_error", f"百炼上传凭证缺少字段 {required}")
        return policy

    def _upload_audio(self, policy: dict, path: Path) -> str:
        key = f"{policy['upload_dir']}/{path.name}"
        files = {
            "OSSAccessKeyId": (None, policy["oss_access_key_id"]),
            "Signature": (None, policy["signature"]),
            "policy": (None, policy["policy"]),
            "x-oss-object-acl": (None, policy["x_oss_object_acl"]),
            "x-oss-forbid-overwrite": (None, policy["x_oss_forbid_overwrite"]),
            "key": (None, key),
            "success_action_status": (None, "200"),
        }
        try:
            with open(path, "rb") as handle, httpx.Client(timeout=300.0) as client:
                files["file"] = (path.name, handle)
                response = client.post(policy["upload_host"], files=files)
        except OSError as exc:
            raise ASRError("asr_upload_failed", f"读取待识别音频失败：{exc}") from exc
        self._check(response, "上传音频")
        return f"oss://{key}"

    def _submit_task(self, oss_url: str, language: str | None) -> str:
        language_code = _lang_code(language)
        payload = {
            "model": self.model,
            "input": {"file_urls": [oss_url]},
            "parameters": {
                "channel_id": [0],
                "language_hints": [language_code] if language_code else self.language_hints,
                "enable_words": bool(self.enable_words),
            },
        }
        headers = {
            **self._auth_headers,
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
            # Required when the input is an oss:// temporary-upload URL.
            "X-DashScope-OssResourceResolve": "enable",
        }
        with httpx.Client(timeout=120.0) as client:
            response = client.post(
                f"{self.base_url}/api/v1/services/audio/asr/transcription",
                headers=headers,
                json=payload,
            )
        self._check(response, "提交转写任务")
        try:
            data = response.json()
        except ValueError as exc:
            raise ASRError("asr_error", "百炼提交任务响应不是有效 JSON") from exc
        task_id = (data.get("output") or {}).get("task_id") or data.get("task_id")
        if not task_id:
            raise ASRError("asr_error", f"百炼未返回 task_id：{str(data)[:200]}")
        return str(task_id)

    def _query_task(self, task_id: str) -> tuple[str, list[dict], dict]:
        with httpx.Client(timeout=60.0) as client:
            response = client.get(f"{self.base_url}/api/v1/tasks/{task_id}", headers=self._auth_headers)
        self._check(response, "查询转写任务")
        try:
            data = response.json()
        except ValueError as exc:
            raise ASRError("asr_error", "百炼任务查询响应不是有效 JSON") from exc
        output = data.get("output") or {}
        status = str(output.get("task_status") or "UNKNOWN").upper()
        results = output.get("results") or []
        return status, results, output

    def _download_result(self, url: str) -> dict:
        with httpx.Client(timeout=120.0) as client:
            response = client.get(url)
        if response.status_code >= 400:
            raise ASRError("asr_error", f"下载百炼转写结果失败（HTTP {response.status_code}）")
        try:
            return response.json()
        except ValueError as exc:
            raise ASRError("asr_error", "百炼转写结果不是有效 JSON") from exc

    @staticmethod
    def _parse_result(payload: dict, language: str | None) -> tuple[list[ASRSegment], str]:
        transcripts = payload.get("transcripts")
        if transcripts is None:
            transcripts = (payload.get("output") or {}).get("transcripts") or []
        segments: list[ASRSegment] = []
        for transcript in transcripts or []:
            for sentence in transcript.get("sentences") or []:
                text = str(sentence.get("text") or "").strip()
                if not text:
                    continue
                start_ms = max(0, round(float(sentence.get("begin_time") or 0)))
                end_ms = max(start_ms, round(float(sentence.get("end_time") or start_ms)))
                segments.append(ASRSegment(start_ms, end_ms, text))
        if not segments:
            texts = [
                str(transcript.get("text") or "").strip()
                for transcript in transcripts or []
                if str(transcript.get("text") or "").strip()
            ]
            if texts:
                duration_ms = max(
                    (int(transcript.get("content_duration_in_milliseconds") or 0) for transcript in transcripts or []),
                    default=0,
                )
                segments = [ASRSegment(0, duration_ms, " ".join(texts))]
        if not segments:
            raise ASRError("asr_empty", "百炼没有返回识别文本")

        properties = payload.get("properties") or {}
        detected = properties.get("language") or properties.get("original_language")
        if not detected:
            for transcript in transcripts or []:
                if transcript.get("language"):
                    detected = transcript.get("language")
                    break
        return segments, str(detected or _lang_code(language) or "unknown")

    def transcribe(
        self,
        path: Path,
        language: str | None,
        progress: ProgressCallback | None = None,
        should_cancel: CancelCheck | None = None,
    ) -> ASRResult:
        if not self.available():
            raise ASRError("asr_not_configured", "百炼未配置 DASHSCOPE_API_KEY")
        report = progress or (lambda fraction: None)
        try:
            report(0.02)
            policy = self._get_upload_policy()
            report(0.06)
            oss_url = self._upload_audio(policy, path)
            report(0.12)
            task_id = self._submit_task(oss_url, language)
            report(0.2)
            deadline = time.monotonic() + self.poll_timeout
            started = time.monotonic()
            results: list[dict] = []
            output: dict = {}
            while True:
                if should_cancel and should_cancel():
                    raise ASRCancelled()
                if time.monotonic() > deadline:
                    raise ASRError("asr_timeout", "百炼转写任务超时", retryable=True)
                status, results, output = self._query_task(task_id)
                if status in ("SUCCEEDED", "SUCCESS"):
                    break
                if status in ("FAILED", "CANCELED", "CANCELLED", "UNKNOWN"):
                    message = output.get("message") or output.get("code") or ""
                    hint = ""
                    if "file url" in str(message).lower() and self.model.startswith("qwen3"):
                        hint = (
                            "；qwen3-asr-flash-filetrans 不接受临时上传的 oss:// URL，"
                            "请改用 qwen-audio-3.1-asr-flash-filetrans 或提供公网 HTTPS 音频地址"
                        )
                    raise ASRError("asr_failed", f"百炼转写任务状态 {status} {message}{hint}".strip())
                elapsed = time.monotonic() - started
                report(0.2 + min(0.6, elapsed / 120.0 * 0.6))
                time.sleep(self.poll_interval)
            report(0.85)
            transcription_url = next(
                (str(item.get("transcription_url")) for item in results if item.get("transcription_url")),
                None,
            )
            if not transcription_url:
                raise ASRError("asr_empty", "百炼未返回转写结果地址")
            payload = self._download_result(transcription_url)
            segments, detected = self._parse_result(payload, language)
            report(1.0)
            return ASRResult(
                language=detected,
                segments=segments,
                provider_id=self.provider_id,
                model=self.model,
            )
        except (ASRError, ASRCancelled):
            raise
        except httpx.TimeoutException as exc:
            raise ASRError("asr_timeout", "百炼请求超时", retryable=True) from exc
        except httpx.HTTPError as exc:
            raise ASRError("asr_network", f"百炼网络错误：{exc}", retryable=True) from exc


def build_dashscope_asr(settings: Settings) -> DashScopeFiletransASR:
    return DashScopeFiletransASR(
        settings.dashscope_api_key,
        settings.dashscope_base_url,
        settings.dashscope_upload_base_url,
        settings.dashscope_asr_model,
        settings.dashscope_asr_language_hints,
        settings.dashscope_asr_enable_words,
        settings.dashscope_poll_interval,
        settings.dashscope_poll_timeout,
    )


def build_asr_capabilities(settings: Settings) -> list[ASRCapability]:
    providers = [
        LocalWhisperProvider(settings.whisper_model, settings.whisper_device),
        build_dashscope_asr(settings),
        OpenAICompatASR(settings.asr_base_url, settings.asr_api_key, settings.asr_model),
    ]
    capabilities = [p.describe() for p in providers]
    if settings.asr_disabled:
        return [
            ASRCapability(
                id=capability.id,
                label=capability.label,
                available=False,
                detail="已通过 TASKAPI_ASR_DISABLED 关闭音频转写",
                timestamps=capability.timestamps,
            )
            for capability in capabilities
        ]
    return capabilities


def select_asr(settings: Settings, requested: str | None = None) -> ASRProvider | None:
    if settings.asr_disabled:
        return None
    requested_clean = requested if requested and requested.lower() not in ("auto", "default") else None
    choice = (requested_clean or settings.asr_provider or "auto").lower()
    local = LocalWhisperProvider(settings.whisper_model, settings.whisper_device)
    dashscope = build_dashscope_asr(settings)
    cloud = OpenAICompatASR(settings.asr_base_url, settings.asr_api_key, settings.asr_model)
    if choice in ("faster-whisper", "local"):
        return local if local.available() else None
    if choice in ("dashscope", "dashscope-filetrans", "bailian", "qwen-asr", "qwen"):
        return dashscope if dashscope.available() else None
    if choice in ("cloud", "openai", "openai-compatible"):
        return cloud if cloud.available() else None
    if local.available():
        return local
    if dashscope.available():
        return dashscope
    if cloud.available():
        return cloud
    return None


def default_asr_id(settings: Settings) -> str:
    provider = select_asr(settings, settings.asr_provider)
    return provider.provider_id if provider else "none"


def ffmpeg_path() -> str | None:
    return shutil.which("ffmpeg")

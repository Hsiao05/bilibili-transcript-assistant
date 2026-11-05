"""Runtime configuration loaded from environment variables and an optional .env file.

Precedence (highest first):
1. real process environment variables (``os.environ``);
2. ``KEY=VALUE`` pairs from the service ``.env`` file (see ``TASKAPI_ENV_FILE``);
3. built-in defaults in :class:`Settings`.

The ``.env`` parser is intentionally dependency-free: blank lines and ``#``
comments are skipped, optional ``export `` prefixes are accepted, and values may
be wrapped in single or double quotes. Backslash escapes are not interpreted
(Windows paths such as ``C:\new`` pass through unchanged); only an escaped
double quote inside a double-quoted value is unescaped. Nested/interpolated
values are not supported and are kept verbatim.
"""

from __future__ import annotations

import contextlib
import os
import re
import secrets
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path

# services/task-api/taskapi/config.py -> services/task-api
SERVICE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV_FILE = SERVICE_ROOT / ".env"
_ENV_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


def env_file_path() -> Path:
    """Return the .env path to read: ``TASKAPI_ENV_FILE`` override or the service default."""
    override = os.environ.get("TASKAPI_ENV_FILE", "").strip()
    return Path(override).expanduser() if override else DEFAULT_ENV_FILE


def read_env_file(path: Path) -> dict[str, str]:
    """Parse a dotenv-style file without any third-party dependency."""
    values: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8-sig")
    except OSError:
        return values
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        if "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip()
        if not name or not _ENV_NAME_RE.match(name):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            quote = value[0]
            value = value[1:-1]
            if quote == '"':
                value = value.replace('\\"', '"')
        values[name] = value
    return values


def env_file_overrides(path: Path | None = None) -> dict[str, str]:
    """Return .env values that are not already set in the real process environment."""
    file_values = read_env_file(path or env_file_path())
    return {name: value for name, value in file_values.items() if name not in os.environ}


@contextlib.contextmanager
def _temporary_environ(overrides: Mapping[str, str]) -> Iterator[None]:
    """Apply defaults from .env while constructing settings, then restore the environment."""
    saved: dict[str, str | None] = {}
    try:
        for name, value in overrides.items():
            saved[name] = os.environ.get(name)
            os.environ[name] = value
        yield
    finally:
        for name, previous in saved.items():
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous


def _bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _optional_bool(name: str) -> bool | None:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return None
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    value = os.environ.get(name)
    try:
        return int(value) if value is not None else default
    except ValueError:
        return default


DEEPSEEK_DEFAULT_BASE = "https://api.deepseek.com"
DEEPSEEK_DEFAULT_MODEL = "deepseek-chat"
BAILIAN_COMPAT_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
BAILIAN_DEFAULT_LLM_MODEL = "deepseek-v4.1-flash"


def _llm_defaults() -> tuple[str, str, str]:
    """LLM defaults: a dedicated OpenAI-compatible text model API (separate from Bailian ASR)."""
    return DEEPSEEK_DEFAULT_BASE, DEEPSEEK_DEFAULT_MODEL, os.environ.get("LLM_API_KEY", "").strip()


def _llm_base_default() -> str:
    return os.environ.get("LLM_BASE_URL") or _llm_defaults()[0]


def _llm_model_default() -> str:
    return os.environ.get("LLM_MODEL") or _llm_defaults()[1]


def _llm_key_default() -> str:
    return os.environ.get("LLM_API_KEY") or _llm_defaults()[2]


@dataclass(frozen=True)
class Settings:
    """All configuration needed by the API and the worker.

    The token is persisted to ``<data_dir>/token.txt`` so that restarts keep the
    extension paired. Set ``TASKAPI_TOKEN`` to pin it explicitly.
    """

    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("TASKAPI_DATA_DIR", "data")))
    host: str = field(default_factory=lambda: os.environ.get("TASKAPI_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _int("TASKAPI_PORT", 8765))
    auth_disabled: bool = field(default_factory=lambda: _bool("TASKAPI_AUTH_DISABLED"))

    llm_base_url: str = field(default_factory=_llm_base_default)
    llm_api_key: str = field(default_factory=_llm_key_default)
    llm_model: str = field(default_factory=_llm_model_default)
    llm_temperature: float = field(default_factory=lambda: float(os.environ.get("LLM_TEMPERATURE", "0.1")))
    # Force the offline rule-based pipeline even when an LLM key is available.
    llm_disabled: bool = field(default_factory=lambda: _bool("LLM_DISABLED"))
    # Opt-in convenience for development: reuse DASHSCOPE_API_KEY as the LLM key against
    # Bailian's OpenAI-compatible endpoint. Off by default because Bailian is configured here
    # for ASR only and the text model usually has its own API/key.
    llm_use_bailian: bool = field(default_factory=lambda: _bool("LLM_USE_BAILIAN"))
    # Explicit thinking switch; None = provider default (forced off for Bailian DeepSeek).
    llm_enable_thinking: bool | None = field(default_factory=lambda: _optional_bool("LLM_ENABLE_THINKING"))
    llm_max_tokens: int = field(default_factory=lambda: _int("LLM_MAX_TOKENS", 8192))

    asr_provider: str = field(default_factory=lambda: os.environ.get("ASR_PROVIDER", "auto"))
    # Operator switch: disable audio transcription entirely (e.g. remote deployments without
    # ASR capacity). Providers stay listed in capabilities but are reported unavailable.
    asr_disabled: bool = field(default_factory=lambda: _bool("TASKAPI_ASR_DISABLED"))
    asr_base_url: str = field(
        default_factory=lambda: os.environ.get("ASR_BASE_URL", "https://api.siliconflow.cn/v1")
    )
    asr_api_key: str = field(default_factory=lambda: os.environ.get("ASR_API_KEY", ""))
    asr_model: str = field(default_factory=lambda: os.environ.get("ASR_MODEL", "FunAudioLLM/SenseVoiceSmall"))
    whisper_model: str = field(default_factory=lambda: os.environ.get("WHISPER_MODEL", "small"))
    whisper_device: str = field(default_factory=lambda: os.environ.get("WHISPER_DEVICE", "auto"))

    # 阿里云百炼 Filetrans（异步录音文件识别，返回句子/词级时间戳）。
    dashscope_api_key: str = field(default_factory=lambda: os.environ.get("DASHSCOPE_API_KEY", ""))
    dashscope_base_url: str = field(
        default_factory=lambda: os.environ.get("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com")
    )
    dashscope_upload_base_url: str = field(
        default_factory=lambda: os.environ.get("DASHSCOPE_UPLOAD_BASE_URL", "")
    )
    dashscope_asr_model: str = field(
        default_factory=lambda: os.environ.get(
            "DASHSCOPE_ASR_MODEL", "qwen-audio-3.1-asr-flash-filetrans"
        )
    )
    dashscope_asr_language_hints: str = field(
        default_factory=lambda: os.environ.get("DASHSCOPE_ASR_LANGUAGE_HINTS", "zh,en")
    )
    dashscope_asr_enable_words: bool = field(
        default_factory=lambda: _bool("DASHSCOPE_ASR_ENABLE_WORDS")
    )
    dashscope_poll_interval: float = field(
        default_factory=lambda: float(os.environ.get("DASHSCOPE_POLL_INTERVAL", "3"))
    )
    dashscope_poll_timeout: int = field(
        default_factory=lambda: _int("DASHSCOPE_POLL_TIMEOUT", 1800)
    )

    max_upload_bytes: int = field(default_factory=lambda: _int("TASKAPI_MAX_UPLOAD_BYTES", 512 * 1024 * 1024))
    max_duration_minutes: int = field(default_factory=lambda: _int("TASKAPI_MAX_DURATION_MINUTES", 120))
    chunk_size: int = field(default_factory=lambda: _int("TASKAPI_CHUNK_SIZE", 4 * 1024 * 1024))
    retention_hours: int = field(default_factory=lambda: _int("TASKAPI_RETENTION_HOURS", 24))
    max_attempts: int = field(default_factory=lambda: _int("TASKAPI_MAX_ATTEMPTS", 3))

    _token: str = field(default="", repr=False)

    @property
    def token(self) -> str:
        return self._token

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "uploads").mkdir(exist_ok=True)
        (self.data_dir / "media").mkdir(exist_ok=True)
        (self.data_dir / "db").mkdir(exist_ok=True)

    def resolve_token(self) -> str:
        """Read or create the local access token (idempotent)."""
        if self._token:
            return self._token
        env_token = os.environ.get("TASKAPI_TOKEN", "").strip()
        if env_token:
            object.__setattr__(self, "_token", env_token)
            return env_token
        self.ensure_dirs()
        token_path = self.data_dir / "token.txt"
        if token_path.exists():
            token = token_path.read_text(encoding="utf-8").strip()
            if token:
                object.__setattr__(self, "_token", token)
                return token
        token = secrets.token_urlsafe(32)
        token_path.write_text(token, encoding="utf-8")
        object.__setattr__(self, "_token", token)
        return token

    @property
    def db_path(self) -> Path:
        return self.data_dir / "db" / "taskapi.sqlite3"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"


def load_settings() -> Settings:
    """Build settings from process env + optional ``.env`` defaults, creating the data dirs."""
    overrides = env_file_overrides()
    with _temporary_environ(overrides):
        settings = Settings()
        settings.ensure_dirs()
        settings.resolve_token()
    return settings

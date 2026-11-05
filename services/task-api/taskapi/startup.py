"""Human-readable startup diagnostics shared by the API and worker entry points.

The banner tells a first-time user how to pair the browser extension and whether
the cleaning/summarization pipeline is running in offline (heuristic) mode. It
must never print API keys: only provider ids, model names and configuration state.
"""

from __future__ import annotations

import shutil

from .config import Settings
from .providers.asr import build_asr_capabilities
from .providers.llm import build_llm

TOKEN_HINT = "将上面的 token 粘贴到扩展设置页的「任务服务 Token」后再重试"


def llm_status(settings: Settings) -> str:
    llm = build_llm(settings)
    if llm.is_heuristic:
        return (
            "未配置（未检测到 LLM_API_KEY，使用 HeuristicLLM 本地规则清洗/提取式总结；"
            "语义清洗与 LLM 章节总结不可用。百炼 DASHSCOPE_API_KEY 默认只用于 ASR）"
        )
    return (
        f"已配置 · {llm.provider_id} · model={llm.model} · baseUrl={getattr(llm, 'base_url', '')}"
        "（密钥不显示）"
    )


def asr_status_lines(settings: Settings, role: str) -> list[str]:
    capabilities = build_asr_capabilities(settings)
    lines: list[str] = []
    for capability in capabilities:
        state = "可用" if capability.available else "不可用"
        detail = f" · {capability.detail}" if capability.detail else ""
        lines.append(f"[{role}] ASR  {capability.id:<16} {state}{detail}")
    if not any(capability.available for capability in capabilities):
        lines.append(
            f"[{role}] ASR  合计：未配置可用识别服务（上传音频转写会进入 NEEDS_INPUT，"
            "配置 ASR_API_KEY 或安装 faster-whisper 后可用）"
        )
    return lines


def runtime_lines(
    settings: Settings,
    role: str,
    host: str | None = None,
    port: int | None = None,
) -> list[str]:
    """Return the startup banner as a list of lines (tests assert on these)."""
    lines = [
        f"[{role}] 数据目录: {settings.data_dir.resolve()}",
        f"[{role}] 数据库: {settings.db_path.resolve()}",
    ]
    if host is not None and port is not None:
        lines.append(f"[{role}] 监听地址: http://{host}:{port}")
    if settings.auth_disabled:
        lines.append(f"[{role}] 访问令牌: 已关闭鉴权（TASKAPI_AUTH_DISABLED=1），无需 token")
    else:
        lines.append(f"[{role}] 访问令牌: {settings.token}")
        lines.append(f"[{role}] 令牌文件: {(settings.data_dir / 'token.txt').resolve()}")
        lines.append(f"[{role}] {TOKEN_HINT}")
    lines.append(f"[{role}] LLM  {llm_status(settings)}")
    lines.extend(asr_status_lines(settings, role))
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    lines.append(f"[{role}] FFmpeg: {ffmpeg or '未找到（上传音视频转码不可用）'}")
    lines.append(f"[{role}] FFprobe: {ffprobe or '未找到（媒体探测不可用）'}")
    return lines


def print_runtime(
    settings: Settings,
    role: str,
    host: str | None = None,
    port: int | None = None,
) -> None:
    for line in runtime_lines(settings, role, host, port):
        print(line, flush=True)

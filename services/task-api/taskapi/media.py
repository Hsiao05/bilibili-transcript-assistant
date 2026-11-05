"""Media probing and ASR-friendly transcoding via ffprobe/FFmpeg."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path


class MediaError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class AudioStream:
    index: int
    codec: str = ""
    channels: int = 0
    sample_rate: int = 0
    bit_rate: int = 0


@dataclass
class MediaInfo:
    duration_ms: int
    container: str = ""
    size: int = 0
    audio_streams: list[AudioStream] = field(default_factory=list)
    video_streams: int = 0
    probed: bool = True


def _tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise MediaError(f"{name}_missing", f"未找到 {name}，请安装 FFmpeg 并加入 PATH")
    return path


def probe(path: Path) -> MediaInfo:
    ffprobe = _tool("ffprobe")
    try:
        output = subprocess.run(
            [
                ffprobe, "-v", "error", "-print_format", "json",
                "-show_format", "-show_streams", str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise MediaError("probe_timeout", "媒体探测超时") from exc
    if output.returncode != 0:
        raise MediaError("probe_failed", f"无法识别媒体文件：{output.stderr.strip()[:300]}")
    try:
        data = json.loads(output.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise MediaError("probe_failed", "媒体探测输出无法解析") from exc
    fmt = data.get("format") or {}
    duration_s = float(fmt.get("duration") or 0)
    streams = data.get("streams") or []
    audio: list[AudioStream] = []
    video_count = 0
    for stream in streams:
        if stream.get("codec_type") == "audio":
            audio.append(
                AudioStream(
                    index=int(stream.get("index", 0)),
                    codec=str(stream.get("codec_name") or ""),
                    channels=int(stream.get("channels") or 0),
                    sample_rate=int(stream.get("sample_rate") or 0),
                    bit_rate=int(stream.get("bit_rate") or 0),
                )
            )
        elif stream.get("codec_type") == "video":
            video_count += 1
    return MediaInfo(
        duration_ms=int(round(duration_s * 1000)),
        container=str(fmt.get("format_name") or ""),
        size=int(fmt.get("size") or path.stat().st_size),
        audio_streams=audio,
        video_streams=video_count,
    )


def ensure_audio(path: Path, target_dir: Path, max_duration_ms: int) -> tuple[Path, MediaInfo]:
    """Validate the upload and return a path that ASR can consume."""
    info = probe(path)
    if not info.audio_streams:
        raise MediaError("no_audio", "媒体中没有可识别的音轨")
    if info.duration_ms > max_duration_ms:
        minutes = max_duration_ms // 60000
        raise MediaError("duration_limit", f"音频时长超过上限（{minutes} 分钟）")
    suffix = path.suffix.lower()
    passthrough = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".amr", ".wma"}
    if suffix in passthrough and info.video_streams == 0:
        return path, info

    ffmpeg = _tool("ffmpeg")
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{path.stem}.asr.mp3"
    if not target.exists():
        result = subprocess.run(
            [
                ffmpeg, "-y", "-v", "error", "-i", str(path),
                "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "48k",
                str(target),
            ],
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        if result.returncode != 0 or not target.exists():
            raise MediaError("transcode_failed", f"音频转码失败：{result.stderr.strip()[:300]}")
    return target, info

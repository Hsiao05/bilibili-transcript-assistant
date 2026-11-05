"""Markdown rendering for transcript and summary exports."""

from __future__ import annotations

from typing import Any

from ..schemas import Correction, Revision, Summary, Term, VideoRef
from ..util import format_time_ms, safe_filename

SOURCE_LABELS = {
    "bilibili_human_subtitle": "B站人工字幕",
    "bilibili_ai_subtitle": "B站AI字幕",
    "bilibili_subtitle": "B站字幕",
    "bilibili_subtitle_unknown": "B站字幕（类型未知）",
    "asr_local": "本机 ASR",
    "asr_cloud": "云 ASR",
    "uploaded_audio": "本地导入音频",
}

STRENGTH_LABELS = {"light": "轻度清洗", "standard": "标准清洗", "compact": "精简稿"}


def source_label(source_type: str | None) -> str:
    return SOURCE_LABELS.get(source_type or "", source_type or "未知来源")


def video_url(video: VideoRef) -> str:
    return f"https://www.bilibili.com/video/{video.bvid}/?p={video.page}"


def time_link(video: VideoRef, ms: int) -> str:
    return f"[{format_time_ms(ms)}]({video_url(video)}&t={max(0, ms // 1000)})"


def _escape_line(text: str) -> str:
    first = text.lstrip()
    if not first:
        return text
    if first.startswith(("#", ">", "- ", "* ", "+ ", "|")):
        return "\\" + text
    if len(first) > 2 and first[0].isdigit() and first[1] in ".)":
        return "\\" + text
    return text


def _citation_time(video: VideoRef, summary: Summary | None, segment_ids: list[str]) -> str:
    if not summary or not segment_ids:
        return ""
    for chapter in summary.chapters:
        for point in chapter.points:
            if set(point.segment_ids) & set(segment_ids):
                return time_link(video, chapter.start_ms)
    return ""


def render_document_markdown(
    video: VideoRef,
    revision: Revision,
    source_type: str | None,
    summary: Summary | None = None,
    terms: list[Term] | None = None,
    options: dict[str, Any] | None = None,
) -> str:
    options = options or {}
    requested_strength = options.get("strengthLabel")
    include_timestamps = options.get("includeTimestamps", True)
    include_summary = options.get("includeSummary", True) and summary is not None
    include_terms = options.get("includeTerms", True)
    strength = str(requested_strength or STRENGTH_LABELS.get(revision.pipeline_version.split(":")[-1], "标准清洗"))
    if revision.kind == "original":
        strength = "原始稿"
    elif revision.kind == "edited":
        strength = "人工修订稿"

    pending = [c for c in revision.corrections if c.status == "pending"]
    start_ms = min((b.start_ms for b in revision.blocks), default=0)
    end_ms = max((b.end_ms for b in revision.blocks), default=0)

    lines: list[str] = [f"# {video.title or '未命名视频'}", ""]
    lines.append(f"作者　{video.author or '未知'}")
    part = video.part_title or f"第 {video.page} P"
    lines.append(f"分P　第 {video.page} P · {part}" if video.page > 1 else f"分P　{part}")
    lines.append(f"来源　{video_url(video)}")
    lines.append(f"文本来源　{source_label(source_type)}")
    lines.append(f"处理范围　{format_time_ms(start_ms)}–{format_time_ms(end_ms)}")
    lines.append(f"整理方式　{strength}")
    lines.append(f"待核对　{len(pending)}处")
    lines.append("")

    if include_summary and summary:
        lines.extend(["## 内容概览", "", summary.overview.strip(), ""])
        if summary.viewpoints:
            lines.extend(["## 核心观点", ""])
            for item in summary.viewpoints:
                citation = _citation_time(video, summary, item.segment_ids)
                suffix = f"（{citation}）" if citation else ""
                lines.append(f"- {item.text.strip()}{suffix}")
            lines.append("")
        if summary.chapters:
            lines.extend(["## 章节要点", ""])
            for chapter in summary.chapters:
                lines.append(f"### {time_link(video, chapter.start_ms)} {chapter.title}")
                lines.append("")
                for point in chapter.points:
                    lines.append(f"- {point.text.strip()}")
                lines.append("")
        if summary.conclusion and summary.conclusion.text.strip():
            lines.extend(["## 结论", "", summary.conclusion.text.strip(), ""])

    lines.extend(["## 整理稿", ""])
    if revision.blocks:
        for block in revision.blocks:
            text = _escape_line(block.text.strip())
            if not text:
                continue
            if include_timestamps:
                lines.append(f"{time_link(video, block.start_ms)}　{text}")
            else:
                lines.append(text)
            lines.append("")
    else:
        lines.extend(["暂无正文。", ""])

    if include_terms and (terms or pending):
        lines.extend(["## 术语与存疑内容", ""])
        if terms:
            for term in terms:
                status = {"confirmed": "已确认", "suggested": "待确认", "disputed": "存疑"}.get(
                    term.status, term.status
                )
                variant_text = f"（原写法：{'、'.join(term.variants)}）" if term.variants else ""
                lines.append(f"- **{term.canonical}** · {status}{variant_text}")
            lines.append("")
        if pending:
            for correction in pending:
                target = (
                    f"「{correction.original}」→「{correction.replacement}」"
                    if correction.replacement
                    else f"「{correction.original}」（仅标记）"
                )
                lines.append(f"- {target}　{correction.reason}")
            lines.append("")

    lines.extend(["## 材料覆盖与处理记录", ""])
    lines.append(f"- 文本来源：{source_label(source_type)}")
    lines.append(f"- 原始片段：{sum(len(b.source_segment_ids) for b in revision.blocks)} 段")
    lines.append(f"- 处理版本：{revision.pipeline_version or 'unknown'}")
    lines.append(f"- 术语表版本：{revision.glossary_version or '未使用'}")
    if summary:
        lines.append(f"- 总结模型：{summary.model}")
    lines.append("- 覆盖限制：仅依据字幕/转写文字，图表、画面操作、表情和未被说出的信息未覆盖。")
    notes = (options.get("notes") or []) if isinstance(options.get("notes"), list) else []
    for note in notes[:20]:
        lines.append(f"- 处理提示：{note}")
    lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def export_filename(video: VideoRef, revision: Revision) -> str:
    suffix = {
        "original": "原始稿",
        "cleaned": "整理稿",
        "edited": "人工修订稿",
    }.get(revision.kind, "文稿")
    base = safe_filename(video.title or "视频文字稿", "视频文字稿")
    part = f"-P{video.page:02d}" if video.page else ""
    return f"{base}{part}-{suffix}.md"

"""Two-level chapter summarization with citation validation."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from ..prompts import (
    SUMMARY_AGGREGATE_SYSTEM,
    SUMMARY_CHUNK_SYSTEM,
    summary_aggregate_user,
    summary_chunk_user,
)
from ..providers.llm import LLMError, LLMProvider
from ..schemas import Block, Chapter, Citation, Coverage, Summary, VideoRef
from .clean import PipelineError

ProgressFn = Callable[[float, str], None]
_SENTENCE_RE = re.compile(r"[^。！？!?；;]+[。！？!?；;]?")


@dataclass
class SummaryOptions:
    max_chunk_chars: int = 6000
    include_editorial_notes: bool = True


def _split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_RE.findall(text) if s.strip()]


def _valid_citation(item: Any, valid_ids: set[str], text_key: str = "text") -> Citation | None:
    if not isinstance(item, dict):
        return None
    text = str(item.get(text_key) or item.get("text") or "").strip()
    if not text:
        return None
    ids = [
        str(sid)
        for sid in (item.get("segmentIds") or [])
        if isinstance(sid, str) and sid in valid_ids
    ]
    return Citation(text=text, segment_ids=list(dict.fromkeys(ids))[:12])


def _chunk_blocks(blocks: list[Block], max_chars: int) -> list[list[Block]]:
    chunks: list[list[Block]] = []
    current: list[Block] = []
    total = 0
    for block in blocks:
        if current and total + len(block.text) > max_chars:
            chunks.append(current)
            current = []
            total = 0
        current.append(block)
        total += len(block.text)
    if current:
        chunks.append(current)
    return chunks


def _coverage_defaults(source_label: str) -> Coverage:
    return Coverage(
        sources=[source_label],
        gaps=["仅依据字幕/转写文字，未覆盖图表、画面操作、表情和未被说出的信息"],
        uncertainties=[],
    )


class HeuristicSummarizer:
    """Extractive fallback that always cites real segments."""

    def summarize(
        self,
        video: VideoRef,
        blocks: list[Block],
        segment_index: dict[str, dict[str, Any]],
        source_label: str,
    ) -> Summary:
        blocks = [b for b in blocks if b.text.strip()]
        if not blocks:
            return Summary(
                id="",
                document_id="",
                revision_id="",
                overview="没有可用于总结的文字材料。",
                coverage=_coverage_defaults(source_label),
                model="extractive-v1",
            )
        chunks = _chunk_blocks(blocks, 2400)
        chapters: list[Chapter] = []
        for chunk in chunks:
            first = chunk[0]
            title = first.text.strip()[:22]
            points: list[Citation] = []
            sentences = []
            for block in chunk:
                for sentence in _split_sentences(block.text):
                    sentences.append((sentence, block))
            for sentence, block in sentences[:3]:
                if len(sentence) < 6:
                    continue
                points.append(
                    Citation(text=sentence[:160], segment_ids=block.source_segment_ids[:4])
                )
            if not points:
                points = [Citation(text=first.text[:160], segment_ids=first.source_segment_ids[:4])]
            chapters.append(
                Chapter(
                    title=title.rstrip("，。！？；： "),
                    start_ms=first.start_ms,
                    end_ms=chunk[-1].end_ms,
                    points=points,
                    editorial_title=True,
                )
            )

        all_sentences: list[tuple[str, Block]] = []
        for block in blocks:
            for sentence in _split_sentences(block.text):
                if len(sentence) >= 8:
                    all_sentences.append((sentence, block))

        opinion_markers = ("我认为", "我觉得", "关键", "重要", "意味着", "应该", "必须", "核心", "本质")
        viewpoints: list[Citation] = []
        for sentence, block in all_sentences:
            if any(marker in sentence for marker in opinion_markers):
                viewpoints.append(
                    Citation(text=sentence[:180], segment_ids=block.source_segment_ids[:4])
                )
            if len(viewpoints) >= 5:
                break
        if not viewpoints:
            step = max(1, len(all_sentences) // 4)
            for sentence, block in all_sentences[::step][:5]:
                viewpoints.append(
                    Citation(text=sentence[:180], segment_ids=block.source_segment_ids[:4])
                )

        overview = " ".join(s[0][:120] for s in all_sentences[:2]).strip()
        if not overview:
            overview = blocks[0].text[:160]
        conclusion_text = all_sentences[-1][0][:180] if all_sentences else blocks[-1].text[:160]
        conclusion_block = all_sentences[-1][1] if all_sentences else blocks[-1]
        key_numbers: list[Citation] = []
        for sentence, block in all_sentences:
            if re.search(r"\d", sentence):
                key_numbers.append(
                    Citation(text=sentence[:180], segment_ids=block.source_segment_ids[:4])
                )
            if len(key_numbers) >= 5:
                break

        return Summary(
            id="",
            document_id="",
            revision_id="",
            overview=overview,
            viewpoints=viewpoints,
            chapters=chapters,
            conclusion=Citation(text=conclusion_text, segment_ids=conclusion_block.source_segment_ids[:4]),
            key_numbers=key_numbers,
            coverage=_coverage_defaults(source_label),
            model="extractive-v1",
        )


class LLMSummarizer:
    def __init__(self, llm: LLMProvider):
        self.llm = llm

    def summarize(
        self,
        video: VideoRef,
        blocks: list[Block],
        segment_index: dict[str, dict[str, Any]],
        source_label: str,
        progress: ProgressFn | None = None,
    ) -> Summary:
        valid_ids = set(segment_index.keys())
        chunks = _chunk_blocks(blocks, 6000)
        partials: list[dict[str, Any]] = []
        for index, chunk in enumerate(chunks):
            if progress:
                progress(0.05 + 0.6 * (index + 1) / max(1, len(chunks)), "生成章节要点")
            payload = [
                {
                    "id": block.id,
                    "text": block.text,
                    "segmentIds": block.source_segment_ids,
                    "startMs": block.start_ms,
                    "endMs": block.end_ms,
                }
                for block in chunk
            ]
            try:
                data = self.llm.chat_json(
                    SUMMARY_CHUNK_SYSTEM, summary_chunk_user(index, payload, segment_index)
                )
            except LLMError as exc:
                if exc.code in ("llm_auth", "llm_balance", "llm_not_configured"):
                    raise PipelineError(exc.code, exc.message, needs_input=True) from exc
                raise PipelineError("summary_failed", f"章节总结失败：{exc.message}", retryable=True) from exc
            points = [
                c for c in (_valid_citation(item, valid_ids) for item in data.get("points") or []) if c
            ]
            partials.append(
                {
                    "chapterTitle": str(data.get("chapterTitle") or f"第 {index + 1} 部分")[:40],
                    "points": [p.model_dump(by_alias=True) for p in points],
                    "keyNumbers": [
                        c.model_dump(by_alias=True)
                        for c in (
                            _valid_citation(item, valid_ids)
                            for item in data.get("keyNumbers") or []
                        )
                        if c
                    ],
                    "uncertainties": [
                        str(item)[:200] for item in data.get("uncertainties") or [] if str(item).strip()
                    ][:10],
                    "startSegmentId": chunk[0].source_segment_ids[0] if chunk[0].source_segment_ids else "",
                    "endSegmentId": chunk[-1].source_segment_ids[-1] if chunk[-1].source_segment_ids else "",
                }
            )
        if progress:
            progress(0.72, "汇总全片")
        try:
            aggregated = self.llm.chat_json(
                SUMMARY_AGGREGATE_SYSTEM, summary_aggregate_user(partials, source_label)
            )
        except LLMError as exc:
            if exc.code in ("llm_auth", "llm_balance", "llm_not_configured"):
                raise PipelineError(exc.code, exc.message, needs_input=True) from exc
            return self._fallback(partials, video, source_label, segment_index)

        chapters: list[Chapter] = []
        for item in aggregated.get("chapters") or []:
            if not isinstance(item, dict):
                continue
            points = [
                c
                for c in (
                    _valid_citation(point, valid_ids)
                    for point in item.get("points") or []
                )
                if c
            ]
            start_id = str(item.get("startSegmentId") or "")
            end_id = str(item.get("endSegmentId") or "")
            start_ms = int(segment_index.get(start_id, {}).get("startMs", 0))
            end_ms = int(segment_index.get(end_id, {}).get("endMs", start_ms))
            cited_ids = [sid for p in points for sid in p.segment_ids]
            if not start_id and cited_ids:
                start_ms = min(segment_index[sid]["startMs"] for sid in cited_ids if sid in segment_index)
            if not end_id and cited_ids:
                end_ms = max(segment_index[sid]["endMs"] for sid in cited_ids if sid in segment_index)
            chapters.append(
                Chapter(
                    title=str(item.get("title") or "未命名章节")[:60],
                    start_ms=max(0, start_ms),
                    end_ms=max(start_ms, end_ms),
                    points=points,
                    editorial_title=True,
                )
            )
        chapters.sort(key=lambda c: c.start_ms)
        if not chapters:
            return self._fallback(partials, video, source_label, segment_index)

        overview = str(aggregated.get("overview") or "").strip()
        if not overview:
            overview = " ".join(p.text for p in chapters[0].points[:2])[:300]
        coverage_data = aggregated.get("coverage") if isinstance(aggregated.get("coverage"), dict) else {}
        coverage = Coverage(
            sources=[str(s) for s in coverage_data.get("sources") or [source_label]][:10],
            gaps=[
                str(s)
                for s in coverage_data.get("gaps")
                or ["仅依据字幕/转写文字，未覆盖图表、画面操作、表情和未被说出的信息"]
            ][:10],
            uncertainties=[str(s)[:240] for s in coverage_data.get("uncertainties") or []][:20],
        )
        viewpoints = [
            c
            for c in (
                _valid_citation(item, valid_ids)
                for item in aggregated.get("viewpoints") or []
            )
            if c
        ][:8]
        conclusion = _valid_citation(aggregated.get("conclusion"), valid_ids)
        key_numbers = [
            c
            for c in (
                _valid_citation(item, valid_ids)
                for item in aggregated.get("keyNumbers") or []
            )
            if c
        ][:8]
        if progress:
            progress(0.9, "校验引用")
        return Summary(
            id="",
            document_id="",
            revision_id="",
            overview=overview[:1200],
            viewpoints=viewpoints,
            chapters=chapters,
            conclusion=conclusion,
            key_numbers=key_numbers,
            coverage=coverage,
            model=self.llm.model,
        )

    def _fallback(
        self,
        partials: list[dict[str, Any]],
        video: VideoRef,
        source_label: str,
        segment_index: dict[str, dict[str, Any]],
    ) -> Summary:
        chapters = []
        for item in partials:
            points = [Citation.model_validate(p) for p in item.get("points") or []]
            ids = [sid for point in points for sid in point.segment_ids if sid in segment_index]
            start_ms = min((segment_index[sid]["startMs"] for sid in ids), default=0) if ids else 0
            end_ms = max((segment_index[sid]["endMs"] for sid in ids), default=start_ms) if ids else start_ms
            chapters.append(
                Chapter(
                    title=str(item.get("chapterTitle") or "章节"),
                    start_ms=start_ms,
                    end_ms=end_ms,
                    points=points,
                    editorial_title=True,
                )
            )
        overview = " ".join(
            point.text for chapter in chapters for point in chapter.points[:1]
        )[:300]
        first_point = next((p for c in chapters for p in c.points), None)
        return Summary(
            id="",
            document_id="",
            revision_id="",
            overview=overview or "本视频按章节整理如下。",
            chapters=chapters,
            conclusion=first_point,
            coverage=_coverage_defaults(source_label),
            model=self.llm.model,
        )


def summarize_document(
    video: VideoRef,
    blocks: list[Block],
    segment_index: dict[str, dict[str, Any]],
    llm: LLMProvider,
    source_label: str,
    progress: ProgressFn | None = None,
) -> Summary:
    if llm.is_heuristic:
        if progress:
            progress(1.0, "本地提取式总结")
        return HeuristicSummarizer().summarize(video, blocks, segment_index, source_label)
    summary = LLMSummarizer(llm).summarize(video, blocks, segment_index, source_label, progress)
    if progress:
        progress(1.0, "总结完成")
    return summary

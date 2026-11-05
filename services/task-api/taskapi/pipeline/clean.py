"""Text cleaning orchestration: normalize, discover terms, rewrite segments, check consistency."""

from __future__ import annotations

import difflib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..prompts import (
    CLEAN_SYSTEM,
    CONSISTENCY_SYSTEM,
    PROMPT_VERSION,
    TERM_DISCOVERY_SYSTEM,
    clean_user,
    consistency_user,
    term_discovery_user,
)
from ..providers.llm import LLMError, LLMProvider
from ..schemas import AppliedEdit, Block, Correction, Term
from .normalize import (
    CleanedSegment,
    build_blocks,
    clean_text,
    find_quote,
    mask_quotes,
    replace_outside_quotes,
)

ProgressFn = Callable[[float, str], None]


class PipelineError(Exception):
    def __init__(self, code: str, message: str, needs_input: bool = False, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.message = message
        self.needs_input = needs_input
        self.retryable = retryable


@dataclass
class CleanOutcome:
    blocks: list[Block]
    corrections: list[Correction]
    applied_edits: list[AppliedEdit]
    terms: list[Term]
    stats: dict[str, Any] = field(default_factory=dict)
    pipeline_version: str = PROMPT_VERSION


@dataclass
class CleanOptions:
    strength: str = "standard"
    glossary: list[dict[str, Any]] = field(default_factory=list)
    language: str = "zh-CN"
    max_chunk_chars: int = 3500

    @classmethod
    def from_options(cls, options: dict[str, Any], glossary: list[dict[str, Any]]) -> CleanOptions:
        strength = options.get("strength") or "standard"
        if strength not in ("light", "standard", "compact"):
            strength = "standard"
        merged = list(glossary)
        for entry in options.get("glossary") or []:
            if isinstance(entry, dict) and entry.get("canonical"):
                merged.append(entry)
        return cls(strength=strength, glossary=merged)


def _chunks(items: list, size: int, length_fn: Callable[[Any], int]) -> list[list]:
    chunks: list[list] = []
    current: list = []
    total = 0
    for item in items:
        length = length_fn(item)
        if current and total + length > size:
            chunks.append(current)
            current = []
            total = 0
        current.append(item)
        total += length
    if current:
        chunks.append(current)
    return chunks


def _glossary_for_prompt(terms: list[Term], limit: int = 40) -> list[dict]:
    entries = []
    for term in terms[:limit]:
        entries.append(
            {
                "canonical": term.canonical,
                "variants": term.variants,
                "status": term.status,
                "evidenceType": term.evidence_type,
            }
        )
    return entries


def _merge_terms(
    glossary: list[dict[str, Any]],
    discovered: list[dict[str, Any]],
    segment_ids: set[str],
) -> list[Term]:
    terms: list[Term] = []
    by_key: dict[str, Term] = {}

    def key(value: str) -> str:
        return value.strip().casefold()

    for index, entry in enumerate(glossary):
        canonical = str(entry.get("canonical") or "").strip()
        if not canonical:
            continue
        variants = [str(v).strip() for v in entry.get("variants") or [] if str(v).strip()]
        variants = [v for v in dict.fromkeys(variants) if v != canonical]
        term = Term(
            term_id=f"term_g{index:03d}",
            entity_type=str(entry.get("entityType") or entry.get("entity_type") or "term"),
            canonical=canonical,
            variants=variants,
            status="confirmed",
            evidence_type="user_glossary",
            evidence_segment_ids=[],
            scope={},
            confirmed_by="user",
        )
        terms.append(term)
        by_key[key(canonical)] = term
        for variant in variants:
            by_key.setdefault(key(variant), term)

    counter = 0
    for item in discovered:
        canonical = str(item.get("canonical") or "").strip()
        if not canonical or len(canonical) > 60:
            continue
        variants = [str(v).strip() for v in item.get("variants") or [] if str(v).strip()]
        variants = [v for v in dict.fromkeys(variants) if v != canonical and len(v) <= 60]
        existing = by_key.get(key(canonical))
        for variant in variants:
            existing = existing or by_key.get(key(variant))
        if existing is not None:
            for variant in variants:
                if variant not in existing.variants and variant != existing.canonical:
                    existing.variants.append(variant)
                    by_key.setdefault(key(variant), existing)
            continue
        evidence_ids = [sid for sid in item.get("evidenceSegmentIds") or [] if sid in segment_ids][:8]
        evidence_type = str(item.get("evidenceType") or "none")
        if evidence_type not in ("user_glossary", "material_spelling", "context_only", "none"):
            evidence_type = "none"
        counter += 1
        term = Term(
            term_id=f"term_m{counter:03d}",
            entity_type=str(item.get("entityType") or "term"),
            canonical=canonical,
            variants=variants,
            status="suggested" if evidence_ids else "disputed",
            evidence_type=evidence_type,
            evidence_segment_ids=evidence_ids,
            scope={},
        )
        terms.append(term)
        by_key[key(canonical)] = term
        for variant in variants:
            by_key.setdefault(key(variant), term)
    return terms[:80]


def _term_discovery(
    llm: LLMProvider,
    normalized: list[CleanedSegment],
    glossary: list[Term],
    notes: list[str],
    progress: ProgressFn | None,
) -> list[dict[str, Any]]:
    if llm.is_heuristic or not normalized:
        return []
    payload = [{"id": s.id, "text": s.text, "startMs": s.start_ms} for s in normalized]
    chunks = _chunks(payload, 6500, lambda item: len(item["text"]))
    discovered: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks):
        if progress:
            progress(0.1 + 0.1 * (index + 1) / max(1, len(chunks)), "发现术语")
        try:
            data = llm.chat_json(TERM_DISCOVERY_SYSTEM, term_discovery_user([chunk], [t.model_dump(by_alias=True) for t in glossary], {}))
        except LLMError as exc:
            if exc.code in ("llm_auth", "llm_balance", "llm_not_configured"):
                raise PipelineError(exc.code, exc.message, needs_input=True) from exc
            notes.append(f"术语发现第 {index + 1} 块失败：{exc.message}")
            continue
        for item in data.get("terms") or []:
            if isinstance(item, dict):
                discovered.append(item)
    return discovered


def _segment_rewrite(
    llm: LLMProvider,
    normalized: list[CleanedSegment],
    glossary: list[Term],
    strength: str,
    options: CleanOptions,
    notes: list[str],
    progress: ProgressFn | None,
) -> list[str]:
    texts = [segment.text for segment in normalized]
    if llm.is_heuristic:
        return texts
    segments = [{"id": s.id, "text": s.text} for s in normalized]
    chunks = _chunks(segments, options.max_chunk_chars, lambda item: len(item["text"]))
    glossary_prompt = _glossary_for_prompt(glossary)
    result_by_id: dict[str, str] = {}
    for index, chunk in enumerate(chunks):
        if progress:
            progress(0.28 + 0.5 * (index + 1) / max(1, len(chunks)), "逐块清洗")
        first_id = chunk[0]["id"]
        last_id = chunk[-1]["id"]
        position = next((i for i, s in enumerate(normalized) if s.id == first_id), 0)
        before = "".join(s.text for s in normalized[max(0, position - 3):position])[-400:]
        end_position = next((i for i, s in enumerate(normalized) if s.id == last_id), len(normalized) - 1)
        after = "".join(s.text for s in normalized[end_position + 1:end_position + 4])[:400]
        try:
            data = llm.chat_json(CLEAN_SYSTEM, clean_user(chunk, glossary_prompt, before, after))
        except LLMError as exc:
            if exc.code in ("llm_auth", "llm_balance", "llm_not_configured"):
                raise PipelineError(exc.code, exc.message, needs_input=True) from exc
            notes.append(f"清洗第 {index + 1} 块失败，已保留规则清洗结果：{exc.message}")
            continue
        returned = data.get("segments")
        if not isinstance(returned, list):
            notes.append(f"清洗第 {index + 1} 块返回格式不正确，已保留规则清洗结果")
            continue
        for item in returned:
            if not isinstance(item, dict):
                continue
            sid = item.get("id")
            text = item.get("text")
            if isinstance(sid, str) and isinstance(text, str) and sid in {s["id"] for s in chunk}:
                result_by_id[sid] = text

    final_texts: list[str] = []
    for segment in normalized:
        candidate = result_by_id.get(segment.id)
        if candidate is None:
            final_texts.append(segment.text)
            continue
        candidate = candidate.strip()
        old = segment.text.strip()
        if not candidate and old.replace(" ", ""):
            notes.append(f"保留 {segment.id}：模型返回空文本")
            final_texts.append(segment.text)
            continue
        if len(old) >= 30 and len(candidate) < len(old) * 0.5:
            notes.append(f"保留 {segment.id}：模型删减过多")
            final_texts.append(segment.text)
            continue
        if len(candidate) > max(40, len(old) * 2.5):
            notes.append(f"保留 {segment.id}：模型扩写过多")
            final_texts.append(segment.text)
            continue
        final_texts.append(candidate)
    return final_texts


def _add_term_corrections(
    terms: list[Term],
    blocks: list[Block],
) -> list[Correction]:
    corrections: list[Correction] = []
    counter = 0
    for term in terms:
        if term.status == "confirmed" or not term.variants:
            continue
        for block in blocks:
            masked = mask_quotes(block.text)
            seen_offsets: set[tuple[int, int]] = set()
            for variant in term.variants:
                if not variant or variant == term.canonical:
                    continue
                start = 0
                while True:
                    index = masked.find(variant, start)
                    if index < 0:
                        break
                    start = index + len(variant)
                    key = (index, index + len(variant))
                    if key in seen_offsets:
                        continue
                    seen_offsets.add(key)
                    counter += 1
                    corrections.append(
                        Correction(
                            id=f"corr_term_{counter:04d}",
                            block_id=block.id,
                            source_segment_ids=list(block.source_segment_ids),
                            start_offset=index,
                            end_offset=index + len(variant),
                            original=variant,
                            replacement=term.canonical,
                            change_type="term",
                            reason=f"疑似与「{term.canonical}」为同一对象；依据：{term.evidence_type}",
                            evidence_type=term.evidence_type,
                            evidence_segment_ids=list(term.evidence_segment_ids),
                            status="pending",
                            term_id=term.term_id,
                            auto_applicable=False,
                        )
                    )
                    if len(corrections) >= 120:
                        return corrections
    return corrections


def _consistency_check(
    llm: LLMProvider,
    blocks: list[Block],
    notes: list[str],
    progress: ProgressFn | None,
) -> list[Correction]:
    if llm.is_heuristic or not blocks:
        return []
    payload = [{"id": b.id, "text": b.text, "sourceSegmentIds": b.source_segment_ids} for b in blocks]
    chunks = _chunks(payload, 16000, lambda item: len(item["text"]))
    issues: list[dict[str, Any]] = []
    for index, chunk in enumerate(chunks):
        if progress:
            progress(0.82 + 0.08 * (index + 1) / max(1, len(chunks)), "检查一致性")
        try:
            data = llm.chat_json(CONSISTENCY_SYSTEM, consistency_user(chunk))
        except LLMError as exc:
            if exc.code in ("llm_auth", "llm_balance", "llm_not_configured"):
                raise PipelineError(exc.code, exc.message, needs_input=True) from exc
            notes.append(f"一致性检查第 {index + 1} 块失败：{exc.message}")
            continue
        for issue in data.get("issues") or []:
            if isinstance(issue, dict):
                issues.append(issue)

    by_id = {block.id: block for block in blocks}
    corrections: list[Correction] = []
    seen: set[tuple[str, int]] = set()
    for issue in issues:
        block = by_id.get(str(issue.get("blockId") or ""))
        if not block:
            continue
        quote = str(issue.get("quote") or "")
        located = find_quote(block.text, quote)
        if not located:
            continue
        start, end = located
        if (block.id, start) in seen:
            continue
        seen.add((block.id, start))
        suggestion = issue.get("suggestion")
        replacement = str(suggestion) if suggestion not in (None, "") else None
        if replacement == quote:
            replacement = None
        # Keep the problem category reported by the model. A conflict without a
        # suggested rewrite is still a consistency issue (not a generic "note"):
        # the UI groups/labels these separately, and CorrectionsApply applies them
        # as "keep" decisions. Only explicit note-type issues become notes.
        issue_type = str(issue.get("type") or "").strip()
        change_type = "note" if issue_type == "note" else "consistency"
        corrections.append(
            Correction(
                id=f"corr_consistency_{len(corrections) + 1:04d}",
                block_id=block.id,
                source_segment_ids=list(block.source_segment_ids),
                start_offset=start,
                end_offset=end,
                original=quote,
                replacement=replacement,
                change_type=change_type,
                reason=str(issue.get("reason") or "内容存在前后不一致"),
                evidence_type="context_only",
                evidence_segment_ids=[
                    sid for sid in issue.get("evidenceSegmentIds") or [] if isinstance(sid, str)
                ][:8],
                status="pending",
            )
        )
        if len(corrections) >= 40:
            break
    return corrections


def clean_document(
    segments: list[dict[str, Any]],
    options: CleanOptions,
    llm: LLMProvider,
    progress: ProgressFn | None = None,
) -> CleanOutcome:
    """Clean subtitles into blocks.

    ``segments`` entries are ``{id, startMs, endMs, text}`` in source order. When the
    caller passes the owning base-revision block (``blockId`` + ``sourceSegmentIds``),
    applied edits are reported as patches against that base block text, mirroring the
    correction contract: ``blockId`` is a real block of the parent revision and
    ``original`` equals ``baseBlock.text[startOffset:endOffset]`` so every automatic
    deletion/replacement can be audited and rolled back.
    """
    if not segments:
        raise PipelineError("empty_source", "没有可清洗的字幕片段")
    notes: list[str] = []
    if progress:
        progress(0.02, "规则规范化")

    normalized: list[CleanedSegment] = []
    base_block_ids: dict[str, str] = {}
    base_source_ids: dict[str, list[str]] = {}
    for seg in segments:
        segment_id = str(seg["id"])
        original_text = str(seg.get("text") or "")
        cleaned = clean_text(original_text, options.strength)
        normalized.append(
            CleanedSegment(
                id=segment_id,
                start_ms=int(seg.get("startMs") or 0),
                end_ms=int(seg.get("endMs") or 0),
                text=cleaned,
                original_text=original_text,
            )
        )
        block_id = str(seg.get("blockId") or "").strip()
        if block_id:
            base_block_ids[segment_id] = block_id
        source_ids = [str(value) for value in seg.get("sourceSegmentIds") or [] if str(value)]
        base_source_ids[segment_id] = source_ids or [segment_id]

    raw_terms = _merge_terms(options.glossary, [], {s.id for s in normalized})
    for term in raw_terms:
        if term.status != "confirmed" or not term.variants:
            continue
        for segment in normalized:
            new_text, _edits = replace_outside_quotes(segment.text, term.variants, term.canonical)
            if new_text != segment.text:
                segment.text = new_text

    discovered = _term_discovery(llm, normalized, raw_terms, notes, progress)
    terms = _merge_terms(options.glossary, discovered, {s.id for s in normalized})

    after_glossary = {segment.id: segment.text for segment in normalized}
    final_texts = _segment_rewrite(
        llm, normalized, terms, options.strength, options, notes, progress
    )
    for segment, final_text in zip(normalized, final_texts):
        segment.text = final_text

    if progress:
        progress(0.8, "合并段落")
    block_dicts = build_blocks(normalized)
    blocks = [Block.model_validate(b) for b in block_dicts]
    if not blocks:
        raise PipelineError("empty_after_clean", "清洗后没有可用正文，已保留原始稿")

    produced_block_ids: dict[str, str] = {}
    for block in blocks:
        for segment_id in block.source_segment_ids:
            produced_block_ids.setdefault(segment_id, block.id)

    canonical_by_variant: dict[str, str] = {}
    for term in terms:
        if term.status != "confirmed":
            continue
        for variant in term.variants:
            if variant and variant != term.canonical:
                canonical_by_variant.setdefault(variant, term.canonical)

    applied_edits: list[AppliedEdit] = []
    for segment in normalized:
        base_text = segment.original_text
        final_text = segment.text
        if base_text == final_text:
            continue
        block_id = base_block_ids.get(segment.id) or produced_block_ids.get(segment.id) or blocks[0].id
        source_ids = base_source_ids.get(segment.id) or [segment.id]
        # A change beyond the deterministic rule pass is attributed to the model rewrite.
        model_changed = final_text != after_glossary.get(segment.id, base_text)
        matcher = difflib.SequenceMatcher(None, base_text, final_text, autojunk=False)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag == "equal":
                continue
            original = base_text[i1:i2]
            replacement = final_text[j1:j2]
            canonical = canonical_by_variant.get(original)
            if canonical is not None and replacement == canonical:
                change_type = "term"
                reason = f"术语表统一为「{canonical}」"
                evidence_type = "user_glossary"
            elif model_changed:
                change_type = "model_clean"
                reason = f"模型按{options.strength}档清洗"
                evidence_type = "model"
            else:
                change_type = "format"
                reason = "规则清洗（格式/口水词/重复）"
                evidence_type = "rule"
            applied_edits.append(
                AppliedEdit(
                    block_id=block_id,
                    source_segment_ids=list(source_ids),
                    start_offset=i1,
                    end_offset=i2,
                    original=original,
                    replacement=replacement,
                    change_type=change_type,
                    reason=reason,
                    evidence_type=evidence_type,
                )
            )

    pending = _add_term_corrections(terms, blocks)
    pending.extend(_consistency_check(llm, blocks, notes, progress))
    if progress:
        progress(0.94, "整稿检查")

    stats = {
        "segments": len(normalized),
        "blocks": len(blocks),
        "charsIn": sum(len(s.original_text) for s in normalized),
        "charsOut": sum(len(b.text) for b in blocks),
        "appliedEdits": len(applied_edits),
        "pendingCorrections": len(pending),
        "terms": len(terms),
        "llm": "heuristic" if llm.is_heuristic else llm.model,
        "llmUsage": getattr(llm, "usage_totals", None),
        "notes": notes[:50],
    }
    if progress:
        progress(1.0, "清洗完成")
    return CleanOutcome(
        blocks=blocks,
        corrections=pending,
        applied_edits=applied_edits,
        terms=terms,
        stats=stats,
    )

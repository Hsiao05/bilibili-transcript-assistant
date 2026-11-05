"""Deterministic text normalization: formatting, filler removal, joins and term replacement."""

from __future__ import annotations

import difflib
import re
from dataclasses import dataclass, field

_QUOTE_RE = re.compile(r"“([^”]*)”|「([^」]*)」|『([^』]*)』|\"([^\"\n]*)\"")
_PROTECT_RES = [
    re.compile(r"https?://[^\s，。；、！？）】》\"']+", re.IGNORECASE),
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),
    re.compile(r"`[^`\n]+`"),
    re.compile(r"\b[A-Za-z]{1,8}-\d+[A-Za-z0-9.\-]*\b"),
    re.compile(r"\bv?\d+\.\d+(?:\.\d+)*\b", re.IGNORECASE),
    re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b"),
]
_TOKEN_RE = re.compile("(\\d+)")

_CLAUSE = "，。！？；：、,.!?;: \t\n"
_SENTENCE_END = "。！？!?…；;：:"
_TERMINAL = "。！？!?…"
_CLOSING = "”’」』）】》"
_OPENERS = "（【《「『“‘("
_CLOSERS = "，。！？；：、）】》」』”’,.!?;:"


@dataclass
class EditSpec:
    start_offset: int
    end_offset: int
    original: str
    replacement: str
    change_type: str
    reason: str = ""
    evidence_type: str | None = None


@dataclass
class CleanedSegment:
    id: str
    start_ms: int
    end_ms: int
    text: str
    original_text: str
    edits: list[EditSpec] = field(default_factory=list)


def mask_quotes(text: str) -> str:
    """Replace quoted spans with NULs while preserving string length and offsets."""
    chars = list(text)
    for match in _QUOTE_RE.finditer(text):
        for i in range(match.start(), match.end()):
            chars[i] = "\x00"
    return "".join(chars)


def _mask_quotes(text: str) -> str:
    return mask_quotes(text)


def _protect(text: str) -> tuple[str, list[str]]:
    tokens: list[str] = []

    def repl(match: re.Match) -> str:
        tokens.append(match.group(0))
        return f"{len(tokens) - 1}"

    masked = text
    for pattern in _PROTECT_RES:
        masked = pattern.sub(repl, masked)
    return masked, tokens


def _restore(text: str, tokens: list[str]) -> str:
    def repl(match: re.Match) -> str:
        index = int(match.group(1))
        return tokens[index] if 0 <= index < len(tokens) else match.group(0)

    return _TOKEN_RE.sub(repl, text)


def format_clean(text: str) -> str:
    if not text:
        return ""
    masked, tokens = _protect(text)
    value = masked.replace("\r\n", "\n").replace("\r", "\n")
    value = value.replace(" ", " ").replace("　", " ")
    value = re.sub("[\u200b\u200c\u200d\ufeff]", "", value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", value)
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"[ \t]+(?=[，。！？；：、）】》」』”’…])", "", value)
    value = re.sub(r"(?<=[，。！？；：、])[ \t]+(?=[一-鿿])", "", value)
    value = re.sub(r"(?<=[（【《「『“‘])[ \t]+", "", value)
    value = re.sub(r"[ \t]*\n[ \t]*", "\n", value)
    value = re.sub(r"\n{2,}", "\n", value)
    value = re.sub(r"，{2,}", "，", value)
    value = re.sub(r"。{2,}", "。", value)
    value = re.sub(r"、{2,}", "、", value)
    value = re.sub(r"；{2,}", "；", value)
    value = re.sub(r"：{2,}", "：", value)
    value = re.sub(r"…{3,}", "……", value)
    value = re.sub(r"\.{4,}", "...", value)
    value = value.strip()
    return _restore(value, tokens)


_STUTTER_RE = re.compile(
    r"(我们|你们|他们|她们|大家|这个|那个|就是|然后|所以|但是|因为|如果|其实|我|你|他|她|它)\1+"
)
_LIGHT_FILLER_RE = re.compile(r"(^|[，。！？；：、\s])(?:呃+|额+)[，,、]?\s*")
_STANDARD_FILLER_RE = re.compile(r"(^|[，。！？；：、\s])(?:嗯+)[，,、]?\s*")
_CLAUSE_FILLER_RE = re.compile(r"(^|[，。！？；：、\s])(?:那个|这个|就是)[，,]\s*")


def _sub_outside_quotes(text: str, pattern: re.Pattern, repl) -> str:
    masked = _mask_quotes(text)
    pieces: list[str] = []
    last = 0
    for match in pattern.finditer(masked):
        pieces.append(text[last : match.start()])
        pieces.append(repl(match, text))
        last = match.end()
    pieces.append(text[last:])
    return "".join(pieces)


def remove_fillers(text: str, strength: str) -> str:
    if strength in ("light", "standard", "compact"):
        text = _sub_outside_quotes(text, _LIGHT_FILLER_RE, lambda m, _t: m.group(1))
        text = _sub_outside_quotes(text, _STUTTER_RE, lambda m, _t: m.group(1))
    if strength in ("standard", "compact"):
        text = _sub_outside_quotes(text, _STANDARD_FILLER_RE, lambda m, _t: m.group(1))
        text = _sub_outside_quotes(text, _CLAUSE_FILLER_RE, lambda m, _t: m.group(1))
        text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def clean_text(text: str, strength: str = "standard") -> str:
    return remove_fillers(format_clean(text), strength)


def normalize_punctuation(text: str) -> str:
    """Make Chinese punctuation consistent and end every paragraph with a sentence stop.

    Correction models are good at restoring punctuation but not perfectly consistent, so this
    deterministic pass guarantees the invariants the reader/export rely on: no doubled stops,
    full-width stops next to Chinese text, no dangling spaces, and a terminal stop per block.
    """
    if not text:
        return ""
    value = format_clean(text)
    # Very long runs of ASCII punctuation next to Chinese text are almost always ASR/model noise.
    value = re.sub(r"(?<=[一-鿿])[ \t]*,[ \t]*", "，", value)
    value = re.sub(r"(?<=[一-鿿])[ \t]*;[ \t]*", "；", value)
    value = re.sub(r"(?<=[一-鿿])[ \t]*:[ \t]*", "：", value)
    value = re.sub(r"(?<=[一-鿿])[ \t]*\?[ \t]*", "？", value)
    value = re.sub(r"(?<=[一-鿿])[ \t]*![ \t]*", "！", value)
    value = re.sub(r"(?<=[一-鿿])\.(?=[一-鿿]|$)", "。", value)
    value = re.sub(r"[ \t]+([，。！？；：、）】》」』”’…])", r"\1", value)
    value = re.sub(r"([，。！？；：、])\1+", r"\1", value)
    value = re.sub(r"。[，,]", "。", value)
    value = re.sub(r"[，,]。", "。", value)
    value = re.sub(r"[；;]，", "；", value)
    value = re.sub(r"([，。！？；：、])\s+([，。！？；：、])", r"\1\2", value)

    def _collapse(match: re.Match) -> str:
        run = match.group(0)
        for mark in "。！？":
            if mark in run:
                return mark
        if "；" in run or ";" in run:
            return "；"
        if "：" in run or ":" in run:
            return "："
        return "，"

    value = re.sub(r"[，。！？；：、,;:!?]{2,}", _collapse, value)
    value = re.sub(r"^[，、；：,;:]+", "", value)
    value = value.strip()
    if not value:
        return ""
    if value[-1] in "，、；：,;:":
        # A paragraph must not end on a clause mark: replace it with a sentence stop instead
        # of appending another mark (which would create "，。").
        value = value[:-1].rstrip() + "。"
    if value[-1] in _TERMINAL:
        return value
    if value[-1] in _CLOSING and len(value) > 1 and value[-2] in _TERMINAL:
        return value
    return value + "。"


def _is_cjk(ch: str) -> bool:
    return bool(ch) and "一" <= ch <= "鿿"


def diff_edits(
    original: str,
    cleaned: str,
    change_type: str,
    reason: str,
    evidence_type: str | None = None,
) -> list[EditSpec]:
    if original == cleaned:
        return []
    edits: list[EditSpec] = []
    matcher = difflib.SequenceMatcher(None, original, cleaned, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        edits.append(
            EditSpec(
                start_offset=i1,
                end_offset=i2,
                original=original[i1:i2],
                replacement=cleaned[j1:j2],
                change_type=change_type,
                reason=reason,
                evidence_type=evidence_type,
            )
        )
    return edits


def replace_outside_quotes(text: str, variants: list[str], canonical: str) -> tuple[str, list[EditSpec]]:
    variants = [v for v in dict.fromkeys(variants) if v and v != canonical]
    if not variants:
        return text, []
    pattern = re.compile("|".join(re.escape(v) for v in sorted(variants, key=len, reverse=True)))
    masked = _mask_quotes(text)
    matches = [m for m in pattern.finditer(masked) if m.group(0) != canonical]
    if not matches:
        return text, []
    result = text
    edits: list[EditSpec] = []
    for match in reversed(matches):
        start, end = match.start(), match.end()
        result = result[:start] + canonical + result[end:]
        edits.append(
            EditSpec(
                start_offset=start,
                end_offset=end,
                original=text[start:end],
                replacement=canonical,
                change_type="term",
                reason=f"按术语表统一为「{canonical}」",
                evidence_type="user_glossary",
            )
        )
    edits.reverse()
    return result, edits


def join_texts(previous: str, following: str, gap_ms: int) -> str:
    if not previous:
        return following
    if not following:
        return previous
    following = following.lstrip("，。！？；：、,.!?;: ")
    if not following:
        return previous
    if previous[-1] in _SENTENCE_END:
        return previous + following
    if previous[-1] in "，、；：,;:":
        # Never stack a second separator after an existing clause mark. A long pause lets the
        # trailing comma become the paragraph's sentence stop.
        if gap_ms >= 1800 and previous[-1] in "，,":
            previous = previous[:-1] + "。"
        return previous + following
    if following[0] in _CLOSERS:
        return previous + following
    if previous[-1] in _OPENERS:
        return previous + following
    if previous[-1].isascii() and previous[-1].isalnum() and following[0].isascii() and following[0].isalnum():
        return previous + " " + following
    if _is_cjk(previous[-1]) and _is_cjk(following[0]):
        separator = "。" if gap_ms >= 1800 else "，"
        return previous + separator + following
    return previous + " " + following


def build_blocks(
    segments: list[CleanedSegment],
    max_chars: int = 240,
    gap_split_ms: int = 2600,
) -> list[dict]:
    blocks: list[dict] = []
    current: dict | None = None
    for segment in segments:
        text = segment.text.strip()
        if not text:
            if current is not None:
                current["endMs"] = segment.end_ms
                current["sourceSegmentIds"].append(segment.id)
            continue
        if current is None:
            current = {
                "id": f"block_{len(blocks) + 1:04d}",
                "sourceSegmentIds": [segment.id],
                "text": text,
                "startMs": segment.start_ms,
                "endMs": segment.end_ms,
            }
            continue
        gap = max(0, segment.start_ms - current["endMs"])
        should_split = len(current["text"]) >= max_chars or gap >= gap_split_ms or (
            len(current["text"]) + len(text) > max_chars * 1.6
        )
        if should_split:
            blocks.append(current)
            current = {
                "id": f"block_{len(blocks) + 1:04d}",
                "sourceSegmentIds": [segment.id],
                "text": text,
                "startMs": segment.start_ms,
                "endMs": segment.end_ms,
            }
        else:
            current["text"] = join_texts(current["text"], text, gap)
            current["sourceSegmentIds"].append(segment.id)
            current["endMs"] = segment.end_ms
    if current is not None:
        blocks.append(current)
    for block in blocks:
        block["text"] = normalize_punctuation(block["text"].strip())
    return blocks


def find_quote(text: str, quote: str) -> tuple[int, int] | None:
    if not quote:
        return None
    index = text.find(quote)
    if index < 0:
        return None
    return index, index + len(quote)

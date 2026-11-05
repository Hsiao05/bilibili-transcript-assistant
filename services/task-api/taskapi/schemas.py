"""Versioned API contracts (Pydantic v2, camelCase on the wire)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="ignore",
    )


# --------------------------------------------------------------------------- video


class VideoRef(CamelModel):
    bvid: str
    cid: str
    page: int = 1
    title: str = ""
    part_title: str | None = None
    author: str = ""
    duration_ms: int = 0
    cover_url: str | None = None
    source_url: str | None = None


# --------------------------------------------------------------------------- source


class Segment(CamelModel):
    id: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    text: str
    recognizer_confidence: float | None = None
    speaker: str | None = None

    @field_validator("end_ms")
    @classmethod
    def _end_after_start(cls, value: int, info: Any) -> int:
        start = info.data.get("start_ms", 0)
        return max(value, start)


class SourceCreate(CamelModel):
    type: str = "bilibili_subtitle"
    track_id: str | None = None
    language: str = "zh-CN"
    content_hash: str | None = None
    segments: list[Segment]

    @field_validator("segments")
    @classmethod
    def _non_empty(cls, value: list[Segment]) -> list[Segment]:
        if not value:
            raise ValueError("source must contain at least one segment")
        return value


class SourceInfo(CamelModel):
    id: str
    document_id: str | None
    type: str
    track_id: str | None
    language: str
    content_hash: str
    segment_count: int
    start_ms: int
    end_ms: int
    created_at: str


# --------------------------------------------------------------------------- document


class Block(CamelModel):
    id: str
    source_segment_ids: list[str] = Field(default_factory=list)
    text: str
    start_ms: int
    end_ms: int


class Correction(CamelModel):
    id: str
    block_id: str
    source_segment_ids: list[str] = Field(default_factory=list)
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    original: str
    replacement: str | None = None
    change_type: Literal["term", "filler", "consistency", "recognition", "format", "note"] = "note"
    reason: str = ""
    evidence_type: str | None = None
    evidence_segment_ids: list[str] = Field(default_factory=list)
    evidence_quote: str | None = None
    status: Literal["pending", "applied", "kept", "superseded"] = "pending"
    term_id: str | None = None
    auto_applicable: bool = False


class AppliedEdit(CamelModel):
    block_id: str
    source_segment_ids: list[str] = Field(default_factory=list)
    start_offset: int
    end_offset: int
    original: str
    replacement: str
    change_type: str
    reason: str = ""
    evidence_type: str | None = None


class Revision(CamelModel):
    id: str
    document_id: str
    parent_revision_id: str | None = None
    kind: Literal["original", "cleaned", "edited", "summary"]
    source_id: str | None = None
    blocks: list[Block]
    corrections: list[Correction] = Field(default_factory=list)
    applied_edits: list[AppliedEdit] = Field(default_factory=list)
    content_hash: str = ""
    pipeline_version: str = ""
    glossary_version: str = ""
    created_by: str = "system"
    created_at: str = ""


class RevisionSummary(CamelModel):
    id: str
    kind: str
    created_by: str
    created_at: str
    parent_revision_id: str | None = None
    block_count: int = 0
    pending_count: int = 0


class Term(CamelModel):
    term_id: str
    entity_type: str = "term"
    canonical: str
    variants: list[str] = Field(default_factory=list)
    status: Literal["confirmed", "suggested", "disputed"] = "suggested"
    evidence_type: str = "context_only"
    evidence_segment_ids: list[str] = Field(default_factory=list)
    scope: dict[str, Any] = Field(default_factory=dict)
    confirmed_by: str | None = None


class Document(CamelModel):
    id: str
    video: VideoRef
    created_at: str
    updated_at: str
    original_revision_id: str | None = None
    latest_revision_id: str | None = None


# --------------------------------------------------------------------------- summary


class Citation(CamelModel):
    text: str
    segment_ids: list[str] = Field(default_factory=list)


class Chapter(CamelModel):
    title: str
    start_ms: int
    end_ms: int
    points: list[Citation] = Field(default_factory=list)
    editorial_title: bool = False


class Coverage(CamelModel):
    sources: list[str] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    uncertainties: list[str] = Field(default_factory=list)


class Summary(CamelModel):
    id: str
    document_id: str
    revision_id: str
    overview: str
    viewpoints: list[Citation] = Field(default_factory=list)
    chapters: list[Chapter] = Field(default_factory=list)
    conclusion: Citation | None = None
    key_numbers: list[Citation] = Field(default_factory=list)
    coverage: Coverage = Field(default_factory=Coverage)
    markdown: str = ""
    model: str = ""
    created_at: str = ""


class DocumentBundle(CamelModel):
    document: Document
    source: SourceInfo | None = None
    revisions: list[RevisionSummary] = Field(default_factory=list)
    terms: list[Term] = Field(default_factory=list)
    summary: Summary | None = None


# --------------------------------------------------------------------------- uploads / jobs


class UploadCreate(CamelModel):
    filename: str = "audio.m4a"
    size: int = Field(ge=0)
    sha256: str | None = None


class UploadSession(CamelModel):
    id: str
    filename: str
    size: int
    chunk_size: int
    max_bytes: int
    status: Literal["open", "complete"]
    received_chunks: list[int] = Field(default_factory=list)
    created_at: str


class UploadComplete(CamelModel):
    chunk_count: int = Field(ge=1)
    total_bytes: int = Field(ge=1)
    sha256: str


class JobProgress(CamelModel):
    completed: float = 0
    total: float | None = None
    unit: str = ""
    percent: float | None = None
    label: str = ""


class JobError(CamelModel):
    code: str
    message: str
    retryable: bool = False
    details: dict[str, Any] | None = None


JobType = Literal["transcribe", "clean", "summarize"]
JobStatus = Literal[
    "CREATED", "QUEUED", "RUNNING", "SUCCEEDED", "PARTIAL", "NEEDS_INPUT", "FAILED",
    "CANCEL_REQUESTED", "CANCELLED",
]


class Job(CamelModel):
    id: str
    type: JobType
    status: JobStatus
    stage: str = ""
    progress: JobProgress = Field(default_factory=JobProgress)
    video: VideoRef | None = None
    document_id: str | None = None
    revision_id: str | None = None
    input: dict[str, Any] = Field(default_factory=dict)
    result: dict[str, Any] | None = None
    error: JobError | None = None
    attempt: int = 0
    cancel_requested: bool = False
    created_at: str = ""
    updated_at: str = ""


class JobCreate(CamelModel):
    type: JobType
    video: VideoRef | None = None
    document_id: str | None = None
    revision_id: str | None = None
    upload_id: str | None = None
    options: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = None


# --------------------------------------------------------------------------- requests


class DocumentCreate(CamelModel):
    video: VideoRef
    source: SourceCreate
    options: dict[str, Any] = Field(default_factory=dict)


class RevisionCreate(CamelModel):
    parent_revision_id: str | None = None
    blocks: list[Block]
    created_by: str = "user"


class ManualCorrection(CamelModel):
    correction_id: str
    replacement: str


class CorrectionsApply(CamelModel):
    revision_id: str
    accepted_ids: list[str] = Field(default_factory=list)
    kept_ids: list[str] = Field(default_factory=list)
    manual_edits: list[ManualCorrection] = Field(default_factory=list)


class GlossaryEntry(CamelModel):
    canonical: str
    variants: list[str] = Field(default_factory=list)
    entity_type: str = "term"


class GlossaryUpdate(CamelModel):
    entries: list[GlossaryEntry] = Field(default_factory=list)


# --------------------------------------------------------------------------- capabilities / errors


class ProviderInfo(CamelModel):
    id: str
    label: str
    available: bool
    detail: str = ""


class AsrCapability(CamelModel):
    configured: bool
    default_provider: str
    providers: list[ProviderInfo] = Field(default_factory=list)
    max_duration_minutes: int = 120


class LlmCapability(CamelModel):
    configured: bool
    provider: str
    model: str
    json_mode: bool = True


class Limits(CamelModel):
    max_upload_bytes: int
    max_duration_minutes: int
    chunk_size: int
    retention_hours: int


class Capabilities(CamelModel):
    api_version: str
    app_version: str
    asr: AsrCapability
    llm: LlmCapability
    limits: Limits
    features: list[str] = Field(default_factory=list)


class ErrorBody(CamelModel):
    code: str
    message: str
    details: Any | None = None

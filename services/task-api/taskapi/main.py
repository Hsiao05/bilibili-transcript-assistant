"""FastAPI application implementing the v1 task protocol."""

from __future__ import annotations

import secrets
from typing import Any
from urllib.parse import quote

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import ValidationError

from . import API_VERSION, __version__
from .config import Settings, load_settings
from .pipeline.markdown import export_filename, render_document_markdown, source_label
from .pipeline.normalize import find_quote
from .providers.asr import build_asr_capabilities, default_asr_id, select_asr
from .providers.llm import build_llm
from .schemas import (
    AppliedEdit,
    AsrCapability,
    Block,
    Capabilities,
    CorrectionsApply,
    DocumentBundle,
    DocumentCreate,
    ErrorBody,
    GlossaryUpdate,
    Job,
    JobCreate,
    Limits,
    LlmCapability,
    ProviderInfo,
    Revision,
    RevisionCreate,
    Summary,
    UploadComplete,
    UploadCreate,
    UploadSession,
)
from .store import ConflictError, NotFoundError, Store


def create_app(settings: Settings | None = None, store: Store | None = None) -> FastAPI:
    settings = settings or load_settings()
    store = store or Store(settings)

    app = FastAPI(
        title="Bilibili Transcript Task API",
        version=__version__,
        docs_url="/docs",
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.store = store

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(chrome-extension://.*|moz-extension://.*|http://localhost:\d+|http://127\.0\.0\.1:\d+)$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Chunk-SHA256"],
        # The extension reads the server-generated filename from these response headers.
        expose_headers=["X-Export-Filename", "Content-Disposition"],
    )

    async def require_token(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> None:
        cfg: Settings = request.app.state.settings
        if cfg.auth_disabled:
            return
        expected = cfg.token
        provided = ""
        if authorization and authorization.lower().startswith("bearer "):
            provided = authorization[7:].strip()
        if not expected or not provided or not secrets.compare_digest(expected, provided):
            raise HTTPException(
                status_code=401,
                detail={"code": "unauthorized", "message": "任务服务访问令牌无效"},
            )

    def st(request: Request) -> Store:
        return request.app.state.store

    def cfg(request: Request) -> Settings:
        return request.app.state.settings

    @app.exception_handler(NotFoundError)
    async def _not_found(_request: Request, exc: NotFoundError) -> JSONResponse:
        return JSONResponse(
            status_code=404,
            content=ErrorBody(code="not_found", message=str(exc) or "资源不存在").model_dump(by_alias=True),
        )

    @app.exception_handler(ConflictError)
    async def _conflict(_request: Request, exc: ConflictError) -> JSONResponse:
        return JSONResponse(
            status_code=409,
            content=ErrorBody(code="conflict", message=str(exc)).model_dump(by_alias=True),
        )

    @app.exception_handler(ValueError)
    async def _value_error(_request: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(
            status_code=400,
            content=ErrorBody(code="invalid_request", message=str(exc)).model_dump(by_alias=True),
        )

    @app.exception_handler(ValidationError)
    async def _validation(_request: Request, exc: ValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=ErrorBody(code="validation_error", message="请求参数校验失败", details=exc.errors()).model_dump(
                by_alias=True
            ),
        )

    @app.exception_handler(HTTPException)
    async def _http_exc(_request: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail
        if isinstance(detail, dict) and "code" in detail:
            body = detail
        else:
            body = {"code": f"http_{exc.status_code}", "message": str(detail)}
        return JSONResponse(status_code=exc.status_code, content=body)

    # ------------------------------------------------------------------ health / capabilities

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "version": __version__, "apiVersion": API_VERSION}

    @app.get("/v1/capabilities", response_model=Capabilities, dependencies=[Depends(require_token)])
    async def capabilities(request: Request) -> Capabilities:
        config = cfg(request)
        asr_caps = build_asr_capabilities(config)
        default_id = default_asr_id(config)
        llm = build_llm(config)
        return Capabilities(
            api_version=API_VERSION,
            app_version=__version__,
            asr=AsrCapability(
                configured=any(c.available for c in asr_caps),
                default_provider=default_id,
                providers=[
                    ProviderInfo(id=c.id, label=c.label, available=c.available, detail=c.detail)
                    for c in asr_caps
                ],
                max_duration_minutes=config.max_duration_minutes,
            ),
            llm=LlmCapability(
                configured=not llm.is_heuristic,
                provider=llm.provider_id,
                model=llm.model,
                json_mode=not llm.is_heuristic,
            ),
            limits=Limits(
                max_upload_bytes=config.max_upload_bytes,
                max_duration_minutes=config.max_duration_minutes,
                chunk_size=config.chunk_size,
                retention_hours=config.retention_hours,
            ),
            features=[
                "bilibili_subtitles",
                "audio_upload",
                "asr",
                "term_discovery",
                "clean",
                "consistency_check",
                "summary",
                "markdown_export",
                "glossary",
                "manual_edit",
            ],
        )

    # ------------------------------------------------------------------ documents

    @app.post(
        "/v1/documents",
        response_model=DocumentBundle,
        status_code=201,
        dependencies=[Depends(require_token)],
    )
    async def create_document(payload: DocumentCreate, request: Request) -> DocumentBundle:
        ids = [segment.id for segment in payload.source.segments]
        if len(set(ids)) != len(ids):
            raise ValueError("source segment ids must be unique")
        document, _source_id, _revision_id = st(request).create_document(payload)
        return st(request).get_bundle(document.id)

    @app.get("/v1/documents", response_model=DocumentBundle, dependencies=[Depends(require_token)])
    async def find_document(
        request: Request,
        bvid: str = Query(...),
        cid: str = Query(...),
        page: int = Query(1, ge=1),
    ) -> DocumentBundle:
        document = st(request).find_document(bvid, cid, page)
        if not document:
            raise NotFoundError("document not found")
        return st(request).get_bundle(document.id)

    @app.get("/v1/documents/{document_id}", response_model=DocumentBundle, dependencies=[Depends(require_token)])
    async def get_document(document_id: str, request: Request) -> DocumentBundle:
        return st(request).get_bundle(document_id)

    @app.delete("/v1/documents/{document_id}", dependencies=[Depends(require_token)])
    async def delete_document(document_id: str, request: Request) -> dict[str, Any]:
        return st(request).delete_document(document_id)

    @app.get(
        "/v1/documents/{document_id}/revisions/{revision_id}",
        response_model=Revision,
        dependencies=[Depends(require_token)],
    )
    async def get_revision(document_id: str, revision_id: str, request: Request) -> Revision:
        revision = st(request).get_revision(revision_id)
        if not revision or revision.document_id != document_id:
            raise NotFoundError("revision not found")
        return revision

    @app.post(
        "/v1/documents/{document_id}/revisions",
        response_model=Revision,
        status_code=201,
        dependencies=[Depends(require_token)],
    )
    async def create_manual_revision(
        document_id: str, payload: RevisionCreate, request: Request
    ) -> Revision:
        document = st(request).get_document(document_id)
        if not document:
            raise NotFoundError("document not found")
        parent = payload.parent_revision_id or document.latest_revision_id
        if not parent:
            raise ValueError("missing parent revision")
        base = st(request).get_revision(parent)
        if not base:
            raise NotFoundError("parent revision not found")
        if not payload.blocks:
            raise ValueError("blocks must not be empty")
        block_ids = [block.id for block in payload.blocks]
        if len(set(block_ids)) != len(block_ids):
            raise ValueError("block ids must be unique")
        return st(request).create_revision(
            document_id=document_id,
            parent_id=parent,
            kind="edited",
            source_id=base.source_id,
            blocks=payload.blocks,
            corrections=[],
            applied_edits=[],
            pipeline_version="manual-edit-v1",
            glossary_version=base.glossary_version,
            created_by=payload.created_by or "user",
        )

    @app.post(
        "/v1/documents/{document_id}/corrections/apply",
        response_model=Revision,
        status_code=201,
        dependencies=[Depends(require_token)],
    )
    async def apply_corrections(
        document_id: str, payload: CorrectionsApply, request: Request
    ) -> Revision:
        document = st(request).get_document(document_id)
        if not document:
            raise NotFoundError("document not found")
        revision = st(request).get_revision(payload.revision_id)
        if not revision or revision.document_id != document_id:
            raise NotFoundError("revision not found")
        accepted = set(payload.accepted_ids)
        kept = set(payload.kept_ids)
        if not accepted and not kept:
            raise ValueError("no corrections selected")
        pending = {correction.id: correction for correction in revision.corrections if correction.status == "pending"}
        selected = [pending[cid] for cid in accepted if cid in pending]
        for cid in accepted | kept:
            if cid not in pending:
                raise ConflictError(f"correction {cid} is not pending on this revision")
        blocks = {block.id: block for block in revision.blocks}
        by_block: dict[str, list] = {}
        for correction in selected:
            if correction.block_id not in blocks:
                raise ConflictError(f"correction {correction.id} target block is missing")
            by_block.setdefault(correction.block_id, []).append(correction)
        for block_id, corrections in by_block.items():
            text = blocks[block_id].text
            seen: set[tuple[int, int]] = set()
            for correction in sorted(corrections, key=lambda c: c.start_offset, reverse=True):
                key = (correction.start_offset, correction.end_offset)
                if key in seen or correction.end_offset > len(text):
                    raise ConflictError(f"correction {correction.id} has invalid offsets")
                seen.add(key)
                if text[correction.start_offset : correction.end_offset] != correction.original:
                    raise ConflictError(f"correction {correction.id} no longer matches the text")
                if correction.replacement is None:
                    continue
                text = text[: correction.start_offset] + correction.replacement + text[correction.end_offset :]
            blocks[block_id].text = text
        if not selected:
            # "keep all" still creates a reviewed revision without edits.
            pass
        return st(request).create_revision(
            document_id=document_id,
            parent_id=revision.id,
            kind="edited",
            source_id=revision.source_id,
            blocks=list(blocks.values()),
            corrections=[],
            applied_edits=revision.applied_edits + [
                AppliedEdit(
                    block_id=c.block_id,
                    source_segment_ids=c.source_segment_ids,
                    start_offset=c.start_offset,
                    end_offset=c.end_offset,
                    original=c.original,
                    replacement=c.replacement or c.original,
                    change_type=c.change_type,
                    reason="用户确认：" + c.reason,
                    evidence_type=c.evidence_type,
                )
                for c in selected
            ],
            pipeline_version="manual-edit-v1",
            glossary_version=revision.glossary_version,
            created_by="user",
        )

    @app.get(
        "/v1/documents/{document_id}/summaries/latest",
        response_model=Summary,
        dependencies=[Depends(require_token)],
    )
    async def latest_summary(
        document_id: str,
        request: Request,
        revision_id: str | None = Query(default=None),
    ) -> Summary:
        summary = st(request).get_summary(document_id, revision_id)
        if not summary:
            raise NotFoundError("summary not found")
        return summary

    @app.get("/v1/documents/{document_id}/export", dependencies=[Depends(require_token)])
    async def export_document(
        document_id: str,
        request: Request,
        revision_id: str | None = Query(default=None),
        format: str = Query(default="md"),
        include_timestamps: bool = Query(default=True, alias="includeTimestamps"),
        include_summary: bool = Query(default=True, alias="includeSummary"),
        include_terms: bool = Query(default=True, alias="includeTerms"),
    ) -> Response:
        bundle = st(request).get_bundle(document_id)
        revision = None
        if revision_id:
            revision = st(request).get_revision(revision_id)
            if revision and revision.document_id != document_id:
                revision = None
        if revision is None and bundle.document.latest_revision_id:
            revision = st(request).get_revision(bundle.document.latest_revision_id)
        if revision is None:
            raise NotFoundError("revision not found")
        summary = st(request).get_summary(document_id, revision.id)
        if summary is None and bundle.summary and bundle.summary.revision_id == revision.id:
            summary = bundle.summary
        if format == "json":
            payload = {
                "document": bundle.document.model_dump(by_alias=True),
                "revision": revision.model_dump(by_alias=True),
                "summary": summary.model_dump(by_alias=True) if summary else None,
                "terms": [t.model_dump(by_alias=True) for t in bundle.terms],
            }
            return JSONResponse(payload)
        source = st(request).get_source(revision.source_id) if revision.source_id else None
        markdown = render_document_markdown(
            bundle.document.video,
            revision,
            source["type"] if source else None,
            summary,
            bundle.terms,
            {
                "includeTimestamps": include_timestamps,
                "includeSummary": include_summary,
                "includeTerms": include_terms,
                "notes": [],
            },
        )
        filename = export_filename(bundle.document.video, revision)
        return PlainTextResponse(
            markdown,
            media_type="text/markdown; charset=utf-8",
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
                "X-Export-Filename": quote(filename),
            },
        )

    # ------------------------------------------------------------------ glossary

    @app.get("/v1/glossary", dependencies=[Depends(require_token)])
    async def get_glossary(request: Request) -> dict[str, Any]:
        return {"entries": st(request).get_glossary()}

    @app.put("/v1/glossary", dependencies=[Depends(require_token)])
    async def put_glossary(payload: GlossaryUpdate, request: Request) -> dict[str, Any]:
        entries = [
            {
                "canonical": entry.canonical.strip(),
                "variants": [v.strip() for v in entry.variants if v.strip()],
                "entityType": entry.entity_type,
            }
            for entry in payload.entries
            if entry.canonical.strip()
        ]
        st(request).set_glossary(entries)
        return {"entries": entries}

    # ------------------------------------------------------------------ uploads

    @app.post(
        "/v1/uploads",
        response_model=UploadSession,
        status_code=201,
        dependencies=[Depends(require_token)],
    )
    async def create_upload(payload: UploadCreate, request: Request) -> UploadSession:
        if payload.size <= 0:
            raise ValueError("upload size must be greater than zero")
        return st(request).create_upload(payload.filename, payload.size, payload.sha256)

    @app.get("/v1/uploads/{upload_id}", response_model=UploadSession, dependencies=[Depends(require_token)])
    async def get_upload(upload_id: str, request: Request) -> UploadSession:
        upload = st(request).get_upload(upload_id)
        if not upload:
            raise NotFoundError("upload not found")
        return upload

    @app.put(
        "/v1/uploads/{upload_id}/chunks/{index}",
        response_model=UploadSession,
        dependencies=[Depends(require_token)],
    )
    async def put_chunk(
        upload_id: str,
        index: int,
        request: Request,
        x_chunk_sha256: str | None = Header(default=None),
    ) -> UploadSession:
        content_length = request.headers.get("content-length")
        max_chunk = cfg(request).chunk_size
        if content_length and int(content_length) > max_chunk:
            raise ValueError("chunk exceeds configured chunk size")
        data = await request.body()
        if len(data) > max_chunk:
            raise ValueError("chunk exceeds configured chunk size")
        return st(request).put_chunk(upload_id, index, data, x_chunk_sha256)

    @app.post(
        "/v1/uploads/{upload_id}/complete",
        response_model=UploadSession,
        dependencies=[Depends(require_token)],
    )
    async def complete_upload(upload_id: str, payload: UploadComplete, request: Request) -> UploadSession:
        return st(request).complete_upload(upload_id, payload.chunk_count, payload.total_bytes, payload.sha256)

    # ------------------------------------------------------------------ jobs

    @app.post("/v1/jobs", response_model=Job, status_code=201, dependencies=[Depends(require_token)])
    async def create_job(payload: JobCreate, request: Request) -> Job:
        if payload.type == "transcribe":
            if not payload.upload_id:
                raise ValueError("transcribe job requires uploadId")
            if not payload.video:
                raise ValueError("transcribe job requires video")
            upload = st(request).get_upload(payload.upload_id)
            if not upload:
                raise NotFoundError("upload not found")
            if upload.status != "complete":
                raise ConflictError("upload is not complete")
        if payload.type in ("clean", "summarize"):
            if not payload.document_id:
                raise ValueError(f"{payload.type} job requires documentId")
            document = st(request).get_document(payload.document_id)
            if not document:
                raise NotFoundError("document not found")
            if payload.type == "clean":
                revision_id = payload.revision_id or document.original_revision_id
                if not revision_id or not st(request).get_revision(revision_id):
                    raise NotFoundError("base revision not found")
        return st(request).create_job(payload)

    @app.get("/v1/jobs/{job_id}", response_model=Job, dependencies=[Depends(require_token)])
    async def get_job(job_id: str, request: Request) -> Job:
        job = st(request).get_job(job_id)
        if not job:
            raise NotFoundError("job not found")
        return job

    @app.post("/v1/jobs/{job_id}/cancel", response_model=Job, dependencies=[Depends(require_token)])
    async def cancel_job(job_id: str, request: Request) -> Job:
        return st(request).cancel_job(job_id)

    @app.get("/v1/jobs", response_model=list[Job], dependencies=[Depends(require_token)])
    async def list_jobs(
        request: Request,
        document_id: str | None = Query(default=None, alias="documentId"),
        limit: int = Query(20, ge=1, le=100),
    ) -> list[Job]:
        return st(request).list_jobs(document_id, limit)

    return app

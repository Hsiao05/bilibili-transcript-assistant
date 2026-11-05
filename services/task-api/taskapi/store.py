"""Persistence layer: documents, revisions, uploads and the job queue."""

from __future__ import annotations

import bisect
import json
import sqlite3
from pathlib import Path
from typing import Any

from .config import Settings
from .db import connect, init_db
from .schemas import (
    AppliedEdit,
    Block,
    Chapter,
    Citation,
    Coverage,
    Correction,
    Document,
    DocumentBundle,
    DocumentCreate,
    Job,
    JobCreate,
    JobError,
    JobProgress,
    Revision,
    RevisionSummary,
    SourceInfo,
    Summary,
    Term,
    UploadSession,
    VideoRef,
)
from .util import (
    canonical_json,
    future_iso,
    iso,
    new_id,
    now_utc,
    parse_iso,
    sha256_file,
    sha256_json,
    sha256_text,
)


class ConflictError(Exception):
    """Raised when an optimistic/concurrency check fails."""


class NotFoundError(Exception):
    pass


class Store:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.settings.ensure_dirs()
        init_db(settings.db_path)

    # ------------------------------------------------------------------ documents

    def create_document(self, payload: DocumentCreate) -> tuple[Document, str, str]:
        video = payload.video
        source = payload.source
        doc_id = new_id("doc")
        source_id = new_id("src")
        revision_id = new_id("rev")
        now = iso()

        segments = [seg.model_dump(by_alias=True) for seg in source.segments]
        content_hash = source.content_hash or sha256_json(
            {"type": source.type, "language": source.language, "segments": segments}
        )

        blocks: list[Block] = []
        for index, seg in enumerate(source.segments, start=1):
            blocks.append(
                Block(
                    id=f"block_{index:04d}",
                    source_segment_ids=[seg.id],
                    text=seg.text,
                    start_ms=seg.start_ms,
                    end_ms=seg.end_ms,
                )
            )
        blocks_json = [b.model_dump(by_alias=True) for b in blocks]
        block_hash = sha256_json(blocks_json)

        with connect(self.settings.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(
                """
                INSERT INTO documents (id, bvid, cid, page, video_json, created_at, updated_at,
                                       original_revision_id, latest_revision_id, deleted)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                """,
                (doc_id, video.bvid, video.cid, video.page, video.model_dump_json(by_alias=True),
                 now, now, revision_id, revision_id),
            )
            conn.execute(
                """
                INSERT INTO sources (id, document_id, type, track_id, language, content_hash,
                                     segments_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (source_id, doc_id, source.type, source.track_id, source.language, content_hash,
                 json.dumps(segments, ensure_ascii=False), now),
            )
            conn.execute(
                """
                INSERT INTO revisions (id, document_id, parent_id, kind, source_id, blocks_json,
                                       corrections_json, edits_json, content_hash, pipeline_version,
                                       glossary_version, created_by, created_at)
                VALUES (?, ?, NULL, 'original', ?, ?, '[]', '[]', ?, 'original-v1', '', 'source', ?)
                """,
                (revision_id, doc_id, source_id, json.dumps(blocks_json, ensure_ascii=False),
                 block_hash, now),
            )
            conn.commit()

        document = Document(
            id=doc_id,
            video=video,
            created_at=now,
            updated_at=now,
            original_revision_id=revision_id,
            latest_revision_id=revision_id,
        )
        return document, source_id, revision_id

    def get_document(self, doc_id: str) -> Document | None:
        with connect(self.settings.db_path) as conn:
            row = conn.execute(
                "SELECT * FROM documents WHERE id = ? AND deleted = 0", (doc_id,)
            ).fetchone()
        return self._document(row) if row else None

    def find_document(self, bvid: str, cid: str, page: int) -> Document | None:
        with connect(self.settings.db_path) as conn:
            row = conn.execute(
                """
                SELECT * FROM documents
                WHERE bvid = ? AND cid = ? AND page = ? AND deleted = 0
                ORDER BY created_at DESC LIMIT 1
                """,
                (bvid, cid, page),
            ).fetchone()
        return self._document(row) if row else None

    def list_documents(self, limit: int = 50) -> list[Document]:
        with connect(self.settings.db_path) as conn:
            rows = conn.execute(
                "SELECT * FROM documents WHERE deleted = 0 ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [self._document(row) for row in rows]

    def delete_document(self, doc_id: str) -> dict[str, Any]:
        with connect(self.settings.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            doc = conn.execute(
                "SELECT id FROM documents WHERE id = ? AND deleted = 0", (doc_id,)
            ).fetchone()
            if not doc:
                conn.rollback()
                raise NotFoundError("document not found")
            counts = {}
            for table in ("revisions", "terms", "summaries", "sources"):
                cur = conn.execute(f"DELETE FROM {table} WHERE document_id = ?", (doc_id,))
                counts[table] = cur.rowcount
            conn.execute(
                "UPDATE jobs SET document_id = NULL WHERE document_id = ?", (doc_id,)
            )
            conn.execute("UPDATE documents SET deleted = 1, updated_at = ? WHERE id = ?", (iso(), doc_id))
            conn.commit()
        return {"deleted": True, "documentId": doc_id, "removed": counts, "mediaKept": True}

    def get_bundle(self, doc_id: str) -> DocumentBundle:
        document = self.get_document(doc_id)
        if not document:
            raise NotFoundError("document not found")
        with connect(self.settings.db_path) as conn:
            source_row = conn.execute(
                "SELECT * FROM sources WHERE document_id = ? ORDER BY created_at LIMIT 1", (doc_id,)
            ).fetchone()
            rev_rows = conn.execute(
                "SELECT * FROM revisions WHERE document_id = ? ORDER BY created_at", (doc_id,)
            ).fetchall()
            term_rows = conn.execute(
                "SELECT * FROM terms WHERE document_id = ? ORDER BY created_at", (doc_id,)
            ).fetchall()
            summary_row = conn.execute(
                "SELECT * FROM summaries WHERE document_id = ? ORDER BY created_at DESC LIMIT 1",
                (doc_id,),
            ).fetchone()

        source_info = self._source_info(source_row) if source_row else None
        summaries = [self._revision_summary(row) for row in rev_rows]
        terms = [Term.model_validate_json(row["term_json"]) for row in term_rows]
        summary = self._summary(summary_row) if summary_row else None
        return DocumentBundle(
            document=document,
            source=source_info,
            revisions=summaries,
            terms=terms,
            summary=summary,
        )

    # ------------------------------------------------------------------ revisions

    def get_revision(self, revision_id: str) -> Revision | None:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT * FROM revisions WHERE id = ?", (revision_id,)).fetchone()
        return self._revision(row) if row else None

    def get_source(self, source_id: str) -> dict[str, Any] | None:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "documentId": row["document_id"],
            "type": row["type"],
            "trackId": row["track_id"],
            "language": row["language"],
            "contentHash": row["content_hash"],
            "segments": json.loads(row["segments_json"]),
            "createdAt": row["created_at"],
        }

    def create_revision(
        self,
        document_id: str,
        parent_id: str | None,
        kind: str,
        source_id: str | None,
        blocks: list[Block],
        corrections: list[Correction] | None = None,
        applied_edits: list[AppliedEdit] | None = None,
        pipeline_version: str = "clean-v1",
        glossary_version: str = "",
        created_by: str = "system",
    ) -> Revision:
        revision_id = new_id("rev")
        now = iso()
        blocks_json = [b.model_dump(by_alias=True) for b in blocks]
        corrections_json = [c.model_dump(by_alias=True) for c in (corrections or [])]
        edits_json = [e.model_dump(by_alias=True) for e in (applied_edits or [])]
        content_hash = sha256_json(blocks_json)
        with connect(self.settings.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            doc = conn.execute(
                "SELECT id FROM documents WHERE id = ? AND deleted = 0", (document_id,)
            ).fetchone()
            if not doc:
                conn.rollback()
                raise NotFoundError("document not found")
            conn.execute(
                """
                INSERT INTO revisions (id, document_id, parent_id, kind, source_id, blocks_json,
                                       corrections_json, edits_json, content_hash, pipeline_version,
                                       glossary_version, created_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (revision_id, document_id, parent_id, kind, source_id,
                 json.dumps(blocks_json, ensure_ascii=False),
                 json.dumps(corrections_json, ensure_ascii=False),
                 json.dumps(edits_json, ensure_ascii=False),
                 content_hash, pipeline_version, glossary_version, created_by, now),
            )
            conn.execute(
                "UPDATE documents SET latest_revision_id = ?, updated_at = ? WHERE id = ?",
                (revision_id, now, document_id),
            )
            conn.commit()

        revision = self.get_revision(revision_id)
        assert revision is not None
        return revision

    def list_revisions(self, document_id: str) -> list[Revision]:
        with connect(self.settings.db_path) as conn:
            rows = conn.execute(
                "SELECT * FROM revisions WHERE document_id = ? ORDER BY created_at", (document_id,)
            ).fetchall()
        return [self._revision(row) for row in rows]

    # ------------------------------------------------------------------ terms / glossary

    def replace_terms(self, document_id: str, terms: list[Term]) -> None:
        with connect(self.settings.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM terms WHERE document_id = ?", (document_id,))
            now = iso()
            for term in terms:
                conn.execute(
                    "INSERT INTO terms (id, document_id, term_json, created_at) VALUES (?, ?, ?, ?)",
                    (term.term_id, document_id, term.model_dump_json(by_alias=True), now),
                )
            conn.commit()

    def get_glossary(self) -> list[dict[str, Any]]:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT value FROM meta WHERE key = 'glossary'").fetchone()
        if not row:
            return []
        try:
            data = json.loads(row["value"])
            return data if isinstance(data, list) else []
        except json.JSONDecodeError:
            return []

    def set_glossary(self, entries: list[dict[str, Any]]) -> None:
        with connect(self.settings.db_path) as conn:
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('glossary', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (canonical_json(entries),),
            )
            conn.commit()

    # ------------------------------------------------------------------ summaries

    def save_summary(self, summary: Summary) -> Summary:
        with connect(self.settings.db_path) as conn:
            conn.execute(
                "INSERT INTO summaries (id, document_id, revision_id, summary_json, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (summary.id, summary.document_id, summary.revision_id,
                 summary.model_dump_json(by_alias=True), summary.created_at),
            )
            conn.execute(
                "UPDATE documents SET updated_at = ? WHERE id = ?", (iso(), summary.document_id)
            )
            conn.commit()
        return summary

    def get_summary(self, document_id: str, revision_id: str | None = None) -> Summary | None:
        query = "SELECT * FROM summaries WHERE document_id = ?"
        params: list[Any] = [document_id]
        if revision_id:
            query += " AND revision_id = ?"
            params.append(revision_id)
        query += " ORDER BY created_at DESC LIMIT 1"
        with connect(self.settings.db_path) as conn:
            row = conn.execute(query, params).fetchone()
        return self._summary(row) if row else None

    # ------------------------------------------------------------------ uploads

    def create_upload(self, filename: str, size: int, sha256: str | None) -> UploadSession:
        if size > self.settings.max_upload_bytes:
            raise ValueError("file exceeds max upload size")
        upload_id = new_id("upl")
        now = iso()
        with connect(self.settings.db_path) as conn:
            conn.execute(
                "INSERT INTO uploads (id, filename, size, chunk_size, received_json, status, sha256, created_at) "
                "VALUES (?, ?, ?, ?, '[]', 'open', ?, ?)",
                (upload_id, filename, size, self.settings.chunk_size, sha256, now),
            )
            conn.commit()
        (self.settings.uploads_dir / upload_id).mkdir(parents=True, exist_ok=True)
        return UploadSession(
            id=upload_id, filename=filename, size=size, chunk_size=self.settings.chunk_size,
            max_bytes=self.settings.max_upload_bytes, status="open", received_chunks=[], created_at=now,
        )

    def get_upload(self, upload_id: str) -> UploadSession | None:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
        return self._upload(row) if row else None

    def put_chunk(self, upload_id: str, index: int, data: bytes, declared_sha: str | None) -> UploadSession:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
            if not row:
                raise NotFoundError("upload not found")
            if row["status"] != "open":
                raise ConflictError("upload already completed")
            chunk_size = int(row["chunk_size"])
            size = int(row["size"])
            max_chunks = max(1, (size + chunk_size - 1) // chunk_size)
            if index < 0 or index >= max_chunks:
                raise ValueError(f"chunk index out of range 0..{max_chunks - 1}")
            expected_len = chunk_size if index < max_chunks - 1 else size - chunk_size * (max_chunks - 1)
            if index == max_chunks - 1 and expected_len == 0:
                expected_len = chunk_size
            if len(data) != expected_len:
                raise ValueError(f"chunk length mismatch: expected {expected_len}, got {len(data)}")
            digest = sha256_text_bytes(data)
            if declared_sha and declared_sha.lower() != digest:
                raise ValueError("chunk sha256 mismatch")
            received = json.loads(row["received_json"] or "[]")
            existing = next((item for item in received if int(item["index"]) == index), None)
            if existing:
                if int(existing.get("bytes", -1)) != len(data) or existing.get("sha256") != digest:
                    raise ConflictError("chunk already uploaded with different content")
                return self._upload(row)
            chunk_path = self.settings.uploads_dir / upload_id / f"{index:06d}.part"
            chunk_path.write_bytes(data)
            received.append({"index": index, "bytes": len(data), "sha256": digest})
            received.sort(key=lambda item: int(item["index"]))
            conn.execute(
                "UPDATE uploads SET received_json = ? WHERE id = ?",
                (json.dumps(received), upload_id),
            )
            conn.commit()
            updated = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
        return self._upload(updated)

    def complete_upload(self, upload_id: str, chunk_count: int, total_bytes: int, sha256: str) -> UploadSession:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
            if not row:
                raise NotFoundError("upload not found")
            if row["status"] == "complete":
                return self._upload(row)
            received = json.loads(row["received_json"] or "[]")
            indexes = sorted(int(item["index"]) for item in received)
            if indexes != list(range(chunk_count)):
                missing = sorted(set(range(chunk_count)) - set(indexes))
                raise ConflictError(f"missing chunks: {missing[:10]}")
            if sum(int(item["bytes"]) for item in received) != total_bytes:
                raise ConflictError("total bytes mismatch")
            if total_bytes != int(row["size"]):
                raise ConflictError("size does not match upload session")

        target = self.settings.media_dir / f"{sha256}.bin"
        if not target.exists():
            tmp = self.settings.media_dir / f".{upload_id}.assembling"
            with open(tmp, "wb") as out:
                for index in range(chunk_count):
                    out.write((self.settings.uploads_dir / upload_id / f"{index:06d}.part").read_bytes())
            actual = sha256_file(tmp)
            if actual != sha256:
                tmp.unlink(missing_ok=True)
                raise ConflictError(f"file sha256 mismatch: expected {sha256}, got {actual}")
            tmp.replace(target)
        with connect(self.settings.db_path) as conn:
            conn.execute(
                "UPDATE uploads SET status = 'complete', media_path = ?, sha256 = ? WHERE id = ?",
                (str(target), sha256, upload_id),
            )
            conn.commit()
            updated = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
        return self._upload(updated)

    def get_media_path(self, upload_id: str) -> Path:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT * FROM uploads WHERE id = ?", (upload_id,)).fetchone()
        if not row or row["status"] != "complete" or not row["media_path"]:
            raise ConflictError("upload is not complete")
        path = Path(row["media_path"])
        if not path.exists():
            raise ConflictError("media file is missing")
        return path

    # ------------------------------------------------------------------ jobs

    def create_job(self, payload: JobCreate) -> Job:
        if payload.idempotency_key:
            with connect(self.settings.db_path) as conn:
                row = conn.execute(
                    "SELECT * FROM jobs WHERE idempotency_key = ?", (payload.idempotency_key,)
                ).fetchone()
            if row:
                return self._job(row)
        job_id = new_id("job")
        now = iso()
        input_data = {
            "type": payload.type,
            "video": payload.video.model_dump(by_alias=True) if payload.video else None,
            "documentId": payload.document_id,
            "revisionId": payload.revision_id,
            "uploadId": payload.upload_id,
            "options": payload.options,
        }
        with connect(self.settings.db_path) as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO jobs (id, type, status, stage, progress_json, video_json,
                                      document_id, revision_id, input_json, idempotency_key,
                                      attempt, cancel_requested, created_at, updated_at)
                    VALUES (?, ?, 'QUEUED', 'queued', '{}', ?, ?, ?, ?, ?, 0, 0, ?, ?)
                    """,
                    (job_id, payload.type,
                     payload.video.model_dump_json(by_alias=True) if payload.video else None,
                     payload.document_id, payload.revision_id,
                     json.dumps(input_data, ensure_ascii=False), payload.idempotency_key, now, now),
                )
                conn.commit()
            except sqlite3.IntegrityError:
                # Concurrent duplicate: return the winner.
                row = conn.execute(
                    "SELECT * FROM jobs WHERE idempotency_key = ?", (payload.idempotency_key,)
                ).fetchone()
                if row:
                    return self._job(row)
                raise
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._job(row)

    def get_job(self, job_id: str) -> Job | None:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._job(row) if row else None

    def list_jobs(self, document_id: str | None = None, limit: int = 30) -> list[Job]:
        with connect(self.settings.db_path) as conn:
            if document_id:
                rows = conn.execute(
                    "SELECT * FROM jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT ?",
                    (document_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
                ).fetchall()
        return [self._job(row) for row in rows]

    def claim_job(self, worker_id: str, lease_seconds: int) -> Job | None:
        now = now_utc()
        with connect(self.settings.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                while True:
                    row = conn.execute(
                        """
                        SELECT * FROM jobs
                        WHERE status = 'QUEUED' AND (lease_expires_at IS NULL OR lease_expires_at < ?)
                        ORDER BY created_at LIMIT 1
                        """,
                        (iso(now),),
                    ).fetchone()
                    if not row:
                        conn.commit()
                        return None
                    if row["cancel_requested"]:
                        conn.execute(
                            "UPDATE jobs SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
                            (iso(), row["id"]),
                        )
                        continue
                    conn.execute(
                        """
                        UPDATE jobs SET status = 'RUNNING', stage = 'starting', lease_owner = ?,
                                        lease_expires_at = ?, attempt = attempt + 1, updated_at = ?
                        WHERE id = ? AND status = 'QUEUED'
                        """,
                        (worker_id, future_iso(lease_seconds), iso(), row["id"]),
                    )
                    claimed = conn.execute(
                        "SELECT * FROM jobs WHERE id = ?", (row["id"],)
                    ).fetchone()
                    conn.commit()
                    return self._job(claimed)
            except Exception:
                conn.rollback()
                raise

    def renew_lease(self, job_id: str, worker_id: str, lease_seconds: int) -> bool:
        with connect(self.settings.db_path) as conn:
            cur = conn.execute(
                """
                UPDATE jobs SET lease_expires_at = ?, updated_at = ?
                WHERE id = ? AND lease_owner = ? AND status IN ('RUNNING', 'CANCEL_REQUESTED')
                """,
                (future_iso(lease_seconds), iso(), job_id, worker_id),
            )
            conn.commit()
            return cur.rowcount > 0

    def update_job_progress(
        self, job_id: str, worker_id: str, stage: str, progress: JobProgress,
    ) -> None:
        with connect(self.settings.db_path) as conn:
            conn.execute(
                """
                UPDATE jobs SET stage = ?, progress_json = ?, updated_at = ?
                WHERE id = ? AND lease_owner = ?
                """,
                (stage, progress.model_dump_json(by_alias=True), iso(), job_id, worker_id),
            )
            conn.commit()

    def finish_job(
        self,
        job_id: str,
        worker_id: str,
        result: dict[str, Any],
        document_id: str | None = None,
        revision_id: str | None = None,
        status: str = "SUCCEEDED",
    ) -> bool:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row or row["lease_owner"] != worker_id:
                return False
            final_status = "CANCELLED" if row["cancel_requested"] else status
            conn.execute(
                """
                UPDATE jobs SET status = ?, result_json = ?, document_id = COALESCE(?, document_id),
                                revision_id = COALESCE(?, revision_id), lease_owner = NULL,
                                lease_expires_at = NULL, stage = 'done', updated_at = ?
                WHERE id = ?
                """,
                (final_status, json.dumps(result, ensure_ascii=False), document_id, revision_id,
                 iso(), job_id),
            )
            conn.commit()
        return True

    def fail_job(self, job_id: str, worker_id: str, error: JobError, retryable: bool) -> bool:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row or row["lease_owner"] != worker_id:
                return False
            status = "FAILED"
            if retryable and row["attempt"] < self.settings.max_attempts:
                status = "QUEUED"
            conn.execute(
                """
                UPDATE jobs SET status = ?, error_json = ?, lease_owner = NULL, lease_expires_at = NULL,
                                updated_at = ?
                WHERE id = ?
                """,
                (status, error.model_dump_json(by_alias=True), iso(), job_id),
            )
            conn.commit()
        return True

    def set_needs_input(self, job_id: str, worker_id: str, error: JobError) -> bool:
        with connect(self.settings.db_path) as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row or row["lease_owner"] != worker_id:
                return False
            conn.execute(
                """
                UPDATE jobs SET status = 'NEEDS_INPUT', error_json = ?, lease_owner = NULL,
                                lease_expires_at = NULL, updated_at = ?
                WHERE id = ?
                """,
                (error.model_dump_json(by_alias=True), iso(), job_id),
            )
            conn.commit()
        return True

    def cancel_job(self, job_id: str) -> Job:
        with connect(self.settings.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
            if not row:
                conn.rollback()
                raise NotFoundError("job not found")
            if row["status"] in ("SUCCEEDED", "FAILED", "CANCELLED", "PARTIAL"):
                conn.commit()
                return self._job(row)
            if row["status"] in ("QUEUED", "CREATED"):
                conn.execute(
                    "UPDATE jobs SET status = 'CANCELLED', cancel_requested = 1, updated_at = ? WHERE id = ?",
                    (iso(), job_id),
                )
            else:
                conn.execute(
                    "UPDATE jobs SET status = 'CANCEL_REQUESTED', cancel_requested = 1, updated_at = ? WHERE id = ?",
                    (iso(), job_id),
                )
            conn.commit()
            updated = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return self._job(updated)

    def is_cancel_requested(self, job_id: str) -> bool:
        with connect(self.settings.db_path) as conn:
            row = conn.execute(
                "SELECT cancel_requested, status FROM jobs WHERE id = ?", (job_id,)
            ).fetchone()
        return bool(row and (row["cancel_requested"] or row["status"] == "CANCEL_REQUESTED"))

    def recover_expired_jobs(self) -> int:
        """Return expired RUNNING jobs to the queue, or fail them after max attempts."""
        now = iso()
        with connect(self.settings.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                """
                SELECT * FROM jobs
                WHERE status IN ('RUNNING', 'CANCEL_REQUESTED')
                  AND (lease_expires_at IS NULL OR lease_expires_at < ?)
                """,
                (now,),
            ).fetchall()
            for row in rows:
                if row["cancel_requested"]:
                    conn.execute(
                        "UPDATE jobs SET status = 'CANCELLED', lease_owner = NULL, updated_at = ? WHERE id = ?",
                        (now, row["id"]),
                    )
                elif row["attempt"] >= self.settings.max_attempts:
                    error = JobError(
                        code="worker_lost",
                        message="处理进程中断且已超过重试上限",
                        retryable=False,
                    )
                    conn.execute(
                        """
                        UPDATE jobs SET status = 'FAILED', error_json = ?, lease_owner = NULL,
                                        lease_expires_at = NULL, updated_at = ? WHERE id = ?
                        """,
                        (error.model_dump_json(by_alias=True), now, row["id"]),
                    )
                else:
                    conn.execute(
                        """
                        UPDATE jobs SET status = 'QUEUED', lease_owner = NULL,
                                        lease_expires_at = NULL, updated_at = ? WHERE id = ?
                        """,
                        (now, row["id"]),
                    )
            conn.commit()
        return len(rows)

    # ------------------------------------------------------------------ row helpers

    @staticmethod
    def _document(row: sqlite3.Row) -> Document:
        return Document(
            id=row["id"],
            video=VideoRef.model_validate_json(row["video_json"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            original_revision_id=row["original_revision_id"],
            latest_revision_id=row["latest_revision_id"],
        )

    @staticmethod
    def _source_info(row: sqlite3.Row) -> SourceInfo:
        segments = json.loads(row["segments_json"])
        starts = [int(s["startMs"]) for s in segments] or [0]
        ends = [int(s["endMs"]) for s in segments] or [0]
        return SourceInfo(
            id=row["id"],
            document_id=row["document_id"],
            type=row["type"],
            track_id=row["track_id"],
            language=row["language"],
            content_hash=row["content_hash"],
            segment_count=len(segments),
            start_ms=min(starts),
            end_ms=max(ends),
            created_at=row["created_at"],
        )

    @staticmethod
    def _revision(row: sqlite3.Row) -> Revision:
        return Revision(
            id=row["id"],
            document_id=row["document_id"],
            parent_revision_id=row["parent_id"],
            kind=row["kind"],
            source_id=row["source_id"],
            blocks=[Block.model_validate(b) for b in json.loads(row["blocks_json"])],
            corrections=[Correction.model_validate(c) for c in json.loads(row["corrections_json"])],
            applied_edits=[AppliedEdit.model_validate(e) for e in json.loads(row["edits_json"])],
            content_hash=row["content_hash"],
            pipeline_version=row["pipeline_version"],
            glossary_version=row["glossary_version"],
            created_by=row["created_by"],
            created_at=row["created_at"],
        )

    @staticmethod
    def _revision_summary(row: sqlite3.Row) -> RevisionSummary:
        blocks = json.loads(row["blocks_json"])
        corrections = json.loads(row["corrections_json"])
        return RevisionSummary(
            id=row["id"],
            kind=row["kind"],
            created_by=row["created_by"],
            created_at=row["created_at"],
            parent_revision_id=row["parent_id"],
            block_count=len(blocks),
            pending_count=sum(1 for c in corrections if c.get("status") == "pending"),
        )

    @staticmethod
    def _summary(row: sqlite3.Row) -> Summary:
        return Summary.model_validate_json(row["summary_json"])

    def _upload(self, row: sqlite3.Row) -> UploadSession:
        received = json.loads(row["received_json"] or "[]")
        return UploadSession(
            id=row["id"],
            filename=row["filename"],
            size=row["size"],
            chunk_size=row["chunk_size"],
            max_bytes=self.settings.max_upload_bytes,
            status=row["status"],
            received_chunks=[int(item["index"]) for item in received],
            created_at=row["created_at"],
        )

    @staticmethod
    def _job(row: sqlite3.Row) -> Job:
        progress_raw = json.loads(row["progress_json"] or "{}")
        try:
            progress = JobProgress.model_validate(progress_raw)
        except Exception:
            progress = JobProgress()
        video = VideoRef.model_validate_json(row["video_json"]) if row["video_json"] else None
        error = None
        if row["error_json"]:
            try:
                error = JobError.model_validate_json(row["error_json"])
            except Exception:
                error = JobError(code="unknown", message=str(row["error_json"]))
        return Job(
            id=row["id"],
            type=row["type"],
            status=row["status"],
            stage=row["stage"],
            progress=progress,
            video=video,
            document_id=row["document_id"],
            revision_id=row["revision_id"],
            input=json.loads(row["input_json"]),
            result=json.loads(row["result_json"]) if row["result_json"] else None,
            error=error,
            attempt=row["attempt"],
            cancel_requested=bool(row["cancel_requested"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


def sha256_text_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()

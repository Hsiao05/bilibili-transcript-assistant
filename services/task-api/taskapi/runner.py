"""Job execution for transcription, cleaning and summarization."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import Settings
from .media import MediaError, ensure_audio
from .pipeline.clean import CleanOptions, PipelineError, clean_document
from .pipeline.markdown import render_document_markdown
from .pipeline.summary import summarize_document
from .providers.asr import ASRCancelled, ASRError, ASRProvider, select_asr
from .providers.llm import LLMProvider, build_llm
from .schemas import (
    Block,
    DocumentCreate,
    Job,
    JobError,
    JobProgress,
    SourceCreate,
    Summary,
    VideoRef,
)
from .store import ConflictError, NotFoundError, Store
from .util import iso, new_id, sha256_json


class JobCancelled(Exception):
    pass


class JobRunner:
    def __init__(self, settings: Settings, store: Store, llm: LLMProvider | None = None):
        self.settings = settings
        self.store = store
        self.llm = llm or build_llm(settings)

    # ------------------------------------------------------------------ public

    def run(self, job: Job, worker_id: str) -> None:
        if job.type == "transcribe":
            self._run_transcribe(job, worker_id)
        elif job.type == "clean":
            self._run_clean(job, worker_id)
        elif job.type == "summarize":
            self._run_summarize(job, worker_id)
        else:
            self._fail(job, worker_id, JobError(code="unknown_job_type", message=f"未知任务类型 {job.type}"))

    # ------------------------------------------------------------------ progress

    def _progress(self, job: Job, worker_id: str):
        def report(fraction: float, label: str = "", stage: str = "") -> None:
            if self.store.is_cancel_requested(job.id):
                raise JobCancelled()
            fraction = max(0.0, min(1.0, fraction))
            self.store.update_job_progress(
                job.id,
                worker_id,
                stage or label or job.stage,
                JobProgress(
                    completed=round(fraction, 4),
                    total=1,
                    unit="fraction",
                    percent=round(fraction * 100, 1),
                    label=label,
                ),
            )

        return report

    def _check_cancel(self, job: Job) -> None:
        if self.store.is_cancel_requested(job.id):
            raise JobCancelled()

    # ------------------------------------------------------------------ transcribe

    def _run_transcribe(self, job: Job, worker_id: str) -> None:
        report = self._progress(job, worker_id)
        input_data = job.input or {}
        upload_id = input_data.get("uploadId")
        video_data = input_data.get("video")
        options = input_data.get("options") or {}
        if not upload_id:
            self._fail(job, worker_id, JobError(code="missing_upload", message="缺少音频上传会话"))
            return
        if not video_data:
            self._fail(job, worker_id, JobError(code="missing_video", message="缺少视频信息"))
            return
        try:
            report(0.02, "读取音频", "audio")
            media_path = self.store.get_media_path(upload_id)
            provider = select_asr(self.settings, options.get("asrProvider") or job.input.get("asrProvider"))
            if provider is None:
                raise PipelineError(
                    "asr_not_configured",
                    "未配置可用的语音识别服务。请安装 faster-whisper 或填写云 ASR 配置。",
                    needs_input=True,
                )
            report(0.05, "探测媒体", "audio")
            audio_path, media_info = ensure_audio(
                media_path,
                self.settings.media_dir,
                self.settings.max_duration_minutes * 60 * 1000,
            )
            duration_ms = media_info.duration_ms

            report(0.1, f"语音识别（{provider.label}）", "asr")

            def asr_progress(fraction: float) -> None:
                report(0.1 + 0.62 * max(0.0, min(1.0, fraction)), "语音识别", "asr")

            result = provider.transcribe(
                audio_path,
                language=options.get("language") or "zh",
                progress=asr_progress,
                should_cancel=lambda: self.store.is_cancel_requested(job.id),
            )
            if not result.segments:
                raise PipelineError("asr_empty", "语音识别没有返回任何片段", needs_input=False)
            report(0.74, "保存原始转写", "asr")

            source_type = "asr_local" if result.provider_id == "faster-whisper" else "asr_cloud"
            segments = []
            for index, seg in enumerate(result.segments, start=1):
                text = seg.text.strip()
                if not text:
                    continue
                start = max(0, seg.start_ms)
                end = max(start, seg.end_ms)
                if duration_ms:
                    end = min(end, max(start, duration_ms))
                segments.append(
                    {
                        "id": f"seg_{index:05d}",
                        "startMs": start,
                        "endMs": end,
                        "text": text,
                        "recognizerConfidence": seg.confidence,
                    }
                )
            if not segments:
                raise PipelineError("asr_empty", "语音识别没有返回有效文本")
            payload = DocumentCreate(
                video=VideoRef.model_validate(video_data),
                source=SourceCreate(
                    type=source_type,
                    track_id=None,
                    language=result.language or options.get("language") or "unknown",
                    segments=segments,
                ),
            )
            document, source_id, original_revision_id = self.store.create_document(payload)
            report(0.8, "生成原始稿", "asr")

            cleaned_revision_id = None
            clean_stats: dict[str, Any] | None = None
            if options.get("autoClean", True):
                clean_stats, cleaned_revision_id = self._clean_document_inner(
                    document, original_revision_id, options, report, worker_id
                )
            report(1.0, "转写完成", "done")
            self.store.finish_job(
                job.id,
                worker_id,
                result={
                    "documentId": document.id,
                    "sourceId": source_id,
                    "originalRevisionId": original_revision_id,
                    "revisionId": cleaned_revision_id or original_revision_id,
                    "stats": clean_stats,
                    "asrProvider": result.provider_id,
                    "asrModel": result.model,
                    "durationMs": duration_ms,
                },
                document_id=document.id,
                revision_id=cleaned_revision_id or original_revision_id,
            )
        except JobCancelled:
            self.store.finish_job(job.id, worker_id, {"cancelled": True}, status="CANCELLED")
        except PipelineError as exc:
            if exc.needs_input:
                self.store.set_needs_input(
                    job.id, worker_id, JobError(code=exc.code, message=exc.message)
                )
            else:
                self._fail(job, worker_id, JobError(code=exc.code, message=exc.message, retryable=exc.retryable))
        except ASRCancelled:
            self.store.finish_job(job.id, worker_id, {"cancelled": True}, status="CANCELLED")
        except ASRError as exc:
            if exc.code in ("asr_not_configured", "asr_auth"):
                self.store.set_needs_input(job.id, worker_id, JobError(code=exc.code, message=exc.message))
            else:
                self._fail(job, worker_id, JobError(code=exc.code, message=exc.message, retryable=exc.retryable))
        except MediaError as exc:
            self._fail(job, worker_id, JobError(code=exc.code, message=exc.message))
        except Exception as exc:  # pragma: no cover - defensive
            self._fail(job, worker_id, JobError(code="internal_error", message=f"处理失败：{exc}"))

    # ------------------------------------------------------------------ clean

    def _run_clean(self, job: Job, worker_id: str) -> None:
        report = self._progress(job, worker_id)
        input_data = job.input or {}
        document_id = input_data.get("documentId") or job.document_id
        revision_id = input_data.get("revisionId") or job.revision_id
        options = input_data.get("options") or {}
        try:
            if not document_id:
                raise PipelineError("missing_document", "缺少文稿 ID")
            document = self.store.get_document(document_id)
            if not document:
                raise PipelineError("document_not_found", "文稿不存在或已删除")
            base_id = revision_id or document.original_revision_id
            if not base_id:
                raise PipelineError("missing_revision", "缺少基础文稿版本")
            base = self.store.get_revision(base_id)
            if not base:
                raise PipelineError("revision_not_found", "基础文稿版本不存在")
            report(0.02, "准备清洗", "clean")
            stats, new_revision_id = self._clean_document_inner(document, base_id, options, report, worker_id)
            report(1.0, "清洗完成", "done")
            self.store.finish_job(
                job.id,
                worker_id,
                result={"documentId": document.id, "revisionId": new_revision_id, "stats": stats},
                document_id=document.id,
                revision_id=new_revision_id,
            )
        except JobCancelled:
            self.store.finish_job(job.id, worker_id, {"cancelled": True}, status="CANCELLED")
        except PipelineError as exc:
            if exc.needs_input:
                self.store.set_needs_input(job.id, worker_id, JobError(code=exc.code, message=exc.message))
            else:
                self._fail(job, worker_id, JobError(code=exc.code, message=exc.message, retryable=exc.retryable))
        except NotFoundError:
            self._fail(job, worker_id, JobError(code="not_found", message="文稿不存在"))
        except Exception as exc:  # pragma: no cover - defensive
            self._fail(job, worker_id, JobError(code="internal_error", message=f"清洗失败：{exc}"))

    def _clean_document_inner(
        self, document, base_revision_id: str, options: dict[str, Any], report, worker_id: str,
    ) -> tuple[dict[str, Any], str]:
        base = self.store.get_revision(base_revision_id)
        if not base:
            raise PipelineError("revision_not_found", "基础文稿版本不存在")
        segments: list[dict[str, Any]] = []
        for block in base.blocks:
            if not block.source_segment_ids:
                continue
            segments.append(
                {
                    "id": block.source_segment_ids[0],
                    "startMs": block.start_ms,
                    "endMs": block.end_ms,
                    "text": block.text,
                    # Parent-revision ancestry, so applied edits can be reported as
                    # patches against this base block (blockId + text offsets).
                    "blockId": block.id,
                    "sourceSegmentIds": list(block.source_segment_ids),
                }
            )
        if not segments:
            raise PipelineError("empty_source", "基础版本没有可清洗的片段")
        glossary = self.store.get_glossary()
        clean_options = CleanOptions.from_options(options, glossary)
        glossary_version = f"glossary-{sha256_json(glossary)[:12]}"
        outcome = clean_document(
            segments,
            clean_options,
            self.llm,
            progress=lambda fraction, label: report(0.05 + fraction * 0.9, label, "clean"),
        )
        revision = self.store.create_revision(
            document_id=document.id,
            parent_id=base_revision_id,
            kind="cleaned",
            source_id=base.source_id,
            blocks=outcome.blocks,
            corrections=outcome.corrections,
            applied_edits=outcome.applied_edits,
            pipeline_version=f"clean-v1:{clean_options.strength}",
            glossary_version=glossary_version,
            created_by="model" if not self.llm.is_heuristic else "rules",
        )
        self.store.replace_terms(document.id, outcome.terms)
        return outcome.stats, revision.id

    # ------------------------------------------------------------------ summarize

    def _run_summarize(self, job: Job, worker_id: str) -> None:
        report = self._progress(job, worker_id)
        input_data = job.input or {}
        document_id = input_data.get("documentId") or job.document_id
        revision_id = input_data.get("revisionId") or job.revision_id
        options = input_data.get("options") or {}
        try:
            if not document_id:
                raise PipelineError("missing_document", "缺少文稿 ID")
            document = self.store.get_document(document_id)
            if not document:
                raise PipelineError("document_not_found", "文稿不存在或已删除")
            revisions = self.store.list_revisions(document.id)
            by_id = {r.id: r for r in revisions}
            if revision_id and revision_id in by_id:
                revision = by_id[revision_id]
            else:
                candidates = [r for r in revisions if r.kind in ("cleaned", "edited")]
                revision = candidates[-1] if candidates else (revisions[-1] if revisions else None)
            if not revision:
                raise PipelineError("revision_not_found", "没有可用于总结的文稿版本")
            source = self.store.get_source(revision.source_id) if revision.source_id else None
            segment_index: dict[str, dict[str, Any]] = {}
            if source:
                for seg in source["segments"]:
                    segment_index[str(seg["id"])] = {
                        "startMs": int(seg.get("startMs") or 0),
                        "endMs": int(seg.get("endMs") or 0),
                    }
            if not segment_index:
                for block in revision.blocks:
                    for sid in block.source_segment_ids:
                        segment_index[sid] = {"startMs": block.start_ms, "endMs": block.end_ms}
            report(0.03, "准备总结", "summarize")
            from .pipeline.markdown import source_label

            label = source_label(source["type"] if source else None)
            summary = summarize_document(
                document.video,
                revision.blocks,
                segment_index,
                self.llm,
                label,
                progress=lambda fraction, text: report(0.03 + fraction * 0.9, text, "summarize"),
            )
            summary.id = new_id("sum")
            summary.document_id = document.id
            summary.revision_id = revision.id
            summary.created_at = iso()
            summary.markdown = render_document_markdown(
                document.video,
                revision,
                source["type"] if source else None,
                summary,
                self.store.get_bundle(document.id).terms,
                {"includeTimestamps": True},
            )
            self.store.save_summary(summary)
            report(1.0, "总结完成", "done")
            self.store.finish_job(
                job.id,
                worker_id,
                result={"documentId": document.id, "summaryId": summary.id, "revisionId": revision.id},
                document_id=document.id,
                revision_id=revision.id,
            )
        except JobCancelled:
            self.store.finish_job(job.id, worker_id, {"cancelled": True}, status="CANCELLED")
        except PipelineError as exc:
            if exc.needs_input:
                self.store.set_needs_input(job.id, worker_id, JobError(code=exc.code, message=exc.message))
            else:
                self._fail(job, worker_id, JobError(code=exc.code, message=exc.message, retryable=exc.retryable))
        except Exception as exc:  # pragma: no cover - defensive
            self._fail(job, worker_id, JobError(code="internal_error", message=f"总结失败：{exc}"))

    # ------------------------------------------------------------------ helpers

    def _fail(self, job: Job, worker_id: str, error: JobError) -> None:
        self.store.fail_job(job.id, worker_id, error, retryable=error.retryable)

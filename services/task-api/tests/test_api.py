import hashlib
import io
import wave

from fastapi.testclient import TestClient

from taskapi.config import Settings
from taskapi.main import create_app
from taskapi.providers.asr import ASRResult, ASRSegment
from taskapi.schemas import Correction
from taskapi.store import Store
from taskapi.worker import Worker


def _create_document(client, video, segments):
    response = client.post(
        "/v1/documents",
        json={
            "video": video,
            "source": {
                "type": "bilibili_ai_subtitle",
                "language": "zh-CN",
                "segments": segments,
            },
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _run_worker(settings, store):
    worker = Worker(settings, store)
    assert worker.run_once() is True


def test_auth_required(tmp_path, monkeypatch):
    monkeypatch.setenv("TASKAPI_TOKEN", "secret-token")
    settings = Settings(data_dir=tmp_path / "data", auth_disabled=False)
    settings.ensure_dirs()
    settings.resolve_token()
    app = create_app(settings)
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200
        assert client.get("/v1/capabilities").status_code == 401
        ok = client.get("/v1/capabilities", headers={"Authorization": "Bearer secret-token"})
        assert ok.status_code == 200, ok.text
        assert ok.json()["apiVersion"] == "v1"


def test_document_clean_job_export(settings, store, client, sample_video, sample_segments):
    bundle = _create_document(client, sample_video, sample_segments)
    document_id = bundle["document"]["id"]
    assert bundle["document"]["originalRevisionId"]
    assert bundle["revisions"][0]["kind"] == "original"
    assert bundle["source"]["segmentCount"] == 4

    created = client.post(
        "/v1/jobs",
        json={
            "type": "clean",
            "documentId": document_id,
            "options": {"strength": "standard"},
            "idempotencyKey": "clean:test:1",
        },
    )
    assert created.status_code == 201, created.text
    job_id = created.json()["id"]
    duplicate = client.post(
        "/v1/jobs",
        json={"type": "clean", "documentId": document_id, "idempotencyKey": "clean:test:1"},
    )
    assert duplicate.json()["id"] == job_id

    _run_worker(settings, store)
    job = client.get(f"/v1/jobs/{job_id}").json()
    assert job["status"] == "SUCCEEDED", job
    assert job["stage"] == "done"
    assert job["progress"]["percent"] == 100.0

    updated = client.get(f"/v1/documents/{document_id}").json()
    kinds = [revision["kind"] for revision in updated["revisions"]]
    assert "cleaned" in kinds
    cleaned_id = updated["document"]["latestRevisionId"]
    revision = client.get(f"/v1/documents/{document_id}/revisions/{cleaned_id}").json()
    text = "".join(block["text"] for block in revision["blocks"])
    assert "我们开始" in text
    assert "然后我们点击保存" in text

    export = client.get(f"/v1/documents/{document_id}/export")
    assert export.status_code == 200
    assert "测试视频" in export.text
    assert "## 整理稿" in export.text
    assert "attachment" in export.headers["content-disposition"]


def test_manual_revision_and_correction_apply(settings, store, client, sample_video, sample_segments):
    bundle = _create_document(client, sample_video, sample_segments)
    document_id = bundle["document"]["id"]
    original_id = bundle["document"]["originalRevisionId"]
    original = store.get_revision(original_id)
    original_text = original.blocks[1].text
    correction = Correction(
        id="corr_1",
        block_id=original.blocks[1].id,
        source_segment_ids=original.blocks[1].source_segment_ids,
        start_offset=0,
        end_offset=len(original_text),
        original=original_text,
        replacement="这个视频支持四个模式。",
        change_type="consistency",
        reason="测试修改",
        status="pending",
    )
    cleaned = store.create_revision(
        document_id=document_id,
        parent_id=original_id,
        kind="cleaned",
        source_id=original.source_id,
        blocks=original.blocks,
        corrections=[correction],
        pipeline_version="clean-v1:standard",
    )
    payload = {
        "revisionId": cleaned.id,
        "acceptedIds": ["corr_1"],
        "keptIds": [],
    }
    response = client.post(f"/v1/documents/{document_id}/corrections/apply", json=payload)
    assert response.status_code == 201, response.text
    applied = response.json()
    assert applied["kind"] == "edited"
    assert applied["parentRevisionId"] == cleaned.id
    assert applied["blocks"][1]["text"] == "这个视频支持四个模式。"
    assert applied["corrections"] == []

    manual = client.post(
        f"/v1/documents/{document_id}/revisions",
        json={
            "parentRevisionId": applied["id"],
            "blocks": applied["blocks"],
            "createdBy": "user",
        },
    )
    assert manual.status_code == 201
    assert manual.json()["kind"] == "edited"


def test_upload_chunks_and_transcribe_needs_input(settings, store, client, sample_video):
    data = b"0123456789"
    digest = hashlib.sha256(data).hexdigest()
    upload = client.post(
        "/v1/uploads", json={"filename": "audio.m4a", "size": len(data), "sha256": digest}
    )
    assert upload.status_code == 201, upload.text
    upload_id = upload.json()["id"]
    assert upload.json()["chunkSize"] == 4

    parts = [data[0:4], data[4:8], data[8:10]]
    for index, part in enumerate(parts):
        response = client.put(
            f"/v1/uploads/{upload_id}/chunks/{index}",
            content=part,
            headers={
                "Content-Type": "application/octet-stream",
                "X-Chunk-SHA256": hashlib.sha256(part).hexdigest(),
            },
        )
        assert response.status_code == 200, response.text

    complete = client.post(
        f"/v1/uploads/{upload_id}/complete",
        json={"chunkCount": 3, "totalBytes": len(data), "sha256": digest},
    )
    assert complete.status_code == 200, complete.text
    assert complete.json()["status"] == "complete"

    job = client.post(
        "/v1/jobs",
        json={
            "type": "transcribe",
            "video": sample_video,
            "uploadId": upload_id,
            "options": {"autoClean": True},
        },
    )
    assert job.status_code == 201, job.text
    _run_worker(settings, store)
    status = client.get(f"/v1/jobs/{job.json()['id']}").json()
    assert status["status"] == "NEEDS_INPUT"
    assert status["error"]["code"] == "asr_not_configured"


def test_cancel_queued_job(settings, client, sample_video, sample_segments):
    bundle = _create_document(client, sample_video, sample_segments)
    job = client.post(
        "/v1/jobs", json={"type": "clean", "documentId": bundle["document"]["id"]}
    ).json()
    cancelled = client.post(f"/v1/jobs/{job['id']}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "CANCELLED"


def test_capabilities_reports_offline_model(settings, client):
    response = client.get("/v1/capabilities")
    assert response.status_code == 200
    data = response.json()
    assert data["apiVersion"] == "v1"
    assert data["llm"]["provider"] == "local-heuristic"
    assert data["asr"]["configured"] is False
    assert data["limits"]["chunkSize"] == 4


def _wav_bytes(seconds: float = 1.0, rate: int = 16000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * int(rate * seconds))
    return buffer.getvalue()


class FakeASR:
    provider_id = "faster-whisper"
    label = "测试 ASR"

    def transcribe(self, path, language, progress=None, should_cancel=None):
        if progress:
            progress(0.5)
        return ASRResult(
            language="zh",
            segments=[
                ASRSegment(0, 600, "呃，你好。"),
                ASRSegment(600, 1200, "我们开始测试。"),
            ],
            provider_id="faster-whisper",
            model="fake-whisper",
        )


def test_transcribe_job_creates_document(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data", auth_disabled=True, chunk_size=10_000)
    settings.ensure_dirs()
    settings.resolve_token()
    store = Store(settings)
    app = create_app(settings)
    monkeypatch.setattr("taskapi.runner.select_asr", lambda config, requested=None: FakeASR())

    with TestClient(app) as client:
        data = _wav_bytes()
        digest = hashlib.sha256(data).hexdigest()
        upload = client.post(
            "/v1/uploads", json={"filename": "test.wav", "size": len(data), "sha256": digest}
        ).json()
        chunk_size = upload["chunkSize"]
        parts = [data[offset : offset + chunk_size] for offset in range(0, len(data), chunk_size)]
        for index, part in enumerate(parts):
            response = client.put(
                f"/v1/uploads/{upload['id']}/chunks/{index}",
                content=part,
                headers={
                    "Content-Type": "application/octet-stream",
                    "X-Chunk-SHA256": hashlib.sha256(part).hexdigest(),
                },
            )
            assert response.status_code == 200, response.text
        complete = client.post(
            f"/v1/uploads/{upload['id']}/complete",
            json={"chunkCount": len(parts), "totalBytes": len(data), "sha256": digest},
        )
        assert complete.status_code == 200, complete.text

        job = client.post(
            "/v1/jobs",
            json={
                "type": "transcribe",
                "video": {
                    "bvid": "BV1xx411c7mD",
                    "cid": "98765",
                    "page": 1,
                    "title": "转写测试",
                    "author": "UP",
                    "durationMs": 1200,
                },
                "uploadId": upload["id"],
                "options": {"autoClean": True, "strength": "standard"},
            },
        ).json()
        worker = Worker(settings, store)
        assert worker.run_once() is True
        status = client.get(f"/v1/jobs/{job['id']}").json()
        assert status["status"] == "SUCCEEDED", status
        assert status["result"]["documentId"]
        document_id = status["result"]["documentId"]
        bundle = client.get(f"/v1/documents/{document_id}").json()
        assert bundle["source"]["type"] == "asr_local"
        kinds = [item["kind"] for item in bundle["revisions"]]
        assert "original" in kinds and "cleaned" in kinds
        revision = client.get(
            f"/v1/documents/{document_id}/revisions/{bundle['document']['latestRevisionId']}"
        ).json()
        text = "".join(block["text"] for block in revision["blocks"])
        assert "你好" in text
        assert "呃" not in text
        found = client.get(
            "/v1/documents?bvid=BV1xx411c7mD&cid=98765&page=1"
        )
        assert found.status_code == 200
        assert found.json()["document"]["id"] == document_id


def test_clean_applied_edits_are_patches_against_original_revision(settings, store, client, sample_video, sample_segments):
    bundle = _create_document(client, sample_video, sample_segments)
    document_id = bundle["document"]["id"]
    original_id = bundle["document"]["originalRevisionId"]
    job = client.post("/v1/jobs", json={"type": "clean", "documentId": document_id}).json()
    _run_worker(settings, store)
    assert client.get(f"/v1/jobs/{job['id']}").json()["status"] == "SUCCEEDED"

    updated = client.get(f"/v1/documents/{document_id}").json()
    cleaned_id = updated["document"]["latestRevisionId"]
    cleaned = client.get(f"/v1/documents/{document_id}/revisions/{cleaned_id}").json()
    original = client.get(f"/v1/documents/{document_id}/revisions/{original_id}").json()
    original_blocks = {block["id"]: block["text"] for block in original["blocks"]}

    assert cleaned["appliedEdits"], "heuristic clean should record rule edits"
    for edit in cleaned["appliedEdits"]:
        assert edit["blockId"] in original_blocks, "appliedEdit.blockId must reference a parent revision block"
        base_text = original_blocks[edit["blockId"]]
        assert base_text[edit["startOffset"] : edit["endOffset"]] == edit["original"]
        assert isinstance(edit["replacement"], str)
        assert edit["reason"]
        assert edit["sourceSegmentIds"]


def test_summary_job_and_export(settings, store, client, sample_video, sample_segments):
    bundle = _create_document(client, sample_video, sample_segments)
    document_id = bundle["document"]["id"]
    clean_job = client.post(
        "/v1/jobs",
        json={"type": "clean", "documentId": document_id, "idempotencyKey": "clean:summary-test"},
    ).json()
    _run_worker(settings, store)
    assert client.get(f"/v1/jobs/{clean_job['id']}").json()["status"] == "SUCCEEDED"
    updated = client.get(f"/v1/documents/{document_id}").json()
    revision_id = updated["document"]["latestRevisionId"]

    summary_job = client.post(
        "/v1/jobs",
        json={
            "type": "summarize",
            "documentId": document_id,
            "revisionId": revision_id,
            "idempotencyKey": "summary:test",
        },
    ).json()
    _run_worker(settings, store)
    status = client.get(f"/v1/jobs/{summary_job['id']}").json()
    assert status["status"] == "SUCCEEDED", status
    summary = client.get(f"/v1/documents/{document_id}/summaries/latest").json()
    assert summary["overview"]
    assert summary["chapters"]
    for chapter in summary["chapters"]:
        for point in chapter["points"]:
            assert isinstance(point["segmentIds"], list)

    export = client.get(f"/v1/documents/{document_id}/export")
    assert export.status_code == 200
    assert "## 内容概览" in export.text
    assert "## 章节要点" in export.text
    assert "## 材料覆盖与处理记录" in export.text

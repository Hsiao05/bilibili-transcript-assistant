"""Store-level regressions for per-document term ids and schema migration."""

from __future__ import annotations

import sqlite3

from taskapi.db import init_db
from taskapi.schemas import DocumentCreate, Term
from taskapi.store import Store


def _term(term_id: str, canonical: str) -> Term:
    return Term(term_id=term_id, canonical=canonical, variants=[], status="suggested")


def test_same_term_id_can_be_stored_for_two_documents(store: Store, sample_video, sample_segments):
    first = store.create_document(
        DocumentCreate(
            video=sample_video,
            source={"type": "bilibili_ai_subtitle", "language": "zh-CN", "segments": sample_segments},
        )
    )[0]
    second = store.create_document(
        DocumentCreate(
            video={**sample_video, "bvid": "BV1yy411c7mE", "cid": "987654321"},
            source={"type": "bilibili_ai_subtitle", "language": "zh-CN", "segments": sample_segments},
        )
    )[0]

    store.replace_terms(first.id, [_term("term_g001", "DeepSeek")])
    store.replace_terms(second.id, [_term("term_g001", "DeepSeek")])

    assert [term.term_id for term in store.get_bundle(first.id).terms] == ["term_g001"]
    assert [term.term_id for term in store.get_bundle(second.id).terms] == ["term_g001"]


def test_init_db_migrates_old_terms_primary_key(tmp_path):
    path = tmp_path / "old.sqlite3"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE terms (
              id TEXT PRIMARY KEY,
              document_id TEXT NOT NULL,
              term_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE INDEX idx_terms_document ON terms(document_id);
            INSERT INTO terms VALUES ('term_g001', 'doc_1', '{}', '2026-01-01T00:00:00Z');
            """
        )
    init_db(path)
    with sqlite3.connect(path) as conn:
        sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='terms'").fetchone()[0].lower()
        assert "primary key (id, document_id)" in " ".join(sql.split())
        conn.execute("INSERT INTO terms VALUES ('term_g001', 'doc_2', '{}', '2026-01-01T00:00:00Z')")
        assert conn.execute("SELECT COUNT(*) FROM terms").fetchone()[0] == 2

"""SQLite connection helpers and schema."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  bvid TEXT NOT NULL,
  cid TEXT NOT NULL,
  page INTEGER NOT NULL,
  video_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  original_revision_id TEXT,
  latest_revision_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_documents_video ON documents(bvid, cid, page, deleted);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  document_id TEXT,
  type TEXT NOT NULL,
  track_id TEXT,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  segments_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_document ON sources(document_id);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL,
  source_id TEXT,
  blocks_json TEXT NOT NULL,
  corrections_json TEXT NOT NULL DEFAULT '[]',
  edits_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  glossary_version TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_document ON revisions(document_id, created_at);

CREATE TABLE IF NOT EXISTS terms (
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  term_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_terms_document ON terms(document_id);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_document ON summaries(document_id, created_at);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  received_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  media_path TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT '',
  progress_json TEXT NOT NULL DEFAULT '{}',
  video_json TEXT,
  document_id TEXT,
  revision_id TEXT,
  input_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  idempotency_key TEXT UNIQUE,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_document ON jobs(document_id);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"""


@contextmanager
def connect(path: Path) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(str(path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
    finally:
        conn.close()


def _migrate_terms_primary_key(conn: sqlite3.Connection) -> None:
    """Allow the same pipeline term id (term_g001, ...) to exist in different documents.

    Older databases used ``id TEXT PRIMARY KEY``, so cleaning a second video failed with
    ``UNIQUE constraint failed: terms.id``. Rebuild the small terms table with a composite key.
    """
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='terms'").fetchone()
    if not row or not row["sql"]:
        return
    normalized = " ".join(row["sql"].lower().split())
    if "primary key (id, document_id)" in normalized or "primary key (document_id, id)" in normalized:
        return
    conn.executescript(
        """
        DROP INDEX IF EXISTS idx_terms_document;
        ALTER TABLE terms RENAME TO terms_old;
        CREATE TABLE terms (
          id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          term_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (id, document_id)
        );
        INSERT OR REPLACE INTO terms (id, document_id, term_json, created_at)
          SELECT id, document_id, term_json, created_at FROM terms_old;
        DROP TABLE terms_old;
        CREATE INDEX IF NOT EXISTS idx_terms_document ON terms(document_id);
        """
    )


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as conn:
        conn.executescript(SCHEMA)
        _migrate_terms_primary_key(conn)
        conn.commit()

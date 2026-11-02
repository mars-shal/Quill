-- Quill local canonical schema.
-- The editable document body is owned by the editor layer; this schema stores
-- the persisted document record, its sync bookkeeping, and app settings.

CREATE TABLE documents (
    id                TEXT PRIMARY KEY NOT NULL,
    title             TEXT NOT NULL DEFAULT 'Untitled document',
    kind              TEXT NOT NULL DEFAULT 'Draft',
    collections_json  TEXT NOT NULL DEFAULT '[]',
    status            TEXT NOT NULL DEFAULT 'Drafts',
    color             TEXT,
    filename          TEXT NOT NULL DEFAULT '',
    content           TEXT NOT NULL DEFAULT '',
    content_format    TEXT NOT NULL DEFAULT 'html',
    schema_version    INTEGER NOT NULL DEFAULT 1,
    yjs_snapshot      BLOB,
    yjs_state_vector  BLOB,
    cloud_id          TEXT,
    sync_state        TEXT NOT NULL DEFAULT 'local_only',
    cloud_revision    INTEGER NOT NULL DEFAULT 0,
    provenance        TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at        TEXT
);

CREATE INDEX idx_documents_updated_at ON documents (updated_at DESC);
CREATE INDEX idx_documents_status     ON documents (status);
CREATE INDEX idx_documents_deleted_at ON documents (deleted_at);

-- Durable Yjs update log. Updates are opaque, commutative and idempotent.
CREATE TABLE ydoc_updates (
    update_id     TEXT PRIMARY KEY NOT NULL,
    document_id   TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    update_blob   BLOB NOT NULL,
    state_vector  BLOB,
    client_id     TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    uploaded_at   TEXT
);

CREATE INDEX idx_ydoc_updates_document ON ydoc_updates (document_id, created_at);

-- Transactional outbox: written in the same transaction as local state changes.
CREATE TABLE sync_outbox (
    id           TEXT PRIMARY KEY NOT NULL,
    document_id  TEXT NOT NULL,
    operation    TEXT NOT NULL,
    payload_ref  TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    next_attempt_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sync_outbox_pending ON sync_outbox (next_attempt_at);

CREATE TABLE sync_state (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    endpoint    TEXT,
    account_id  TEXT,
    state       TEXT NOT NULL DEFAULT 'offline',
    last_synced_at TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sync_state (id, state) VALUES (1, 'offline');

-- App settings. Secrets are never stored here; they live in the OS keyring.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Metadata about which credential slots exist, without the credential material.
CREATE TABLE secrets_meta (
    service    TEXT PRIMARY KEY NOT NULL,
    account    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Job state for long-running work (AI, import, export, migration).
CREATE TABLE jobs (
    id             TEXT PRIMARY KEY NOT NULL,
    kind           TEXT NOT NULL,
    state          TEXT NOT NULL DEFAULT 'queued',
    document_id    TEXT,
    progress       REAL NOT NULL DEFAULT 0.0,
    question_json  TEXT,
    result_json    TEXT,
    error          TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_jobs_state ON jobs (state, updated_at DESC);

-- Durable job event log so restarts can rebuild progress.
CREATE TABLE job_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id     TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_job_events_job ON job_events (job_id, id);

-- Versioned local migration bookkeeping for legacy data imports.
CREATE TABLE migration_runs (
    id           TEXT PRIMARY KEY NOT NULL,
    source_kind  TEXT NOT NULL,
    source_path  TEXT NOT NULL,
    source_hash  TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'running',
    report_json  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_migration_runs_source
    ON migration_runs (source_kind, source_hash);

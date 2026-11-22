-- Allow the CLI transport in the provider registry.
--
-- 0005's protocol CHECK predates `Protocol::Cli`. The sidecar could already
-- hand a turn to `opencode run --format json` or `codex exec --json`, and both
-- `Protocol` and `as_str()` knew the value, but the row that stores the command
-- was rejected by SQLite before it could be activated: adopting a CLI tool in
-- Settings failed with "CHECK constraint failed: protocol IN (...)".
--
-- SQLite cannot widen a CHECK in place, so rebuild the table with the same
-- columns (including the role models added by 0007), copy every row, and
-- recreate the index and the two single-active triggers. The copy is explicit
-- about column names so a future column added in between cannot shift values.

CREATE TABLE providers_new (
    id            TEXT PRIMARY KEY NOT NULL
        CHECK (length(id) > 0 AND id NOT GLOB '*[^a-z0-9-]*'),
    label         TEXT NOT NULL DEFAULT '',
    vendor        TEXT NOT NULL DEFAULT 'compatible'
        CHECK (vendor IN ('openai', 'anthropic', 'google', 'compatible')),
    protocol      TEXT NOT NULL DEFAULT 'openai_chat'
        CHECK (protocol IN ('openai_chat', 'openai_responses',
                            'anthropic_messages', 'google_generative', 'cli')),
    base_url      TEXT NOT NULL DEFAULT '',
    default_model TEXT NOT NULL DEFAULT '',
    models        TEXT NOT NULL DEFAULT '[]',
    is_active     INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
    thinking_model TEXT NOT NULL DEFAULT '',
    writing_model  TEXT NOT NULL DEFAULT ''
);

INSERT INTO providers_new (
    id, label, vendor, protocol, base_url, default_model, models, is_active,
    thinking_model, writing_model
)
SELECT
    id, label, vendor, protocol, base_url, default_model, models, is_active,
    thinking_model, writing_model
FROM providers;

DROP TABLE providers;
ALTER TABLE providers_new RENAME TO providers;

CREATE INDEX idx_providers_is_active ON providers (is_active) WHERE is_active = 1;

CREATE TRIGGER providers_activate_on_insert
AFTER INSERT ON providers
WHEN NEW.is_active = 1
BEGIN
    UPDATE providers SET is_active = 0 WHERE id <> NEW.id;
END;

CREATE TRIGGER providers_activate_on_update
AFTER UPDATE OF is_active ON providers
WHEN NEW.is_active = 1
BEGIN
    UPDATE providers SET is_active = 0 WHERE id <> NEW.id;
END;

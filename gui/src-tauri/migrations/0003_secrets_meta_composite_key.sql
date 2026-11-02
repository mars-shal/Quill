-- `secrets_meta` recorded which credentials exist without storing the secrets
-- themselves; the values live in the OS keyring. It was keyed on `service`
-- alone, but `secrets::SERVICE` is the constant "app.quill.workspace" for every
-- write, so the table could hold at most one row for the whole lifetime of the
-- install, belonging to whichever credential happened to be stored first.
--
-- The auth token and the provider API keys share this table on purpose: both
-- are keyring entries under the same service name, distinguished only by their
-- account slot. So signing in before adding a provider key made the provider
-- insert collide, bump `updated_at`, and silently keep the token's account
-- value. `get_provider_secret_status` then reported the token's timestamp as
-- the age of the provider key.
--
-- Rebuilt with a composite primary key so each (service, account) pair has its
-- own row. The table is tiny and holds no secrets, so copying it through a
-- temp table is the simplest correct migration.
CREATE TABLE secrets_meta_new (
    service    TEXT NOT NULL,
    account    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (service, account)
);

INSERT INTO secrets_meta_new (service, account, created_at, updated_at)
    SELECT service, account, created_at, updated_at FROM secrets_meta;

DROP TABLE secrets_meta;

ALTER TABLE secrets_meta_new RENAME TO secrets_meta;

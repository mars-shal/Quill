-- Provider registry.
--
-- One row per provider configuration the reader can point a request at. This
-- table is the only source of truth for which providers exist: nothing here is
-- seeded, because seeding a provider that has no credential behind it would
-- advertise a choice the app cannot actually make. The rows come from Rust, from
-- the environment, once a key has been copied into the keyring.
--
-- vendor and protocol are separate columns and must stay that way. A vendor
-- cannot select a wire protocol: Anthropic and Google do not speak the OpenAI
-- protocol at all, so collapsing the two into one enum produced a model where
-- the only way to talk to Anthropic was to claim to be OpenAI. `vendor` answers
-- "who bills this", `protocol` answers "what do we put on the wire".
--
-- The slug CHECK uses GLOB, not a regular expression. SQLite has no regex
-- operator at all -- `~*` is PostgreSQL and fails to parse here with a syntax
-- error that takes every test which applies migrations down with it. GLOB is
-- SQLite's own operator and it is case-SENSITIVE, which is what makes it the
-- right tool: `[^a-z0-9-]` matches an uppercase letter, a space, or an
-- underscore, and `NOT GLOB` rejects the id when any one of them is present.
--
-- `length(id) > 0` is not redundant. GLOB cannot match the empty string against
-- a pattern that requires one character, so `'' NOT GLOB '*[^a-z0-9-]*'`
-- evaluates to TRUE and an empty id would sail through. Also note that a TEXT
-- PRIMARY KEY in SQLite does not imply NOT NULL the way it does elsewhere, so
-- the NOT NULL here is what actually rejects a NULL id.

CREATE TABLE providers (
    id            TEXT PRIMARY KEY NOT NULL
        CHECK (length(id) > 0 AND id NOT GLOB '*[^a-z0-9-]*'),
    label         TEXT NOT NULL DEFAULT '',
    vendor        TEXT NOT NULL DEFAULT 'compatible'
        CHECK (vendor IN ('openai', 'anthropic', 'google', 'compatible')),
    protocol      TEXT NOT NULL DEFAULT 'openai_chat'
        CHECK (protocol IN ('openai_chat', 'openai_responses',
                            'anthropic_messages', 'google_generative')),
    base_url      TEXT NOT NULL DEFAULT '',
    default_model TEXT NOT NULL DEFAULT '',
    -- JSON array of model ids, round-tripped through serde in providers.rs.
    -- Deliberately left unvalidated in SQL: an unparseable or non-array value is
    -- rejected loudly at the read boundary rather than coerced to `[]`, because
    -- silently dropping a reader's model list is worse than surfacing the error.
    models        TEXT NOT NULL DEFAULT '[]',
    is_active     INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1))
);

-- `get_active` is read on every request and at most one row can be active, so a
-- partial index over just the active row is the smallest thing that answers it.
CREATE INDEX idx_providers_is_active ON providers (is_active) WHERE is_active = 1;

-- The single-active invariant, enforced here rather than in Rust so that a raw
-- INSERT or UPDATE -- from a script, a future command, or a bug -- cannot leave
-- two providers active. Two triggers are needed because an INSERT does not fire
-- an UPDATE trigger. Neither recurses: the body only ever sets is_active = 0,
-- so the WHEN clause is false on the inner update.
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

-- Deliberately no AFTER DELETE trigger. An earlier draft had one that set
-- is_active = 0 on the row it had just deleted, which is a no-op. The state
-- after deleting the active provider is already defined -- the row is gone, so
-- get_active() returns None -- and a test pins that.
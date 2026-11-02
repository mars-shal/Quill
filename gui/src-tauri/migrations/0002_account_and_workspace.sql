-- Local mirror of the signed-in account, plus the app-level state that has to
-- survive a restart: which workspace this device is pointed at, user-created
-- themes, and whether onboarding has been seen.
--
-- The account row is a *mirror*. The password and the token never live here:
-- the token goes to the OS keyring, and the password only ever exists in the
-- sign-in request. A mirror is written on sign-in and cleared on sign-out, so
-- an offline start still knows who was last signed in and can show their name
-- and email without contacting the server.
CREATE TABLE account (
    id                TEXT PRIMARY KEY NOT NULL,
    email             TEXT NOT NULL,
    name              TEXT NOT NULL DEFAULT '',
    -- The PocketBase workspace this device syncs into. Empty until the first
    -- successful sync creates one.
    workspace_id      TEXT NOT NULL DEFAULT '',
    -- 'offline' until the server has answered at least once, so the UI can be
    -- honest about whether this device is actually syncing.
    sync_state        TEXT NOT NULL DEFAULT 'signed_out',
    last_synced_at    TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which PocketBase endpoint this device talks to. A row is created on first run
-- from the VITE_POCKETBASE_URL build-time default, and can be pointed at a
-- different deployment from Settings.
CREATE TABLE sync_config (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    base_url      TEXT NOT NULL,
    -- Opt-in. The default is off: a reader who never asked for a replica should
    -- not have their documents uploaded by an app update.
    sync_enabled  INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- User-created palettes. One row per theme; `theme_id` is the slug the
-- stylesheet and the settings both refer to. Tokens are a JSON object of CSS
-- custom property names to values, which keeps the set extensible without a
-- migration each time the palette grows a knob.
CREATE TABLE custom_themes (
    theme_id     TEXT PRIMARY KEY NOT NULL,
    name         TEXT NOT NULL,
    tokens_json  TEXT NOT NULL,
    -- 'light' or 'dark'. Decides which side of a pair the theme belongs to and
    -- which ink the editor's canvas effects are given.
    mode         TEXT NOT NULL DEFAULT 'dark',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- First-run state. Key/value rather than columns so onboarding can grow a step
-- without a migration each time.
CREATE TABLE onboarding_state (
    key        TEXT PRIMARY KEY NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO sync_config (id, base_url) VALUES (1, 'http://127.0.0.1:8090');
INSERT INTO onboarding_state (key, value) VALUES ('completed', 'false');

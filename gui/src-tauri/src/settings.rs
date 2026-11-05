use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::AppResult;

/// Non-secret application settings. Provider API keys are deliberately absent;
/// they are stored in the OS credential store via `secrets.rs`. Which provider,
/// model and endpoint a run uses is also absent: that lives in the `providers`
/// registry, which is the one place a request reads it from.
///
/// Every field carries a `#[serde(default)]` that returns the same value as
/// [`Settings::defaults`]. Without it, adding any field makes serde reject
/// every record written by an older build, and `load` then falls back to
/// defaults -- silently discarding the reader's theme, font and density on
/// first launch. `#[serde(default)]` on the struct alone is not enough: it fills
/// missing fields from `Default::default()`, which for `bool` is `false` and for
/// `String` is empty, not the intended defaults.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_font")]
    pub font: String,
    #[serde(default = "default_density")]
    pub density: String,
    #[serde(default = "default_true")]
    pub autosave: bool,
    #[serde(default = "default_true")]
    pub spellcheck: bool,
    #[serde(default = "default_true")]
    pub word_count: bool,
    #[serde(default)]
    pub reduce_motion: bool,
    /// A bundled texture id from `public/textures/`, or empty for none.
    ///
    /// An id rather than a path: the bundled set ships with the build, so a path
    /// would be a string that stops resolving the day the file moves.
    #[serde(default)]
    pub editor_texture: String,
    /// A user-picked texture as a `data:` URL, or empty for none.
    ///
    /// The URL is stored rather than the path on purpose. A path is a promise
    /// about the filesystem that a build update, a moved file, or a synced
    /// settings row can all break, and the failure mode is a silently blank
    /// writing surface. The bytes cost a settings row each, which is the
    /// tradeoff P4 asks for and `MAX_WALLPAPER_BYTES` below bounds.
    #[serde(default)]
    pub editor_texture_data: String,
    /// A wallpaper behind the whole app as a `data:` URL, or empty for none.
    #[serde(default)]
    pub wallpaper: String,
    /// How opaque the panels are, 0 to 100.
    ///
    /// Defaults to 100, which is byte-identical to the build before wallpapers
    /// existed. Anything less is opt-in, and the contrast check in P4-4 has to
    /// account for what shows through.
    #[serde(default = "default_surface_alpha")]
    pub surface_alpha: i64,
    /// How much the wallpaper is dimmed, 0 to 100.
    ///
    /// A wallpaper behind body text needs one. `--scrim` from P0-6 is the hook
    /// this drives, and 0 is the honest default for "I picked this image and I
    /// want to see it", with the reader in control of how much legibility costs.
    #[serde(default = "default_scrim")]
    pub scrim: i64,
    /// The reader's own `--editor-texture-wash`, or None to follow the theme.
    ///
    /// `None` rather than a number because the right value is not a constant:
    /// a light theme's darkest text clears 4.5:1 on white and about 3.4:1 on
    /// the grey a 14% veil leaves, so a fixed default would ship a contrast
    /// failure for every light theme. The applier resolves None against the
    /// theme's mode, and the two sides of that decision live in
    /// `backgrounds.js::DEFAULT_WASH`.
    #[serde(default)]
    pub texture_wash: Option<f64>,
}

fn default_theme() -> String {
    "light".into()
}

/// The themes `src/styles.css` ships a `body[data-theme=...]` block for.
///
/// A theme id outside this set has to name a row in `custom_themes`; there is no
/// third possibility. Anything else is a dangling id -- a theme that was deleted
/// while selected, a record hand-edited, a build that renamed a block -- and it
/// has to resolve rather than render a document with a dozen undefined custom
/// properties. The frontend's `resolveTheme` falls back to `light` for the same
/// id, so the two agree rather than disagreeing about what "no theme" means.
pub const BUILT_IN_THEMES: [&str; 3] = ["light", "paper", "night"];

/// The theme to store for an id, which is the id itself when it is one this
/// build can paint and `light` when it is not.
pub async fn normalize_theme(pool: &SqlitePool, theme: &str) -> String {
    let id = theme.trim();
    if BUILT_IN_THEMES.contains(&id) {
        return id.to_string();
    }
    if id.is_empty() {
        return default_theme();
    }
    // A custom theme is a database row, so this is a query and not a list. The
    // error path falls back rather than propagating: settings are the last thing
    // that should be unreadable.
    let known =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM custom_themes WHERE theme_id = ?1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap_or(0);
    if known > 0 {
        id.to_string()
    } else {
        default_theme()
    }
}

fn default_font() -> String {
    "Arial".into()
}

fn default_density() -> String {
    "comfortable".into()
}

fn default_true() -> bool {
    true
}

/// The largest `data:` URL any of the image settings will keep.
///
/// Four megabytes is a little over three megabytes of image once base64 has
/// inflated it, and `images::MAX_BYTES` is derived from this number rather than
/// set next to it -- see the comment there. A value that is too long is dropped
/// to empty on both write and load, so a hand-edited row cannot smuggle a
/// megabyte-scale string past a reader that would never have accepted the file.
/// A wallpaper is a full-window image, so it gets the same cap as a texture
/// rather than a larger one.
pub const MAX_IMAGE_DATA_BYTES: usize = 4 * 1024 * 1024;

fn default_surface_alpha() -> i64 {
    100
}

fn default_scrim() -> i64 {
    0
}

impl Settings {
    pub fn defaults() -> Self {
        Self {
            theme: default_theme(),
            font: default_font(),
            density: default_density(),
            autosave: default_true(),
            spellcheck: default_true(),
            word_count: default_true(),
            reduce_motion: false,
            editor_texture: String::new(),
            editor_texture_data: String::new(),
            wallpaper: String::new(),
            surface_alpha: default_surface_alpha(),
            scrim: default_scrim(),
            texture_wash: None,
        }
    }

    /// Merges a partial update over `base`, leaving omitted fields untouched.
    ///
    /// `set_settings` is a replace, not a patch, so a caller that sends only
    /// the keys it means to change would blank everything else. Callers on the
    /// JS side currently paper over this by spreading the full defaults object;
    /// this makes a partial payload correct on its own.
    pub fn merged_with(&self, patch: &SettingsPatch) -> Self {
        let mut next = self.clone();
        if let Some(value) = &patch.theme {
            next.theme = value.clone();
        }
        if let Some(value) = &patch.font {
            next.font = value.clone();
        }
        if let Some(value) = &patch.density {
            next.density = value.clone();
        }
        if let Some(value) = patch.autosave {
            next.autosave = value;
        }
        if let Some(value) = patch.spellcheck {
            next.spellcheck = value;
        }
        if let Some(value) = patch.word_count {
            next.word_count = value;
        }
        if let Some(value) = patch.reduce_motion {
            next.reduce_motion = value;
        }
        if let Some(value) = patch.reduce_motion {
            next.reduce_motion = value;
        }
        if let Some(value) = &patch.editor_texture {
            next.editor_texture = value.clone();
        }
        if let Some(value) = &patch.editor_texture_data {
            next.editor_texture_data = clamp_image_data(value);
        }
        if let Some(value) = &patch.wallpaper {
            next.wallpaper = clamp_image_data(value);
        }
        if let Some(value) = patch.surface_alpha {
            next.surface_alpha = value.clamp(0, 100);
        }
        if let Some(value) = patch.scrim {
            next.scrim = value.clamp(0, 100);
        }
        if let Some(value) = patch.texture_wash {
            // NaN is not `is_finite` and is not greater than 0.6, so a bare
            // `clamp` would let it through and it would then be written into a
            // stylesheet as `calc((1 - NaN) * 100%)`, which is an invalid value
            // the browser drops -- leaving the page with no veil at all, and no
            // way to tell from the settings screen which of the two happened.
            next.texture_wash = match value {
                Some(amount) if amount.is_finite() => Some(amount.clamp(0.0, 0.6)),
                Some(_) | None => None,
            };
        }
        next
    }
}

/// Keeps an image `data:` URL if it is one and small enough, and empties it
/// otherwise.
///
/// Degrading to "no image" rather than erroring is the whole point. This runs
/// inside `merged_with`, which runs inside a settings write, and a settings write
/// carries the font, the theme and the provider. A reader whose wallpaper is from
/// a build two versions back -- a `file://` URL from before P4-1, a truncated
/// row, a paste that got mangled -- should get a flat surface and keep their
/// settings, not a dialog they have to dismiss to change their font.
///
/// A non-`data:` URL is dropped for the same reason it was never stored: the
/// webview cannot load one, so keeping it would show a broken-image icon in
/// settings forever.
fn clamp_image_data(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if !trimmed.starts_with("data:image/") {
        return String::new();
    }
    if trimmed.len() > MAX_IMAGE_DATA_BYTES {
        return String::new();
    }
    trimmed.to_string()
}

/// A partial settings update. Every field is optional and `None` means "leave
/// as-is", so a caller can send only what changed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub theme: Option<String>,
    pub font: Option<String>,
    pub density: Option<String>,
    pub autosave: Option<bool>,
    pub spellcheck: Option<bool>,
    pub word_count: Option<bool>,
    pub reduce_motion: Option<bool>,
    pub editor_texture: Option<String>,
    pub editor_texture_data: Option<String>,
    pub wallpaper: Option<String>,
    pub surface_alpha: Option<i64>,
    pub scrim: Option<i64>,
    /// `Some(None)` clears the reader's choice and `None` leaves the stored one
    /// alone, which is the same distinction `Settings::merged_with` draws for
    /// every other field. Serde needs the nesting for exactly that reason: a
    /// bare `Option<f64>` could not tell "not mentioned" from "set to nothing",
    /// and this field's whole point is that nothing is a real value.
    pub texture_wash: Option<Option<f64>>,
}

const SETTINGS_KEY: &str = "app";

/// The wallpaper lives in its own row of the same `settings` table.
///
/// It is the one field here large enough to change how the others behave. A
/// 4MiB image becomes a ~5.4MB `data:` URL, and it was living inside the `app`
/// row, which meant every settings write -- changing the word-count toggle, the
/// font, anything -- re-encoded all of that base64 and rewrote it, and every
/// read parsed megabytes back to recover forty small scalars. The settings that
/// get written most often were paying for the one that changes least.
///
/// A second row rather than a new table, because `settings` is already
/// `key`/`value`: this needs no schema migration, and an existing install simply
/// grows a row on its next read. `MAX_WALLPAPER_BYTES` still bounds it.
const WALLPAPER_KEY: &str = "app.wallpaper";

/// Reads the wallpaper row, or `None` when there is not one yet.
async fn load_wallpaper(pool: &SqlitePool) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
            .bind(WALLPAPER_KEY)
            .fetch_optional(pool)
            .await?,
    )
}

/// Writes the wallpaper row, or removes it when there is no wallpaper.
///
/// Deleting rather than storing `""`, so a reader who clears their wallpaper
/// leaves nothing behind for the next load to rediscover.
async fn store_wallpaper(pool: &SqlitePool, wallpaper: &str) -> AppResult<()> {
    if wallpaper.is_empty() {
        sqlx::query("DELETE FROM settings WHERE key = ?1")
            .bind(WALLPAPER_KEY)
            .execute(pool)
            .await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(WALLPAPER_KEY)
    .bind(wallpaper)
    .execute(pool)
    .await?;
    Ok(())
}

/// Writes the `app` row. The caller is responsible for normalising first and
/// for having moved the wallpaper out; see [`save`].
async fn write_blob(pool: &SqlitePool, blob: &Settings) -> AppResult<()> {
    let json = serde_json::to_string(blob)
        .map_err(|e| crate::error::AppError::Other(format!("could not encode settings: {e}")))?;
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(SETTINGS_KEY)
    .bind(json)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load(pool: &SqlitePool) -> AppResult<Settings> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind(SETTINGS_KEY)
        .fetch_optional(pool)
        .await?;

    let Some(raw) = raw else {
        return Ok(Settings::defaults());
    };

    // The match yields a `Settings`, not a `Result`, because the theme
    // normalisation below has to run on the fallback too: a record that failed
    // to parse is replaced wholesale, and its theme is the default anyway.
    let value = match serde_json::from_str::<Settings>(&raw) {
        // Fields absent from the record are filled by the per-field
        // `#[serde(default)]` on the struct, so a record written by an older
        // build loads without losing the fields it did have.
        Ok(mut value) => {
            // A field present but blank is a distinct case: it can only have
            // come from a caller that sent an empty string.
            let defaults = Settings::defaults();
            if value.theme.is_empty() {
                value.theme = defaults.theme;
            }
            if value.font.is_empty() {
                value.font = defaults.font;
            }
            if value.density.is_empty() {
                value.density = defaults.density;
            }
            value
        }
        Err(_) => Settings::defaults(),
    };
    let theme = normalize_theme(pool, &value.theme).await;
    // The image settings are normalized on read as well as on write. A record
    // that reached the table another way -- hand-edited, restored from a backup
    // taken on a build that stored paths -- has to degrade here too, or the
    // settings dialog renders a broken-image icon and the editor paints a
    // `file://` URL that cannot resolve.
    let mut value = value;
    value.theme = theme;
    value.editor_texture_data = clamp_image_data(&value.editor_texture_data);
    value.wallpaper = clamp_image_data(&value.wallpaper);

    // The wallpaper is authoritative in its own row, not in the blob above.
    // A record written by a build from before the split still carries one there,
    // so when the dedicated row is absent and the blob has something, this is a
    // pre-split install: move it out and rewrite the blob without it, so the
    // megabytes stop being carried by every subsequent read.
    match load_wallpaper(pool).await? {
        Some(stored) => value.wallpaper = clamp_image_data(&stored),
        None => {
            if !value.wallpaper.is_empty() {
                store_wallpaper(pool, &value.wallpaper).await?;
                let mut migrated = value.clone();
                migrated.wallpaper = String::new();
                write_blob(pool, &migrated).await?;
            }
        }
    }

    Ok(value)
}

/// Applies a partial update to the stored settings and returns the merged
/// result. Unlike [`save`], omitted keys keep their current value.
pub async fn apply_patch(pool: &SqlitePool, update: &SettingsPatch) -> AppResult<Settings> {
    let current = load(pool).await?;
    let next = current.merged_with(update);
    save(pool, &next).await
}

pub async fn save(pool: &SqlitePool, settings: &Settings) -> AppResult<Settings> {
    // The stored record is normalised, not just the returned one: a settings row
    // that keeps a deleted theme's id would keep rendering `light` forever, and
    // the next build to add a theme called that would silently adopt it.
    let mut normalized = settings.clone();
    normalized.theme = normalize_theme(pool, &settings.theme).await;
    let settings = &normalized;

    // Two rows, written in this order so the invariant "the wallpaper is never
    // in the blob" holds at every point, including a failure partway through.
    // Blanking it in the serialised copy is what keeps a megabyte of base64 out
    // of a row that gets rewritten every time a toggle changes; the field stays
    // present and empty in the JSON, so an older build reading this row still
    // deserialises it, it just sees no wallpaper until it is written back.
    store_wallpaper(pool, &settings.wallpaper).await?;
    let mut blob = settings.clone();
    blob.wallpaper = String::new();
    write_blob(pool, &blob).await?;

    Ok(settings.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account;

    async fn test_pool() -> SqlitePool {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open in-memory database");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations");
        pool
    }

    // -----------------------------------------------------------------------
    // Themes
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn a_built_in_theme_is_stored_as_itself() {
        let pool = test_pool().await;
        for id in BUILT_IN_THEMES {
            let normalized = normalize_theme(&pool, id).await;
            assert_eq!(normalized, id, "{id} is a built-in and must survive");
        }
        // And through a real write, not just the helper.
        let mut settings = Settings::defaults();
        settings.theme = "paper".into();
        let saved = save(&pool, &settings).await.expect("save");
        assert_eq!(saved.theme, "paper");
        assert_eq!(load(&pool).await.expect("load").theme, "paper");
    }

    #[tokio::test]
    async fn a_custom_theme_is_valid_only_while_its_row_exists() {
        let pool = test_pool().await;
        // Not there yet: the id is a dangling reference, and it has to resolve
        // rather than paint a document with undefined custom properties.
        assert_eq!(normalize_theme(&pool, "mine").await, "light");

        sqlx::query(
            "INSERT INTO custom_themes (theme_id, name, tokens_json, mode) VALUES (?1, ?2, ?3, ?4)",
        )
        .bind("mine")
        .bind("Mine")
        .bind(r##"{"--main":"#101010"}"##)
        .bind("dark")
        .execute(&pool)
        .await
        .expect("insert theme");
        assert_eq!(
            normalize_theme(&pool, "mine").await,
            "mine",
            "a stored theme is selectable"
        );

        // The case the old code got wrong: the theme is deleted while it is the
        // selected one. Loading has to fall back, not render a broken palette.
        sqlx::query("DELETE FROM custom_themes WHERE theme_id = ?1")
            .bind("mine")
            .execute(&pool)
            .await
            .expect("delete theme");
        assert_eq!(normalize_theme(&pool, "mine").await, "light");
    }

    #[tokio::test]
    async fn an_unknown_theme_id_falls_back_to_light_on_load_and_on_write() {
        let pool = test_pool().await;
        let mut settings = Settings::defaults();
        settings.theme = "midnight-navy".into();
        let saved = save(&pool, &settings).await.expect("save");
        assert_eq!(saved.theme, "light", "the returned record is corrected");
        assert_eq!(
            load(&pool).await.expect("load").theme,
            "light",
            "and so is the stored one"
        );

        // A record that reached the table some other way -- hand-edited, or
        // written by a build that knew a theme this one does not -- is corrected
        // on read rather than trusted.
        sqlx::query("UPDATE settings SET value = replace(value, '\"theme\":\"light\"', '\"theme\":\"ghost\"') WHERE key = ?1")
            .bind(SETTINGS_KEY)
            .execute(&pool)
            .await
            .expect("corrupt the theme");
        assert_eq!(load(&pool).await.expect("load").theme, "light");
    }

    #[tokio::test]
    async fn a_blank_theme_is_the_default() {
        let pool = test_pool().await;
        assert_eq!(normalize_theme(&pool, "").await, "light");
        assert_eq!(normalize_theme(&pool, "   ").await, "light");
    }

    #[tokio::test]
    async fn a_theme_id_is_matched_case_sensitively() {
        // Case is load-bearing: "Night" is a different id from "night", and
        // `resolveTheme` in the frontend compares `theme_id` exactly too, so
        // lower-casing on one side only would make the two disagree about which
        // theme is active.
        let pool = test_pool().await;
        assert_eq!(normalize_theme(&pool, "Night").await, "light");
        assert_eq!(normalize_theme(&pool, "NIGHT").await, "light");
        // Surrounding whitespace is not, and is trimmed: no id can carry it
        // (`slugify` strips it), so the only source would be a hand-edited row,
        // and falling back to light over a stray space would be the wrong answer.
        assert_eq!(normalize_theme(&pool, " night ").await, "night");
    }

    #[tokio::test]
    async fn the_rust_and_javascript_slugs_agree() {
        // The browser fallback derives a theme id in JavaScript from the same
        // name, so the same theme cannot end up with two ids depending on the
        // runtime. This asserts the two rules produce the same string for the
        // awkward names, and `tests/themes.test.mjs` asserts the JavaScript side
        // against this file's fixtures.
        for name in [
            "Midnight",
            "Rose Pine",
            "  spaced  out  ",
            "punctuation!! here",
            "Ünïcode Näme",
            "123",
            "--leading and trailing--",
            "a",
        ] {
            let rust = account::slugify(name);
            let js = slugify_like_store(name);
            assert_eq!(rust, js, "slug mismatch for {name:?}");
            assert!(!rust.is_empty());
        }
    }

    /// The exact rule in `slugify` in `src/platform/store.js`, duplicated here
    /// so a change on either side fails this test instead of only failing at
    /// runtime for the one runtime that uses the changed copy.
    fn slugify_like_store(value: &str) -> String {
        let lowered = value.to_lowercase().trim().to_string();
        let mut out = String::new();
        let mut last_dash = true;
        for ch in lowered.chars() {
            if ch.is_ascii_alphanumeric() {
                out.push(ch);
                last_dash = false;
            } else if !last_dash {
                out.push('-');
                last_dash = true;
            }
        }
        let trimmed = out.trim_matches('-').to_string();
        if trimmed.is_empty() {
            "untitled-document".into()
        } else {
            trimmed
        }
    }

    #[tokio::test]
    async fn the_seeded_presets_are_present_and_usable() {
        // The curated themes arrive with the migration, so a fresh install and
        // `npm run check-contrast` agree on what the app can paint.
        let pool = test_pool().await;
        let rows: Vec<(String, String, String, String)> = sqlx::query_as(
            "SELECT theme_id, name, mode, tokens_json FROM custom_themes ORDER BY theme_id",
        )
        .fetch_all(&pool)
        .await
        .expect("list themes");

        let ids: Vec<&str> = rows.iter().map(|(id, ..)| id.as_str()).collect();
        for expected in [
            "midnight",
            "nord",
            "dracula",
            "rose-pine",
            "sepia",
            "solar",
            "catppuccin-latte",
            "catppuccin-mocha",
            "tokyo-night",
            "gruvbox-dark",
            "rose-pine-dawn",
            "everforest-light",
        ] {
            assert!(
                ids.contains(&expected),
                "the {expected} preset is missing: {ids:?}"
            );
        }

        for (id, name, mode, tokens) in &rows {
            assert!(
                mode == "light" || mode == "dark",
                "{id} has mode {mode}, which is neither side of a pair"
            );
            assert!(!name.trim().is_empty(), "{id} needs a display name");
            assert_eq!(
                crate::account::slugify(name),
                *id,
                "{id} must be its own name's slug"
            );
            let parsed: serde_json::Value = serde_json::from_str(tokens)
                .unwrap_or_else(|e| panic!("{id} tokens_json is not valid JSON: {e}"));
            assert!(parsed.is_object(), "{id} tokens must be an object");
            assert!(
                parsed.as_object().expect("object").len() >= 15,
                "{id} sets too few tokens to be a palette"
            );
            // Every seeded id has to be selectable, or the picker would offer a
            // theme that the settings layer silently rewrites to light.
            assert_eq!(
                normalize_theme(&pool, id).await,
                *id,
                "{id} must resolve to itself"
            );
        }
    }

    #[tokio::test]
    async fn seeding_is_idempotent() {
        // Migrations run once, but a database restored from a backup and then
        // migrated again must not fail on the primary key. The insert is a
        // plain one rather than an upsert, which is correct for a migration and
        // is why this test exists.
        let pool = test_pool().await;
        let again = sqlx::query(
            "INSERT INTO custom_themes (theme_id, name, tokens_json, mode)
             VALUES ('midnight', 'Midnight', '{}', 'dark')
             ON CONFLICT(theme_id) DO UPDATE SET name = excluded.name",
        )
        .execute(&pool)
        .await;
        assert!(again.is_ok(), "re-seeding must not error: {again:?}");
    }

    // -----------------------------------------------------------------------
    // Image backgrounds
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn image_settings_default_to_a_flat_surface() {
        // The whole opt-in design rests on this: a fresh install and any install
        // that never touched the new controls have to render exactly what the
        // build rendered before them.
        let settings = Settings::defaults();
        assert_eq!(settings.editor_texture, "");
        assert_eq!(settings.editor_texture_data, "");
        assert_eq!(settings.wallpaper, "");
        assert_eq!(settings.surface_alpha, 100, "panels are opaque by default");
        assert_eq!(settings.scrim, 0);
    }

    #[tokio::test]
    async fn image_settings_round_trip_through_the_database() {
        let pool = test_pool().await;
        let data = "data:image/png;base64,iVBORw0KGgo=";
        let wallpaper = "data:image/webp;base64,UklGRg==";

        let stored = save(
            &pool,
            &Settings {
                editor_texture: "grain".into(),
                editor_texture_data: data.to_string(),
                wallpaper: wallpaper.to_string(),
                surface_alpha: 62,
                scrim: 35,
                ..Settings::defaults()
            },
        )
        .await
        .expect("save");

        assert_eq!(stored.editor_texture, "grain");
        assert_eq!(stored.editor_texture_data, data);
        assert_eq!(stored.wallpaper, wallpaper);
        assert_eq!(stored.surface_alpha, 62);
        assert_eq!(stored.scrim, 35);

        let loaded = load(&pool).await.expect("load");
        assert_eq!(loaded.editor_texture, "grain");
        assert_eq!(loaded.editor_texture_data, data);
        assert_eq!(loaded.wallpaper, wallpaper);
        assert_eq!(loaded.surface_alpha, 62);
        assert_eq!(loaded.scrim, 35);
    }

    // -----------------------------------------------------------------------
    // The wallpaper's own row
    //
    // The point of these is that the *blob* stays small. Every other setting
    // lives there and gets rewritten whenever any of them changes, so a
    // wallpaper carried inside it made each of those writes re-encode megabytes
    // of base64 for a field that did not change.
    // -----------------------------------------------------------------------

    /// The `app` row as stored, without going through `load`.
    async fn raw_blob(pool: &SqlitePool) -> String {
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
            .bind(SETTINGS_KEY)
            .fetch_one(pool)
            .await
            .expect("the app row")
    }

    #[tokio::test]
    async fn the_wallpaper_is_not_written_into_the_settings_blob() {
        let pool = test_pool().await;
        let wallpaper = "data:image/webp;base64,UklGRg==";

        save(
            &pool,
            &Settings {
                wallpaper: wallpaper.to_string(),
                ..Settings::defaults()
            },
        )
        .await
        .expect("save");

        let blob = raw_blob(&pool).await;
        assert!(
            !blob.contains("UklGRg"),
            "the wallpaper reached the blob, so every unrelated settings write              re-encodes it: {blob}"
        );
        // Blank rather than absent, so a build from before the split still
        // deserialises the row instead of failing on a missing field.
        assert!(
            blob.contains(r#""wallpaper":"""#),
            "the field should stay present and empty so older readers still parse it: {blob}"
        );
    }

    #[tokio::test]
    async fn a_wallpaper_saved_alone_is_read_back_and_still_omitted_from_the_blob() {
        let pool = test_pool().await;
        let wallpaper = "data:image/png;base64,iVBORw0KGgo=";

        let stored = save(
            &pool,
            &Settings {
                wallpaper: wallpaper.to_string(),
                ..Settings::defaults()
            },
        )
        .await
        .expect("save");
        assert_eq!(stored.wallpaper, wallpaper, "the caller still gets it back");

        let loaded = load(&pool).await.expect("load");
        assert_eq!(loaded.wallpaper, wallpaper);
    }

    #[tokio::test]
    async fn changing_an_unrelated_setting_does_not_disturb_the_wallpaper() {
        let pool = test_pool().await;
        let wallpaper = "data:image/png;base64,iVBORw0KGgo=";

        save(
            &pool,
            &Settings {
                wallpaper: wallpaper.to_string(),
                ..Settings::defaults()
            },
        )
        .await
        .expect("first save");

        // The shape of the reported problem: a one-word change to a boolean.
        let after = apply_patch(
            &pool,
            &SettingsPatch {
                word_count: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("patch");

        assert!(after.word_count, "the patch applied");
        assert_eq!(after.wallpaper, wallpaper, "the wallpaper survived");
        assert!(
            !raw_blob(&pool).await.contains("iVBORw0KGgo"),
            "the wallpaper leaked into the blob during an unrelated write"
        );
    }

    #[tokio::test]
    async fn clearing_the_wallpaper_removes_its_row() {
        let pool = test_pool().await;
        save(
            &pool,
            &Settings {
                wallpaper: "data:image/png;base64,iVBORw0KGgo=".into(),
                ..Settings::defaults()
            },
        )
        .await
        .expect("save");
        assert!(load_wallpaper(&pool).await.expect("read").is_some());

        let cleared = apply_patch(
            &pool,
            &SettingsPatch {
                wallpaper: Some(String::new()),
                ..Default::default()
            },
        )
        .await
        .expect("patch");

        assert_eq!(cleared.wallpaper, "", "the caller sees it gone");
        assert!(
            load_wallpaper(&pool).await.expect("read").is_none(),
            "an empty string should be deleted, not stored, so nothing is left to rediscover"
        );
        assert_eq!(load(&pool).await.expect("load").wallpaper, "");
    }

    #[tokio::test]
    async fn a_wallpaper_written_inside_the_blob_is_migrated_out_on_read() {
        let pool = test_pool().await;
        let wallpaper = "data:image/webp;base64,UklGRg==";

        // What a build from before the split left behind: the wallpaper inside
        // the `app` row, and no dedicated row at all.
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))",
        )
        .bind(SETTINGS_KEY)
        .bind(format!(
            r#"{{"provider":"ollama","theme":"night","wallpaper":"{wallpaper}"}}"#
        ))
        .execute(&pool)
        .await
        .expect("seed a pre-split row");

        let loaded = load(&pool).await.expect("load");
        assert_eq!(loaded.wallpaper, wallpaper, "the wallpaper is not lost");
        assert_eq!(loaded.theme, "night", "the rest of the row still loads");
        assert_eq!(
            load_wallpaper(&pool).await.expect("read").as_deref(),
            Some(wallpaper),
            "it should have been written to its own row"
        );
        assert!(
            !raw_blob(&pool).await.contains("UklGRg"),
            "the blob was not rewritten without the wallpaper, so it keeps being              parsed on every read"
        );
    }

    #[tokio::test]
    async fn the_dedicated_row_wins_over_a_stale_copy_left_in_the_blob() {
        let pool = test_pool().await;
        sqlx::query(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))",
        )
        .bind(SETTINGS_KEY)
        .bind(r#"{"theme":"light","wallpaper":"data:image/png;base64,STALE"}"#)
        .execute(&pool)
        .await
        .expect("seed");
        store_wallpaper(&pool, "data:image/png;base64,CURRENT")
            .await
            .expect("store");

        // The two should never disagree, but a hand-edited row can, and the
        // dedicated row is the one that gets written deliberately.
        assert_eq!(
            load(&pool).await.expect("load").wallpaper,
            "data:image/png;base64,CURRENT"
        );
    }

    #[tokio::test]
    async fn a_patch_touching_only_the_wallpaper_leaves_everything_else_alone() {
        // The P0-1 landmine: a settings write that only means to change one field
        // and blanks the rest. The reader's theme, font and density are in the
        // same row as the wallpaper.
        let pool = test_pool().await;
        save(
            &pool,
            &Settings {
                theme: "paper".into(),
                font: "Georgia".into(),
                density: "compact".into(),
                editor_texture: "linen".into(),
                ..Settings::defaults()
            },
        )
        .await
        .expect("save");

        let updated = apply_patch(
            &pool,
            &SettingsPatch {
                wallpaper: Some("data:image/png;base64,AAAA".into()),
                ..SettingsPatch::default()
            },
        )
        .await
        .expect("patch");
        assert_eq!(updated.wallpaper, "data:image/png;base64,AAAA");
        assert_eq!(
            updated.editor_texture, "linen",
            "the texture survived the patch"
        );
        assert_eq!(updated.font, "Georgia");
        assert_eq!(updated.density, "compact");
        assert_eq!(updated.theme, "paper");
    }

    #[tokio::test]
    async fn a_bad_image_setting_degrades_to_no_image_and_keeps_the_write() {
        // The requirement from P4-5: an unsupported or missing texture path must
        // not turn into an error. A reader whose wallpaper came from a build that
        // stored paths gets a flat surface and keeps their font.
        let pool = test_pool().await;
        save(
            &pool,
            &Settings {
                font: "Georgia".into(),
                ..Settings::defaults()
            },
        )
        .await
        .expect("save");

        for bad in [
            "/home/someone/wallpaper.png",
            "file:///home/someone/wallpaper.png",
            "asset://localhost/wallpaper.png",
            "https://example.com/wallpaper.png",
            "data:text/html;base64,PHNjcmlwdD4=",
        ] {
            let patched = apply_patch(
                &pool,
                &SettingsPatch {
                    wallpaper: Some(bad.into()),
                    editor_texture_data: Some(bad.into()),
                    ..SettingsPatch::default()
                },
            )
            .await
            .expect("a bad image must not fail the write");
            assert_eq!(patched.wallpaper, "", "{bad} should have been dropped");
            assert_eq!(
                patched.editor_texture_data, "",
                "{bad} should have been dropped"
            );
            assert_eq!(
                patched.font, "Georgia",
                "and the rest of the settings survived"
            );
        }
    }

    #[tokio::test]
    async fn an_oversized_image_setting_is_dropped_rather_than_stored() {
        let pool = test_pool().await;
        let huge = format!("data:image/png;base64,{}", "A".repeat(MAX_IMAGE_DATA_BYTES));
        let patched = apply_patch(
            &pool,
            &SettingsPatch {
                wallpaper: Some(huge),
                ..SettingsPatch::default()
            },
        )
        .await
        .expect("a write must not fail over an oversized wallpaper");
        assert_eq!(patched.wallpaper, "");
    }

    #[tokio::test]
    async fn a_hand_edited_image_setting_is_corrected_on_read() {
        // `merged_with` only runs on a write. A record that got into the table
        // some other way -- restored from a backup, edited by hand, written by a
        // future build -- has to be normalized on load too.
        let pool = test_pool().await;
        let raw = r#"{"theme":"light","wallpaper":"file:///tmp/wallpaper.png","editorTextureData":"data:text/html;base64,PHNjcmlwdD4=","surfaceAlpha":62,"scrim":20}"#;
        sqlx::query("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .bind(SETTINGS_KEY)
            .bind(raw)
            .execute(&pool)
            .await
            .expect("write a raw record");

        let loaded = load(&pool).await.expect("load");
        assert_eq!(
            loaded.wallpaper, "",
            "a file:// URL is not loadable by the webview"
        );
        assert_eq!(loaded.editor_texture_data, "");
        // And the numeric settings in the same record are kept: the correction is
        // per-field, not a reset.
        assert_eq!(loaded.surface_alpha, 62);
        assert_eq!(loaded.scrim, 20);
    }

    #[tokio::test]
    async fn the_two_sliders_are_clamped_rather_than_trusted() {
        // A range input cannot produce these, but a settings row can, and an
        // alpha of 4000 or -1 produces an invalid value that the browser drops,
        // leaving the panels neither opaque nor translucent and no way to tell
        // which from the settings screen.
        let pool = test_pool().await;
        let patched = apply_patch(
            &pool,
            &SettingsPatch {
                surface_alpha: Some(4000),
                scrim: Some(-40),
                ..SettingsPatch::default()
            },
        )
        .await
        .expect("patch");
        assert_eq!(patched.surface_alpha, 100);
        assert_eq!(patched.scrim, 0);
    }

    #[tokio::test]
    async fn a_record_from_before_the_image_settings_still_loads() {
        // The `#[serde(default)]` rule from the top of this file, applied to the
        // new fields. Without them, this record fails to parse and the reader
        // loses their theme and font on the next launch.
        let pool = test_pool().await;
        let raw = r#"{"provider":"Anthropic","model":"claude-3-5-sonnet","theme":"night","font":"Georgia","density":"compact","autosave":false,"spellcheck":true,"wordCount":true,"reduceMotion":true}"#;
        sqlx::query("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .bind(SETTINGS_KEY)
            .bind(raw)
            .execute(&pool)
            .await
            .expect("write a legacy record");

        let loaded = load(&pool).await.expect("load");
        assert_eq!(loaded.theme, "night");
        assert_eq!(loaded.font, "Georgia");
        assert!(!loaded.autosave, "an explicit false is not an absent field");
        assert_eq!(loaded.editor_texture, "");
        assert_eq!(loaded.surface_alpha, 100);
        assert_eq!(loaded.scrim, 0);
    }

    #[tokio::test]
    async fn the_texture_wash_distinguishes_unset_from_cleared() {
        // The whole reason this field is `Option<Option<f64>>`. A bare
        // `Option<f64>` could not tell "the reader never touched the slider"
        // from "the reader put it back to the theme default", and those are the
        // two values this field is allowed to hold apart from a number.
        let pool = test_pool().await;
        assert_eq!(
            Settings::defaults().texture_wash,
            None,
            "unset follows the theme"
        );

        // A number survives.
        let set = apply_patch(
            &pool,
            &SettingsPatch {
                texture_wash: Some(Some(0.25)),
                ..SettingsPatch::default()
            },
        )
        .await
        .expect("patch");
        assert_eq!(set.texture_wash, Some(0.25));
        assert_eq!(load(&pool).await.expect("load").texture_wash, Some(0.25));

        // So does being left alone.
        let untouched = apply_patch(
            &pool,
            &SettingsPatch {
                font: Some("Georgia".into()),
                ..SettingsPatch::default()
            },
        )
        .await
        .expect("patch");
        assert_eq!(
            untouched.texture_wash,
            Some(0.25),
            "an unrelated patch kept it"
        );

        // And so does being explicitly put back.
        let cleared = apply_patch(
            &pool,
            &SettingsPatch {
                texture_wash: Some(None),
                ..SettingsPatch::default()
            },
        )
        .await
        .expect("patch");
        assert_eq!(cleared.texture_wash, None);
        assert_eq!(load(&pool).await.expect("load").texture_wash, None);
    }

    #[tokio::test]
    async fn the_texture_wash_is_clamped_and_nan_falls_back_to_the_theme() {
        // NaN would otherwise be written into a stylesheet as
        // `calc((1 - NaN) * 100%)`, which the browser drops, leaving the page
        // with no veil and nothing on screen to explain it.
        let pool = test_pool().await;
        let high = apply_patch(
            &pool,
            &SettingsPatch {
                texture_wash: Some(Some(9.0)),
                ..SettingsPatch::default()
            },
        )
        .await
        .expect("patch");
        assert_eq!(high.texture_wash, Some(0.6));

        let low = apply_patch(
            &pool,
            &SettingsPatch {
                texture_wash: Some(Some(-4.0)),
                ..SettingsPatch::default()
            },
        )
        .await
        .expect("patch");
        assert_eq!(low.texture_wash, Some(0.0));

        let nan = apply_patch(
            &pool,
            &SettingsPatch {
                texture_wash: Some(Some(f64::NAN)),
                ..SettingsPatch::default()
            },
        )
        .await
        .expect("patch");
        assert_eq!(
            nan.texture_wash, None,
            "NaN is not a veil, it is a missing one"
        );
        assert_eq!(load(&pool).await.expect("load").texture_wash, None);
    }

    #[tokio::test]
    async fn a_record_written_before_the_wash_existed_still_loads() {
        let pool = test_pool().await;
        let raw = r#"{"theme":"paper","font":"Georgia","editorTexture":"linen","editorTextureData":"","wallpaper":"","surfaceAlpha":80,"scrim":10}"#;
        sqlx::query("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
            .bind(SETTINGS_KEY)
            .bind(raw)
            .execute(&pool)
            .await
            .expect("write");
        let loaded = load(&pool).await.expect("load");
        assert_eq!(loaded.texture_wash, None);
        assert_eq!(loaded.editor_texture, "linen");
        assert_eq!(loaded.surface_alpha, 80);
    }

    #[tokio::test]
    async fn defaults_are_returned_when_unset() {
        let pool = test_pool().await;
        let settings = load(&pool).await.expect("load should succeed");
        assert_eq!(settings.theme, "light");
        assert!(settings.autosave);
    }

    #[tokio::test]
    async fn settings_round_trip() {
        let pool = test_pool().await;
        let mut settings = Settings::defaults();
        settings.theme = "night".into();
        settings.reduce_motion = true;

        save(&pool, &settings).await.expect("save should succeed");
        let loaded = load(&pool).await.expect("load should succeed");

        assert_eq!(loaded.theme, "night");
        assert!(loaded.reduce_motion);
    }

    #[tokio::test]
    async fn corrupt_settings_fall_back_to_defaults() {
        let pool = test_pool().await;
        sqlx::query("INSERT INTO settings (key, value) VALUES ('app', 'not-json')")
            .execute(&pool)
            .await
            .expect("insert");

        let loaded = load(&pool)
            .await
            .expect("load should not fail on corrupt data");
        assert_eq!(loaded.theme, "light");
    }

    /// A record written before a field existed must load with the other fields
    /// intact. This is the regression that `#[serde(default)]` exists to
    /// prevent: without it, this deserialisation fails and every preference in
    /// the record is replaced by the defaults.
    ///
    /// The row also carries the `provider`/`model`/`endpoint` triple a
    /// pre-registry build wrote. Those keys are gone from `Settings`, and an
    /// unknown key has to be ignored rather than fail the parse -- otherwise the
    /// reader loses every preference they have the first time this build opens
    /// their old record.
    #[tokio::test]
    async fn a_record_missing_a_field_keeps_its_other_fields() {
        let pool = test_pool().await;
        // `reduceMotion` is the field a later build is assumed to have added.
        sqlx::query("INSERT INTO settings (key, value) VALUES ('app', ?1)")
            .bind(
                r#"{"provider":"Anthropic","model":"claude","endpoint":"https://example.test",
                "theme":"night","font":"Newsreader","density":"compact",
                "autosave":false,"spellcheck":false,"wordCount":true}"#,
            )
            .execute(&pool)
            .await
            .expect("insert partial record");

        let loaded = load(&pool).await.expect("load should succeed");

        // Fields present in the record survive.
        assert_eq!(loaded.theme, "night");
        assert_eq!(loaded.font, "Newsreader");
        assert_eq!(loaded.density, "compact");
        assert!(!loaded.autosave);
        assert!(!loaded.spellcheck);

        // The absent field takes its intended default, not `bool::default()`.
        assert!(loaded.word_count);
        assert!(!loaded.reduce_motion);
    }

    /// A bare `{}` must produce exactly the defaults, including the booleans
    /// that are `true` by default. Struct-level `#[serde(default)]` alone would
    /// give `false` here.
    #[tokio::test]
    async fn an_empty_object_yields_the_intended_defaults() {
        let pool = test_pool().await;
        sqlx::query("INSERT INTO settings (key, value) VALUES ('app', '{}')")
            .execute(&pool)
            .await
            .expect("insert empty object");

        let loaded = load(&pool).await.expect("load should succeed");
        let defaults = Settings::defaults();

        assert_eq!(loaded.theme, defaults.theme);
        assert_eq!(loaded.font, defaults.font);
        assert_eq!(loaded.density, defaults.density);
        assert_eq!(loaded.autosave, defaults.autosave);
        assert_eq!(loaded.spellcheck, defaults.spellcheck);
        assert_eq!(loaded.word_count, defaults.word_count);
        assert_eq!(loaded.reduce_motion, defaults.reduce_motion);
    }

    /// Round-trips a value that omits several optional fields.
    #[tokio::test]
    async fn settings_round_trip_omitting_optional_fields() {
        let pool = test_pool().await;
        let mut settings = Settings::defaults();
        settings.theme = "paper".into();
        settings.editor_texture = "paper-grain".into();

        save(&pool, &settings).await.expect("save should succeed");
        let loaded = load(&pool).await.expect("load should succeed");

        assert_eq!(loaded.theme, "paper");
        assert_eq!(loaded.editor_texture, "paper-grain");
        // Untouched fields keep their defaults through the JSON round trip.
        assert_eq!(loaded.font, "Arial");
        assert!(loaded.autosave);
    }

    #[tokio::test]
    async fn patch_leaves_omitted_fields_untouched() {
        let pool = test_pool().await;
        let mut settings = Settings::defaults();
        settings.theme = "night".into();
        settings.font = "Newsreader".into();
        settings.density = "compact".into();
        save(&pool, &settings).await.expect("save should succeed");

        let patch = SettingsPatch {
            theme: Some("paper".into()),
            ..SettingsPatch::default()
        };
        let updated = apply_patch(&pool, &patch)
            .await
            .expect("patch should succeed");

        assert_eq!(updated.theme, "paper");
        assert_eq!(updated.font, "Newsreader");
        assert_eq!(updated.density, "compact");
    }

    #[tokio::test]
    async fn patch_can_clear_a_field_to_an_explicit_empty_string() {
        let pool = test_pool().await;
        let mut settings = Settings::defaults();
        settings.editor_texture = "paper-grain".into();
        save(&pool, &settings).await.expect("save should succeed");

        let patch = SettingsPatch {
            editor_texture: Some(String::new()),
            ..SettingsPatch::default()
        };
        let updated = apply_patch(&pool, &patch)
            .await
            .expect("patch should succeed");

        // `editorTexture` has no non-empty repair in `load`, so it stays cleared.
        assert_eq!(updated.editor_texture, "");
    }

    #[tokio::test]
    async fn patch_can_turn_a_true_default_off() {
        let pool = test_pool().await;
        let patch = SettingsPatch {
            autosave: Some(false),
            spellcheck: Some(false),
            ..SettingsPatch::default()
        };

        let updated = apply_patch(&pool, &patch)
            .await
            .expect("patch should succeed");

        // `Some(false)` must be distinguishable from "not mentioned".
        assert!(!updated.autosave);
        assert!(!updated.spellcheck);
        assert!(updated.word_count);
    }

    #[tokio::test]
    async fn patch_against_no_existing_row_starts_from_defaults() {
        let pool = test_pool().await;
        let patch = SettingsPatch {
            theme: Some("night".into()),
            ..SettingsPatch::default()
        };

        let updated = apply_patch(&pool, &patch)
            .await
            .expect("patch should succeed");

        assert_eq!(updated.theme, "night");
        assert_eq!(updated.font, "Arial");
        assert!(updated.autosave);
    }
}

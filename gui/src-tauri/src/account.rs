//! The signed-in account, as this device knows it.
//!
//! This is a local mirror, not a session. The token lives in the OS keyring
//! and the password is never stored at all, so what is kept here is only what is
//! needed to show "who am I" and "am I syncing" on an offline start.

use serde::Serialize;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::pocketbase::{Account, PocketBase};
use crate::secrets;
use sqlx::SqlitePool;

/// What the UI needs to render the account area and the sync state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountState {
    /// False when nobody is signed in, which is the normal state for a reader
    /// who only ever wanted a local notebook.
    pub signed_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
    /// Whether the server answered the last time we asked. `false` with
    /// `signed_in: true` means the mirror is stale and the UI should say so
    /// rather than implying everything is current.
    pub online: bool,
    pub sync_enabled: bool,
    pub base_url: String,
}

/// Reads the endpoint and the opt-in flag, seeding the row on first run.
pub async fn read_config(pool: &SqlitePool) -> AppResult<(String, bool)> {
    if let Some(row) = sqlx::query_as::<_, (String, i64)>(
        "SELECT base_url, sync_enabled FROM sync_config WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?
    {
        return Ok((row.0, row.1 == 1));
    }
    // First run: seed from the build-time default.
    let url = option_env!("VITE_POCKETBASE_URL").unwrap_or("http://127.0.0.1:8090");
    sqlx::query("INSERT INTO sync_config (id, base_url, sync_enabled) VALUES (1, ?, 0)")
        .bind(url)
        .execute(pool)
        .await?;
    Ok((url.to_string(), false))
}

/// Points this device at a different deployment and optionally turns sync on.
///
/// This is a full overwrite, not a patch, and the command it backs is named
/// `sync_config_write` for that reason. A caller that wants to flip the toggle
/// must echo the current `base_url` back, or it blanks the endpoint it is
/// preserving. That is the caller's problem, but the row's existence is this
/// function's: `read_config` seeds a row on first read, so in practice one exists
/// -- but a database that lost the row, or a test that never called
/// `read_config`, previously got a silent success from an `UPDATE` that matched
/// nothing.
///
/// `INSERT ... ON CONFLICT DO UPDATE` removes the possibility rather than
/// reporting it: one statement, correct whether or not the row is there, and the
/// value written is still validated first.
pub async fn write_config(pool: &SqlitePool, base_url: &str, sync_enabled: bool) -> AppResult<()> {
    let url = base_url.trim();
    if url.is_empty() {
        return Err(AppError::Validation(
            "the sync address cannot be empty".into(),
        ));
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::Validation(
            "the sync address must start with http:// or https://".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO sync_config (id, base_url, sync_enabled, updated_at)
         VALUES (1, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           base_url = excluded.base_url,
           sync_enabled = excluded.sync_enabled,
           updated_at = datetime('now')",
    )
    .bind(url.trim_end_matches('/'))
    .bind(i64::from(sync_enabled))
    .execute(pool)
    .await?;
    Ok(())
}

async fn read_mirror(pool: &SqlitePool) -> AppResult<Option<Account>> {
    let row = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT id, email, name, workspace_id FROM account LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id, email, name, workspace)| Account {
        id,
        email,
        name,
        workspace,
    }))
}

async fn write_mirror(pool: &SqlitePool, account: &Account) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO account (id, email, name, workspace_id, sync_state, last_synced_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'local_only', datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email,
           name = excluded.name,
           workspace_id = excluded.workspace_id,
           sync_state = 'local_only',
           last_synced_at = datetime('now'),
           updated_at = datetime('now')",
    )
    .bind(&account.id)
    .bind(&account.email)
    .bind(&account.name)
    .bind(&account.workspace)
    .execute(pool)
    .await?;
    Ok(())
}

async fn clear_mirror(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query("DELETE FROM account").execute(pool).await?;
    Ok(())
}

/// The keyring slot holding the PocketBase token for an account.
///
/// The existing `secrets` module keys slots by a provider name, so the token
/// reuses that store with a `pocketbase:` prefix. Sharing one credential store
/// is better than adding a second, and `secrets_meta` then tracks the token's
/// age for free.
fn token_slot(account_id: &str) -> String {
    format!("pocketbase:{account_id}")
}

/// The current account state, tolerant of an absent server.
///
/// An unreachable server is not an error here. It flips `online` to false and
/// returns whatever the mirror holds, which is the entire point of mirroring it.
pub async fn state(pool: &SqlitePool) -> AppResult<AccountState> {
    let (base_url, sync_enabled) = read_config(pool).await?;
    let account = read_mirror(pool).await?;
    let online = if sync_enabled {
        PocketBase::new(&base_url)?.is_reachable().await
    } else {
        false
    };
    Ok(AccountState {
        signed_in: account.is_some(),
        account,
        online,
        sync_enabled,
        base_url,
    })
}

/// Creates the remote account, then signs in so a token exists.
///
/// PocketBase does not return a token from record creation, so the sign-in is
/// not redundant. The password is used twice here and never stored.
pub async fn sign_up(
    pool: &SqlitePool,
    email: &str,
    password: &str,
    name: &str,
) -> AppResult<AccountState> {
    let email = email.trim();
    if email.is_empty() || !email.contains('@') {
        return Err(AppError::Validation(
            "that does not look like an email address".into(),
        ));
    }
    validate_password(password)?;

    let (base_url, _) = read_config(pool).await?;
    let client = PocketBase::new(&base_url)?;
    client.sign_up(email, password, name.trim()).await?;
    let (token, account) = client.sign_in(email, password).await?;

    secrets::set(pool, &token_slot(&account.id), &token).await?;
    write_mirror(pool, &account).await?;
    state(pool).await
}

/// Exchanges credentials for a token and stores it.
pub async fn sign_in(pool: &SqlitePool, email: &str, password: &str) -> AppResult<AccountState> {
    let (base_url, _) = read_config(pool).await?;
    let client = PocketBase::new(&base_url)?;
    let (token, account) = client.sign_in(email.trim(), password).await?;

    secrets::set(pool, &token_slot(&account.id), &token).await?;
    write_mirror(pool, &account).await?;
    state(pool).await
}

/// Renews the stored token, keeping a session alive without the password.
///
/// Falls back to the existing token if the server is unreachable, because a
/// network blip is not a reason to sign someone out.
pub async fn refresh(pool: &SqlitePool) -> AppResult<AccountState> {
    let account = read_mirror(pool)
        .await?
        .ok_or_else(|| AppError::Validation("nobody is signed in".into()))?;
    let token = secrets::read_for_job(&token_slot(&account.id))
        .await
        .map_err(|_| {
            AppError::Validation("the stored session has expired; sign in again".into())
        })?;

    let (base_url, _) = read_config(pool).await?;
    let client = PocketBase::new(&base_url)?;
    match client.refresh(&token).await {
        Ok((token, account)) => {
            secrets::set(pool, &token_slot(&account.id), &token).await?;
            write_mirror(pool, &account).await?;
        }
        Err(AppError::Offline) => return state(pool).await,
        Err(e) => return Err(e),
    }
    state(pool).await
}

/// Forgets the session locally. The token is destroyed; the remote account is
/// untouched, because a sign-out is a local act and deleting someone's writing
/// is not something a button labelled "Sign out" should do.
pub async fn sign_out(pool: &SqlitePool) -> AppResult<AccountState> {
    if let Some(account) = read_mirror(pool).await? {
        let _ = secrets::delete(pool, &token_slot(&account.id)).await;
    }
    clear_mirror(pool).await?;
    state(pool).await
}

fn validate_password(password: &str) -> AppResult<()> {
    if password.chars().count() < 10 {
        return Err(AppError::Validation(
            "use at least 10 characters for the password".into(),
        ));
    }
    Ok(())
}

// --- user-created themes ---------------------------------------------------

/// A palette the reader defined. Tokens are CSS custom property names.
///
/// `theme_id` is pinned to snake_case on the wire, against this struct's
/// `camelCase` default, and the reason is that every reader of it is JavaScript
/// that already speaks `theme_id`: `resolveTheme` matches on it, `ThemePicker`
/// keys its cards on it, `slugify.js` mirrors the Rust derivation of it, and
/// `settings::normalize_theme` agrees with it. Letting the derive rename it to
/// `themeId` made all six of those silently fail to match, so
/// `resolveTheme` fell through to the light built-in: every saved theme listed
/// as "Light", and picking one quietly repainted the whole app in the light
/// theme while the settings row still said `midnight`.
///
/// Nothing tested it, because the JS test harness mocked this command with
/// `theme_id` -- the harness agreed with the JavaScript and disagreed with the
/// Rust, so 200-odd green tests described an API that no runtime ever returned.
/// `tests/custom-theme-contract.test.mjs` and the assertion below pin the same
/// field list on both sides.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomTheme {
    #[serde(rename = "theme_id")]
    pub theme_id: String,
    pub name: String,
    pub tokens: Value,
    pub mode: String,
}

/// The id a theme is stored under, derived from its name.
///
/// `pub(crate)` rather than private because the id is a contract in two places,
/// not one: `save_theme` derives it, and `settings::normalize_theme` has to
/// agree that a given row is the theme a settings record is pointing at. It also
/// has to match `slugify` in `src/library/slugify.js` exactly, because the
/// browser fallback derives the same id in JavaScript and a divergence would
/// give the same theme two ids depending on the runtime.
pub(crate) fn slugify(value: &str) -> String {
    let slug: String = value
        .to_lowercase()
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug: String = slug
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "custom-theme".into()
    } else {
        slug
    }
}

pub async fn list_themes(pool: &SqlitePool) -> AppResult<Vec<CustomTheme>> {
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT theme_id, name, tokens_json, mode FROM custom_themes ORDER BY created_at",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(theme_id, name, tokens, mode)| CustomTheme {
            theme_id,
            name,
            tokens: serde_json::from_str(&tokens).unwrap_or(Value::Object(Default::default())),
            mode,
        })
        .collect())
}

pub async fn save_theme(
    pool: &SqlitePool,
    name: &str,
    tokens: Value,
    mode: &str,
) -> AppResult<CustomTheme> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("give the theme a name".into()));
    }
    if !tokens.is_object() {
        return Err(AppError::Validation(
            "a theme must be a set of colour tokens".into(),
        ));
    }
    if mode != "light" && mode != "dark" {
        return Err(AppError::Validation(
            "a theme is either light or dark".into(),
        ));
    }
    let theme_id = slugify(name);
    sqlx::query(
        "INSERT INTO custom_themes (theme_id, name, tokens_json, mode) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(theme_id) DO UPDATE SET
           name = excluded.name, tokens_json = excluded.tokens_json,
           mode = excluded.mode, updated_at = datetime('now')",
    )
    .bind(&theme_id)
    .bind(name)
    .bind(tokens.to_string())
    .bind(mode)
    .execute(pool)
    .await?;
    Ok(CustomTheme {
        theme_id,
        name: name.to_string(),
        tokens,
        mode: mode.to_string(),
    })
}

pub async fn delete_theme(pool: &SqlitePool, theme_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM custom_themes WHERE theme_id = ?1")
        .bind(theme_id)
        .execute(pool)
        .await?;
    Ok(())
}

// --- onboarding state -------------------------------------------------------

/// Reads a value from the first-run state, or `default` when absent.
pub async fn onboarding_value(pool: &SqlitePool, key: &str, default: &str) -> AppResult<String> {
    let row = sqlx::query_scalar::<_, String>("SELECT value FROM onboarding_state WHERE key = ?1")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.unwrap_or_else(|| default.to_string()))
}

/// Writes a value into the first-run state.
pub async fn set_onboarding_value(pool: &SqlitePool, key: &str, value: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO onboarding_state (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

/// Reconciles the `completed` flag against what the database actually holds.
///
/// Migration `0002` inserts `completed = 'false'` unconditionally, and it runs
/// against every database it touches -- including installs that already had
/// documents. Taken literally that means every existing reader is shown a
/// welcome card on their next launch, which is the kind of regression that gets
/// filed as "your update made my app nag me".
///
/// So: documents present and onboarding not completed means this database
/// predates the onboarding feature, and the reader has already been onboarded by
/// using the app. Mark it complete and stay quiet. No documents means a genuine
/// first run, and `false` is already right.
///
/// Returns whether anything was written, so a caller can say so in a log without
/// re-reading the row.
///
/// This deliberately takes the count as an argument rather than counting rows
/// itself. The caller already counted them for `bootstrap`, and counting twice
/// would give two answers if the database is failing.
pub async fn reconcile_onboarding_completed(
    pool: &SqlitePool,
    document_count: i64,
) -> AppResult<bool> {
    let completed = onboarding_value(pool, "completed", "false").await?;
    if completed == "true" {
        return Ok(false);
    }
    if document_count <= 0 {
        return Ok(false);
    }
    set_onboarding_value(pool, "completed", "true").await?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    async fn seed_document(pool: &SqlitePool, id: &str) {
        sqlx::query("INSERT INTO documents (id, title) VALUES (?1, ?2)")
            .bind(id)
            .bind("An existing note")
            .execute(pool)
            .await
            .expect("seed a document");
    }

    /// The upgrade path, and the reason P5-0 exists. Migration 0002 seeds
    /// `completed = 'false'` into every database it touches, so an install that
    /// already had a library is handed "you have never been here" and shows the
    /// welcome card to a reader who did not ask for it.
    #[tokio::test]
    async fn an_existing_library_is_not_a_first_run() {
        let pool = test_pool().await;
        seed_document(&pool, "doc-1").await;

        assert_eq!(
            onboarding_value(&pool, "completed", "true").await.unwrap(),
            "false",
            "the migration seeds this false for everyone, which is the bug"
        );

        assert!(reconcile_onboarding_completed(&pool, 1).await.unwrap());
        assert_eq!(
            onboarding_value(&pool, "completed", "true").await.unwrap(),
            "true"
        );

        // And it is stable: a second launch must not flip it back, and must not
        // claim to have done anything.
        assert!(!reconcile_onboarding_completed(&pool, 1).await.unwrap());
        assert_eq!(
            onboarding_value(&pool, "completed", "true").await.unwrap(),
            "true"
        );
    }

    #[tokio::test]
    async fn an_empty_library_still_sees_onboarding() {
        let pool = test_pool().await;
        assert!(!reconcile_onboarding_completed(&pool, 0).await.unwrap());
        assert_eq!(
            onboarding_value(&pool, "completed", "true").await.unwrap(),
            "false",
            "a genuine first run is left alone"
        );
    }

    /// A reader who has genuinely finished onboarding must never be un-completed
    /// by a library that happens to be non-empty.
    #[tokio::test]
    async fn a_completed_reader_is_never_reopened() {
        let pool = test_pool().await;
        seed_document(&pool, "doc-1").await;
        set_onboarding_value(&pool, "completed", "true")
            .await
            .unwrap();

        assert!(!reconcile_onboarding_completed(&pool, 1).await.unwrap());
        assert_eq!(
            onboarding_value(&pool, "completed", "true").await.unwrap(),
            "true"
        );
    }

    /// Counted rows exclude soft-deleted documents, because that is the query
    /// bootstrap runs. A library where every document is in the trash is, for
    /// onboarding's purposes, a library that existed.
    #[tokio::test]
    async fn a_library_of_deleted_documents_is_still_an_existing_one() {
        let pool = test_pool().await;
        seed_document(&pool, "doc-1").await;
        sqlx::query("UPDATE documents SET deleted_at = datetime('now') WHERE id = ?1")
            .bind("doc-1")
            .execute(&pool)
            .await
            .expect("soft delete");

        let live: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(live, 0);
        assert!(!reconcile_onboarding_completed(&pool, live).await.unwrap());
        assert_eq!(
            onboarding_value(&pool, "completed", "true").await.unwrap(),
            "false",
            "the count the caller passes in is the live count, and this documents that"
        );
    }

    /// The field list on the wire is a contract with the JavaScript, and every
    /// reader of it matches on `theme_id`. Deriving it as `themeId` broke all of
    /// them at once and nothing noticed, so it is pinned here -- in Rust, next to
    /// the derive that got it wrong. The JavaScript half of the same pin is
    /// `tests/custom-theme-contract.test.mjs`.
    #[test]
    fn a_custom_theme_serialises_with_the_field_names_the_javascript_matches_on() {
        let theme = CustomTheme {
            theme_id: "midnight".into(),
            name: "Midnight".into(),
            tokens: serde_json::json!({ "--main": "#000" }),
            mode: "dark".into(),
        };
        let json = serde_json::to_value(&theme).expect("serialise");

        // Sorted, because `serde_json::Map` is a `BTreeMap` and hands back the
        // keys alphabetically. What matters is the set of names, not the order
        // the struct declares them in.
        let mut keys: Vec<&str> = json
            .as_object()
            .expect("an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["mode", "name", "theme_id", "tokens"],
            "the wire field names the frontend matches on"
        );
        assert_eq!(json["theme_id"], "midnight");
        // The regression itself, so the intent survives a well-meaning rename.
        assert!(
            json.get("themeId").is_none(),
            "camelCase here silently disabled every custom theme"
        );
    }

    #[test]
    fn slugs_are_stable_and_safe() {
        assert_eq!(slugify("  Quiet Interfaces  "), "quiet-interfaces");
        assert_eq!(slugify("Midnight / Blue"), "midnight-blue");
        assert_eq!(slugify("!!!"), "custom-theme");
        // Anything outside [a-z0-9] becomes a separator, including accented
        // characters. That is deliberate: the slug is a CSS-safe identifier and a
        // storage key, so folding accents would be a nicety with a real risk of
        // two different names colliding onto one theme.
        assert_eq!(slugify("Ünïcode Ok"), "n-code-ok");
    }

    /// P6-7. The write used to be `UPDATE`-only, so a database with no
    /// `sync_config` row reported success and changed nothing -- and a caller
    /// that flipped the toggle was told it had worked.
    #[tokio::test]
    async fn writing_the_config_works_even_with_no_row_to_update() {
        let pool = test_pool().await;
        sqlx::query("DELETE FROM sync_config")
            .execute(&pool)
            .await
            .expect("remove the row");

        write_config(&pool, "https://sync.example.com/", true)
            .await
            .expect("write");

        let (url, enabled) = read_config(&pool).await.expect("read back");
        assert_eq!(
            url, "https://sync.example.com",
            "a trailing slash is trimmed"
        );
        assert!(enabled, "and the flag was written, not silently dropped");
    }

    #[tokio::test]
    async fn the_config_is_a_full_overwrite_and_says_so() {
        // The JS side has to echo `baseUrl` back when it flips the toggle. This
        // pins the behaviour that makes that necessary, so nobody "fixes" it into
        // a partial update and breaks a caller that relies on the overwrite.
        let pool = test_pool().await;
        write_config(&pool, "https://one.example.com", false)
            .await
            .expect("first");
        write_config(&pool, "https://two.example.com", true)
            .await
            .expect("second");

        let (url, enabled) = read_config(&pool).await.expect("read back");
        assert_eq!(url, "https://two.example.com");
        assert!(enabled);
    }

    #[tokio::test]
    async fn an_unusable_address_is_refused_before_it_is_stored() {
        let pool = test_pool().await;
        let (before, _) = read_config(&pool).await.expect("read before");

        for bad in ["", "   ", "sync.example.com", "ftp://sync.example.com"] {
            assert!(
                write_config(&pool, bad, true).await.is_err(),
                "{bad:?} should be refused"
            );
        }

        let (after, enabled) = read_config(&pool).await.expect("read after");
        assert_eq!(
            after, before,
            "a refused write leaves the stored address alone"
        );
        assert!(!enabled, "and does not turn sync on as a side effect");
    }

    #[test]
    fn a_short_password_is_refused_before_any_request() {
        assert!(validate_password("short").is_err());
        assert!(validate_password("long-enough-password").is_ok());
    }
}

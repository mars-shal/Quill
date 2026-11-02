use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

const SERVICE: &str = "app.quill.workspace";

/// Every credential slot is namespaced by this prefix and keyed by the provider's
/// registry **id**, never its display name.
///
/// The previous scheme used the display name verbatim, which is three bugs in
/// one: renaming a provider orphaned its credential with no way to find it,
/// every custom endpoint shared the single slot `"Custom endpoint"` so the
/// second one overwrote the first, and a display name containing a character the
/// keyring rejects failed at an unrelated-looking moment.
const SLOT_PREFIX: &str = "provider:";

/// Display names the pre-registry build wrote credentials under, mapped to the
/// registry id that now owns them. Used once, on first read, so an existing
/// install does not have to re-enter a key it already saved.
const LEGACY_SLOTS: [(&str, &str); 4] = [
    ("OpenAI", "openai"),
    ("Anthropic", "anthropic"),
    ("Google", "google"),
    ("Custom endpoint", "custom"),
];

/// The keyring account a provider's credential lives in.
pub fn slot_for(id: &str) -> String {
    format!("{SLOT_PREFIX}{id}")
}

/// A provider profile as seen by the UI. The credential itself is never
/// returned to the frontend; only whether a credential is present.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub provider: String,
    pub has_credential: bool,
    pub updated_at: Option<String>,
}

/// Swaps in the crate's in-memory credential store, once per test binary.
///
/// Without this a test that stores a key writes to the machine's real OS
/// keyring, under the very same service name the app uses -- so running the
/// suite replaces a live provider credential with whatever fixture the test
/// happened to hand over, and the app then fails to authenticate against a
/// vendor using a string like `sk-from-env`. The in-memory store keeps the
/// value inside the entry that wrote it, so nothing reaches the platform.
#[cfg(test)]
fn use_mock_credential_store() {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    });
}

fn entry(slot: &str) -> AppResult<keyring::Entry> {
    #[cfg(test)]
    use_mock_credential_store();
    keyring::Entry::new(SERVICE, slot)
        .map_err(|e| AppError::Keyring(format!("could not open credential store: {e}")))
}

/// Stores a provider credential in the OS credential store and records only
/// metadata locally. The secret is never written to SQLite, logs, or IPC
/// responses after this call returns.
pub async fn set(pool: &SqlitePool, provider: &str, secret: &str) -> AppResult<SecretStatus> {
    if provider.trim().is_empty() {
        return Err(AppError::Validation("provider must not be empty".into()));
    }
    if secret.is_empty() {
        return Err(AppError::Validation("secret must not be empty".into()));
    }

    let slot = slot_for(provider);
    entry(&slot)?.set_password(secret)?;

    record_meta(pool, &slot).await?;

    Ok(SecretStatus {
        provider: provider.to_string(),
        has_credential: true,
        updated_at: Some(chrono::Utc::now().to_rfc3339()),
    })
}

/// Records that a credential exists, without storing the credential itself.
///
/// Separate from [`set`] so the metadata layer can be tested without an OS
/// credential store. The conflict target must be the full primary key: the auth
/// token and the provider keys are all written under the same `SERVICE` name and
/// differ only by account slot, so upserting on `service` alone would collapse
/// them into one row. That was the bug migration 0003 fixed.
async fn record_meta(pool: &SqlitePool, account: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO secrets_meta (service, account, updated_at)
         VALUES (?1, ?2, datetime('now'))
         ON CONFLICT (service, account)
         DO UPDATE SET updated_at = datetime('now')",
    )
    .bind(SERVICE)
    .bind(account)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn status(pool: &SqlitePool, provider: &str) -> AppResult<SecretStatus> {
    let slot = slot_for(provider);
    let has_credential = entry(&slot)?.get_password().is_ok();

    let updated_at: Option<String> = sqlx::query_scalar(
        "SELECT updated_at FROM secrets_meta WHERE service = ?1 AND account = ?2",
    )
    .bind(SERVICE)
    .bind(&slot)
    .fetch_optional(pool)
    .await?;

    Ok(SecretStatus {
        provider: provider.to_string(),
        has_credential,
        updated_at,
    })
}

pub async fn delete(pool: &SqlitePool, provider: &str) -> AppResult<()> {
    let slot = slot_for(provider);
    let _ = entry(&slot)?.delete_credential();

    sqlx::query("DELETE FROM secrets_meta WHERE service = ?1 AND account = ?2")
        .bind(SERVICE)
        .bind(&slot)
        .execute(pool)
        .await?;

    Ok(())
}

/// Reads the credential for use by an outbound request. This is intentionally
/// not exposed as a Tauri command; only in-process callers may call it.
///
/// Falls back to the pre-registry display-name slot so a key saved before the
/// registry existed still works without the reader being asked to retype it.
pub async fn read_for_job(provider: &str) -> AppResult<String> {
    let slot = slot_for(provider);
    if let Ok(secret) = entry(&slot)?.get_password() {
        return Ok(secret);
    }
    for (legacy_name, legacy_id) in LEGACY_SLOTS {
        if legacy_id == provider {
            if let Ok(secret) = entry(legacy_name)?.get_password() {
                return Ok(secret);
            }
        }
    }
    Err(AppError::Keyring(format!(
        "no credential stored for {provider} (looked in {slot})"
    )))
}

/// Reads the credential a request to `base_url` will actually be sent with.
///
/// A local server (`ollama`, LM Studio) has no key on purpose: its endpoint is
/// on loopback and there is nobody to bill. Treating that as "no credential"
/// made a perfectly working local model unusable -- the model list refused to
/// load and a run stopped before it started -- so an endpoint on this machine
/// resolves to an empty key instead of an error, and the request is sent with
/// no `Authorization` header at all.
///
/// The exemption is the address, not the provider's id. A row named `ollama`
/// pointed at a hosted gateway still needs a key, and a row with any other name
/// pointed at localhost still does not.
pub async fn read_for_provider(provider: &str, base_url: &str) -> AppResult<String> {
    match read_for_job(provider).await {
        Ok(secret) => Ok(secret),
        Err(_) if is_loopback_endpoint(base_url) => Ok(String::new()),
        Err(error) => Err(error),
    }
}

/// Whether a base URL names a server on this machine.
fn is_loopback_endpoint(base_url: &str) -> bool {
    let trimmed = base_url.trim();
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or(trimmed);
    // Credentials in the authority (`http://user:pass@host`) are not a host.
    let authority = without_scheme
        .split('/')
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    let host = if let Some(rest) = authority.strip_prefix('[') {
        rest.split(']').next().unwrap_or_default().to_string()
    } else {
        authority.split(':').next().unwrap_or_default().to_string()
    };
    matches!(host.as_str(), "localhost" | "::1" | "0.0.0.0")
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
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

    async fn meta_row_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM secrets_meta")
            .fetch_one(pool)
            .await
            .expect("count rows")
    }

    /// The regression. Every credential is written under the same `SERVICE`
    /// constant, so a `service`-only primary key left the table able to hold a
    /// single row: signing in first made every later provider key collide onto
    /// the auth row and inherit its `account` value.
    #[tokio::test]
    async fn two_credentials_sharing_a_service_get_their_own_rows() {
        let pool = test_pool().await;

        // The auth token and a provider key, exactly as account.rs writes them.
        record_meta(&pool, "token:acc_123")
            .await
            .expect("record token");
        record_meta(&pool, "OpenAI").await.expect("record provider");

        assert_eq!(meta_row_count(&pool).await, 2);
    }

    /// Re-recording the same slot must update it in place, not add a row.
    #[tokio::test]
    async fn re_recording_a_slot_updates_instead_of_duplicating() {
        let pool = test_pool().await;

        record_meta(&pool, "OpenAI").await.expect("first");
        record_meta(&pool, "OpenAI").await.expect("second");
        record_meta(&pool, "OpenAI").await.expect("third");

        assert_eq!(meta_row_count(&pool).await, 1);
    }

    /// Each slot keeps its own timestamp, so a provider key's age is not
    /// reported as the auth token's.
    ///
    /// `datetime('now')` has one-second resolution, so the token row is
    /// written first and then backdated before the provider key is stored.
    #[tokio::test]
    async fn each_slot_keeps_its_own_updated_at() {
        let pool = test_pool().await;

        record_meta(&pool, "token:acc_123")
            .await
            .expect("record token");

        sqlx::query("UPDATE secrets_meta SET updated_at = '2000-01-01 00:00:00'")
            .execute(&pool)
            .await
            .expect("backdate the token row");

        record_meta(&pool, "OpenAI").await.expect("record provider");

        let token_at: String = sqlx::query_scalar(
            "SELECT updated_at FROM secrets_meta WHERE service = ?1 AND account = ?2",
        )
        .bind(SERVICE)
        .bind("token:acc_123")
        .fetch_one(&pool)
        .await
        .expect("token row");

        let provider_at: String = sqlx::query_scalar(
            "SELECT updated_at FROM secrets_meta WHERE service = ?1 AND account = ?2",
        )
        .bind(SERVICE)
        .bind("OpenAI")
        .fetch_one(&pool)
        .await
        .expect("provider row");

        // The provider key is the newer credential, so it must not report the
        // token's backdated age.
        assert_eq!(token_at, "2000-01-01 00:00:00");
        assert_ne!(token_at, provider_at);
    }

    /// The migration has to preserve rows written by an older build rather than
    /// dropping the metadata of whoever had already signed in.
    ///
    /// Runs the real shipped SQL from the migration file, after rolling the
    /// schema back to the single-column-primary-key shape.
    #[tokio::test]
    async fn migration_0003_preserves_existing_rows() {
        let pool = test_pool().await;

        // Roll `secrets_meta` back to the pre-0003 shape, the way a database
        // written by an older build would look.
        sqlx::query("DROP TABLE secrets_meta")
            .execute(&pool)
            .await
            .expect("drop the migrated table");
        sqlx::query(
            "CREATE TABLE secrets_meta (
                 service    TEXT PRIMARY KEY NOT NULL,
                 account    TEXT NOT NULL,
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             )",
        )
        .execute(&pool)
        .await
        .expect("create legacy table");

        sqlx::query(
            "INSERT INTO secrets_meta (service, account, created_at, updated_at)
             VALUES (?1, 'token:acc_legacy', '2020-01-01 00:00:00', '2020-01-01 00:00:00')",
        )
        .bind(SERVICE)
        .execute(&pool)
        .await
        .expect("seed legacy row");

        // The actual migration file, not a paraphrase of it.
        sqlx::raw_sql(include_str!(
            "../migrations/0003_secrets_meta_composite_key.sql"
        ))
        .execute(&pool)
        .await
        .expect("migration 0003 should apply cleanly");

        let account: String = sqlx::query_scalar(
            "SELECT account FROM secrets_meta WHERE service = ?1 AND account = ?2",
        )
        .bind(SERVICE)
        .bind("token:acc_legacy")
        .fetch_optional(&pool)
        .await
        .expect("query row")
        .expect("the legacy row must survive migration 0003");

        assert_eq!(account, "token:acc_legacy");

        // And the rebuilt table now accepts a second slot, which is the whole
        // point of the migration.
        sqlx::query(
            "INSERT INTO secrets_meta (service, account, updated_at)
             VALUES (?1, 'OpenAI', datetime('now'))",
        )
        .bind(SERVICE)
        .execute(&pool)
        .await
        .expect("the composite key must allow a second row");

        assert_eq!(meta_row_count(&pool).await, 2);
    }
}

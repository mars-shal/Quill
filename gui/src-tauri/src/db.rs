use std::path::PathBuf;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Applies pending schema migrations to an existing pool.
///
/// Exposed so examples and integration checks can build a schema without
/// duplicating the migration definition.
pub async fn apply_migrations(pool: &SqlitePool) -> AppResult<()> {
    MIGRATOR.run(pool).await?;
    Ok(())
}

/// Absolute path to the local canonical database.
///
/// This is the single source of truth. PocketBase is a remote replica only.
pub fn database_path() -> AppResult<PathBuf> {
    let base = dirs::data_dir()
        .ok_or_else(|| AppError::Other("could not resolve user data directory".into()))?
        .join("app.quill.workspace");
    std::fs::create_dir_all(&base)
        .map_err(|e| AppError::Other(format!("could not create data directory: {e}")))?;
    Ok(base.join("quill.db"))
}

pub async fn init_pool() -> AppResult<SqlitePool> {
    let path = database_path()?;

    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect_with(options)
        .await?;

    MIGRATOR.run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrations_apply_to_a_fresh_database() {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("in-memory database should open");

        MIGRATOR
            .run(&pool)
            .await
            .expect("migrations should apply cleanly");

        let tables: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
                .fetch_all(&pool)
                .await
                .expect("should be able to list tables");

        for expected in [
            "documents",
            "settings",
            "secrets_meta",
            // From 0002: the account mirror, the endpoint configuration, the
            // reader's own palettes and the first-run state.
            "account",
            "sync_config",
            "custom_themes",
            "onboarding_state",
        ] {
            assert!(
                tables.iter().any(|t| t == expected),
                "expected table {expected}, found {tables:?}"
            );
        }
    }

    /// Sync must be off until the reader asks for it.
    ///
    /// A person who only ever wanted a local notebook should not have their
    /// documents uploaded because an app update turned replication on, so the
    /// seeded row has to default to disabled.
    #[tokio::test]
    async fn sync_is_off_until_it_is_asked_for() {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("in-memory database should open");
        MIGRATOR.run(&pool).await.expect("migrations apply");

        let (base_url, enabled): (String, i64) =
            sqlx::query_as("SELECT base_url, sync_enabled FROM sync_config WHERE id = 1")
                .fetch_one(&pool)
                .await
                .expect("sync_config should be seeded");
        assert_eq!(enabled, 0, "sync must default to off");
        assert!(
            base_url.starts_with("http"),
            "the endpoint should be seeded"
        );

        // First-run state starts incomplete so onboarding shows on a new install.
        let completed: String =
            sqlx::query_scalar("SELECT value FROM onboarding_state WHERE key = 'completed'")
                .fetch_one(&pool)
                .await
                .expect("onboarding state should be seeded");
        assert_eq!(completed, "false");
    }

    /// `PRAGMA foreign_keys` is per-connection, so it must be asserted on a
    /// connection taken from the configured pool rather than a separate client.
    #[tokio::test]
    async fn foreign_keys_are_enforced_on_pooled_connections() {
        let dir = std::env::temp_dir().join(format!("quill-fk-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let db_path = dir.join("fk.db");

        let options = SqliteConnectOptions::new()
            .filename(&db_path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open database");
        MIGRATOR.run(&pool).await.expect("migrations");

        let enabled: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .expect("read pragma");
        assert_eq!(enabled, 1, "foreign key enforcement must be on");

        // A ydoc_update for a non-existent document must be rejected.
        let result = sqlx::query(
            "INSERT INTO ydoc_updates (update_id, document_id, update_blob, client_id)
             VALUES ('u1', 'missing-doc', x'00', 'client')",
        )
        .execute(&pool)
        .await;

        assert!(
            result.is_err(),
            "inserting a child row with a missing parent must fail"
        );

        pool.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}

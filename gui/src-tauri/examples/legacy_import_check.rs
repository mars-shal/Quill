//! Imports a legacy store into a throwaway database and prints the outcome as
//! a single JSON line, so the JavaScript verification script can assert on the
//! imported content without parsing prose output.

use std::path::PathBuf;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("usage: legacy_import_check <path>")?;

    let pool: SqlitePool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(":memory:")
                .create_if_missing(true)
                .foreign_keys(true),
        )
        .await?;

    quill_lib::db::apply_migrations(&pool).await?;

    let result = quill_lib::legacy::run(&pool, &path).await?;

    let row: Option<(String, String, String, String)> =
        sqlx::query_as("SELECT title, content, content_format, provenance FROM documents LIMIT 1")
            .fetch_optional(&pool)
            .await?;

    let outbox: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_outbox")
        .fetch_one(&pool)
        .await?;

    let runs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM migration_runs")
        .fetch_one(&pool)
        .await?;

    let total_documents: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM documents")
        .fetch_one(&pool)
        .await?;

    let (title, html, content_format, provenance) = row.unwrap_or_default();

    println!(
        "RESULT {}",
        serde_json::json!({
            "documentsCreated": result.documents_created,
            "keysTotal": result.keys_total,
            "title": title,
            "html": html,
            "contentFormat": content_format,
            "provenance": provenance,
            "outbox": outbox,
            "runs": runs,
            "totalDocuments": total_documents,
        })
    );

    Ok(())
}

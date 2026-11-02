/**
 * Runs the legacy importer against the real `database/database.json` and reports
 * what it found — without modifying the source.
 *
 * This exercises the shipped Rust code paths (classification, quality gating,
 * duplicate collapse) against real data rather than a fixture, so drift in the
 * legacy file shows up as a diff in this report.
 *
 * Usage: cargo run --example legacy_report -- <path-to-database.json>
 */
use std::path::PathBuf;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../database/database.json"));

    if !path.exists() {
        eprintln!("source not found: {}", path.display());
        std::process::exit(1);
    }

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

    let scan = quill_lib::legacy::scan(&pool, &path).await?;

    println!("source            : {}", scan.source_path);
    println!("sha256            : {}", scan.source_hash);
    println!("already imported  : {}", scan.already_imported);
    println!("total keys        : {}", scan.total_keys);
    println!("importable        : {}", scan.importable_documents);
    println!("quarantined       : {}", scan.quarantined);
    println!("discarded         : {}", scan.discarded);
    println!();

    for entry in &scan.report {
        println!(
            "  {:<12} {:<46} {}",
            entry.verdict.as_str(),
            entry.key,
            entry.reason
        );
    }

    Ok(())
}

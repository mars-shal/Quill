use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// A document as stored locally. Content format is tracked explicitly so the
/// legacy HTML payload can be migrated to the ProseMirror/Yjs representation
/// later without ambiguity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub collections: Vec<String>,
    pub status: String,
    pub color: Option<String>,
    pub filename: String,
    pub content: String,
    pub content_format: String,
    pub schema_version: i64,
    pub cloud_id: Option<String>,
    pub sync_state: String,
    pub cloud_revision: i64,
    pub provenance: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewDocument {
    pub title: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub collections: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub content_format: Option<String>,
    #[serde(default)]
    pub provenance: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateDocument {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub collections: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub content_format: Option<String>,
}

const COLUMNS: &str = "id, title, kind, collections_json, status, color, filename, content, \
     content_format, schema_version, cloud_id, sync_state, cloud_revision, provenance, \
     created_at, updated_at, deleted_at";

fn row_to_document(row: &sqlx::sqlite::SqliteRow) -> Result<Document, sqlx::Error> {
    use sqlx::Row;

    let collections_json: String = row.try_get("collections_json")?;
    let collections = serde_json::from_str(&collections_json).unwrap_or_default();

    Ok(Document {
        id: row.try_get("id")?,
        title: row.try_get("title")?,
        kind: row.try_get("kind")?,
        collections,
        status: row.try_get("status")?,
        color: row.try_get("color")?,
        filename: row.try_get("filename")?,
        content: row.try_get("content")?,
        content_format: row.try_get("content_format")?,
        schema_version: row.try_get("schema_version")?,
        cloud_id: row.try_get("cloud_id")?,
        sync_state: row.try_get("sync_state")?,
        cloud_revision: row.try_get("cloud_revision")?,
        provenance: row.try_get("provenance")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        deleted_at: row.try_get("deleted_at")?,
    })
}

pub fn slugify(value: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "untitled-document".to_string()
    } else {
        trimmed
    }
}

pub async fn list(pool: &SqlitePool, include_deleted: bool) -> AppResult<Vec<Document>> {
    let sql = if include_deleted {
        format!("SELECT {COLUMNS} FROM documents ORDER BY updated_at DESC")
    } else {
        format!("SELECT {COLUMNS} FROM documents WHERE deleted_at IS NULL ORDER BY updated_at DESC")
    };

    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    rows.iter()
        .map(row_to_document)
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppError::from)
}

pub async fn get(pool: &SqlitePool, id: &str) -> AppResult<Document> {
    let sql = format!("SELECT {COLUMNS} FROM documents WHERE id = ?1");
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("document {id}")))?;

    row_to_document(&row).map_err(AppError::from)
}

pub async fn create(pool: &SqlitePool, input: NewDocument) -> AppResult<Document> {
    if input.title.trim().is_empty() {
        return Err(AppError::Validation("title must not be empty".into()));
    }

    let id = Uuid::new_v4().to_string();
    let filename = input
        .filename
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| format!("{}.md", slugify(&input.title)));

    let collections = input.collections.unwrap_or_default();
    let collections_json = serde_json::to_string(&collections)
        .map_err(|e| AppError::Other(format!("could not encode collections: {e}")))?;

    sqlx::query(
        "INSERT INTO documents
           (id, title, kind, collections_json, status, color, filename, content, content_format, provenance)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )
    .bind(&id)
    .bind(input.title.trim())
    .bind(input.kind.unwrap_or_else(|| "Draft".into()))
    .bind(collections_json)
    .bind(input.status.unwrap_or_else(|| "Drafts".into()))
    .bind(input.color)
    .bind(filename)
    .bind(input.content.unwrap_or_default())
    .bind(input.content_format.unwrap_or_else(|| "html".into()))
    .bind(input.provenance)
    .execute(pool)
    .await?;

    get(pool, &id).await
}

/// Applies a partial update. Only provided fields are written.
///
/// Local document writes and the sync outbox entry are committed in the same
/// transaction so an acknowledged edit can never be lost by a crash.
pub async fn update(pool: &SqlitePool, input: UpdateDocument) -> AppResult<Document> {
    if let Some(title) = &input.title {
        if title.trim().is_empty() {
            return Err(AppError::Validation("title must not be empty".into()));
        }
    }

    let mut tx = pool.begin().await?;

    let existing: Option<String> = sqlx::query_scalar("SELECT id FROM documents WHERE id = ?1")
        .bind(&input.id)
        .fetch_optional(&mut *tx)
        .await?;

    if existing.is_none() {
        return Err(AppError::NotFound(format!("document {}", input.id)));
    }

    if let Some(title) = input.title {
        sqlx::query("UPDATE documents SET title = ?1 WHERE id = ?2")
            .bind(title.trim())
            .bind(&input.id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(kind) = input.kind {
        sqlx::query("UPDATE documents SET kind = ?1 WHERE id = ?2")
            .bind(kind)
            .bind(&input.id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(collections) = input.collections {
        let json = serde_json::to_string(&collections)
            .map_err(|e| AppError::Other(format!("could not encode collections: {e}")))?;
        sqlx::query("UPDATE documents SET collections_json = ?1 WHERE id = ?2")
            .bind(json)
            .bind(&input.id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(status) = input.status {
        sqlx::query("UPDATE documents SET status = ?1 WHERE id = ?2")
            .bind(status)
            .bind(&input.id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(color) = input.color {
        sqlx::query("UPDATE documents SET color = ?1 WHERE id = ?2")
            .bind(color)
            .bind(&input.id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(filename) = input.filename {
        sqlx::query("UPDATE documents SET filename = ?1 WHERE id = ?2")
            .bind(filename)
            .bind(&input.id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(content) = input.content {
        sqlx::query("UPDATE documents SET content = ?1 WHERE id = ?2")
            .bind(content)
            .bind(&input.id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(content_format) = input.content_format {
        sqlx::query("UPDATE documents SET content_format = ?1 WHERE id = ?2")
            .bind(content_format)
            .bind(&input.id)
            .execute(&mut *tx)
            .await?;
    }

    sqlx::query("UPDATE documents SET updated_at = datetime('now') WHERE id = ?1")
        .bind(&input.id)
        .execute(&mut *tx)
        .await?;

    let outbox_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sync_outbox (id, document_id, operation, payload_ref)
         VALUES (?1, ?2, 'upsert', ?3)",
    )
    .bind(outbox_id)
    .bind(&input.id)
    .bind(&input.id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    get(pool, &input.id).await
}

/// Soft delete. Uses a tombstone so deletion can be synced and recovered.
pub async fn soft_delete(pool: &SqlitePool, id: &str) -> AppResult<()> {
    let mut tx = pool.begin().await?;

    let changed = sqlx::query(
        "UPDATE documents SET deleted_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?1 AND deleted_at IS NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if changed == 0 {
        return Err(AppError::NotFound(format!("document {id}")));
    }

    sqlx::query(
        "INSERT INTO sync_outbox (id, document_id, operation, payload_ref)
         VALUES (?1, ?2, 'delete', ?2)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

pub async fn restore(pool: &SqlitePool, id: &str) -> AppResult<Document> {
    sqlx::query(
        "UPDATE documents SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?1",
    )
    .bind(id)
    .execute(pool)
    .await?;

    update(
        pool,
        UpdateDocument {
            id: id.to_string(),
            ..Default::default()
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open in-memory database");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("apply migrations");
        pool
    }

    #[test]
    fn slugify_normalises_titles() {
        assert_eq!(
            slugify("The Shape of a Quiet Interface"),
            "the-shape-of-a-quiet-interface"
        );
        assert_eq!(slugify("  A Field Guide!  "), "a-field-guide");
        assert_eq!(slugify("!!!"), "untitled-document");
        assert_eq!(slugify("Notes 2026"), "notes-2026");
    }

    #[tokio::test]
    async fn create_then_read_round_trips() {
        let pool = test_pool().await;
        let created = create(
            &pool,
            NewDocument {
                title: "A Quiet Test".into(),
                kind: Some("Essay".into()),
                collections: Some(vec!["Essays".into()]),
                status: Some("Drafts".into()),
                color: Some("#8a5a2b".into()),
                filename: None,
                content: Some("<p>Hello</p>".into()),
                content_format: None,
                provenance: None,
            },
        )
        .await
        .expect("create should succeed");

        assert_eq!(created.filename, "a-quiet-test.md");
        assert_eq!(created.collections, vec!["Essays".to_string()]);

        let fetched = get(&pool, &created.id)
            .await
            .expect("document should exist");
        assert_eq!(fetched.content, "<p>Hello</p>");
    }

    #[tokio::test]
    async fn empty_title_is_rejected() {
        let pool = test_pool().await;
        let result = create(
            &pool,
            NewDocument {
                title: "   ".into(),
                kind: None,
                collections: None,
                status: None,
                color: None,
                filename: None,
                content: None,
                content_format: None,
                provenance: None,
            },
        )
        .await;

        assert!(matches!(result, Err(AppError::Validation(_))));
    }

    #[tokio::test]
    async fn update_writes_outbox_atomically() {
        let pool = test_pool().await;
        let created = create(
            &pool,
            NewDocument {
                title: "Outbox Test".into(),
                kind: None,
                collections: None,
                status: None,
                color: None,
                filename: None,
                content: Some("first".into()),
                content_format: None,
                provenance: None,
            },
        )
        .await
        .expect("create should succeed");

        let updated = update(
            &pool,
            UpdateDocument {
                id: created.id.clone(),
                title: None,
                kind: None,
                collections: None,
                status: None,
                color: None,
                filename: None,
                content: Some("second".into()),
                content_format: None,
            },
        )
        .await
        .expect("update should succeed");

        assert_eq!(updated.content, "second");

        let pending: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sync_outbox WHERE document_id = ?1")
                .bind(&created.id)
                .fetch_one(&pool)
                .await
                .expect("count outbox rows");
        assert_eq!(pending, 1, "update should enqueue exactly one outbox row");
    }

    #[tokio::test]
    async fn soft_delete_hides_from_default_list() {
        let pool = test_pool().await;
        let created = create(
            &pool,
            NewDocument {
                title: "Delete Me".into(),
                kind: None,
                collections: None,
                status: None,
                color: None,
                filename: None,
                content: None,
                content_format: None,
                provenance: None,
            },
        )
        .await
        .expect("create should succeed");

        soft_delete(&pool, &created.id)
            .await
            .expect("delete should succeed");

        let visible = list(&pool, false).await.expect("list should succeed");
        assert!(visible.iter().all(|d| d.id != created.id));

        let all = list(&pool, true)
            .await
            .expect("list including deleted should succeed");
        assert!(all.iter().any(|d| d.id == created.id));

        let restored = restore(&pool, &created.id)
            .await
            .expect("restore should succeed");
        assert!(restored.deleted_at.is_none());
    }
}

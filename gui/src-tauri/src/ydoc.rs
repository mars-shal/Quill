//! Durable local persistence for a Yjs document.
//!
//! Yjs updates are opaque, commutative and idempotent, so this layer never
//! needs to interpret them. It only guarantees that an update which the
//! frontend has applied is durably stored before the write is acknowledged.
//!
//! The document snapshot columns on `documents` hold the last full state; the
//! `ydoc_updates` table holds the incremental tail that is not yet covered by
//! that snapshot. Compaction folds the tail into a new snapshot and prunes it.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::error::{AppError, AppResult};

/// Maximum accepted size for a single encoded update (8 MiB decoded). This is a
/// guard against a malformed or hostile client flooding the local database.
const MAX_UPDATE_BYTES: usize = 8 * 1024 * 1024;

/// Cap on updates returned by a single load call. Clients page via `since` when
/// more remain, so a very large document cannot produce an unbounded payload.
const MAX_UPDATES_PER_LOAD: i64 = 5_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YdocUpdate {
    pub update_id: String,
    pub update: String,
}

/// The stored `(snapshot, state_vector)` pair for a document.
type SnapshotRow = (Option<Vec<u8>>, Option<Vec<u8>>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YdocState {
    /// Last full-state snapshot, base64 encoded. `None` for a new document.
    pub snapshot: Option<String>,
    /// State vector matching `snapshot`, base64 encoded.
    pub state_vector: Option<String>,
    /// Incremental updates recorded after `snapshot`, in insertion order.
    pub updates: Vec<YdocUpdate>,
    /// True when more updates remain beyond this page.
    pub has_more: bool,
}

pub fn decode_b64(value: &str, field: &str) -> AppResult<Vec<u8>> {
    let bytes = BASE64
        .decode(value.trim())
        .map_err(|e| AppError::Validation(format!("{field} is not valid base64: {e}")))?;
    if bytes.len() > MAX_UPDATE_BYTES {
        return Err(AppError::Validation(format!(
            "{field} exceeds the {MAX_UPDATE_BYTES} byte limit"
        )));
    }
    Ok(bytes)
}

/// Stable identity for an update so a retried submission is a no-op.
pub fn update_id(document_id: &str, bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(document_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

async fn document_exists(pool: &SqlitePool, document_id: &str) -> AppResult<()> {
    let found: Option<String> = sqlx::query_scalar("SELECT id FROM documents WHERE id = ?1")
        .bind(document_id)
        .fetch_optional(pool)
        .await?;
    if found.is_none() {
        return Err(AppError::NotFound(format!("document {document_id}")));
    }
    Ok(())
}

/// Returns the snapshot plus the pending update tail for a document.
pub async fn load(pool: &SqlitePool, document_id: &str) -> AppResult<YdocState> {
    document_exists(pool, document_id).await?;

    let row: Option<SnapshotRow> =
        sqlx::query_as("SELECT yjs_snapshot, yjs_state_vector FROM documents WHERE id = ?1")
            .bind(document_id)
            .fetch_optional(pool)
            .await?;

    let (snapshot, state_vector) = row.unwrap_or((None, None));

    // Ordering uses SQLite's implicit `rowid`, not `created_at`.
    //
    // `datetime('now')` has one-second resolution, so a burst of updates within
    // the same second ties and would fall back to `update_id` — a content hash,
    // i.e. effectively random order. SQLite assigns `rowid` as max(rowid)+1 on
    // insert, so it increases monotonically for the life of the table (reusing
    // values only after the highest row is deleted, which still sorts after every
    // remaining row). That gives the stable per-document insertion order the
    // snapshot/compaction bookkeeping depends on.
    let rows: Vec<(String, Vec<u8>)> = sqlx::query_as(
        "SELECT update_id, update_blob FROM ydoc_updates
         WHERE document_id = ?1 ORDER BY rowid ASC LIMIT ?2",
    )
    .bind(document_id)
    .bind(MAX_UPDATES_PER_LOAD)
    .fetch_all(pool)
    .await?;

    let has_more = rows.len() as i64 == MAX_UPDATES_PER_LOAD;

    Ok(YdocState {
        snapshot: snapshot.map(|b| BASE64.encode(b)),
        state_vector: state_vector.map(|b| BASE64.encode(b)),
        updates: rows
            .into_iter()
            .map(|(update_id, update)| YdocUpdate {
                update_id,
                update: BASE64.encode(update),
            })
            .collect(),
        has_more,
    })
}

/// Durably appends an incremental update.
///
/// The insert is idempotent on `update_id`, so a client retrying after a network
/// or IPC failure converges on exactly one stored copy.
pub async fn append_update(
    pool: &SqlitePool,
    document_id: &str,
    encoded: &str,
    client_id: &str,
) -> AppResult<String> {
    document_exists(pool, document_id).await?;

    let bytes = decode_b64(encoded, "update")?;
    if bytes.is_empty() {
        return Err(AppError::Validation("update must not be empty".into()));
    }

    let id = update_id(document_id, &bytes);

    sqlx::query(
        "INSERT INTO ydoc_updates (update_id, document_id, update_blob, client_id)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (update_id) DO NOTHING",
    )
    .bind(&id)
    .bind(document_id)
    .bind(&bytes)
    .bind(if client_id.is_empty() {
        "unknown"
    } else {
        client_id
    })
    .execute(pool)
    .await?;

    sqlx::query("UPDATE documents SET updated_at = datetime('now') WHERE id = ?1")
        .bind(document_id)
        .execute(pool)
        .await?;

    Ok(id)
}

/// Stores a full-state snapshot and prunes the update tail it supersedes.
///
/// `covered_update_ids` must be the ids the caller has folded into the
/// snapshot. Only those rows are deleted, so a concurrent write that was not
/// part of this snapshot is preserved.
pub async fn compact(
    pool: &SqlitePool,
    document_id: &str,
    encoded_snapshot: &str,
    encoded_state_vector: &str,
    covered_update_ids: &[String],
) -> AppResult<usize> {
    document_exists(pool, document_id).await?;

    let snapshot = decode_b64(encoded_snapshot, "snapshot")?;
    let state_vector = decode_b64(encoded_state_vector, "stateVector")?;
    if snapshot.is_empty() {
        return Err(AppError::Validation("snapshot must not be empty".into()));
    }

    let mut tx = pool.begin().await?;

    sqlx::query(
        "UPDATE documents SET yjs_snapshot = ?1, yjs_state_vector = ?2,
                             updated_at = datetime('now')
         WHERE id = ?3",
    )
    .bind(&snapshot)
    .bind(&state_vector)
    .bind(document_id)
    .execute(&mut *tx)
    .await?;

    let mut pruned = 0usize;
    if !covered_update_ids.is_empty() {
        // Chunk the IN list so a very large tail cannot exceed SQLite's
        // parameter limit (default 999).
        for chunk in covered_update_ids.chunks(500) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!("DELETE FROM ydoc_updates WHERE update_id IN ({placeholders})");
            let mut query = sqlx::query(&sql);
            for value in chunk {
                query = query.bind(value);
            }
            pruned += query.execute(&mut *tx).await?.rows_affected() as usize;
        }
    }

    tx.commit().await?;

    Ok(pruned)
}

/// Number of pending updates, used by the UI to decide when to compact.
pub async fn pending_count(pool: &SqlitePool, document_id: &str) -> AppResult<i64> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ydoc_updates WHERE document_id = ?1")
        .bind(document_id)
        .fetch_optional(pool)
        .await?
        .unwrap_or(0);
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::{self, NewDocument};
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    async fn test_pool() -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
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

    async fn seed_doc(pool: &SqlitePool) -> String {
        documents::create(
            pool,
            NewDocument {
                title: "Ydoc Test".into(),
                ..Default::default()
            },
        )
        .await
        .expect("create document")
        .id
    }

    #[test]
    fn base64_round_trips_and_rejects_garbage() {
        let encoded = BASE64.encode(b"hello quill");
        assert_eq!(decode_b64(&encoded, "update").unwrap(), b"hello quill");
        assert!(decode_b64("not base64!!", "update").is_err());
    }

    #[test]
    fn oversized_updates_are_rejected() {
        let big = BASE64.encode(vec![0u8; MAX_UPDATE_BYTES + 1]);
        assert!(decode_b64(&big, "update").is_err());
    }

    #[test]
    fn update_ids_are_deterministic_and_document_scoped() {
        let a = update_id("doc-1", b"payload");
        assert_eq!(a, update_id("doc-1", b"payload"), "same input, same id");
        assert_ne!(
            a,
            update_id("doc-2", b"payload"),
            "ids are scoped per document"
        );
    }

    #[tokio::test]
    async fn new_document_has_no_ydoc_state() {
        let pool = test_pool().await;
        let id = seed_doc(&pool).await;
        let state = load(&pool, &id).await.expect("load");

        assert!(state.snapshot.is_none());
        assert!(state.state_vector.is_none());
        assert!(state.updates.is_empty());
        assert!(!state.has_more);
    }

    #[tokio::test]
    async fn appended_updates_are_returned_in_order() {
        let pool = test_pool().await;
        let id = seed_doc(&pool).await;

        for payload in [&b"one"[..], b"two", b"three"] {
            append_update(&pool, &id, &BASE64.encode(payload), "client-a")
                .await
                .expect("append");
        }

        let state = load(&pool, &id).await.expect("load");
        assert_eq!(state.updates.len(), 3);
        assert_eq!(BASE64.decode(&state.updates[0].update).unwrap(), b"one");
        assert_eq!(BASE64.decode(&state.updates[1].update).unwrap(), b"two");
        assert_eq!(BASE64.decode(&state.updates[2].update).unwrap(), b"three");
    }

    #[tokio::test]
    async fn duplicate_appends_are_idempotent() {
        let pool = test_pool().await;
        let id = seed_doc(&pool).await;
        let encoded = BASE64.encode(b"same bytes");

        let first = append_update(&pool, &id, &encoded, "client-a")
            .await
            .expect("first");
        let second = append_update(&pool, &id, &encoded, "client-b")
            .await
            .expect("retry");

        assert_eq!(first, second, "same bytes must yield the same update id");
        assert_eq!(pending_count(&pool, &id).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn empty_update_is_rejected() {
        let pool = test_pool().await;
        let id = seed_doc(&pool).await;
        assert!(append_update(&pool, &id, &BASE64.encode(b""), "c")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn missing_document_is_reported() {
        let pool = test_pool().await;
        assert!(load(&pool, "nope").await.is_err());
        assert!(append_update(&pool, "nope", &BASE64.encode(b"x"), "c")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn compaction_stores_snapshot_and_prunes_only_covered_updates() {
        let pool = test_pool().await;
        let id = seed_doc(&pool).await;

        let mut covered = Vec::new();
        for payload in [&b"a"[..], b"b", b"c"] {
            let uid = append_update(&pool, &id, &BASE64.encode(payload), "client")
                .await
                .expect("append");
            covered.push(uid);
        }
        // A late update that the snapshot does not include must survive.
        let survivor = append_update(&pool, &id, &BASE64.encode(b"late"), "client")
            .await
            .expect("append late");

        let pruned = compact(
            &pool,
            &id,
            &BASE64.encode(b"full-state"),
            &BASE64.encode(b"state-vector"),
            &covered,
        )
        .await
        .expect("compact");

        assert_eq!(pruned, 3);

        let state = load(&pool, &id).await.expect("load");
        assert_eq!(
            BASE64.decode(state.snapshot.unwrap()).unwrap(),
            b"full-state"
        );
        assert_eq!(state.updates.len(), 1, "uncovered update must be retained");
        assert_eq!(state.updates[0].update_id, survivor);
    }

    #[tokio::test]
    async fn compaction_without_covered_ids_keeps_everything() {
        let pool = test_pool().await;
        let id = seed_doc(&pool).await;
        append_update(&pool, &id, &BASE64.encode(b"keep"), "c")
            .await
            .expect("append");

        compact(
            &pool,
            &id,
            &BASE64.encode(b"snap"),
            &BASE64.encode(b"sv"),
            &[],
        )
        .await
        .expect("compact");

        assert_eq!(pending_count(&pool, &id).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn updates_appended_within_one_second_keep_insertion_order() {
        // Regression test: `created_at` only has second resolution, so a fast
        // burst ties and previously fell back to ordering by the content hash.
        let pool = test_pool().await;
        let id = seed_doc(&pool).await;

        let payloads: [&[u8]; 12] = [
            b"a", b"b", b"c", b"d", b"e", b"f", b"g", b"h", b"i", b"j", b"k", b"l",
        ];
        for payload in payloads {
            append_update(&pool, &id, &BASE64.encode(payload), "client")
                .await
                .expect("append");
        }

        let state = load(&pool, &id).await.expect("load");
        let decoded: Vec<Vec<u8>> = state
            .updates
            .iter()
            .map(|u| BASE64.decode(&u.update).expect("decode"))
            .collect();

        assert_eq!(decoded, payloads.map(|p| p.to_vec()));
    }

    #[tokio::test]
    async fn updates_are_isolated_per_document() {
        let pool = test_pool().await;
        let first = seed_doc(&pool).await;
        let second = seed_doc(&pool).await;

        append_update(&pool, &first, &BASE64.encode(b"one"), "c")
            .await
            .expect("append");
        append_update(&pool, &second, &BASE64.encode(b"two"), "c")
            .await
            .expect("append");

        assert_eq!(load(&pool, &first).await.unwrap().updates.len(), 1);
        assert_eq!(load(&pool, &second).await.unwrap().updates.len(), 1);
        assert_eq!(
            BASE64
                .decode(&load(&pool, &first).await.unwrap().updates[0].update)
                .unwrap(),
            b"one"
        );
    }
}

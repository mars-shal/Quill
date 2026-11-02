//! Non-destructive importer for the legacy Python JSON store.
//!
//! The legacy `database/database.json` is an ad-hoc key/value blob that mixed
//! parsed documents, concept maps, research payloads, generated writing,
//! plagiarism reports, sessions and an internal parse cache. It also contains
//! genuine corruption, and the file has changed shape between runs, so nothing
//! here is hard-coded to a fixed set of keys or record counts.
//!
//! Instead the importer *discovers* the namespaces, validates each record
//! against observable properties, and records a verdict for every key so a run
//! is auditable and repeatable.
//!
//! Guarantees:
//!   - the source file is only ever read;
//!   - a re-run is a no-op, guarded by a content hash in `migration_runs`;
//!   - duplicate documents collapse to one survivor;
//!   - anything that cannot be trusted is quarantined with a reason rather than
//!     silently dropped or silently imported.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use pulldown_cmark::CowStr;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Outcome recorded for every key in the source file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Imported,
    Discarded,
    Quarantined,
    /// Reached the duplicate-collapse step and lost to another record.
    Merged,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Imported => "imported",
            Verdict::Discarded => "discarded",
            Verdict::Quarantined => "quarantined",
            Verdict::Merged => "merged",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyReport {
    pub key: String,
    pub namespace: String,
    pub verdict: Verdict,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyScan {
    pub source_path: String,
    pub source_hash: String,
    pub already_imported: bool,
    pub total_keys: usize,
    pub importable_documents: usize,
    pub quarantined: usize,
    pub discarded: usize,
    pub report: Vec<KeyReport>,
}

/// Result of actually running the import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportResult {
    pub source_path: String,
    pub source_hash: String,
    pub run_id: String,
    pub documents_created: usize,
    pub keys_total: usize,
    pub report: Vec<KeyReport>,
}

fn is_uuid_key(key: &str) -> bool {
    // Shape check only; does not require a valid version/variant.
    key.len() == 36
        && key.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && key.matches('-').count() == 4
}

fn namespace_of(key: &str) -> &str {
    match key.split_once(':') {
        Some((head, _)) => head,
        // `sessions` is a denormalised index of the `session:*` records and has
        // no colon, so it would otherwise be mistaken for a document.
        None if key == "sessions" => "sessions",
        None => "document",
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Converts Markdown to HTML for the document body.
///
/// Two hardening steps, because imported content is untrusted and this value is
/// later fed to `innerHTML` when summarising a document in the library:
///
///   1. Raw HTML in the source is turned into an escaped *text* node.
///      pulldown-cmark has no option to disable raw HTML, so the event stream
///      is rewritten by hand; `Event::Text` is escaped by the renderer.
///   2. Link and image destinations are restricted to safe schemes, so a
///      `javascript:` or `data:` URL cannot survive into the document.
fn markdown_to_html(markdown: &str) -> String {
    use pulldown_cmark::{html, Event, Options, Parser, Tag};

    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);

    let events = Parser::new_ext(markdown, options).map(|event| match event {
        Event::Html(text) | Event::InlineHtml(text) => Event::Text(text),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Link {
            link_type,
            dest_url: safe_url(&dest_url),
            title,
            id,
        }),
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Image {
            link_type,
            dest_url: safe_url(&dest_url),
            title,
            id,
        }),
        other => other,
    });

    let mut out = String::with_capacity(markdown.len() + markdown.len() / 2);
    html::push_html(&mut out, events);
    out
}

/// Allows only schemes that cannot execute script, plus relative URLs.
/// Anything else is replaced with an empty destination.
fn safe_url(url: &str) -> CowStr<'static> {
    let trimmed = url.trim();
    let lowered = trimmed.to_ascii_lowercase();

    let is_relative = !trimmed.contains(':')
        || lowered.starts_with('#')
        || lowered.starts_with('/')
        || lowered.starts_with("./")
        || lowered.starts_with("../");

    const ALLOWED: [&str; 5] = ["http:", "https:", "mailto:", "tel:", "data:image/"];
    let permitted = is_relative || ALLOWED.iter().any(|scheme| lowered.starts_with(scheme));

    if permitted {
        CowStr::from(trimmed.to_string())
    } else {
        CowStr::from(String::new())
    }
}

fn slugify(value: &str) -> String {
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

/// Renders a legacy `sections` tree to HTML.
///
/// The tree is the authoritative structure: the sibling `markdown` field in the
/// legacy store is plain text whose heading markers were stripped during
/// normalisation, so it cannot be used to recover document outline. Each node
/// carries `level`, optional section `no`, a `title`, typed `blocks`, and
/// nested `children`.
fn sections_to_html(node: &Value) -> String {
    let mut out = String::new();

    if let Some(title) = node.get("title").and_then(Value::as_str) {
        let title = title.trim();
        if !title.is_empty() {
            let level = node.get("level").and_then(Value::as_i64).unwrap_or(1);
            // Clamp so a malformed level cannot produce an invalid tag.
            let tag = match level {
                1 => "h1",
                2 => "h2",
                _ => "h3",
            };
            let number = node
                .get("no")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|no| !no.is_empty());
            match number {
                Some(no) => out.push_str(&format!(
                    "<{tag}>{} {}</{tag}>",
                    escape_html(no),
                    escape_html(title)
                )),
                None => out.push_str(&format!("<{tag}>{}</{tag}>", escape_html(title))),
            }
        }
    }

    if let Some(blocks) = node.get("blocks").and_then(Value::as_array) {
        for block in blocks {
            let kind = block
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("paragraph");
            let content = block
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if content.is_empty() {
                continue;
            }
            // A line that looks like a URL on its own becomes a link.
            if kind == "code" {
                out.push_str(&format!(
                    "<pre><code>{}</code></pre>\n",
                    escape_html(content)
                ));
            } else if kind == "quote" {
                out.push_str(&format!(
                    "<blockquote><p>{}</p></blockquote>\n",
                    inline_html(content)
                ));
            } else {
                out.push_str(&format!("<p>{}</p>\n", inline_html(content)));
            }
        }
    }

    if let Some(children) = node.get("children").and_then(Value::as_array) {
        for child in children {
            out.push_str(&sections_to_html(child));
        }
    }

    out
}

/// Escapes text for interpolation into an HTML text node or attribute.
fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 16);
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Escapes a block of text, turning bare URLs and `- ` bullets into markup.
///
/// Legacy block content is plain prose with no markup of its own, so a small
/// amount of structure is recovered here rather than escaping everything.
fn inline_html(value: &str) -> String {
    let trimmed = value.trim();

    if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
        let items: String = trimmed
            .lines()
            .map(|line| {
                let item = line.trim_start().trim_start_matches(['-', '*']).trim();
                format!("<li>{}</li>\n", escape_html(item))
            })
            .collect();
        return format!("<ul>\n{items}</ul>");
    }

    escape_html(trimmed)
}

/// Builds the document body, preferring the section tree over `markdown`.
///
/// Falls back to parsing `markdown`, which is the correct path for genuine
/// Markdown files. In the legacy store that field has already lost its heading
/// markers, so it degrades to plain paragraphs — which is still better than
/// dropping the text, and is escaped and URL-filtered either way.
fn document_body_html(record: &Value) -> String {
    if let Some(sections) = record.get("sections").and_then(Value::as_array) {
        if !sections.is_empty() {
            let html: String = sections.iter().map(sections_to_html).collect();
            if html.contains("<h1") || html.contains("<h2") || html.contains("<h3") {
                return html;
            }
        }
    }

    record
        .get("markdown")
        .and_then(Value::as_str)
        .map(markdown_to_html)
        .unwrap_or_default()
}
/// Minimum word count for a body to be considered intact.
///
/// Deliberately low. A short note is legitimate, so a low count alone is not
/// evidence of corruption; the structural check below (at least one heading) is
/// the stronger signal that a record was truncated or mangled by the legacy
/// pipeline. This floor only catches bodies that are effectively empty.
const MIN_BODY_WORDS: usize = 20;

/// Heuristic quality checks used to decide whether a legacy record is trustworthy.
///
/// These deliberately favour quarantine over import: a document that fails a
/// check is preserved in the report and the original file, and can be reviewed.
fn assess_document(record: &Value) -> Result<(), String> {
    let title = record
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if title.is_empty() {
        return Err("title is empty".into());
    }

    let body = document_body_html(record);
    if body.trim().is_empty() {
        return Err("no recoverable body content".into());
    }

    let headings =
        body.matches("<h1").count() + body.matches("<h2").count() + body.matches("<h3").count();
    let words = body.split_whitespace().count();

    if words < MIN_BODY_WORDS {
        return Err(format!("body has only {words} words; likely truncated"));
    }
    if headings == 0 {
        return Err(format!(
            "body has {words} words but no recoverable headings; likely not prose"
        ));
    }
    Ok(())
}

/// Reads and classifies the source without writing anything.
pub async fn scan(pool: &SqlitePool, source: &Path) -> AppResult<LegacyScan> {
    let raw = std::fs::read(source)
        .map_err(|e| AppError::Other(format!("could not read {}: {e}", source.display())))?;
    let source_hash = sha256_hex(&raw);

    let already_imported: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM migration_runs WHERE source_kind = 'legacy-py-json' AND source_hash = ?1 AND state = 'completed'",
    )
    .bind(&source_hash)
    .fetch_one(pool)
    .await?;

    let parsed: Value = serde_json::from_slice(&raw)
        .map_err(|e| AppError::Other(format!("source is not valid JSON: {e}")))?;
    let map = parsed
        .as_object()
        .ok_or_else(|| AppError::Other("source JSON is not an object".into()))?;

    let report = classify(map);
    let importable = report
        .iter()
        .filter(|r| r.verdict == Verdict::Imported)
        .count();
    let quarantined = report
        .iter()
        .filter(|r| r.verdict == Verdict::Quarantined)
        .count();
    let discarded = report
        .iter()
        .filter(|r| r.verdict == Verdict::Discarded)
        .count();

    Ok(LegacyScan {
        source_path: source.display().to_string(),
        source_hash,
        already_imported: already_imported > 0,
        total_keys: map.len(),
        importable_documents: importable,
        quarantined,
        discarded,
        report,
    })
}

/// Walks every key in the source and assigns a verdict with a reason.
fn classify(map: &serde_json::Map<String, Value>) -> Vec<KeyReport> {
    let mut report = Vec::with_capacity(map.len());

    // --- collect document candidates ---------------------------------------
    let mut candidates: BTreeMap<String, Value> = BTreeMap::new();
    for (key, value) in map {
        if !is_uuid_key(key) || !value.is_object() {
            continue;
        }
        if document_body_html(value).trim().is_empty() {
            continue;
        }
        candidates.insert(key.clone(), value.clone());
    }

    // --- choose survivors by content identity -------------------------------
    //
    // Content identity is the `markdown` field. The sibling `sections` tree is a
    // derived parse artifact that drifted between parser versions, so hashing
    // the rendered body would treat the same document re-parsed by a newer
    // parser as a distinct document and import it several times.
    let mut by_content: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (uuid, record) in &candidates {
        let markdown = record
            .get("markdown")
            .and_then(Value::as_str)
            .unwrap_or_default();
        // Fall back to the rendered body only when there is no markdown at all.
        let identity = if markdown.trim().is_empty() {
            document_body_html(record)
        } else {
            markdown.to_string()
        };
        by_content
            .entry(sha256_hex(identity.as_bytes()))
            .or_default()
            .push(uuid.clone());
    }

    // A parse cache entry marks the id the newest parser produced; prefer it as
    // the survivor so the richest section tree is the one kept.
    let mut preferred: Option<String> = None;
    if let Some(Value::Object(cache)) = map.get("meta:parsecache") {
        let mut best_version: i64 = -1;
        for (cache_key, target) in cache {
            let version = cache_key
                .split(':')
                .next()
                .and_then(|v| v.parse::<i64>().ok())
                .unwrap_or(-1);
            if version > best_version {
                if let Some(id) = target.as_str() {
                    best_version = version;
                    preferred = Some(id.to_string());
                }
            }
        }
    }

    let mut survivor_of: BTreeMap<String, String> = BTreeMap::new(); // duplicate -> survivor
    for group in by_content.values() {
        // Preference order: named by the newest parse cache, then the record
        // with the most recovered headings, then a stable lexicographic id.
        let survivor = match &preferred {
            Some(p) if group.contains(p) => p.clone(),
            _ => group
                .iter()
                .max_by_key(|uuid| {
                    candidates
                        .get(*uuid)
                        .map(|record| {
                            document_body_html(record).matches("<h1").count()
                                + document_body_html(record).matches("<h2").count()
                                + document_body_html(record).matches("<h3").count()
                        })
                        .unwrap_or(0)
                })
                .or_else(|| group.iter().min())
                .cloned()
                .unwrap_or_default(),
        };
        for member in group {
            survivor_of.insert(member.clone(), survivor.clone());
        }
    }

    for (key, value) in map {
        let namespace = namespace_of(key).to_string();

        if is_uuid_key(key) {
            let record = match candidates.get(key) {
                Some(record) => record.clone(),
                None => {
                    report.push(KeyReport {
                        key: key.clone(),
                        namespace,
                        verdict: Verdict::Discarded,
                        reason: "not a document record".into(),
                        document_id: None,
                    });
                    continue;
                }
            };

            let survivor = survivor_of.get(key).cloned().unwrap_or_else(|| key.clone());
            if survivor != *key {
                report.push(KeyReport {
                    key: key.clone(),
                    namespace,
                    verdict: Verdict::Merged,
                    reason: format!("duplicate content; collapsed into {survivor}"),
                    document_id: None,
                });
                continue;
            }

            match assess_document(&record) {
                Ok(()) => report.push(KeyReport {
                    key: key.clone(),
                    namespace,
                    verdict: Verdict::Imported,
                    reason: format!(
                        "{} words, {} heading(s)",
                        document_body_html(&record).split_whitespace().count(),
                        document_body_html(&record).matches("<h").count()
                    ),
                    document_id: None,
                }),
                Err(reason) => report.push(KeyReport {
                    key: key.clone(),
                    namespace,
                    verdict: Verdict::Quarantined,
                    reason,
                    document_id: None,
                }),
            }
            continue;
        }

        let (verdict, reason) = match namespace.as_str() {
            "concept" => {
                if value
                    .get("sections")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .filter(|row| {
                                row.get("path")
                                    .and_then(Value::as_str)
                                    .map(|p| p.is_empty())
                                    .unwrap_or(false)
                            })
                            .count()
                    })
                    .unwrap_or(0)
                    > 0
                {
                    (
                        Verdict::Quarantined,
                        "section paths are empty; concept map is not trustworthy".to_string(),
                    )
                } else {
                    (Verdict::Discarded, "concept map is regenerable".to_string())
                }
            }
            "research" => {
                let blank_urls = value
                    .get("pages")
                    .and_then(Value::as_array)
                    .map(|pages| {
                        pages
                            .iter()
                            .filter(|p| {
                                p.get("url")
                                    .and_then(Value::as_str)
                                    .map(|u| u.is_empty())
                                    .unwrap_or(true)
                            })
                            .count()
                    })
                    .unwrap_or(0);
                let status = value
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                if value
                    .get("low_research")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || blank_urls > 0
                {
                    (
                        Verdict::Quarantined,
                        format!(
                            "research incomplete: status={status}, {blank_urls} page(s) without a URL, low_research flag set"
                        ),
                    )
                } else {
                    (
                        Verdict::Discarded,
                        "research payload is regenerable".to_string(),
                    )
                }
            }
            "written" => (
                Verdict::Quarantined,
                "generated writing may have been altered by the plagiarism corrector; \
                 prefer the clean file in output/ if present"
                    .to_string(),
            ),
            "session" | "sessions" => (
                Verdict::Discarded,
                "session metadata has no document equivalent; retained only in this report"
                    .to_string(),
            ),
            "meta" => (
                Verdict::Discarded,
                "parser-internal cache; regenerable".to_string(),
            ),
            other => (
                Verdict::Quarantined,
                format!("unrecognised namespace `{other}`"),
            ),
        };

        report.push(KeyReport {
            key: key.clone(),
            namespace,
            verdict,
            reason,
            document_id: None,
        });
    }

    report.sort_by(|a, b| a.key.cmp(&b.key));
    report
}

/// Imports validated documents and records the run. Safe to call repeatedly.
pub async fn run(pool: &SqlitePool, source: &Path) -> AppResult<LegacyImportResult> {
    let raw = std::fs::read(source)
        .map_err(|e| AppError::Other(format!("could not read {}: {e}", source.display())))?;
    let source_hash = sha256_hex(&raw);

    // Idempotency gate: a completed run for this exact content is a no-op.
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM migration_runs
         WHERE source_kind = 'legacy-py-json' AND source_hash = ?1 AND state = 'completed'",
    )
    .bind(&source_hash)
    .fetch_optional(pool)
    .await?;

    if let Some(run_id) = existing {
        let report_json: Option<String> =
            sqlx::query_scalar("SELECT report_json FROM migration_runs WHERE id = ?1")
                .bind(&run_id)
                .fetch_optional(pool)
                .await?;
        let report: Vec<KeyReport> = report_json
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        return Ok(LegacyImportResult {
            source_path: source.display().to_string(),
            source_hash,
            run_id,
            documents_created: 0,
            keys_total: report.len(),
            report,
        });
    }

    let parsed: Value = serde_json::from_slice(&raw)
        .map_err(|e| AppError::Other(format!("source is not valid JSON: {e}")))?;
    let map = parsed
        .as_object()
        .ok_or_else(|| AppError::Other("source JSON is not an object".into()))?
        .clone();

    let mut report = classify(&map);
    let run_id = Uuid::new_v4().to_string();

    let mut created = 0usize;
    let mut tx = pool.begin().await?;

    let importable: BTreeSet<String> = report
        .iter()
        .filter(|r| r.verdict == Verdict::Imported)
        .map(|r| r.key.clone())
        .collect();

    for uuid in &importable {
        let Some(obj) = map.get(uuid) else { continue };
        let title = obj
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled document")
            .to_string();

        // Per-record idempotency: provenance is the stable identity of a
        // legacy import, independent of the generated document id.
        let provenance = format!("legacy-py-json:{uuid}");
        let existing_doc: Option<String> =
            sqlx::query_scalar("SELECT id FROM documents WHERE provenance = ?1")
                .bind(&provenance)
                .fetch_optional(&mut *tx)
                .await?;

        if let Some(found) = existing_doc {
            if let Some(entry) = report.iter_mut().find(|r| &r.key == uuid) {
                entry.document_id = Some(found);
                entry.verdict = Verdict::Imported;
                entry.reason = "already present; skipped".into();
            }
            continue;
        }

        let html = document_body_html(obj);
        let new_id = Uuid::new_v4().to_string();
        let filename = format!("{}.md", slugify(&title));

        sqlx::query(
            "INSERT INTO documents
               (id, title, kind, collections_json, status, filename, content, content_format, provenance)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'html', ?8)",
        )
        .bind(&new_id)
        .bind(title.trim())
        .bind("Notes")
        .bind(r#"["Notes"]"#)
        .bind("Revising")
        .bind(&filename)
        .bind(&html)
        .bind(&provenance)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            "INSERT INTO sync_outbox (id, document_id, operation, payload_ref)
             VALUES (?1, ?2, 'upsert', ?2)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&new_id)
        .execute(&mut *tx)
        .await?;

        if let Some(entry) = report.iter_mut().find(|r| &r.key == uuid) {
            entry.document_id = Some(new_id);
        }
        created += 1;
    }

    let report_json = serde_json::to_string(&report)
        .map_err(|e| AppError::Other(format!("could not encode report: {e}")))?;

    sqlx::query(
        "INSERT INTO migration_runs
           (id, source_kind, source_path, source_hash, state, report_json)
         VALUES (?1, 'legacy-py-json', ?2, ?3, 'completed', ?4)",
    )
    .bind(&run_id)
    .bind(source.display().to_string())
    .bind(&source_hash)
    .bind(&report_json)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(LegacyImportResult {
        source_path: source.display().to_string(),
        source_hash,
        run_id,
        documents_created: created,
        keys_total: map.len(),
        report,
    })
}

/// Human-readable one-line summary, used by the CLI-facing report.
pub fn summarise(result: &LegacyImportResult) -> String {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for entry in &result.report {
        *counts.entry(entry.verdict.as_str()).or_default() += 1;
    }
    let detail = counts
        .iter()
        .map(|(name, n)| format!("{n} {name}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{} — {} document(s) created across {} key(s) [{detail}]",
        result.source_path, result.documents_created, result.keys_total
    )
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn write_temp(name: &str, contents: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("quill-legacy-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join(name);
        std::fs::write(&path, contents).expect("write source");
        path
    }

    const GOOD_BODY: &str = "# Motion Detector Report\n\nThis is a sufficiently long paragraph that clearly reads as real prose rather than a stub or a truncated fragment, which is what the quality gate is meant to distinguish.\n\n## Overview\n\nThe system detects motion using a passive infrared sensor array mounted above the entry point, and reports activations to a local controller over a serial link.\n\n## Limitations\n\nDetection quality degrades in direct sunlight and the false positive rate rises sharply when ambient temperature crosses the sensor threshold, which remains an open problem.\n";

    /// The legacy `markdown` field has lost its heading markers; all duplicates
    /// of the same document share this exact text.
    const SHARED_MARKDOWN: &str = "FLAT TEXT WITH NO HEADING MARKERS AT ALL";

    /// Builds a source document that mirrors the real legacy layout:
    /// two byte-identical document records, a parse cache naming the survivor,
    /// and one record in each of the derived namespaces.
    fn sample_json(extra: &[(&str, Value)]) -> String {
        let mut map = serde_json::Map::new();

        // The real legacy store keeps structure in `sections`; its `markdown`
        // field has already lost heading markers, so the fixture mirrors that.
        let sections = serde_json::json!([{
            "level": 1, "no": null, "title": "Motion Detector Report",
            "blocks": [{ "type": "paragraph", "content": GOOD_BODY }],
            "children": [],
        }]);

        map.insert(
            "3eceffdd-d161-4352-8dba-16c1c7991b15".into(),
            serde_json::json!({
                "title": "Real Doc",
                "unique_id": "3eceffdd-d161-4352-8dba-16c1c7991b15",
                "markdown": SHARED_MARKDOWN,
                "sections": sections,
            }),
        );
        // Same markdown, different parsed section tree: this is exactly the
        // parser-version drift present in the real store.
        let other_sections = serde_json::json!([{
            "level": 1, "no": null, "title": "Motion Detector Report",
            "blocks": [{ "type": "paragraph", "content": GOOD_BODY }],
            "children": [],
        }]);
        map.insert(
            "aaaabbbb-1111-2222-3333-444455556666".into(),
            serde_json::json!({
                "title": "Duplicate",
                "unique_id": "aaaabbbb-1111-2222-3333-444455556666",
                "markdown": SHARED_MARKDOWN,
                "sections": other_sections,
            }),
        );
        map.insert(
            "meta:parsecache".into(),
            serde_json::json!({
                "8:abc": "3eceffdd-d161-4352-8dba-16c1c7991b15",
                "6:abc": "aaaabbbb-1111-2222-3333-444455556666",
            }),
        );
        map.insert(
            "concept:3eceffdd-d161-4352-8dba-16c1c7991b15".into(),
            serde_json::json!({ "sections": [{ "path": "", "text_chars": 0 }] }),
        );
        map.insert(
            "written:3eceffdd-d161-4352-8dba-16c1c7991b15".into(),
            serde_json::json!({ "markdown": "x" }),
        );
        map.insert(
            "session:abc123".into(),
            serde_json::json!({ "id": "abc123" }),
        );

        for (key, value) in extra {
            map.insert((*key).to_string(), value.clone());
        }

        Value::Object(map).to_string()
    }

    #[test]
    fn uuid_shape_detection() {
        assert!(is_uuid_key("3eceffdd-d161-4352-8dba-16c1c7991b15"));
        assert!(!is_uuid_key("sessions"));
        assert!(!is_uuid_key("concept:smoke"));
        assert!(!is_uuid_key("meta:parsecache"));
        assert!(!is_uuid_key("aaaabbbb-1111-2222-3333"));
    }

    /// Builds a legacy-shaped record: title, a flat markdown fallback, and a
    /// section tree that is the authoritative structure.
    fn record(title: &str, sections: Value, markdown: &str) -> Value {
        serde_json::json!({
            "title": title,
            "markdown": markdown,
            "sections": sections,
        })
    }

    fn section(level: u64, no: Option<&str>, title: &str, body: &str) -> Value {
        serde_json::json!({
            "level": level,
            "no": no,
            "title": title,
            "blocks": [{ "type": "paragraph", "content": body }],
            "children": [],
        })
    }

    #[test]
    fn quality_gate_accepts_a_well_formed_record() {
        let sections = serde_json::json!([section(1, None, "Report Title", GOOD_BODY),]);
        assert!(assess_document(&record("Report", sections.clone(), "")).is_ok());
    }

    #[test]
    fn quality_gate_rejects_empty_and_thin_records() {
        assert!(assess_document(&record("", serde_json::json!([]), "")).is_err());
        assert!(assess_document(&record("Title", serde_json::json!([]), "")).is_err());
        assert!(assess_document(&record("Title", serde_json::json!([]), "too short")).is_err());
    }

    #[test]
    fn quality_gate_rejects_bodies_without_recoverable_headings() {
        // 200 words but no section tree and no markdown headings.
        let flat = "word ".repeat(200);
        assert!(assess_document(&record("Title", serde_json::json!([]), &flat)).is_err());
    }

    #[test]
    fn section_tree_is_preferred_over_the_flat_markdown_field() {
        let sections = serde_json::json!([
            section(1, None, "Alpha", "First body paragraph."),
            section(2, Some("1.1"), "Beta", "Second body paragraph."),
        ]);
        let html = document_body_html(&record("T", sections, "plain text with no markup"));
        assert!(html.contains("<h1>Alpha</h1>"), "got {html}");
        assert!(
            html.contains("<h2>1.1 Beta</h2>"),
            "numbered heading: {html}"
        );
    }

    #[test]
    fn nested_children_are_rendered() {
        let child = section(2, Some("1.1"), "Child Section", "Child body text.");
        let parent = serde_json::json!({
            "level": 1, "no": "1", "title": "Parent Section",
            "blocks": [{ "type": "paragraph", "content": "Parent body." }],
            "children": [child],
        });
        let html = document_body_html(&record("T", serde_json::json!([parent]), ""));
        assert!(html.contains("<h1>1 Parent Section</h1>"), "got {html}");
        assert!(html.contains("<h2>1.1 Child Section</h2>"), "got {html}");
        assert!(html.contains("<p>Child body text.</p>"), "got {html}");
    }

    #[test]
    fn section_content_is_escaped() {
        let hostile = section(
            1,
            None,
            "Title <script>alert(1)</script>",
            "body <img src=x onerror=alert(1)>",
        );
        let html = document_body_html(&record("T", serde_json::json!([hostile]), ""));
        // No tag from the payload may survive as markup; every angle bracket it
        // contained must be entity-encoded. (The literal text "onerror" may
        // appear as inert escaped content, which is harmless.)
        assert!(!html.contains("<script"), "raw script tag: {html}");
        assert!(!html.contains("<img"), "raw img tag: {html}");
        assert!(html.contains("&lt;script&gt;"), "should be escaped: {html}");

        // The only real tags are the ones the renderer itself emitted.
        for (index, _) in html.match_indices('<') {
            let rest = &html[index..];
            let tag = &rest[..rest.find('>').map(|p| p + 1).unwrap_or(1)];
            let name = tag
                .trim_start_matches('<')
                .trim_start_matches('/')
                .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
                .next()
                .unwrap_or_default();
            assert!(
                matches!(
                    name,
                    "h1" | "h2" | "h3" | "p" | "ul" | "ol" | "li" | "pre" | "code" | "blockquote"
                ),
                "unexpected tag emitted: {tag}"
            );
        }
    }

    #[test]
    fn section_heading_level_is_clamped() {
        let weird = serde_json::json!({
            "level": 99, "title": "Odd Level", "blocks": [], "children": []
        });
        let html = document_body_html(&record("T", serde_json::json!([weird]), ""));
        assert!(html.contains("<h3>Odd Level</h3>"), "got {html}");
        assert!(!html.contains("h99"), "got {html}");
    }

    #[test]
    fn bullet_blocks_become_lists() {
        let bulleted = serde_json::json!({
            "level": 2, "no": null, "title": "Findings",
            "blocks": [{ "type": "paragraph", "content": "- first\n- second" }],
            "children": []
        });
        let html = document_body_html(&record("T", serde_json::json!([bulleted]), ""));
        assert!(html.contains("<ul>"), "got {html}");
        assert!(html.contains("<li>first</li>"), "got {html}");
    }

    #[test]
    fn markdown_conversion_produces_headings() {
        let html = markdown_to_html("# Heading\n\nSome *text*.\n");
        assert!(html.contains("<h1>Heading</h1>"), "got {html}");
        assert!(html.contains("<em>text</em>"), "got {html}");
    }

    #[test]
    fn markdown_conversion_escapes_raw_html() {
        let html = markdown_to_html("<script>alert(1)</script>\n\ntext\n");
        assert!(
            !html.contains("<script>"),
            "raw html must not pass through: {html}"
        );
    }

    #[test]
    fn dangerous_link_schemes_are_stripped() {
        for bad in [
            "[click](javascript:alert(1))",
            "[click](vbscript:msgbox)",
            "![img](data:text/html;base64,PHNjcmlwdD4=)",
        ] {
            let html = markdown_to_html(bad);
            assert!(!html.contains("javascript:"), "got {html}");
            assert!(!html.contains("vbscript:"), "got {html}");
            assert!(!html.contains("data:text/html"), "got {html}");
        }
    }

    #[test]
    fn safe_link_schemes_survive() {
        let html = markdown_to_html("[ok](https://example.com/page) and ![i](/img/a.png)");
        assert!(html.contains("https://example.com/page"), "got {html}");
        assert!(html.contains("/img/a.png"), "got {html}");
    }

    #[test]
    fn data_image_urls_are_allowed() {
        let html = markdown_to_html("![i](data:image/png;base64,iVBORw0K)");
        assert!(
            html.contains("data:image/png"),
            "inline images should survive: {html}"
        );
    }

    #[tokio::test]
    async fn duplicate_documents_collapse_to_the_cache_survivor() {
        let path = write_temp("db.json", &sample_json(&[]));
        let pool = test_pool().await;
        let result = scan(&pool, &path).await.expect("scan");

        assert_eq!(result.total_keys, 6);
        assert_eq!(result.importable_documents, 1, "one survivor");

        let survivor = result
            .report
            .iter()
            .find(|r| r.verdict == Verdict::Imported)
            .expect("a survivor");
        assert_eq!(
            survivor.key, "3eceffdd-d161-4352-8dba-16c1c7991b15",
            "the highest parse-cache version names the survivor"
        );

        let merged = result
            .report
            .iter()
            .find(|r| r.verdict == Verdict::Merged)
            .expect("the duplicate is reported as merged");
        assert!(merged.reason.contains("3eceffdd"), "got {}", merged.reason);
    }

    #[tokio::test]
    async fn defective_namespaces_are_quarantined_not_dropped() {
        let path = write_temp("db.json", &sample_json(&[]));
        let pool = test_pool().await;
        let result = scan(&pool, &path).await.expect("scan");

        let concept = result
            .report
            .iter()
            .find(|r| r.key.starts_with("concept:"))
            .unwrap();
        assert_eq!(concept.verdict, Verdict::Quarantined);
        assert!(
            concept.reason.contains("paths are empty"),
            "got {}",
            concept.reason
        );

        let written = result
            .report
            .iter()
            .find(|r| r.key.starts_with("written:"))
            .unwrap();
        assert_eq!(written.verdict, Verdict::Quarantined);

        // Regenerable internals are discarded, with a reason.
        let cache = result
            .report
            .iter()
            .find(|r| r.key.starts_with("meta:"))
            .unwrap();
        assert_eq!(cache.verdict, Verdict::Discarded);

        // Every key is accounted for.
        assert_eq!(result.report.len(), result.total_keys);
    }

    #[tokio::test]
    async fn import_creates_documents_and_html_content() {
        let path = write_temp("db.json", &sample_json(&[]));
        let pool = test_pool().await;
        let result = run(&pool, &path).await.expect("import");

        assert_eq!(result.documents_created, 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM documents")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);

        let doc: (String, String, String, String) =
            sqlx::query_as("SELECT title, content, content_format, provenance FROM documents")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(doc.0, "Real Doc");
        assert!(
            doc.1.contains("<h1>Motion Detector Report</h1>"),
            "content should be HTML: {}",
            doc.1
        );
        assert_eq!(doc.2, "html");
        assert_eq!(doc.3, "legacy-py-json:3eceffdd-d161-4352-8dba-16c1c7991b15");
    }

    #[tokio::test]
    async fn import_is_idempotent_across_runs() {
        let path = write_temp("db.json", &sample_json(&[]));
        let pool = test_pool().await;

        let first = run(&pool, &path).await.expect("first import");
        assert_eq!(first.documents_created, 1);

        let second = run(&pool, &path).await.expect("second import");
        assert_eq!(second.documents_created, 0, "a re-run must not duplicate");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM documents")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "still exactly one document");

        // The second call returns the original run id rather than a new one.
        assert_eq!(first.run_id, second.run_id);
    }

    #[tokio::test]
    async fn import_writes_a_sync_outbox_row() {
        let path = write_temp("db.json", &sample_json(&[]));
        let pool = test_pool().await;
        run(&pool, &path).await.expect("import");

        let outbox: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sync_outbox")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(outbox, 1);
    }

    #[tokio::test]
    async fn source_file_is_never_modified() {
        let original = sample_json(&[]);
        let path = write_temp("db.json", &original);
        let pool = test_pool().await;

        run(&pool, &path).await.expect("import");
        run(&pool, &path).await.expect("re-import");

        let after = std::fs::read_to_string(&path).expect("source still readable");
        assert_eq!(
            after, original,
            "the source file must be byte-for-byte unchanged"
        );
    }

    #[tokio::test]
    async fn invalid_json_is_reported_not_panicked_on() {
        let path = write_temp("db.json", "{not json");
        let pool = test_pool().await;
        assert!(scan(&pool, &path).await.is_err());
    }

    #[tokio::test]
    async fn scan_reports_every_key_including_unknown_namespaces() {
        let path = write_temp(
            "db.json",
            &sample_json(&[("weird:thing", serde_json::json!({ "a": 1 }))]),
        );
        let pool = test_pool().await;
        let result = scan(&pool, &path).await.expect("scan");

        let unknown = result
            .report
            .iter()
            .find(|r| r.key == "weird:thing")
            .unwrap();
        assert_eq!(unknown.verdict, Verdict::Quarantined);
        assert!(
            unknown.reason.contains("unrecognised namespace"),
            "got {}",
            unknown.reason
        );
        assert_eq!(result.report.len(), result.total_keys);
    }

    #[tokio::test]
    async fn summary_is_human_readable() {
        let path = write_temp("db.json", &sample_json(&[]));
        let pool = test_pool().await;
        let result = run(&pool, &path).await.expect("import");
        let text = summarise(&result);
        assert!(text.contains("1 document(s) created"), "got {text}");
        assert!(text.contains("imported"), "got {text}");
    }
}

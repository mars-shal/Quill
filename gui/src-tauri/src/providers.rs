//! Provider registry: the local table of every provider the reader can send a
//! request to.
//!
//! This module owns one noun -- a provider row -- and the seven operations that
//! act on it. Nothing here reaches for the network or the keyring; `secrets.rs`
//! owns the credential and this table only records which providers exist, so a
//! row without a credential is a legitimate state (a provider being set up) and
//! a credential without a row is not.
//!
//! Two decisions are load-bearing and both were got wrong once:
//!
//! * `vendor` and `protocol` are separate. A vendor is who bills the account; a
//!   protocol is what goes on the wire. Anthropic and Google do not speak the
//!   OpenAI protocol, so an enum that conflated them could only reach them by
//!   claiming to be OpenAI. `Vendor` and `Protocol` are independent closed sets
//!   and nothing derives one from the other.
//! * `models` is a JSON array on the wire and a `Vec<String>` in Rust. A stored
//!   value that is not an array of strings is reported as an error at the read
//!   boundary. Coercing it to `[]` would silently erase a reader's model list and
//!   leave them staring at an empty dropdown with no idea why.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::error::{AppError, AppResult};
use crate::secrets;

/// Who bills the account. Says nothing about the wire format -- see [`Protocol`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Vendor {
    #[default]
    Compatible,
    Openai,
    Anthropic,
    Google,
}

/// The request shape sent to a provider. Independent of [`Vendor`]: an
/// OpenAI-compatible gateway is `Vendor::Compatible`, and a self-hosted
/// Llama served over vLLM is `Vendor::Openai` with either protocol.
///
/// `Cli` is the one transport that is not a request shape: the sidecar hands
/// the turn to a CLI agent's one-shot invocation (`opencode run`, `codex
/// exec`, ...) and reads the answer off its stdout. The tool's own login is
/// the credential, so a `cli` provider never has a registry key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    #[default]
    OpenaiChat,
    OpenaiResponses,
    AnthropicMessages,
    GoogleGenerative,
    Cli,
}

impl Vendor {
    pub fn as_str(self) -> &'static str {
        match self {
            Vendor::Openai => "openai",
            Vendor::Anthropic => "anthropic",
            Vendor::Google => "google",
            Vendor::Compatible => "compatible",
        }
    }
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Protocol::OpenaiChat => "openai_chat",
            Protocol::OpenaiResponses => "openai_responses",
            Protocol::AnthropicMessages => "anthropic_messages",
            Protocol::GoogleGenerative => "google_generative",
            Protocol::Cli => "cli",
        }
    }
}

/// Creates the first provider from the environment, exactly once.
///
/// This is what makes an existing installation keep working after the registry
/// lands. `.env` already holds a working endpoint and key that the pipeline read
/// directly, and the whole failure mode of this work would be that upgrading
/// leaves a reader with a configured app that cannot answer anything. So the
/// environment is grandfathered into a real provider, with the credential copied
/// into the credential store, and the environment stops being consulted
/// afterwards.
///
/// Seeding is skipped the moment the table holds anything, including a row the
/// reader deliberately deleted -- resurrecting a provider someone removed would
/// be worse than making them re-add it.
pub async fn seed_from_env<F>(pool: &SqlitePool, lookup: F) -> AppResult<bool>
where
    F: Fn(&str) -> Option<String>,
{
    if !list(pool).await?.is_empty() {
        return Ok(false);
    }

    let base_url = lookup("OPENAI_BASE_URL").unwrap_or_default();
    let api_key = lookup("OPENAI_API_KEY").unwrap_or_default();
    let model = lookup("LLM_MODEL").unwrap_or_default();
    let base_url = base_url.trim().to_string();
    if base_url.is_empty() && api_key.trim().is_empty() {
        return Ok(false);
    }

    // A custom base URL means an OpenAI-compatible gateway, not OpenAI itself --
    // this install points at a third party. `openai_chat` is the default because
    // it is the shape nearly every compatible endpoint implements; a provider
    // that only speaks the Responses API says so in Settings.
    let (id, vendor) = if base_url.is_empty() {
        ("openai".to_string(), Vendor::Openai)
    } else {
        ("compatible".to_string(), Vendor::Compatible)
    };

    let created = create(
        pool,
        NewProvider {
            id: id.clone(),
            label: Some(seed_label(&base_url)),
            vendor: Some(vendor),
            protocol: Some(Protocol::OpenaiChat),
            base_url: Some(base_url),
            default_model: Some(model),
            models: Some(Vec::new()),
        },
    )
    .await?;
    set_active(pool, &created.id).await?;

    if !api_key.trim().is_empty() {
        secrets::set(pool, &created.id, api_key.trim()).await?;
        set_key_source(pool, &created.id, SOURCE_ENV).await?;
    }

    Ok(true)
}

/// Who owns a provider's credential -- the only thing that can decide who wins
/// on the next launch, since a stored key records nothing about who set it.
const SOURCE_ENV: &str = "env";
const SOURCE_USER: &str = "user";

/// A `settings` row rather than a column on `providers`, for the same reason
/// `app.wallpaper` is one: the table is already `key`/`value`, so this needs no
/// migration and an existing install simply grows a row on its next launch.
fn key_source_key(id: &str) -> String {
    format!("provider.key_source.{id}")
}

/// `None` covers every install predating this, and reads as "not the reader's",
/// so the environment is free to claim the provider.
pub async fn key_source(pool: &SqlitePool, id: &str) -> AppResult<Option<String>> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
            .bind(key_source_key(id))
            .fetch_optional(pool)
            .await?,
    )
}

pub async fn set_key_source(pool: &SqlitePool, id: &str, source: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(key_source_key(id))
    .bind(source)
    .execute(pool)
    .await?;
    Ok(())
}

/// Records that the reader set this provider's credential, so the environment
/// stops replacing it on the next launch.
pub async fn mark_key_user_owned(pool: &SqlitePool, id: &str) -> AppResult<()> {
    set_key_source(pool, id, SOURCE_USER).await
}

/// Forgets a provider's credential origin, so that once its key is deleted the
/// environment may claim the provider again.
pub async fn clear_key_source(pool: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM settings WHERE key = ?1")
        .bind(key_source_key(id))
        .execute(pool)
        .await?;
    Ok(())
}

/// Re-applies the environment's key to the provider the environment seeded.
///
/// The registry takes its copy of the key at first launch and then stops reading
/// the file. That is right for every provider except the one the file describes,
/// where it means a corrected key changes nothing and nothing says why. So each
/// launch lets the environment reclaim that one provider -- unless a key was
/// typed for it in Settings, the one case where the file has to lose.
///
/// Only the provider the environment names is touched: the base URL must match,
/// so a provider pointing at another host is never handed a credential for a
/// host it does not talk to.
pub async fn sync_env_credential<F>(pool: &SqlitePool, lookup: F) -> AppResult<bool>
where
    F: Fn(&str) -> Option<String>,
{
    let Some(provider) = get_active(pool).await? else {
        return Ok(false);
    };
    if key_source(pool, &provider.id).await?.as_deref() == Some(SOURCE_USER) {
        return Ok(false);
    }

    let Some(key) = lookup("OPENAI_API_KEY").filter(|k| !k.trim().is_empty()) else {
        return Ok(false);
    };

    let env_base = lookup("OPENAI_BASE_URL").unwrap_or_default();
    if !same_endpoint(&provider.base_url, &env_base) {
        return Ok(false);
    }

    secrets::set(pool, &provider.id, key.trim()).await?;
    set_key_source(pool, &provider.id, SOURCE_ENV).await?;
    Ok(true)
}

/// Trailing slash and case only. An empty URL on both sides means the vendor's
/// own default endpoint, which is what an unset `OPENAI_BASE_URL` produces.
fn same_endpoint(a: &str, b: &str) -> bool {
    a.trim()
        .trim_end_matches('/')
        .eq_ignore_ascii_case(b.trim().trim_end_matches('/'))
}

/// Moves the flat `provider`/`model`/`endpoint` a pre-registry build kept in the
/// `settings` row into the registry, then rewrites the row without them.
///
/// The registry is the one place a request reads its provider from, so a second
/// copy in settings is how a run ends up crediting a provider it did not use --
/// the two agree until the moment one of them is edited. The values are adopted
/// only where the registry has no answer of its own: it is the newer record, and
/// it is the one with an endpoint column to write to, while the legacy field was
/// left empty as often as not.
pub async fn migrate_legacy_settings(pool: &SqlitePool) -> AppResult<bool> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app'")
        .fetch_optional(pool)
        .await?;
    let Some(raw) = raw else {
        return Ok(false);
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(false);
    };
    let Some(object) = value.as_object_mut() else {
        return Ok(false);
    };

    let field = |key: &str| {
        object
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let provider = field("provider");
    let model = field("model");
    let endpoint = field("endpoint");

    let stripped = object.remove("provider").is_some()
        | object.remove("model").is_some()
        | object.remove("endpoint").is_some();
    if !stripped {
        return Ok(false);
    }

    adopt_legacy_provider(pool, &provider, &model, &endpoint).await?;

    let rewritten = serde_json::to_string(&value)
        .map_err(|e| AppError::Other(format!("could not encode settings: {e}")))?;
    sqlx::query("UPDATE settings SET value = ?1, updated_at = datetime('now') WHERE key = 'app'")
        .bind(rewritten)
        .execute(pool)
        .await?;

    Ok(true)
}

/// Where the legacy values land: a provider of their own when the registry is
/// empty, the active provider's missing model when it is not.
async fn adopt_legacy_provider(
    pool: &SqlitePool,
    provider: &str,
    model: &str,
    endpoint: &str,
) -> AppResult<()> {
    if list(pool).await?.is_empty() {
        let Some(id) = slug(provider) else {
            return Ok(());
        };
        let created = create(
            pool,
            NewProvider {
                id,
                label: Some(provider.to_string()),
                // A named endpoint means a compatible gateway; no endpoint means
                // the vendor's own, and the only vendor a pre-registry build
                // could name by default is OpenAI.
                vendor: Some(if endpoint.is_empty() {
                    Vendor::Openai
                } else {
                    Vendor::Compatible
                }),
                protocol: Some(Protocol::OpenaiChat),
                base_url: Some(endpoint.to_string()),
                default_model: Some(model.to_string()),
                models: Some(Vec::new()),
            },
        )
        .await?;
        set_active(pool, &created.id).await?;
        return Ok(());
    }

    if model.is_empty() {
        return Ok(());
    }
    let Some(active) = get_active(pool).await? else {
        return Ok(());
    };
    if !active.default_model.trim().is_empty() {
        return Ok(());
    }
    update(
        pool,
        ProviderPatch {
            id: active.id,
            default_model: Some(model.to_string()),
            ..ProviderPatch::default()
        },
    )
    .await?;
    Ok(())
}

/// A provider id from the name a pre-registry build displayed, or `None` when
/// the name holds nothing a slug can be built from.
fn slug(name: &str) -> Option<String> {
    let id: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let id = id.trim_matches('-');
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// Reads a variable from the process environment, falling back to the pipeline's
/// own `.env`.
///
/// The desktop process does not inherit the shell's environment, and `.env` is
/// how this project has always configured the pipeline -- so the file is the only
/// place a working key is likely to be. Parsing it here is deliberate: it is the
/// one migration source for a credential that already exists, and reading it once
/// at first launch is cheaper than asking the reader to retype a key we can see.
pub fn env_lookup(key: &str) -> Option<String> {
    if let Ok(value) = std::env::var(key) {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }
    let root = crate::sidecar::pipeline_root().ok()?;
    let contents = std::fs::read_to_string(root.join(".env")).ok()?;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() != key {
            continue;
        }
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

/// Names the seeded provider after the host it points at, so the reader sees
/// which of their endpoints was adopted rather than an unexplained row.
fn seed_label(base_url: &str) -> String {
    if base_url.is_empty() {
        return "OpenAI".to_string();
    }
    let host = base_url
        .split("://")
        .nth(1)
        .unwrap_or(base_url)
        .split('/')
        .next()
        .unwrap_or(base_url);
    if host.is_empty() {
        "Custom endpoint".to_string()
    } else {
        host.to_string()
    }
}

/// Every provider id the registry accepts.
impl TryFrom<&str> for Vendor {
    type Error = AppError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "openai" => Ok(Vendor::Openai),
            "anthropic" => Ok(Vendor::Anthropic),
            "google" => Ok(Vendor::Google),
            "compatible" => Ok(Vendor::Compatible),
            other => Err(AppError::Validation(format!("unknown vendor {other:?}"))),
        }
    }
}

impl TryFrom<&str> for Protocol {
    type Error = AppError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "openai_chat" => Ok(Protocol::OpenaiChat),
            "openai_responses" => Ok(Protocol::OpenaiResponses),
            "anthropic_messages" => Ok(Protocol::AnthropicMessages),
            "google_generative" => Ok(Protocol::GoogleGenerative),
            other => Err(AppError::Validation(format!("unknown protocol {other:?}"))),
        }
    }
}

/// A provider as stored locally.
///
/// The `Default` impl is not a convenience: it is the schema's column defaults,
/// and `#[serde(default)]` on the struct means a payload from an older build
/// that predates a field fills that field from here rather than from
/// `Default::default()`. The same reasoning is written out at length on
/// [`crate::settings::Settings`], and the failure it prevents -- serde silently
/// discarding what an older build wrote -- is the reason it is spelled out here
/// too.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Provider {
    pub id: String,
    pub label: String,
    pub vendor: Vendor,
    pub protocol: Protocol,
    pub base_url: String,
    pub default_model: String,
    pub models: Vec<String>,
    pub is_active: bool,
}

impl Default for Provider {
    fn default() -> Self {
        Provider {
            id: String::new(),
            label: String::new(),
            vendor: Vendor::Compatible,
            protocol: Protocol::OpenaiChat,
            base_url: String::new(),
            default_model: String::new(),
            models: Vec::new(),
            is_active: false,
        }
    }
}

/// The fields a caller may set when creating a provider. `None` takes the
/// column default.
///
/// A create never activates. Activating is a separate, explicit call, so saving
/// a new provider cannot silently move the reader's requests onto it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NewProvider {
    pub id: String,
    pub label: Option<String>,
    pub vendor: Option<Vendor>,
    pub protocol: Option<Protocol>,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    pub models: Option<Vec<String>>,
}

/// A partial update. `None` leaves a field alone; `Some` writes it, including
/// `Some("")` and `Some(vec![])` as explicit clears.
///
/// `is_active` is absent on purpose: it is changed by [`set_active`] alone, so
/// that "make this one active" cannot arrive through the generic edit path and
/// skip the invariant.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderPatch {
    pub id: String,
    pub label: Option<String>,
    pub vendor: Option<Vendor>,
    pub protocol: Option<Protocol>,
    pub base_url: Option<String>,
    pub default_model: Option<String>,
    pub models: Option<Vec<String>>,
}

const COLUMNS: &str = "id, label, vendor, protocol, base_url, default_model, models, is_active";

/// Rejects anything that is not a slug of `[a-z0-9-]`.
///
/// The same rule is a `CHECK` in the migration, and both layers are tested. The
/// CHECK alone cannot produce a useful message and does not run when the value
/// arrives through anything but SQL; the Rust layer alone would leave the table
/// reachable by a script, a future command, or a migration. Neither is redundant
/// with the other.
fn validate_id(id: &str) -> AppResult<()> {
    if id.is_empty() {
        return Err(AppError::Validation(
            "provider id must not be empty".to_string(),
        ));
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(AppError::Validation(format!(
            "provider id {id:?} must be a slug of lowercase letters, digits and dashes"
        )));
    }
    Ok(())
}

/// Decodes the stored JSON model list, or reports why it could not be decoded.
fn decode_models(id: &str, raw: &str) -> AppResult<Vec<String>> {
    serde_json::from_str(raw).map_err(|e| {
        AppError::Other(format!(
            "provider {id:?} has an unreadable model list ({e}); stored value was {raw:?}"
        ))
    })
}

/// Encodes the model list for storage. `Vec<String>` always encodes, so this
/// cannot fail in practice; the error arm exists because `to_string` returns one.
fn encode_models(models: &[String]) -> AppResult<String> {
    serde_json::to_string(models)
        .map_err(|e| AppError::Other(format!("could not encode model list: {e}")))
}

/// Every provider, ordered by id.
///
/// `id` is the primary key, so the order is total and defined rather than
/// whatever SQLite happened to return. A picker that reorders itself between two
/// identical reads is a picker the reader cannot learn.
pub async fn list(pool: &SqlitePool) -> AppResult<Vec<Provider>> {
    let sql = format!("SELECT {COLUMNS} FROM providers ORDER BY id ASC");
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    rows.iter().map(row_to_provider).collect()
}

pub async fn get(pool: &SqlitePool, id: &str) -> AppResult<Provider> {
    let sql = format!("SELECT {COLUMNS} FROM providers WHERE id = ?1");
    let row = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("provider {id:?}")))?;
    row_to_provider(&row)
}

/// The provider requests are sent to, if one is selected.
///
/// `None` is a normal state, not a failure: it is what the registry looks like
/// before anything has been activated and again after the active provider is
/// deleted.
pub async fn get_active(pool: &SqlitePool) -> AppResult<Option<Provider>> {
    let sql = format!("SELECT {COLUMNS} FROM providers WHERE is_active = 1 ORDER BY id LIMIT 1");
    let row = sqlx::query(&sql).fetch_optional(pool).await?;
    row.as_ref().map(row_to_provider).transpose()
}

pub async fn create(pool: &SqlitePool, input: NewProvider) -> AppResult<Provider> {
    validate_id(&input.id)?;

    let vendor = input.vendor.unwrap_or_default();
    let protocol = input.protocol.unwrap_or_default();
    let models_json = encode_models(input.models.as_deref().unwrap_or(&[]))?;

    let mut tx = pool.begin().await?;

    let taken: Option<String> = sqlx::query_scalar("SELECT id FROM providers WHERE id = ?1")
        .bind(&input.id)
        .fetch_optional(&mut *tx)
        .await?;
    if taken.is_some() {
        return Err(AppError::Validation(format!(
            "provider {:?} already exists",
            input.id
        )));
    }

    sqlx::query(
        "INSERT INTO providers (id, label, vendor, protocol, base_url, default_model, models)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&input.id)
    .bind(input.label.unwrap_or_default())
    .bind(vendor.as_str())
    .bind(protocol.as_str())
    .bind(input.base_url.unwrap_or_default())
    .bind(input.default_model.unwrap_or_default())
    .bind(models_json)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    get(pool, &input.id).await
}

pub async fn update(pool: &SqlitePool, input: ProviderPatch) -> AppResult<Provider> {
    // Id is the primary key and is never rewritten, but a patch naming a
    // non-slug would still be rejected: the rule is about provider ids, and this
    // is the only other place an id enters the module.
    validate_id(&input.id)?;

    let models_json = input.models.as_deref().map(encode_models).transpose()?;

    let mut tx = pool.begin().await?;

    let changed = sqlx::query(
        "UPDATE providers SET
            label         = COALESCE(?2, label),
            vendor        = COALESCE(?3, vendor),
            protocol      = COALESCE(?4, protocol),
            base_url      = COALESCE(?5, base_url),
            default_model = COALESCE(?6, default_model),
            models        = COALESCE(?7, models)
         WHERE id = ?1",
    )
    .bind(&input.id)
    .bind(input.label.as_deref())
    .bind(input.vendor.map(Vendor::as_str))
    .bind(input.protocol.map(Protocol::as_str))
    .bind(input.base_url.as_deref())
    .bind(input.default_model.as_deref())
    .bind(models_json.as_deref())
    .execute(&mut *tx)
    .await?
    .rows_affected();

    if changed == 0 {
        return Err(AppError::NotFound(format!("provider {:?}", input.id)));
    }

    tx.commit().await?;

    get(pool, &input.id).await
}

pub async fn delete(pool: &SqlitePool, id: &str) -> AppResult<()> {
    let changed = sqlx::query("DELETE FROM providers WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected();

    if changed == 0 {
        return Err(AppError::NotFound(format!("provider {id:?}")));
    }

    Ok(())
}

/// Makes `id` the active provider and deactivates every other one.
///
/// The deactivation is a database trigger, not a second statement here, so the
/// single-active invariant has exactly one implementation. A raw `UPDATE` or
/// `INSERT` from a script gets the same guarantee.
pub async fn set_active(pool: &SqlitePool, id: &str) -> AppResult<Provider> {
    let changed = sqlx::query("UPDATE providers SET is_active = 1 WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected();

    if changed == 0 {
        return Err(AppError::NotFound(format!("provider {id:?}")));
    }

    get(pool, id).await
}

fn row_to_provider(row: &sqlx::sqlite::SqliteRow) -> AppResult<Provider> {
    let id: String = row.try_get("id")?;
    let models_raw: String = row.try_get("models")?;
    let vendor_raw: String = row.try_get("vendor")?;
    let protocol_raw: String = row.try_get("protocol")?;
    let is_active: i64 = row.try_get("is_active")?;

    Ok(Provider {
        label: row.try_get("label")?,
        vendor: Vendor::try_from(vendor_raw.as_str())?,
        protocol: Protocol::try_from(protocol_raw.as_str())?,
        base_url: row.try_get("base_url")?,
        default_model: row.try_get("default_model")?,
        models: decode_models(&id, &models_raw)?,
        is_active: is_active == 1,
        id,
    })
}

#[cfg(test)]
mod tests;

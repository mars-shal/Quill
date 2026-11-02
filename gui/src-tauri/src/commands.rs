use std::path::Path;

use serde::Serialize;
use sqlx::SqlitePool;
use tauri::State;

use crate::cli_tools;
use crate::db;
use crate::documents::{self, NewDocument, UpdateDocument};
use crate::error::{AppError, AppResult};
use crate::export;
use crate::images::{self, ImageData};
use crate::legacy;
use crate::model_catalog;
use crate::providers::{self, NewProvider, Provider, ProviderPatch};
use crate::secrets::{self, SecretStatus};
use crate::settings::{self, Settings, SettingsPatch};
use crate::ydoc::{self, YdocState};

pub type SharedState<'a> = State<'a, crate::AppState>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub app_version: String,
    pub platform: String,
    pub database_path: String,
    pub document_count: i64,
    pub settings: Settings,
}

#[tauri::command]
pub async fn bootstrap(state: SharedState<'_>) -> AppResult<Bootstrap> {
    // This used to be `.unwrap_or(0)`, which made a database error look exactly
    // like a fresh install -- and a fresh install is what onboarding keys off,
    // so a transient read failure could have walked a real reader through
    // first-run setup. It is also the number P5-0 reasons about. If the table
    // cannot be counted the app cannot list it either, so the honest answer is
    // to fail the command rather than invent one.
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM documents WHERE deleted_at IS NULL")
        .fetch_one(&state.pool)
        .await?;

    // P5-0: an existing library is not a first run, whatever migration 0002
    // seeded into the onboarding row.
    let reconciled = crate::account::reconcile_onboarding_completed(&state.pool, count).await?;
    if reconciled {
        eprintln!("onboarding: back-filled completed for an existing library");
    }

    Ok(Bootstrap {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        database_path: db::database_path()?.to_string_lossy().to_string(),
        document_count: count,
        settings: settings::load(&state.pool).await?,
    })
}

#[tauri::command]
pub async fn list_documents(
    state: SharedState<'_>,
    include_deleted: bool,
) -> AppResult<Vec<documents::Document>> {
    documents::list(&state.pool, include_deleted).await
}

#[tauri::command]
pub async fn get_document(state: SharedState<'_>, id: String) -> AppResult<documents::Document> {
    documents::get(&state.pool, &id).await
}

#[tauri::command]
pub async fn create_document(
    state: SharedState<'_>,
    input: NewDocument,
) -> AppResult<documents::Document> {
    documents::create(&state.pool, input).await
}

#[tauri::command]
pub async fn update_document(
    state: SharedState<'_>,
    input: UpdateDocument,
) -> AppResult<documents::Document> {
    documents::update(&state.pool, input).await
}

#[tauri::command]
pub async fn delete_document(state: SharedState<'_>, id: String) -> AppResult<()> {
    documents::soft_delete(&state.pool, &id).await
}

#[tauri::command]
pub async fn restore_document(
    state: SharedState<'_>,
    id: String,
) -> AppResult<documents::Document> {
    documents::restore(&state.pool, &id).await
}

#[tauri::command]
pub async fn get_settings(state: SharedState<'_>) -> AppResult<Settings> {
    settings::load(&state.pool).await
}

/// Replaces the stored settings. The payload is merged over the current value,
/// so a caller may send only the keys it means to change.
#[tauri::command]
pub async fn set_settings(state: SharedState<'_>, value: SettingsPatch) -> AppResult<Settings> {
    settings::apply_patch(&state.pool, &value).await
}

#[tauri::command]
pub async fn set_provider_secret(
    state: SharedState<'_>,
    provider: String,
    secret: String,
) -> AppResult<SecretStatus> {
    let status = secrets::set(&state.pool, &provider, &secret).await?;
    // A key the reader typed outranks the environment's, so mark this provider
    // as theirs and the launch-time environment sync will leave it alone.
    crate::providers::mark_key_user_owned(&state.pool, &provider).await?;
    Ok(status)
}

#[tauri::command]
pub async fn get_provider_secret_status(
    state: SharedState<'_>,
    provider: String,
) -> AppResult<SecretStatus> {
    secrets::status(&state.pool, &provider).await
}

#[tauri::command]
pub async fn delete_provider_secret(state: SharedState<'_>, provider: String) -> AppResult<()> {
    secrets::delete(&state.pool, &provider).await?;
    // With no key of the reader's left, hand the provider back to the
    // environment rather than leaving it marked as owned by a key that is gone.
    crate::providers::clear_key_source(&state.pool, &provider).await
}

// ---------------------------------------------------------------------------
// Yjs document state
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ydoc_load(state: SharedState<'_>, document_id: String) -> AppResult<YdocState> {
    ydoc::load(&state.pool, &document_id).await
}

/// Durably records an incremental update. Returns the idempotent update id.
#[tauri::command]
pub async fn ydoc_append_update(
    state: SharedState<'_>,
    document_id: String,
    update: String,
    client_id: String,
) -> AppResult<String> {
    ydoc::append_update(&state.pool, &document_id, &update, &client_id).await
}

/// Folds the update tail into a new full-state snapshot.
#[tauri::command]
pub async fn ydoc_compact(
    state: SharedState<'_>,
    document_id: String,
    snapshot: String,
    state_vector: String,
    covered_update_ids: Vec<String>,
) -> AppResult<usize> {
    ydoc::compact(
        &state.pool,
        &document_id,
        &snapshot,
        &state_vector,
        &covered_update_ids,
    )
    .await
}

#[tauri::command]
pub async fn ydoc_pending_count(state: SharedState<'_>, document_id: String) -> AppResult<i64> {
    ydoc::pending_count(&state.pool, &document_id).await
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

/// Every configured provider, ordered by id.
#[tauri::command]
pub async fn list_providers(state: SharedState<'_>) -> AppResult<Vec<Provider>> {
    providers::list(&state.pool).await
}

#[tauri::command]
pub async fn get_provider(state: SharedState<'_>, id: String) -> AppResult<Provider> {
    providers::get(&state.pool, &id).await
}

/// The provider requests currently go to, or `None` when none is selected.
#[tauri::command]
pub async fn get_active_provider(state: SharedState<'_>) -> AppResult<Option<Provider>> {
    providers::get_active(&state.pool).await
}

#[tauri::command]
pub async fn create_provider(state: SharedState<'_>, input: NewProvider) -> AppResult<Provider> {
    providers::create(&state.pool, input).await
}

#[tauri::command]
pub async fn update_provider(state: SharedState<'_>, input: ProviderPatch) -> AppResult<Provider> {
    providers::update(&state.pool, input).await
}

#[tauri::command]
pub async fn delete_provider(state: SharedState<'_>, id: String) -> AppResult<()> {
    providers::delete(&state.pool, &id).await
}

/// Selects the active provider, deactivating whichever one it replaces.
#[tauri::command]
pub async fn set_active_provider(state: SharedState<'_>, id: String) -> AppResult<Provider> {
    providers::set_active(&state.pool, &id).await
}

#[tauri::command]
pub async fn list_provider_models(state: SharedState<'_>, id: String) -> AppResult<Vec<String>> {
    model_catalog::list(&state.pool, &id).await
}

/// Coding tools already installed on this machine, and the local model servers
/// that are running.
///
/// No `state`: detection reads the filesystem and two loopback ports, never the
/// database, so it cannot fail in a way worth surfacing -- an empty list is a
/// legitimate answer (nothing installed).
#[tauri::command]
pub async fn detect_cli_tools() -> Vec<cli_tools::DetectedTool> {
    cli_tools::detect().await
}

// ---------------------------------------------------------------------------
// Legacy import
// ---------------------------------------------------------------------------

/// Classifies a legacy Python JSON store without writing anything, so the user
/// can review what would happen before committing to it.
#[tauri::command]
pub async fn legacy_scan(state: SharedState<'_>, path: String) -> AppResult<legacy::LegacyScan> {
    legacy::scan(&state.pool, Path::new(&path)).await
}

/// Imports validated legacy documents. Safe to call repeatedly.
#[tauri::command]
pub async fn legacy_import(
    state: SharedState<'_>,
    path: String,
) -> AppResult<legacy::LegacyImportResult> {
    legacy::run(&state.pool, Path::new(&path)).await
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Renders a document to the requested format and writes it atomically.
///
/// Markdown is serialised by `@tiptap/markdown` in the frontend and arrives in
/// `markdown`; every other format is built from the ProseMirror JSON in
/// `document`.
#[tauri::command]
pub async fn export_document(request: export::ExportRequest) -> AppResult<export::ExportOutcome> {
    export::export(&request).map_err(AppError::Other)
}

/// Lists the export formats with their file extensions, for the export dialog.
#[tauri::command]
pub async fn export_formats() -> AppResult<Vec<export::ExportFormatInfo>> {
    Ok(export::ExportFormat::all()
        .into_iter()
        .map(export::ExportFormatInfo::from)
        .collect())
}

// Keep an unused-import guard for the shared pool type so future command
// modules can reference it without re-importing sqlx.
#[allow(dead_code)]
fn _pool_type_marker(_: &SqlitePool) {}

// ---------------------------------------------------------------------------
// Account, sync configuration, themes and first-run state
// ---------------------------------------------------------------------------

/// The current account state. Never an error when the server is absent: the
/// local-first contract means "signed out or signed in but offline" are both
/// ordinary, so this reports rather than failing.
#[tauri::command]
pub async fn account_state(state: SharedState<'_>) -> AppResult<crate::account::AccountState> {
    crate::account::state(&state.pool).await
}

#[tauri::command]
pub async fn account_sign_up(
    state: SharedState<'_>,
    email: String,
    password: String,
    name: String,
) -> AppResult<crate::account::AccountState> {
    crate::account::sign_up(&state.pool, &email, &password, &name).await
}

#[tauri::command]
pub async fn account_sign_in(
    state: SharedState<'_>,
    email: String,
    password: String,
) -> AppResult<crate::account::AccountState> {
    crate::account::sign_in(&state.pool, &email, &password).await
}

#[tauri::command]
pub async fn account_refresh(state: SharedState<'_>) -> AppResult<crate::account::AccountState> {
    crate::account::refresh(&state.pool).await
}

#[tauri::command]
pub async fn account_sign_out(state: SharedState<'_>) -> AppResult<crate::account::AccountState> {
    crate::account::sign_out(&state.pool).await
}

#[tauri::command]
pub async fn sync_config_write(
    state: SharedState<'_>,
    base_url: String,
    sync_enabled: bool,
) -> AppResult<crate::account::AccountState> {
    crate::account::write_config(&state.pool, &base_url, sync_enabled).await?;
    crate::account::state(&state.pool).await
}

#[tauri::command]
pub async fn list_custom_themes(
    state: SharedState<'_>,
) -> AppResult<Vec<crate::account::CustomTheme>> {
    crate::account::list_themes(&state.pool).await
}

#[tauri::command]
pub async fn save_custom_theme(
    state: SharedState<'_>,
    name: String,
    tokens: serde_json::Value,
    mode: String,
) -> AppResult<crate::account::CustomTheme> {
    crate::account::save_theme(&state.pool, &name, tokens, &mode).await
}

#[tauri::command]
pub async fn delete_custom_theme(state: SharedState<'_>, theme_id: String) -> AppResult<()> {
    crate::account::delete_theme(&state.pool, &theme_id).await
}

#[tauri::command]
pub async fn onboarding_value(
    state: SharedState<'_>,
    key: String,
    default: String,
) -> AppResult<String> {
    crate::account::onboarding_value(&state.pool, &key, &default).await
}

#[tauri::command]
pub async fn onboarding_set(state: SharedState<'_>, key: String, value: String) -> AppResult<()> {
    crate::account::set_onboarding_value(&state.pool, &key, &value).await
}

/// Reads an image the reader chose and returns it as a `data:` URL.
///
/// The path comes from the dialog plugin, which is the only filesystem access in
/// the build; this command reads exactly that one file. See `images.rs` for why
/// the webview is not given `fs:` access instead.
#[tauri::command]
pub async fn read_image_as_data_url(path: String) -> AppResult<ImageData> {
    images::read_image_as_data_url(Path::new(&path))
}

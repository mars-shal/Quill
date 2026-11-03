mod account;
pub mod cli_tools;
pub mod commands;
pub mod db;
pub mod documents;
pub mod error;
pub mod export;
pub mod images;
pub mod legacy;
pub mod model_catalog;
pub mod pipeline;
mod pocketbase;
pub mod providers;
mod secrets;
pub mod settings;
mod sidecar;
pub mod ydoc;

use tauri::Manager;

/// Managed application state held by the Tauri core process.
pub struct AppState {
    pub pool: sqlx::SqlitePool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("QUILL_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let pool = tauri::async_runtime::block_on(db::init_pool())?;
            // Adopt whatever the pipeline was already using, so an existing
            // install keeps answering after the registry lands. A failure here
            // must not stop the app opening: no provider is a state the Settings
            // screen already knows how to recover from.
            if let Err(e) = tauri::async_runtime::block_on(providers::seed_from_env(
                &pool,
                providers::env_lookup,
            )) {
                eprintln!("provider seeding skipped: {e}");
            }
            // And let the environment reclaim the provider it seeded, so a key
            // corrected in `.env` takes effect on the next launch instead of
            // being ignored forever behind the copy taken at first launch.
            if let Err(e) = tauri::async_runtime::block_on(providers::sync_env_credential(
                &pool,
                providers::env_lookup,
            )) {
                eprintln!("provider environment sync skipped: {e}");
            }
            // And take the flat provider/model/endpoint an older build left in
            // the settings row into the registry, so nothing keeps reading a
            // second copy of what a run uses.
            if let Err(e) =
                tauri::async_runtime::block_on(providers::migrate_legacy_settings(&pool))
            {
                eprintln!("provider settings migration skipped: {e}");
            }
            app.manage(AppState { pool });
            app.manage(pipeline::Supervisor::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::list_documents,
            commands::get_document,
            commands::create_document,
            commands::update_document,
            commands::delete_document,
            commands::restore_document,
            commands::get_settings,
            commands::set_settings,
            commands::set_provider_secret,
            commands::get_provider_secret_status,
            commands::delete_provider_secret,
            commands::ydoc_load,
            commands::ydoc_append_update,
            commands::ydoc_compact,
            commands::ydoc_pending_count,
            commands::legacy_scan,
            commands::legacy_import,
            commands::export_document,
            commands::export_formats,
            commands::account_state,
            commands::account_sign_up,
            commands::account_sign_in,
            commands::account_refresh,
            commands::account_sign_out,
            commands::sync_config_write,
            commands::list_custom_themes,
            commands::save_custom_theme,
            pipeline::api_chat,
            pipeline::api_chat_stream,
            pipeline::api_health,
            pipeline::api_start_run,
            pipeline::api_run_status,
            pipeline::api_cancel_run,
            pipeline::api_stream_run,
            pipeline::pipeline_status,
            pipeline::usage_stats,
            pipeline::pipeline_start,
            pipeline::pipeline_stop,
            commands::delete_custom_theme,
            commands::onboarding_value,
            commands::onboarding_set,
            commands::read_image_as_data_url,
            commands::list_providers,
            commands::get_provider,
            commands::get_active_provider,
            commands::create_provider,
            commands::update_provider,
            commands::delete_provider,
            commands::set_active_provider,
            commands::list_provider_models,
            commands::detect_cli_tools,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Quill");

    // The Python sidecar outlives the window unless it is reaped, and a leaked
    // one keeps the port against the next launch.
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            pipeline::stop_on_exit(app_handle);
        }
    });
}

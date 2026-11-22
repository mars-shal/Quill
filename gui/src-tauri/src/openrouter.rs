//! OpenRouter OAuth PKCE.
//!
//! A reader connects their own OpenRouter account without registering a client
//! or sharing a secret with Quill. The verifier never leaves this process: the
//! system browser authorises, the loopback listener captures the one-time code,
//! and the exchange happens here. The resulting `sk-or-v1-…` key is written to
//! the OS credential store under the ordinary `openrouter` provider slot.

use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::error::{AppError, AppResult};
use crate::providers::{self, NewProvider, Protocol, Provider, ProviderPatch, Vendor};
use crate::secrets;

const PROVIDER_ID: &str = "openrouter";
const AUTH_URL: &str = "https://openrouter.ai/auth";
const EXCHANGE_URL: &str = "https://openrouter.ai/api/v1/auth/keys";
const CALLBACK_PATH: &str = "/openrouter/callback";
const TIMEOUT: Duration = Duration::from_secs(300);

fn verifier() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn auth_url(callback: &str, challenge: &str, state: &str) -> AppResult<String> {
    let url = reqwest::Url::parse_with_params(
        AUTH_URL,
        &[
            ("callback_url", callback),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
            ("key_label", "Quill"),
        ],
    )
    .map_err(|error| {
        AppError::Other(format!("cannot build the OpenRouter sign-in URL: {error}"))
    })?;
    Ok(url.to_string())
}

/// Reads exactly one callback request and returns the authorization code.
async fn wait_for_code(listener: TcpListener, expected_state: &str) -> AppResult<String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|error| AppError::Other(format!("the sign-in listener stopped: {error}")))?;
        let mut buffer = vec![0u8; 8192];
        let read = stream.read(&mut buffer).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("");
        let Ok(url) = reqwest::Url::parse(&format!("http://127.0.0.1{target}")) else {
            let _ = write_page(&mut stream, false, "That sign-in link was not understood.").await;
            continue;
        };
        if url.path() != CALLBACK_PATH {
            let _ = write_page(&mut stream, false, "That address is not a Quill sign-in.").await;
            continue;
        }

        let code = url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.to_string());
        let state = url
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string());
        let denial = url
            .query_pairs()
            .find(|(key, _)| key == "error")
            .map(|(_, value)| value.to_string());

        if let Some(denial) = denial {
            let _ = write_page(&mut stream, false, "OpenRouter sign-in was cancelled.").await;
            return Err(AppError::Other(format!(
                "OpenRouter sign-in was cancelled: {denial}"
            )));
        }
        // A browser or a health probe may open the callback without a code.
        // That is not the answer; keep waiting rather than ending the attempt.
        let Some(code) = code.filter(|value| !value.is_empty()) else {
            let _ = write_page(
                &mut stream,
                true,
                "Waiting for OpenRouter to finish authorizing Quill…",
            )
            .await;
            continue;
        };
        if state.as_deref() != Some(expected_state) {
            let _ = write_page(
                &mut stream,
                false,
                "That sign-in response did not match this request.",
            )
            .await;
            return Err(AppError::Other(
                "OpenRouter sign-in state did not match".into(),
            ));
        }
        let _ = write_page(
            &mut stream,
            true,
            "OpenRouter is connected. You can close this tab.",
        )
        .await;
        return Ok(code);
    }
}

async fn write_page(
    stream: &mut tokio::net::TcpStream,
    ok: bool,
    message: &str,
) -> std::io::Result<()> {
    let title = if ok { "Connected" } else { "Sign-in failed" };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title} · Quill</title>\
         <body style=\"font:16px system-ui;padding:48px;background:#f9f9f9;color:#111\">\
         <h1 style=\"font-size:22px;margin:0 0 8px\">{title}</h1><p>{message}</p>\
         <script>setTimeout(()=>window.close(),1200)</script></body>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

async fn exchange(code: &str, verifier: &str) -> AppResult<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| AppError::Other(format!("cannot build the OpenRouter client: {error}")))?;
    let response = client
        .post(EXCHANGE_URL)
        .json(&serde_json::json!({
            "code": code,
            "code_verifier": verifier,
            "code_challenge_method": "S256",
        }))
        .send()
        .await
        .map_err(|error| AppError::Other(format!("could not reach OpenRouter: {error}")))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        let reason = body
            .get("error")
            .and_then(|value| value.as_str())
            .unwrap_or("OpenRouter rejected the authorization code");
        return Err(AppError::Other(format!("{reason} (HTTP {status})")));
    }
    body.get("key")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::Other("OpenRouter returned no API key".into()))
}

async fn ensure_provider(pool: &SqlitePool) -> AppResult<Provider> {
    if let Some(provider) = providers::list(pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == PROVIDER_ID)
    {
        if provider.base_url.trim().is_empty() || provider.default_model.trim().is_empty() {
            return providers::update(
                pool,
                ProviderPatch {
                    id: PROVIDER_ID.into(),
                    base_url: Some("https://openrouter.ai/api/v1".into()),
                    default_model: Some(if provider.default_model.trim().is_empty() {
                        "openrouter/auto".into()
                    } else {
                        provider.default_model
                    }),
                    ..ProviderPatch::default()
                },
            )
            .await;
        }
        return Ok(provider);
    }
    providers::create(
        pool,
        NewProvider {
            id: PROVIDER_ID.into(),
            label: Some("OpenRouter".into()),
            vendor: Some(Vendor::Compatible),
            protocol: Some(Protocol::OpenaiChat),
            base_url: Some("https://openrouter.ai/api/v1".into()),
            default_model: Some("openrouter/auto".into()),
            models: Some(Vec::new()),
            ..NewProvider::default()
        },
    )
    .await
}

/// Runs the whole browser flow and returns the provider ready for inference.
pub async fn connect(_app: &AppHandle, pool: &SqlitePool) -> AppResult<Provider> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| AppError::Other(format!("cannot open the sign-in listener: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::Other(format!("cannot read the sign-in port: {error}")))?
        .port();
    let callback = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let verifier = verifier();
    let challenge = challenge(&verifier);
    let state = uuid::Uuid::new_v4().to_string();
    let url = auth_url(&callback, &challenge, &state)?;
    tauri_plugin_opener::open_url(url, None::<&str>)
        .map_err(|error| AppError::Other(format!("could not open the browser: {error}")))?;

    let code = tokio::time::timeout(TIMEOUT, wait_for_code(listener, &state))
        .await
        .map_err(|_| AppError::Other("OpenRouter sign-in timed out".into()))??;
    let key = exchange(&code, &verifier).await?;

    secrets::set(pool, PROVIDER_ID, &key).await?;
    providers::mark_key_user_owned(pool, PROVIDER_ID).await?;
    let provider = ensure_provider(pool).await?;
    let active = providers::set_active(pool, PROVIDER_ID).await?;
    // `set_active` returns the row it activated; keep the provider shape the
    // caller expects even if a future version stops returning it.
    Ok(if active.id == PROVIDER_ID {
        active
    } else {
        provider
    })
}

pub async fn disconnect(pool: &SqlitePool) -> AppResult<()> {
    secrets::delete(pool, PROVIDER_ID).await?;
    providers::clear_key_source(pool, PROVIDER_ID).await
}

#[cfg(test)]
mod tests {
    use super::{challenge, verifier};

    #[test]
    fn the_verifier_is_pkce_sized_and_url_safe() {
        let value = verifier();
        assert!((43..=128).contains(&value.len()));
        assert!(value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'));
    }

    #[test]
    fn the_challenge_is_deterministic_and_distinct_from_the_verifier() {
        let value = verifier();
        let first = challenge(&value);
        assert_eq!(first, challenge(&value));
        assert_ne!(first, value);
        assert_eq!(first.len(), 43);
    }
}

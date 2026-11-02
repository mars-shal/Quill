//! Fetches the model list a provider actually offers.
//!
//! The picker used to offer whatever happened to be stored on the provider row,
//! which drifts the moment the vendor ships or retires a model. The list is a
//! live fact about the endpoint, so it is read from the endpoint with the same
//! credential a run uses. That is why this lives in the core: the React layer
//! never sees the key.
//!
//! Nothing here mutates the registry. A failure is reported to the caller so the
//! picker can keep offering the stored default instead of inventing a list.

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::providers::{self, Protocol};
use crate::secrets;

/// A hung vendor must not leave the picker spinning through a whole session.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Lists the model ids the provider offers, sorted and deduplicated.
pub async fn list(pool: &sqlx::SqlitePool, provider_id: &str) -> AppResult<Vec<String>> {
    let provider = providers::get(pool, provider_id).await?;
    // A CLI provider has no endpoint to ask: its one "model" is the tool
    // itself, recorded on the row at adopt time. A refresh therefore returns
    // what is stored rather than an error the picker would show as a failure.
    if provider.protocol == Protocol::Cli {
        let own = if provider.default_model.trim().is_empty() {
            provider.id.clone()
        } else {
            provider.default_model.clone()
        };
        return Ok(vec![own]);
    }
    let base = provider.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AppError::Validation(format!(
            "{} has no base URL, so its models cannot be listed.",
            if provider.label.is_empty() {
                &provider.id
            } else {
                &provider.label
            }
        )));
    }
    // Local servers have no key, so the credential is read after the URL: it is
    // the URL that says whether one is expected.
    let api_key = secrets::read_for_provider(&provider.id, base).await.map_err(|_| {
        AppError::Validation(format!(
            "{} has no API key. Add one in Settings, then try again.",
            if provider.label.is_empty() {
                &provider.id
            } else {
                &provider.label
            }
        ))
    })?;

    let url = format!("{base}/models");
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| AppError::Other(format!("could not build the model request: {error}")))?;

    // A keyless local endpoint must not be sent an empty `Authorization`
    // header: Ollama and LM Studio accept a request without one and some
    // gateways reject `Bearer ` with a 401 that looks like a bad key.
    let keyless = api_key.is_empty();
    let request = match provider.protocol {
        Protocol::OpenaiChat | Protocol::OpenaiResponses if keyless => client.get(&url),
        Protocol::OpenaiChat | Protocol::OpenaiResponses => client.get(&url).bearer_auth(api_key),
        Protocol::AnthropicMessages if keyless => client.get(&url),
        Protocol::AnthropicMessages => client
            .get(&url)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        Protocol::GoogleGenerative if keyless => client.get(&url),
        Protocol::GoogleGenerative => client.get(&url).header("x-goog-api-key", api_key),
        // Unreachable in practice: `list` returns a CLI provider's stored
        // identity before any request is built. The arm exists because match
        // exhaustiveness is static -- the compiler cannot know the guard above
        // holds -- and because a second caller reaching here should get a
        // plain attempt rather than a panic.
        Protocol::Cli => client.get(&url),
    };

    let response = request
        .send()
        .await
        .map_err(|error| AppError::Other(format!("could not reach {url}: {error}")))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| AppError::Other(format!("{url} did not return JSON: {error}")))?;

    if !status.is_success() {
        // The vendor body is the actionable part ("invalid api key", "model
        // list not enabled"). It never contains the key we sent, so it is safe
        // to show, but it is still truncated: some gateways echo a whole page.
        let detail = error_message(&body);
        return Err(AppError::Other(if detail.is_empty() {
            format!("{url} returned HTTP {status}.")
        } else {
            format!("{url} returned HTTP {status}: {detail}")
        }));
    }

    Ok(parse_models(&body))
}

/// Extracts ids from the three response shapes in use.
///
/// OpenAI-compatible and Anthropic both answer `{ "data": [{ "id": ... }] }`.
/// Google answers `{ "models": [{ "name": "models/gemini-…" }] }`, so the
/// prefix is stripped to leave the id the request path expects.
///
/// Ollama's native `/api/tags` is the third: `{ "models": [{ "name": … }] }`,
/// which is covered by the `models` arm. `cli_tools` reuses this so a local
/// tool's list and a provider's list are read by one parser.
pub(crate) fn parse_models(body: &Value) -> Vec<String> {
    let mut models = Vec::new();
    if let Some(items) = body.get("data").and_then(Value::as_array) {
        for item in items {
            push_id(&mut models, item.get("id").and_then(Value::as_str));
        }
    }
    if let Some(items) = body.get("models").and_then(Value::as_array) {
        for item in items {
            push_id(
                &mut models,
                item.get("id")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("name").and_then(Value::as_str)),
            );
        }
    }
    models.sort();
    models.dedup();
    models
}

fn push_id(models: &mut Vec<String>, raw: Option<&str>) {
    let Some(raw) = raw.map(str::trim).filter(|id| !id.is_empty()) else {
        return;
    };
    let id = raw.strip_prefix("models/").unwrap_or(raw);
    if !id.is_empty() {
        models.push(id.to_string());
    }
}

fn error_message(body: &Value) -> String {
    body.get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .or_else(|| body.get("message").and_then(Value::as_str))
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_openai_and_anthropic_data() {
        let body = serde_json::json!({
            "data": [{ "id": "gpt-4o-mini" }, { "id": "gpt-4o" }, { "id": "gpt-4o" }]
        });
        assert_eq!(parse_models(&body), vec!["gpt-4o", "gpt-4o-mini"]);
    }

    #[test]
    fn reads_google_names_without_the_prefix() {
        let body = serde_json::json!({
            "models": [
                { "name": "models/gemini-2.5-pro" },
                { "name": "models/gemini-2.5-flash" }
            ]
        });
        assert_eq!(
            parse_models(&body),
            vec!["gemini-2.5-flash", "gemini-2.5-pro"]
        );
    }

    #[test]
    fn ignores_empty_ids_and_unrelated_shapes() {
        let body = serde_json::json!({
            "data": [{ "id": "" }, { "id": "   " }, {}],
            "models": [{ "name": "models/" }]
        });
        assert!(parse_models(&body).is_empty());
        assert!(parse_models(&serde_json::json!({ "object": "list" })).is_empty());
    }

    #[test]
    fn reports_vendor_message_without_leaking_the_key() {
        let body = serde_json::json!({
            "error": { "message": "invalid api key", "key": "sk-secret" }
        });
        let message = error_message(&body);
        assert_eq!(message, "invalid api key");
        assert!(!message.contains("sk-secret"));
    }
}

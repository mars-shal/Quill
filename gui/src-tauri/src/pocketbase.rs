//! PocketBase client.
//!
//! The remote is a **replica**. Local SQLite is canonical and the app is fully
//! usable with no server running: every method here is allowed to fail, and a
//! transport failure is reported as [`AppError::Offline`] rather than as a
//! problem the reader has to act on. Nothing in the writing path depends on a
//! successful call.
//!
//! The user password is used exactly once, to obtain a token, and is never
//! written anywhere. Tokens go to the OS keyring via [`crate::secrets`].

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// A short timeout. The local-first contract means a sync attempt must never
/// hold up the UI, so a slow or absent server fails fast and is retried by the
/// next outbox drain rather than by blocking a keystroke.
const TIMEOUT: Duration = Duration::from_secs(8);

/// The subset of a PocketBase auth record the app cares about.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PbUser {
    pub id: String,
    pub email: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub workspace: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AuthResponse {
    token: String,
    #[serde(default)]
    record: Option<PbUser>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    pub name: String,
    pub workspace: String,
}

impl From<PbUser> for Account {
    fn from(user: PbUser) -> Self {
        Account {
            id: user.id,
            email: user.email,
            name: user.name,
            workspace: user.workspace,
        }
    }
}

/// A thin, cloneable client. Holds no credentials: the token is passed in per
/// call, so this can be shared without leaking one.
#[derive(Debug, Clone)]
pub struct PocketBase {
    base_url: String,
    http: reqwest::Client,
}

impl PocketBase {
    pub fn new(base_url: &str) -> AppResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .map_err(|e| AppError::Other(format!("could not build the HTTP client: {e}")))?;
        Ok(PocketBase {
            base_url: base_url.trim_end_matches('/').to_string(),
            http,
        })
    }

    /// True when the server answers its health probe.
    ///
    /// Used to decide whether to show "offline" in the UI. Never cached: a
    /// stale answer here would mislabel a working connection.
    pub async fn is_reachable(&self) -> bool {
        self.http
            .get(format!("{}/api/health", self.base_url))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    async fn post_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: serde_json::Value,
        token: Option<&str>,
    ) -> AppResult<T> {
        let mut request = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .json(&body);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(classify)?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(validation_error(status.as_u16(), &text));
        }
        serde_json::from_str(&text)
            .map_err(|e| AppError::Other(format!("unexpected response from the server: {e}")))
    }

    /// Creates the account. PocketBase does not return a token from record
    /// creation, so the caller follows this with [`Self::sign_in`].
    pub async fn sign_up(&self, email: &str, password: &str, name: &str) -> AppResult<()> {
        let _: serde_json::Value = self
            .post_json(
                "/api/collections/users/records",
                serde_json::json!({
                    "email": email,
                    "password": password,
                    "passwordConfirm": password,
                    "name": name,
                }),
                None,
            )
            .await?;
        Ok(())
    }

    /// Exchanges credentials for a token and returns the account it belongs to.
    pub async fn sign_in(&self, email: &str, password: &str) -> AppResult<(String, Account)> {
        let auth: AuthResponse = self
            .post_json(
                "/api/collections/users/auth-with-password",
                serde_json::json!({ "identity": email, "password": password }),
                None,
            )
            .await?;
        let user = auth
            .record
            .ok_or_else(|| AppError::Other("the server returned no account".into()))?;
        Ok((auth.token, user.into()))
    }

    /// Refreshes an expiring token.
    ///
    /// `auth-refresh` only needs a currently valid token, so this is the
    /// cheap way to keep a session alive without asking for the password again.
    pub async fn refresh(&self, token: &str) -> AppResult<(String, Account)> {
        let auth: AuthResponse = self
            .post_json(
                "/api/collections/users/auth-refresh",
                serde_json::json!({}),
                Some(token),
            )
            .await?;
        let user = auth
            .record
            .ok_or_else(|| AppError::Other("the server returned no account".into()))?;
        Ok((auth.token, user.into()))
    }

    /// Fetches the signed-in account, used to confirm a stored token is still good.
    ///
    /// Not called yet: the token check is P6-11, which also fixes the
    /// `?fields=` selector and the `workspace` field this decodes into. Kept
    /// rather than deleted because the roadmap depends on it.
    #[allow(dead_code)]
    pub async fn current_account(&self, token: &str) -> AppResult<Account> {
        let user: PbUser = self
            .get_json(
                "/api/collections/users/records/me?fields=id,email,name,workspace",
                token,
            )
            .await?;
        Ok(user.into())
    }

    /// A GET that decodes into `T`.
    ///
    /// Private, and unused only because its two callers are the two pending
    /// methods below and in P6-11.
    #[allow(dead_code)]
    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        token: &str,
    ) -> AppResult<T> {
        let response = self
            .http
            .get(format!("{}{}", self.base_url, path))
            .bearer_auth(token)
            .send()
            .await
            .map_err(classify)?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(validation_error(status.as_u16(), &text));
        }
        serde_json::from_str(&text)
            .map_err(|e| AppError::Other(format!("unexpected response from the server: {e}")))
    }

    /// Uploads one local document.
    ///
    /// `local_id` is unique per owner on the server, so a retried outbox row
    /// fails with a uniqueness error rather than creating a duplicate. Callers
    /// treat that specific failure as success.
    ///
    /// Not called yet: this is the server half of P7-1, and nothing may write
    /// to it until `sync_outbox` has a drain worker. Kept rather than deleted
    /// because the roadmap depends on it.
    #[allow(dead_code)]
    pub async fn upsert_document(
        &self,
        token: &str,
        payload: serde_json::Value,
    ) -> AppResult<String> {
        let record: serde_json::Value = self
            .post_json("/api/collections/documents/records", payload, Some(token))
            .await?;
        record
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| AppError::Other("the server returned no record id".into()))
    }
}

/// Distinguishes "the server is not there" from "the server said no".
///
/// This split matters: the first is an expected condition for a local-first app
/// and must never surface as an error dialog, while the second is a real
/// problem the reader can act on.
fn classify(error: reqwest::Error) -> AppError {
    if error.is_timeout() || error.is_connect() || error.is_request() {
        AppError::Offline
    } else {
        AppError::Other(format!("could not reach the sync server: {error}"))
    }
}

/// Turns a PocketBase error body into something worth showing.
///
/// PocketBase answers `{"data": {"field": {"message": "..."}}}` for validation
/// failures, which is far more useful than the status code alone.
fn validation_error(status: u16, body: &str) -> AppError {
    #[derive(Deserialize)]
    struct Body {
        #[serde(default)]
        data: serde_json::Map<String, serde_json::Value>,
        #[serde(default)]
        message: String,
    }
    if let Ok(parsed) = serde_json::from_str::<Body>(body) {
        let mut parts: Vec<String> = Vec::new();
        for (field, detail) in &parsed.data {
            let message = detail
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("is invalid");
            parts.push(format!("{field} {message}"));
        }
        if !parts.is_empty() {
            return AppError::Other(parts.join("; "));
        }
        if !parsed.message.is_empty() {
            return AppError::Other(parsed.message);
        }
    }
    AppError::Other(format!("the server rejected the request ({status})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_validation_failure_surfaces_the_field_not_just_the_status() {
        let body = r#"{"data":{"email":{"code":"validation_invalid_email","message":"Invalid email."}},"message":"Failed to create record.","status":400}"#;
        let error = validation_error(400, body);
        assert!(
            error.to_string().contains("email Invalid email."),
            "expected the field-level message, got: {error}"
        );
    }

    #[test]
    fn a_non_json_body_still_produces_something_readable() {
        let error = validation_error(502, "<html>bad gateway</html>");
        assert!(error.to_string().contains("502"), "got: {error}");
    }

    #[test]
    fn a_plain_message_falls_back_when_there_is_no_field_detail() {
        let body = r#"{"message":"Failed to authenticate.","status":400}"#;
        let error = validation_error(400, body);
        assert!(
            error.to_string().contains("Failed to authenticate."),
            "got: {error}"
        );
    }

    #[test]
    fn a_trailing_slash_in_the_base_url_does_not_double_up() {
        let client = PocketBase::new("http://127.0.0.1:8090/").expect("client builds");
        assert_eq!(client.base_url, "http://127.0.0.1:8090");
    }
}

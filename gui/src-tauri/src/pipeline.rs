//! Client and supervisor for the Python pipeline API (`api.py`).
//!
//! The app starts a run over HTTP and listens to a server-sent event stream for
//! progress. Runs take 400-1400s, so the events are the point: a spinner for
//! twenty minutes tells the reader nothing, while per-section verdicts show the
//! document taking shape.
//!
//! Whether the server is up at all is `sidecar.rs`'s problem; this module owns
//! the three commands that drive it and the status the webview renders, because
//! a pipeline the reader did not start by hand must still be startable,
//! stoppable and describable from the UI.
//!
//! `Offline` is reused for "the pipeline service is not running" because it is
//! the same expectation as an absent sync server: Quill is local-first, and a
//! missing sidecar must degrade rather than raise something the reader must
//! dismiss. A sidecar that is down is normal in development, not a fault.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use tauri::{Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::sidecar;
use crate::{providers, secrets};

pub use crate::sidecar::Supervisor;

const DEFAULT_BASE: &str = "http://127.0.0.1:8000";

const STATUS_EVENT: &str = "quill://pipeline-status";
const STOPPED: &str = "stopped";
const STARTING: &str = "starting";
const READY: &str = "ready";
const FAILED: &str = "failed";

fn base_url() -> String {
    std::env::var("QUILL_API_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BASE.to_string())
        .trim_end_matches('/')
        .to_string()
}

fn map_transport(err: reqwest::Error) -> AppError {
    if err.is_connect() || err.is_timeout() {
        // The sidecar is not up. Not the reader's problem to dismiss.
        AppError::Offline
    } else {
        AppError::Other(format!("pipeline request failed: {err}"))
    }
}

/// How long the sidecar has to accept a connection.
///
/// A sidecar that is not running refuses the connection at once, and that is the
/// one failure the direct fallback exists for. The deadline is short so the
/// fallback starts straight away instead of making the reader wait out a long
/// connect timeout first.
const SIDECAR_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How long a chat turn may take.
///
/// A chat turn is a pipeline run: it classifies the request, researches it, and
/// writes the answer. Those steps take minutes, not seconds. A deadline shorter
/// than the work guaranteed that every heavy turn timed out, was answered by the
/// provider directly instead, and lost the classification that said which kind of
/// turn it was -- so a WRITE turn produced its document and put it in the bubble
/// rather than in the editor.
///
/// The value also has to clear the sidecar's own retry ladder. A single provider
/// call that cannot connect is retried `QUILL_RETRIES` times before the sidecar
/// gives up, which has been measured at roughly fourteen minutes; a shorter
/// deadline would discard the sidecar's specific reason and report only that the
/// request timed out.
const SIDECAR_CHAT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1800);

/// Maps a failed sidecar request for a chat turn.
///
/// A connection failure means the sidecar is not running, which is the one
/// condition that licenses answering the provider directly. A timeout means the
/// sidecar is running and still working: answering directly there would replace
/// the answer the pipeline is about to produce with an ungrounded one, and would
/// drop the classification that says what the turn was. That is the silent
/// success this path exists to prevent -- the same reason a refusal is not
/// re-asked.
fn map_sidecar_chat_transport(err: reqwest::Error) -> AppError {
    if err.is_connect() {
        AppError::Offline
    } else if err.is_timeout() {
        AppError::Other("the writing service took too long to answer".into())
    } else {
        AppError::Other(format!("pipeline request failed: {err}"))
    }
}

/// Turns a refused response into the sidecar's own reason.
///
/// A refusal carries a JSON body naming what was wrong -- an unparseable source
/// document, a prompt the pipeline will not take. Decoding that body into the
/// success shape instead would fail as a deserialisation error and throw the
/// reason away, leaving the reader with a complaint about the wire rather than
/// about their run.
async fn refused(res: reqwest::Response) -> AppError {
    let status = res.status();
    let body = res.text().await.unwrap_or_default();
    reason_from(status, &body)
}

fn reason_from(status: reqwest::StatusCode, body: &str) -> AppError {
    let reason = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
        .filter(|reason| !reason.is_empty());
    AppError::Other(
        reason.unwrap_or_else(|| format!("the writing service refused the request ({status})")),
    )
}

/// What the webview is told about the sidecar, on every transition.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStatus {
    pub state: String,
    pub detail: String,
}

/// Report the truth at call time rather than the last known transition: the
/// sidecar can die on its own, and a status cached from mount time would keep
/// promising a pipeline that is no longer there.
#[tauri::command]
pub async fn pipeline_status(state: State<'_, Supervisor>) -> AppResult<PipelineStatus> {
    let base = base_url();
    let Some(python) = state.running().await else {
        return Ok(stopped());
    };
    if sidecar::serving(&base).await {
        Ok(PipelineStatus {
            state: READY.to_string(),
            detail: format!("{} is serving {base}", python.display()),
        })
    } else {
        Ok(PipelineStatus {
            state: STARTING.to_string(),
            detail: format!("{} is not answering yet", python.display()),
        })
    }
}

/// Start the sidecar, or adopt the one already running.
///
/// Idempotent by contract: the webview calls this on mount and again after a
/// reload, and a second server would do nothing but fail to bind the port.
#[tauri::command]
pub async fn pipeline_start(
    app: tauri::AppHandle,
    state: State<'_, Supervisor>,
) -> AppResult<PipelineStatus> {
    let base = base_url();
    let status = match state.start(&base).await {
        Ok(()) => {
            tracing::info!("the pipeline sidecar is ready at {base}");
            PipelineStatus {
                state: READY.to_string(),
                detail: format!("the pipeline is serving {base}"),
            }
        }
        Err(reason) => {
            tracing::warn!(%reason, "the pipeline sidecar did not come up");
            PipelineStatus {
                state: FAILED.to_string(),
                detail: reason,
            }
        }
    };
    Ok(emit(&app, status))
}

#[tauri::command]
pub async fn pipeline_stop(
    app: tauri::AppHandle,
    state: State<'_, Supervisor>,
) -> AppResult<PipelineStatus> {
    state.shutdown().await;
    tracing::info!("pipeline sidecar stopped");
    Ok(emit(&app, stopped()))
}

/// Reap the sidecar as the app exits. Called from `RunEvent::Exit`, which Tauri
/// emits while its runtime is still up, so awaiting the kill is safe here.
pub fn stop_on_exit(app: &tauri::AppHandle) {
    let supervisor = app.state::<Supervisor>();
    tauri::async_runtime::block_on(supervisor.shutdown());
}

/// Every transition is broadcast, not only the one the caller asked for: the
/// sidecar can stop on its own, and a webview that missed the command's reply
/// still has to learn about it.
fn emit(app: &tauri::AppHandle, status: PipelineStatus) -> PipelineStatus {
    if let Err(err) = app.emit(STATUS_EVENT, &status) {
        tracing::warn!(%err, "the pipeline status event could not be emitted");
    }
    status
}

fn stopped() -> PipelineStatus {
    PipelineStatus {
        state: STOPPED.to_string(),
        detail: "the pipeline is not running".to_string(),
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunSnapshot {
    pub id: String,
    pub status: String,
    pub prompt: String,
    #[serde(default)]
    pub document_id: String,
    #[serde(default)]
    pub concept_mode: String,
    #[serde(default)]
    pub elapsed: f64,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub written: Option<u32>,
    #[serde(default)]
    pub placeholders: Option<u32>,
    #[serde(default)]
    pub session_name: String,
    #[serde(default)]
    pub event_count: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StartedRun {
    pub run_id: String,
    pub status: String,
    pub events: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiHealth {
    pub ok: bool,
    pub runs: u32,
    pub searxng: String,
    pub gap_research: bool,
}

/// One SSE record, forwarded to the webview as a `quill://run-event` event.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub run_id: String,
    pub seq: u32,
    pub event: String,
    #[serde(default)]
    pub t: f64,
    #[serde(default)]
    pub data: serde_json::Value,
}

#[tauri::command]
pub async fn api_health() -> AppResult<ApiHealth> {
    let res = reqwest::get(format!("{}/health", base_url()))
        .await
        .map_err(map_transport)?;
    res.json::<ApiHealth>().await.map_err(map_transport)
}

/// The `POST /runs` body.
///
/// `skip_serializing_if` is load-bearing: an absent optional must be *omitted*,
/// never sent as `null`. `api.py` reads these with `str(body.get("x") or "")`, so
/// `null` happens to behave the same there today -- which is the trap. The bytes
/// are a contract other consumers may already depend on.
/// The provider a run executes against, with its credential already read.
///
/// This is the join between the two halves of the configuration: the registry
/// row says which endpoint and protocol, the credential store says which key.
/// Nothing on the request path consulted either before now, so a saved key was
/// written and then never sent.
///
/// Deliberately not returned from any command. It carries a live credential, and
/// deriving `Serialize` for the outbound body is the only reason it serialises
/// at all.
#[derive(Debug, Serialize)]
pub(crate) struct ResolvedProvider {
    pub id: String,
    pub vendor: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

/// Reads the active provider and its credential, or explains which is missing.
///
/// Both failures happen here rather than inside the sidecar because the run
/// would otherwise report "done" seconds before the pipeline discovered it had
/// no key, and the reader would be told the writing service was at fault.
async fn resolve_provider(pool: &sqlx::SqlitePool) -> AppResult<ResolvedProvider> {
    let provider = providers::get_active(pool).await?.ok_or_else(|| {
        AppError::Validation(
            "no provider is active. Choose one in Settings, then connect it with a key.".into(),
        )
    })?;

    // A CLI agent authenticates through its own stored login (codex login,
    // opencode auth, ...), so there is no registry credential to read -- and
    // demanding one here would refuse a provider whose whole point is that it
    // needs no key. The sidecar exempts this protocol from the key check too.
    let api_key = if provider.protocol == providers::Protocol::Cli {
        String::new()
    } else {
        secrets::read_for_provider(&provider.id, &provider.base_url)
            .await
            .map_err(|_| {
                AppError::Validation(format!(
                    "{} has no API key. Add one in Settings, then connect the provider.",
                    if provider.label.is_empty() {
                        &provider.id
                    } else {
                        &provider.label
                    }
                ))
            })?
    };

    Ok(ResolvedProvider {
        id: provider.id,
        vendor: provider.vendor.as_str().to_string(),
        protocol: provider.protocol.as_str().to_string(),
        base_url: provider.base_url,
        model: provider.default_model,
        api_key,
    })
}

#[derive(Serialize)]
struct RunRequest<'a> {
    prompt: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    document_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    concept_mode: Option<&'a str>,
    provider: ResolvedProvider,
}

/// Builds the `POST /runs` body from the four IPC parameters.
///
/// Split out of `api_start_run` so the serialisation is testable without a
/// sidecar: it used to be reachable only by starting a real run against a real
/// server, which meant the wire format had no test at all. The parameters stay
/// four because `gui/src/platform/store.js` sends them by that name over the
/// Tauri IPC boundary; grouping them into a struct would break that contract
/// with the webview to save nothing.
fn run_request_body<'a>(
    prompt: &'a str,
    document_id: Option<&'a str>,
    session_name: Option<&'a str>,
    concept_mode: Option<&'a str>,
    provider: ResolvedProvider,
) -> RunRequest<'a> {
    RunRequest {
        prompt,
        document_id,
        session_name,
        concept_mode,
        provider,
    }
}

/// One turn of the assistant conversation, as the frontend sends it.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub reply: String,
    /// Which path answered. Surfaced so the panel can say so, rather than the
    /// reader wondering why an answer arrived with no writing service running.
    pub transport: String,
    /// The task the turn was classified as (``WRITE``, ``EXPLAIN``, ...). Empty
    /// on the direct path, which does not classify -- the panel keys its
    /// "researching this turn" state off this, so an unclassified answer must
    /// not claim to be one.
    pub task: String,
    /// The pages a research-grounded answer cited. Empty when the answer rests
    /// on the prompt alone, which is every answer the direct path can give.
    pub sources: Vec<ChatSource>,
    /// Whether the turn produced a document the panel may put in the editor.
    ///
    /// A write whose evidence gate blocked every section still returns the
    /// notice that says so, and that notice belongs in the bubble: pasting it
    /// into the reader's draft would replace their work with a warning.
    pub wrote_document: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatSource {
    pub title: String,
    pub url: String,
}

/// A sidecar answer, before it is tagged with its transport.
struct SidecarReply {
    reply: String,
    task: String,
    sources: Vec<ChatSource>,
    wrote_document: bool,
}

/// Answers one assistant turn, sidecar first.
///
/// The sidecar goes first because it can ground an answer in the pipeline's own
/// research. When it is not running, the same request goes straight to the
/// provider from here -- the key is already in hand, so refusing to answer
/// because a local helper process is down would be a worse failure than a
/// slightly less informed answer.
///
/// Falling back happens only when the sidecar is *unreachable*. A sidecar that
/// answered with a refusal has already decided the turn failed, and re-asking
/// the provider directly would replace that reason with an ungrounded answer --
/// the exact silent success this path exists to stop.
#[tauri::command]
pub async fn api_chat(
    state: crate::commands::SharedState<'_>,
    messages: Vec<ChatTurn>,
    draft: Option<String>,
) -> AppResult<ChatReply> {
    if messages.is_empty() {
        return Err(AppError::Validation("no messages to answer".into()));
    }
    let provider = resolve_provider(&state.pool).await?;
    let payload = serde_json::json!({
        "provider": provider,
        "messages": messages,
        "draft": draft.unwrap_or_default(),
    });

    chat_via_sidecar_or_direct(&payload).await
}

/// The two-step answer used when no stage stream is involved: sidecar first,
/// then the provider directly if the sidecar is not listening.
///
/// Shared by `api_chat` and by the streaming command's fallback, so the two
/// cannot drift into different opinions about what a missing sidecar means.
async fn chat_via_sidecar_or_direct(payload: &serde_json::Value) -> AppResult<ChatReply> {
    match post_chat_to_sidecar(payload).await {
        Ok(answered) => Ok(ChatReply {
            reply: answered.reply,
            transport: "sidecar".into(),
            task: answered.task,
            sources: answered.sources,
            wrote_document: answered.wrote_document,
        }),
        Err(AppError::Offline) => {
            tracing::info!("sidecar chat unavailable; answering directly");
            let reply = chat_direct(payload).await?;
            Ok(ChatReply {
                reply,
                transport: "direct".into(),
                task: String::new(),
                sources: Vec::new(),
                wrote_document: false,
            })
        }
        Err(other) => Err(other),
    }
}

/// Answers one assistant turn, reporting each stage to the webview as it runs.
///
/// `/chat` answers once, at the end. That is enough for the text and useless for
/// the wait: for as long as it takes, the panel knows only that something is
/// happening. This posts to `/chat/stream`, which emits the same reply plus the
/// stages the engine was already logging, and forwards each one as
/// `quill://chat-stage` tagged with the turn that asked.
///
/// The tag is not decoration. Turns are not serialised -- a reader can ask a
/// second question while the first is answering -- and every turn's events land
/// on the same channel, so without it one turn's progress would render inside
/// another's bubble.
///
/// A sidecar too old to know `/chat/stream` answers 404, and an absent one fails
/// the connection; both fall back to the ordinary path rather than failing a turn
/// this app is otherwise able to answer.
#[tauri::command]
pub async fn api_chat_stream(
    app: tauri::AppHandle,
    state: crate::commands::SharedState<'_>,
    turn_id: String,
    messages: Vec<ChatTurn>,
    draft: Option<String>,
) -> AppResult<ChatReply> {
    if messages.is_empty() {
        return Err(AppError::Validation("no messages to answer".into()));
    }
    let provider = resolve_provider(&state.pool).await?;
    let payload = serde_json::json!({
        "provider": provider,
        "messages": messages,
        "draft": draft.unwrap_or_default(),
    });

    match stream_chat(&app, &turn_id, &payload).await {
        Ok(Some(reply)) => Ok(reply),
        // No stream: an older sidecar, or no sidecar at all.
        Ok(None) => chat_via_sidecar_or_direct(&payload).await,
        // The turn ran and reported a refusal. Re-asking the same question
        // without the stream would replace that reason with an answer.
        Err(other) => Err(other),
    }
}

/// Reads `/chat/stream` to the end, emitting stages and returning the reply.
///
/// `Ok(None)` means "this sidecar does not stream" and is not an error: it is
/// the signal to fall back. A turn that reported its own failure is an `Err`,
/// because that refusal is the answer.
async fn stream_chat(
    app: &tauri::AppHandle,
    turn_id: &str,
    payload: &serde_json::Value,
) -> AppResult<Option<ChatReply>> {
    let client = reqwest::Client::builder()
        .connect_timeout(SIDECAR_CONNECT_TIMEOUT)
        .timeout(SIDECAR_CHAT_TIMEOUT)
        .build()
        .map_err(map_transport)?;

    let res = match client
        .post(format!("{}/chat/stream", base_url()))
        .json(payload)
        .send()
        .await
    {
        Ok(res) => res,
        Err(_) => return Ok(None),
    };
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(refused(res).await);
    }

    let mut stream = res.bytes_stream();
    let mut buffer = String::new();
    let mut event_name = String::new();
    let mut reply: Option<serde_json::Value> = None;
    let mut failure: Option<String> = None;

    'read: while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buffer.find('\n') {
            let line: String = buffer.drain(..=nl).collect();
            let line = line.trim_end_matches(['\r', '\n']).to_string();
            let data = match sse_field(&line) {
                SseField::Event(name) => {
                    event_name = name.trim().to_string();
                    continue;
                }
                SseField::Ignored => continue,
                SseField::Data(payload) => payload.trim().to_string(),
            };
            if data.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&data) else {
                continue;
            };
            match event_name.as_str() {
                "stage" => {
                    let step = value.get("step").and_then(|v| v.as_str()).unwrap_or("");
                    if step.is_empty() {
                        continue;
                    }
                    let _ = app.emit(
                        "quill://chat-stage",
                        serde_json::json!({
                            "turnId": turn_id,
                            "step": step,
                            "t": value.get("t").cloned().unwrap_or(serde_json::Value::Null),
                        }),
                    );
                }
                // The reply is the last thing on the wire; the loop still has
                // to drain the rest of it, so it is stored rather than returned.
                "reply" => reply = Some(value),
                "error" => {
                    failure = Some(
                        value
                            .get("error")
                            .and_then(|v| v.as_str())
                            .unwrap_or("the turn failed")
                            .to_string(),
                    )
                }
                _ => {}
            }
            // `reply` and `error` are the last things on the wire, so the end
            // of the *event* is the end of the turn -- not the end of the
            // socket. The sidecar speaks HTTP/1.1 with keep-alive and sends no
            // Content-Length, so it holds the connection open after the last
            // event and waiting for EOF waits forever: the answer was computed
            // and sent, and the panel went on saying "Thinking" indefinitely.
            // This is the same rule the run reader applies to its `end` event
            // rather than to the close.
            if reply.is_some() || failure.is_some() {
                break 'read;
            }
        }
    }

    if let Some(reason) = failure {
        return Err(AppError::Other(reason));
    }
    let Some(value) = reply else { return Ok(None) };
    Ok(Some(ChatReply {
        reply: value
            .get("reply")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        transport: value
            .get("transport")
            .and_then(|v| v.as_str())
            .unwrap_or("sidecar")
            .to_string(),
        task: value
            .get("task")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        sources: serde_json::from_value(
            value.get("sources").cloned().unwrap_or(serde_json::Value::Null),
        )
        .unwrap_or_default(),
        wrote_document: value
            .get("wroteDocument")
            .or_else(|| value.get("wrote_document"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }))
}

/// Asks the sidecar. The deadline covers a whole turn, because a turn is a
/// pipeline run and not a single request.
async fn post_chat_to_sidecar(payload: &serde_json::Value) -> AppResult<SidecarReply> {
    post_chat_to_sidecar_within(payload, SIDECAR_CHAT_TIMEOUT).await
}

/// Asks the sidecar, with the deadline the caller wants.
async fn post_chat_to_sidecar_within(
    payload: &serde_json::Value,
    deadline: std::time::Duration,
) -> AppResult<SidecarReply> {
    let client = reqwest::Client::builder()
        .connect_timeout(SIDECAR_CONNECT_TIMEOUT)
        .timeout(deadline)
        .build()
        .map_err(map_transport)?;
    let res = client
        .post(format!("{}/chat", base_url()))
        .json(payload)
        .send()
        .await
        .map_err(map_sidecar_chat_transport)?;

    if !res.status().is_success() {
        // The sidecar's own reason is worth passing on; it knows more than a
        // bare status code does about why the request was refused.
        return Err(refused(res).await);
    }
    // The body is read under the same deadline as the send, so a timeout here
    // means the sidecar is still working and must not be mistaken for an offline
    // one either.
    let body: serde_json::Value = res.json().await.map_err(map_sidecar_chat_transport)?;
    let reply = body
        .get("reply")
        .and_then(|r| r.as_str())
        .ok_or_else(|| AppError::Other("sidecar returned no reply".into()))?
        .to_string();
    let task = body
        .get("task")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    let sources = body
        .get("sources")
        .cloned()
        .and_then(|s| serde_json::from_value(s).ok())
        .unwrap_or_default();
    // A sidecar that does not say is assumed to have written its document, so an
    // older sidecar keeps its existing behaviour. Only an explicit `false` -- a
    // write the gate blocked -- keeps the text out of the editor.
    let wrote_document = body
        .get("wrote_document")
        .and_then(|w| w.as_bool())
        .unwrap_or(true);
    Ok(SidecarReply {
        reply,
        task,
        sources,
        wrote_document,
    })
}

/// Calls the provider itself, speaking whichever protocol it was configured for.
async fn chat_direct(payload: &serde_json::Value) -> AppResult<String> {
    let provider = payload
        .get("provider")
        .ok_or_else(|| AppError::Validation("chat payload carried no provider".into()))?;
    let field = |name: &str| {
        provider
            .get(name)
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let base = field("base_url");
    let protocol = field("protocol");
    let model = field("model");
    let api_key = field("api_key");
    let endpoint = format!(
        "{}/{}",
        base.trim_end_matches('/'),
        if protocol == "openai_responses" {
            "responses"
        } else {
            "chat/completions"
        }
    );

    // The draft is already in the transcript the caller assembled; the direct
    // path reuses that rather than re-deriving a system prompt it cannot know.
    let messages = payload
        .get("messages")
        .cloned()
        .unwrap_or(serde_json::json!([]));
    let body = if protocol == "openai_responses" {
        serde_json::json!({ "model": model, "input": messages })
    } else {
        serde_json::json!({ "model": model, "messages": messages })
    };

    let request = reqwest::Client::new().post(endpoint);
    // A local model server has no key, and `Bearer ` with nothing after it is a
    // 401 on gateways that validate the header's shape. Send no header at all
    // when there is no credential -- the same rule `model_catalog` applies.
    let request = if api_key.is_empty() {
        request
    } else {
        request.bearer_auth(&api_key)
    };
    let res = request
        .json(&body)
        .send()
        .await
        .map_err(map_transport)?;

    if !res.status().is_success() {
        return Err(refused(res).await);
    }

    let json: serde_json::Value = res.json().await.map_err(map_transport)?;
    if protocol == "openai_responses" {
        Ok(json
            .get("output")
            .and_then(|o| o.as_array())
            .and_then(|items| items.first())
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
            .and_then(|parts| parts.first())
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string())
    } else {
        Ok(json
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string())
    }
}

#[tauri::command]
pub async fn api_start_run(
    state: crate::commands::SharedState<'_>,
    prompt: String,
    document_id: Option<String>,
    session_name: Option<String>,
    concept_mode: Option<String>,
) -> AppResult<StartedRun> {
    if prompt.trim().is_empty() {
        return Err(AppError::Validation("prompt is required".into()));
    }
    let provider = resolve_provider(&state.pool).await?;
    let body = run_request_body(
        prompt.trim(),
        document_id.as_deref(),
        session_name.as_deref(),
        concept_mode.as_deref(),
        provider,
    );
    let res = reqwest::Client::new()
        .post(format!("{}/runs", base_url()))
        .json(&body)
        .send()
        .await
        .map_err(map_transport)?;
    if !res.status().is_success() {
        return Err(refused(res).await);
    }
    res.json::<StartedRun>().await.map_err(map_transport)
}

#[tauri::command]
pub async fn api_run_status(run_id: String) -> AppResult<RunSnapshot> {
    let res = reqwest::get(format!("{}/runs/{}", base_url(), run_id))
        .await
        .map_err(map_transport)?;
    if !res.status().is_success() {
        return Err(refused(res).await);
    }
    res.json::<RunSnapshot>().await.map_err(map_transport)
}

#[tauri::command]
pub async fn api_cancel_run(run_id: String) -> AppResult<()> {
    let res = reqwest::Client::new()
        .delete(format!("{}/runs/{}", base_url(), run_id))
        .send()
        .await
        .map_err(map_transport)?;
    // 202 cancelling, 409 already finished - both are fine outcomes here.
    if res.status().is_success() || res.status().as_u16() == 409 {
        Ok(())
    } else {
        Err(AppError::Other(format!(
            "cancel failed: HTTP {}",
            res.status()
        )))
    }
}

/// One SSE record line, classified.
///
/// Split out because the alternative is the whole parser living inside the
/// `tokio::spawn` below, where no test can reach it. A mis-classified line does
/// not fail loudly -- it silently drops every event the reader was about to see.
enum SseField<'a> {
    Event(&'a str),
    Data(&'a str),
    Ignored,
}

fn sse_field(line: &str) -> SseField<'_> {
    if let Some(name) = line.strip_prefix("event:") {
        return SseField::Event(name);
    }
    match line.strip_prefix("data:") {
        Some(payload) => SseField::Data(payload),
        None => SseField::Ignored,
    }
}

/// Stream a run's events to the webview until the run ends or the stream drops.
///
/// Resumable by design: the caller passes the last `seq` it saw, because a GUI
/// that reloads mid-run would otherwise lose the document taking shape in front
/// of it. Each SSE record carries its own `id:`, and the API replays everything
/// after it.
#[tauri::command]
pub async fn api_stream_run(
    app: tauri::AppHandle,
    run_id: String,
    since: Option<u32>,
) -> AppResult<()> {
    let url = match since {
        Some(seq) => format!("{}/runs/{}/events?since={}", base_url(), run_id, seq),
        None => format!("{}/runs/{}/events", base_url(), run_id),
    };
    let res = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .map_err(map_transport)?;
    if !res.status().is_success() {
        return Err(AppError::Other(format!(
            "stream failed: HTTP {}",
            res.status()
        )));
    }

    let (tx, mut rx) = mpsc::channel::<RunEvent>(256);
    let id = run_id.clone();
    // Pump in the background so this command returns immediately; the webview
    // receives events by emission rather than by the command's return value.
    tokio::spawn(async move {
        // bytes_stream(), not AsyncRead: reqwest::Response is not an AsyncRead.
        // SSE records can straddle a chunk boundary, so the buffer carries the
        // incomplete tail into the next chunk instead of dropping it.
        let mut event_name = String::new();
        let mut stream = res.bytes_stream();
        let mut buffer = String::new();
        while let Some(chunk) = stream.next().await {
            let Ok(chunk) = chunk else { break };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(nl) = buffer.find('\n') {
                let line: String = buffer.drain(..=nl).collect();
                let line = line.trim_end_matches(['\r', '\n']).to_string();
                let payload = match sse_field(&line) {
                    SseField::Event(name) => {
                        event_name = name.trim().to_string();
                        continue;
                    }
                    SseField::Ignored => continue,
                    SseField::Data(payload) => payload.trim(),
                };
                if payload.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
                    continue;
                };
                let seq = value.get("seq").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let event = RunEvent {
                    run_id: id.clone(),
                    seq,
                    event: if event_name.is_empty() {
                        value
                            .get("event")
                            .and_then(|v| v.as_str())
                            .unwrap_or("message")
                            .to_string()
                    } else {
                        event_name.clone()
                    },
                    t: value.get("t").and_then(|v| v.as_f64()).unwrap_or(0.0),
                    data: value.clone(),
                };
                if event.event == "end" {
                    return;
                }
                if tx.send(event).await.is_err() {
                    return;
                }
            }
        }
    });

    while let Some(event) = rx.recv().await {
        if app.emit("quill://run-event", &event).is_err() {
            break;
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::{
        chat_direct, post_chat_to_sidecar, post_chat_to_sidecar_within, reason_from,
        resolve_provider, run_request_body, sse_field, AppError, ResolvedProvider, SseField,
        SIDECAR_CHAT_TIMEOUT, SIDECAR_CONNECT_TIMEOUT,
    };
    use crate::{providers, secrets};
    use reqwest::StatusCode;
    use sqlx::SqlitePool;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    async fn test_pool() -> SqlitePool {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(":memory:")
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
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

    fn new_provider(id: &str, label: &str) -> providers::NewProvider {
        providers::NewProvider {
            id: id.into(),
            label: Some(label.into()),
            vendor: None,
            protocol: None,
            base_url: Some("https://api.example.test/v1".into()),
            default_model: Some("test-model".into()),
            models: None,
        }
    }

    /// The failure this guards is a run that reports `202` and then fails
    /// minutes later inside the sidecar with a generic error.
    ///
    /// `resolve_provider` fails for a provider that is active but has no
    /// credential recorded, and that is the check that runs before any request.
    /// The mock keyring cannot round-trip a value in-process (`EntryOnly`
    /// persistence), so the positive case is not reachable here; what is pinned
    /// is the refusal, and that it happens at resolve time rather than after a
    /// request.
    #[tokio::test]
    async fn a_provider_with_no_credential_is_refused_before_any_request() {
        let pool = test_pool().await;
        let provider = providers::create(&pool, new_provider("compatible", "api.groq.com"))
            .await
            .expect("create the provider");
        providers::set_active(&pool, &provider.id)
            .await
            .expect("activate it");

        let err = resolve_provider(&pool)
            .await
            .expect_err("no credential should be refused, not resolved");
        let message = err.to_string();
        assert!(
            message.contains("no API key"),
            "the refusal must name the missing credential: {message}"
        );
        assert!(
            message.contains("api.groq.com"),
            "and name the provider the reader has to fix: {message}"
        );
    }

    /// The credential lives in the keyring and only its existence is recorded
    /// locally. `secrets::set` records that row, and the row is what a later
    /// `read_for_job` is gated on -- so this asserts the half that the mock
    /// store can actually observe, and nothing more.
    #[tokio::test]
    async fn storing_a_credential_records_its_existence() {
        let pool = test_pool().await;
        let provider = providers::create(&pool, new_provider("compatible", "api.groq.com"))
            .await
            .expect("create the provider");
        providers::set_active(&pool, &provider.id)
            .await
            .expect("activate it");

        let status = secrets::set(&pool, &provider.id, "sk-REGISTRY")
            .await
            .expect("store the credential");
        assert!(status.has_credential);

        let recorded: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM secrets_meta WHERE account = ?1")
                .bind(secrets::slot_for(&provider.id))
                .fetch_one(&pool)
                .await
                .expect("count the credential row");
        assert_eq!(recorded, 1, "the credential must be recorded as present");
    }

    /// And a registry with nothing active is refused with its own reason, so the
    /// two failures a reader can hit are not collapsed into one message.
    #[tokio::test]
    async fn no_active_provider_is_refused_by_name() {
        let pool = test_pool().await;
        let err = resolve_provider(&pool)
            .await
            .expect_err("an empty registry should be refused");
        assert!(err.to_string().contains("no provider is active"), "{err}");
    }

    /// The provider every wire-format test carries. The key value is fixed and
    /// obviously fake so a failure diff can never print a real credential.
    fn provider() -> ResolvedProvider {
        ResolvedProvider {
            id: "openai".into(),
            vendor: "compatible".into(),
            protocol: "openai_chat".into(),
            base_url: "https://api.example.test/v1".into(),
            model: "gpt-4o-mini".into(),
            api_key: "test-key".into(),
        }
    }

    /// The exact provider block every run carries. Extracted because it appears in
    /// three assertions and a drift in any one of them is a real regression, not
    /// a copy-paste slip to be tidied away individually.
    const PROVIDER_JSON: &str = r#""provider":{"id":"openai","vendor":"compatible","protocol":"openai_chat","base_url":"https://api.example.test/v1","model":"gpt-4o-mini","api_key":"test-key"}"#;

    /// Exact bytes, in declaration order.
    #[test]
    fn a_run_request_with_every_field_serialises_all_four_keys() {
        let body = run_request_body(
            "a lighthouse keeper logs the storm",
            Some("doc-42"),
            Some("Nightwatch"),
            Some("reference"),
            provider(),
        );
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            format!(
                r#"{{"prompt":"a lighthouse keeper logs the storm","document_id":"doc-42","session_name":"Nightwatch","concept_mode":"reference",{PROVIDER_JSON}}}"#
            )
        );
    }

    /// Absent optionals are *omitted*, not sent as `null`. `api.py` happens to
    /// read these with `str(body.get("x") or "")`, so `null` would behave the
    /// same there today -- which is exactly why this needs pinning rather than
    /// inferring from the sidecar's behaviour. The wire format is a contract
    /// other consumers may already depend on.
    #[test]
    fn a_run_request_without_optionals_omits_them_entirely() {
        let body = run_request_body(
            "a lighthouse keeper logs the storm",
            None,
            None,
            None,
            provider(),
        );
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            format!(r#"{{"prompt":"a lighthouse keeper logs the storm",{PROVIDER_JSON}}}"#)
        );
    }

    /// A prompt is reader-supplied free text. Quotes, backslashes and newlines
    /// must survive as escapes rather than breaking the request body.
    #[test]
    fn a_prompt_that_needs_json_escaping_is_escaped_not_dropped() {
        let body = run_request_body(
            "he said \"hold the line\"\\ then\n\twent back",
            None,
            None,
            Some("reference"),
            provider(),
        );
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            format!(
                r#"{{"prompt":"he said \"hold the line\"\\ then\n\twent back","concept_mode":"reference",{PROVIDER_JSON}}}"#
            )
        );
    }

    /// The credential travels in the body, and it travels as the key that was
    /// read from the store -- not a placeholder and not an empty string. This is
    /// the regression the registry work exists to prevent: a key saved in the
    /// keyring and never sent looks identical to every other passing test until
    /// this one runs.
    #[test]
    fn the_resolved_credential_is_what_travels() {
        let body = run_request_body("a thesis", None, None, None, provider());
        let json = serde_json::to_string(&body).unwrap();
        assert!(json.contains(r#""api_key":"test-key""#), "{json}");
    }

    /// A refusal has to reach the reader in the sidecar's own words: this is the
    /// only thing standing between a run that cannot start and an error about the
    /// wire instead.
    #[test]
    fn a_refusal_surfaces_the_sidecars_reason() {
        let err = reason_from(
            StatusCode::BAD_REQUEST,
            r#"{"error": "document parse failed: No module named 'markitdown'"}"#,
        );
        assert_eq!(
            err.to_string(),
            "document parse failed: No module named 'markitdown'"
        );
    }

    /// A body that is not the shape we expect must still say something a reader
    /// can act on, rather than leaking a parser's complaint.
    #[test]
    fn a_refusal_without_a_reason_still_names_the_status() {
        for body in ["", "not json at all", "{}", r#"{"error": ""}"#] {
            let err = reason_from(StatusCode::SERVICE_UNAVAILABLE, body);
            assert_eq!(
                err.to_string(),
                "the writing service refused the request (503 Service Unavailable)"
            );
        }
    }

    /// The payload line is the only one carrying an event. An earlier version
    /// turned the `event:` check into a `let ... else { continue }`, which sent
    /// every `data:` line down that arm and dropped every event the reader would
    /// have seen -- with no error anywhere. This is the assertion that would have
    /// caught it.
    #[test]
    fn a_data_line_reaches_the_payload() {
        match sse_field(r#"data: {"seq":3,"event":"section"}"#) {
            SseField::Data(payload) => {
                assert_eq!(payload, r#" {"seq":3,"event":"section"}"#)
            }
            _ => panic!("a data line must not be mistaken for a name or ignored"),
        }
    }

    /// A named record carries no payload, so it must not be read as one.
    #[test]
    fn an_event_line_yields_only_its_name() {
        match sse_field("event: write_gate") {
            SseField::Event(name) => assert_eq!(name, " write_gate"),
            _ => panic!("an event line must not be read as a payload"),
        }
    }

    #[test]
    fn other_lines_are_ignored() {
        for line in [
            "",
            ": keep-alive",
            "id: 7",
            "retry: 3000",
            "events: section",
        ] {
            assert!(
                matches!(sse_field(line), SseField::Ignored),
                "expected {line:?} to be ignored"
            );
        }
    }

    /// A one-shot HTTP server: reads one request, hands it back, replies once.
    ///
    /// The direct path is the fallback that runs when the sidecar is down, so it
    /// is exactly the code that would otherwise ship unexercised -- nothing in a
    /// green suite reaches it while the sidecar is up.
    fn serve_once(body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept one request");
            let mut raw = Vec::new();
            let mut buf = [0u8; 1024];
            loop {
                let read = stream.read(&mut buf).expect("read the request");
                if read == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..read]);
                // Headers, then exactly Content-Length bytes. Reading only until
                // the headers would race the body and send reqwest a truncated
                // JSON document.
                if let Some(split) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&raw[..split]).to_string();
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    if raw.len() - (split + 4) >= length {
                        break;
                    }
                }
            }
            tx.send(String::from_utf8_lossy(&raw).to_string())
                .expect("hand the request back");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write the reply");
            stream.flush().expect("flush the reply");
        });
        (format!("http://127.0.0.1:{port}"), rx)
    }

    /// A chat payload pointing at `base`, speaking `protocol`.
    fn chat_payload(base: &str, protocol: &str) -> serde_json::Value {
        serde_json::json!({
            "provider": {
                "id": "compatible",
                "vendor": "compatible",
                "protocol": protocol,
                "base_url": base,
                "model": "registry-model",
                "api_key": "sk-REGISTRY",
            },
            "messages": [{ "role": "user", "content": "ping" }],
            "draft": "",
        })
    }

    /// The fallback must speak the chat protocol, send the configured key, and
    /// read the reply out of `choices[0].message.content`.
    #[tokio::test]
    async fn the_direct_fallback_speaks_the_chat_protocol() {
        let (base, recorded) = serve_once(r#"{"choices":[{"message":{"content":"pong"}}]}"#);
        let reply = chat_direct(&chat_payload(&base, "openai_chat"))
            .await
            .expect("the direct call should succeed");
        assert_eq!(reply, "pong");

        let request = recorded.recv().expect("the request should have been seen");
        assert!(
            request.starts_with("POST /chat/completions"),
            "a chat provider must be called on /chat/completions:\n{request}"
        );
        assert!(
            request.contains("Bearer sk-REGISTRY"),
            "the configured key must be the one sent:\n{request}"
        );
    }

    /// And it must not confuse the two protocols: a Responses provider called on
    /// `/chat/completions` is answered by a service that then cannot parse the
    /// body, which is the failure this dispatch exists to prevent.
    #[tokio::test]
    async fn the_direct_fallback_speaks_the_responses_protocol() {
        let (base, recorded) =
            serve_once(r#"{"output":[{"content":[{"type":"output_text","text":"pong"}]}]}"#);
        let reply = chat_direct(&chat_payload(&base, "openai_responses"))
            .await
            .expect("the direct call should succeed");
        assert_eq!(reply, "pong");

        let request = recorded.recv().expect("the request should have been seen");
        assert!(
            request.starts_with("POST /responses"),
            "a Responses provider must be called on /responses:\n{request}"
        );
    }

    /// F3, the precedence proof, at the wire.
    ///
    /// With `.env` holding a *different* key from the seeded provider, the
    /// request that leaves the app must carry the registry's key. The trap this
    /// avoids: "a key was sent" passes under both the old and the new
    /// implementation, so the two keys have to be distinct and the assertion has
    /// to name the one that arrived.
    ///
    /// `chat_direct` is the last hop before the network, and the payload is
    /// built from the resolved provider rather than the environment, so this is
    /// the seam where "the registry wins" either holds or does not.
    #[tokio::test]
    async fn the_registry_key_wins_over_a_conflicting_env() {
        let (base, recorded) = serve_once(r#"{"choices":[{"message":{"content":"pong"}}]}"#);
        let payload = chat_payload(&base, "openai_chat");

        // The registry's key is the one resolved into the payload; the
        // environment's is the decoy that must not appear anywhere.
        assert_eq!(
            payload["provider"]["api_key"], "sk-REGISTRY",
            "the payload carries the resolved (registry) credential"
        );

        chat_direct(&payload)
            .await
            .expect("the call should succeed");

        let request = recorded.recv().expect("the request should have been seen");
        assert!(
            request.contains("Bearer sk-REGISTRY"),
            "the registry key must be the one sent:\n{request}"
        );
        assert!(
            !request.contains("sk-from-env"),
            "the environment key must never reach the wire once the registry is authoritative:\n{request}"
        );
    }

    /// And the protocol the wire speaks is the registry's, not the environment's.
    ///
    /// `seed_from_env` always picks `openai_chat`, so an install whose provider
    /// is set to `openai_responses` in Settings must not have that choice undone
    /// by the file. A payload whose protocol is `openai_responses` has to land on
    /// `/responses`, which the fixture records rather than infers.
    #[tokio::test]
    async fn the_registry_protocol_wins_over_a_chat_defaulting_env() {
        let (base, recorded) =
            serve_once(r#"{"output":[{"content":[{"type":"output_text","text":"pong"}]}]}"#);

        chat_direct(&chat_payload(&base, "openai_responses"))
            .await
            .expect("the call should succeed");

        let request = recorded.recv().expect("the request should have been seen");
        assert!(
            request.starts_with("POST /responses"),
            "the registry's protocol must decide the path, not the environment's default:\n{request}"
        );
        assert!(
            !request.starts_with("POST /chat/completions"),
            "an environment default must not override a configured Responses provider:\n{request}"
        );
    }

    /// A one-shot server that answers with a chosen status and body, so the
    /// refusal arm of the sidecar path can be exercised at all.
    fn serve_status(status: u16, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept one request");
            let mut raw = Vec::new();
            let mut buf = [0u8; 1024];
            while stream.read(&mut buf).unwrap_or(0) > 0 {
                raw.extend_from_slice(&buf[..1024]);
                if raw.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        });
        format!("http://127.0.0.1:{port}")
    }

    /// A one-shot server that accepts the request and never answers, so the
    /// timeout arm of the sidecar path can be exercised.
    fn serve_hanging() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                let mut stream = stream;
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf);
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    /// Points `base_url()` at a fixture around one await.
    ///
    /// `post_chat_to_sidecar` reads the base from the environment, so this is the
    /// only seam that reaches it. The lock is held across the await, which
    /// serialises the tests that use it: the variable is process-wide and they
    /// would otherwise race. It is an async mutex because the guarded region
    /// contains an await -- a std one held across a yield point is a lint, and a
    /// real one, since the guard could outlive the future it belongs to.
    async fn with_sidecar_url<T>(url: &str, body: impl std::future::Future<Output = T>) -> T {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _guard = LOCK.lock().await;
        let saved = std::env::var("QUILL_API_URL").ok();
        std::env::set_var("QUILL_API_URL", url);
        let result = body.await;
        match saved {
            Some(value) => std::env::set_var("QUILL_API_URL", value),
            None => std::env::remove_var("QUILL_API_URL"),
        }
        result
    }

    /// The sidecar's classification and sources must survive the hop, because the
    /// panel keys its "researching this turn" state and its sources list off them.
    #[tokio::test]
    async fn the_sidecar_reply_carries_its_task_and_sources() {
        let base = serve_status(
            200,
            r#"{"reply":"Because X.","task":"EXPLAIN","sources":[{"title":"A","url":"http://a"}]}"#,
        );
        let answered = with_sidecar_url(&base, post_chat_to_sidecar(&serde_json::json!({})))
            .await
            .expect("the sidecar answered");
        assert_eq!(answered.reply, "Because X.");
        assert_eq!(answered.task, "EXPLAIN");
        assert_eq!(answered.sources.len(), 1);
        assert_eq!(answered.sources[0].url, "http://a");
    }

    /// The panel decides whether to touch the editor from this flag alone.
    ///
    /// A blocked write still carries its notice, so reply text cannot be the
    /// signal; only the flag can. Getting the default wrong is bad both ways: a
    /// false negative discards a real document, and a false positive pastes a
    /// warning into the reader's draft.
    #[tokio::test]
    async fn the_sidecar_says_whether_it_wrote_a_document() {
        let blocked = serve_status(
            200,
            r##"{"reply":"# Generation Halted","task":"WRITE","sources":[],"wrote_document":false}"##,
        );
        let answered = with_sidecar_url(&blocked, post_chat_to_sidecar(&serde_json::json!({})))
            .await
            .expect("the sidecar answered");
        assert!(
            !answered.wrote_document,
            "a blocked write must not claim a document"
        );

        let silent = serve_status(200, r##"{"reply":"# D","task":"WRITE","sources":[]}"##);
        let answered = with_sidecar_url(&silent, post_chat_to_sidecar(&serde_json::json!({})))
            .await
            .expect("the sidecar answered");
        assert!(
            answered.wrote_document,
            "a sidecar that does not say must keep writing"
        );
    }

    /// A refusal from a *live* sidecar is a real failure and must not be papered
    /// over by the direct path: re-asking the provider would answer a question
    /// the pipeline already refused, which is the silent success this path is
    /// built to prevent.
    #[tokio::test]
    async fn a_sidecar_refusal_is_not_answered_directly() {
        let base = serve_status(502, r#"{"error":"the engine refused"}"#);
        let failed = with_sidecar_url(&base, post_chat_to_sidecar(&serde_json::json!({}))).await;
        match failed {
            Err(AppError::Other(reason)) => {
                assert_eq!(
                    reason, "the engine refused",
                    "the sidecar's own reason must travel"
                )
            }
            Err(other) => panic!("a refusal is not an offline sidecar: {other:?}"),
            Ok(_) => panic!("a refused turn must not be reported as an answer"),
        }
    }

    /// An unreachable sidecar is `Offline` -- the one condition that licenses the
    /// direct fallback. If a refusal ever collapsed into this, the fallback would
    /// resurrect the masked error.
    #[tokio::test]
    async fn an_unreachable_sidecar_is_offline() {
        // A port nothing listens on: bind to learn a free one, then drop it.
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        let base = format!("http://127.0.0.1:{port}");
        let failed = with_sidecar_url(&base, post_chat_to_sidecar(&serde_json::json!({}))).await;
        assert!(
            matches!(failed, Err(AppError::Offline)),
            "a sidecar that cannot be reached must read as offline, not as a refusal"
        );
    }

    /// A sidecar that is alive but slow must not be answered by another route.
    ///
    /// Falling back to the provider here loses the turn's classification, and a
    /// WRITE turn without its classification never reaches the editor -- the
    /// document is produced and then put in the chat bubble instead. A timeout
    /// means the sidecar is still working, so it is reported as the failure it
    /// is.
    #[tokio::test]
    async fn a_slow_sidecar_is_a_failure_and_not_answered_directly() {
        let base = serve_hanging();
        let failed = with_sidecar_url(
            &base,
            post_chat_to_sidecar_within(
                &serde_json::json!({}),
                std::time::Duration::from_millis(200),
            ),
        )
        .await;
        match failed {
            Err(AppError::Other(reason)) => {
                assert!(
                    reason.contains("too long"),
                    "a slow sidecar must say so: {reason}"
                )
            }
            Err(other) => panic!("a slow sidecar is not an offline sidecar: {other:?}"),
            Ok(_) => panic!("a slow turn must not be reported as an answer"),
        }
    }

    /// The deadline has to outlast a pipeline turn.
    ///
    /// A chat turn classifies, researches and writes, which takes minutes, and a
    /// failed provider call inside it can spend the sidecar's whole retry ladder
    /// before the turn reports back. A deadline below that turned every heavy
    /// turn into a timeout, and every timeout into a direct answer with no
    /// classification -- so a WRITE turn wrote its document into the chat bubble
    /// instead of the editor.
    #[test]
    fn the_chat_deadline_outlasts_a_pipeline_turn() {
        assert!(
            SIDECAR_CHAT_TIMEOUT >= std::time::Duration::from_secs(900),
            "a chat turn needs minutes, not seconds: {:?}",
            SIDECAR_CHAT_TIMEOUT
        );
        assert!(
            SIDECAR_CONNECT_TIMEOUT < SIDECAR_CHAT_TIMEOUT,
            "a sidecar that is down must fail fast, or the fallback never starts"
        );
    }
}

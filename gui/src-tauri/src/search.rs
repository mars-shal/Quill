//! Starts the local search backend before research needs it.
//!
//! Research talks to SearXNG over HTTP. There are three ways that server can
//! exist, and this module tries them in order:
//!
//! 1. **Bundled.** Packaged builds carry an unmodified SearXNG as a PyInstaller
//!    sidecar (`quill-searxng`), so a fresh install needs neither Docker nor a
//!    network before its first search. This is the normal path.
//! 2. **Docker.** A machine with no bundled binary but with Docker gets the
//!    existing container: started if present, created from the stock image with
//!    a settings file if not.
//! 3. **Scrapers.** With neither, research falls back to the DuckDuckGo and
//!    Bing scrapers. That is a degraded quality, not a broken app, so it is
//!    logged rather than surfaced as a failure.
//!
//! An explicitly empty `QUILL_SEARXNG_URL` is an opt-out and a non-loopback URL
//! is an operator-managed instance; both are left alone.
//!
//! Everything runs off the main thread, after the window is up. Unpacking a
//! 60 MB binary and a first Docker pull are both slow, and blocking the editor
//! behind either would be worse than the problem this solves.

use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Manager;

const CONTAINER: &str = "quill-searxng";
const IMAGE: &str = "searxng/searxng:latest";
const DEFAULT_URL: &str = "http://127.0.0.1:8080";
const SETTINGS_FILE: &str = "searxng-settings.yml";

/// Settings the server needs. `json` under `search.formats` is the line the
/// whole provider depends on; `limiter: false` stops the bot heuristics from
/// 429ing a loopback JSON client after a few research rounds.
///
/// `contact_url` is required by the Wikipedia engine, and `instance_name` keeps
/// its API responses honest about what this instance is. The three engines are
/// the ones that answer reliably without a token: the default list is broad and
/// half of it needs credentials or upstream keys Quill does not have.
const SETTINGS_TEMPLATE: &str = r#"# Written by Quill for its local SearXNG server.
# Mounted read-only at /etc/searxng/settings.yml when Docker runs it, and
# pointed at directly by SEARXNG_SETTINGS_PATH when the bundled binary does.
use_default_settings: true

general:
  instance_name: "Quill"
  contact_url: "https://github.com/searxng/searxng"

server:
  secret_key: "quill-local-search-only-not-for-deployment"
  limiter: false
  port: {port}
  bind_address: "127.0.0.1"

search:
  formats:
    - html
    - json

engines:
  - name: duckduckgo
  - name: brave
  - name: wikipedia
  # Both fail to register in a frozen build (one needs a token, the other a
  # dependency Quill does not ship) and would log an error on every start.
  - name: ahmia
    disabled: true
  - name: torch
    disabled: true
"#;

/// The bundled server, so exit can reap it. A child left holding 8080 would be
/// adopted by the next launch (which is safe but means a stale settings file).
static BUNDLED: Mutex<Option<Child>> = Mutex::new(None);

/// Kick off the check without waiting for it. Errors are logged, never surfaced
/// as a dialog: a reader who writes without research is still writing.
pub fn ensure_local_search(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(reason) = ensure(&app).await {
            tracing::info!(%reason, "local search was not started; research keeps its scraper fallback");
        }
    });
}

/// Kill the bundled server. Safe when nothing is running.
pub fn stop() {
    let Ok(mut guard) = BUNDLED.lock() else {
        return;
    };
    let Some(mut child) = guard.take() else {
        return;
    };
    let _ = child.kill();
    let _ = child.wait();
}

async fn ensure(app: &tauri::AppHandle) -> Result<(), String> {
    let configured = std::env::var("QUILL_SEARXNG_URL").ok();
    let base = match configured.as_deref() {
        // Explicit opt-out, documented as the way to run scraper-only.
        Some("") => return Ok(()),
        Some(value) => value.trim().trim_end_matches('/').to_string(),
        None => DEFAULT_URL.to_string(),
    };
    if !is_loopback(&base) {
        tracing::debug!(base = %base, "search points at another host; local search is not Quill's business");
        return Ok(());
    }
    if healthy(&base).await {
        tracing::debug!(base = %base, "local search is already answering");
        return Ok(());
    }
    // Only the conventional port is Quill's to fill. A different loopback port
    // means someone configured an instance; a server started on 8080 would not
    // be the one the sidecar asks.
    if base != DEFAULT_URL {
        tracing::info!(
            base = %base,
            "nothing is answering at the configured loopback URL; research will use the scrapers"
        );
        return Ok(());
    }

    // The bundled server is the normal path: no daemon, no image, no root.
    if let Some(binary) = bundled_binary() {
        match start_bundled(app, &binary, &base).await {
            Ok(()) => return Ok(()),
            Err(reason) => {
                tracing::warn!(%reason, "the bundled search server did not start; trying Docker");
            }
        }
    }

    start_docker(app, &base, port_of(&base)).await
}

// --- bundled ---------------------------------------------------------------

async fn start_bundled(app: &tauri::AppHandle, binary: &Path, base: &str) -> Result<(), String> {
    let port = port_of(base);
    let settings = settings_path(app)?;
    write_settings(&settings, port)?;

    let mut command = std::process::Command::new(binary);
    command
        .env("SEARXNG_SETTINGS_PATH", &settings)
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    }
    #[cfg(not(windows))]
    {
        // Inherited so a failure to bind or load an engine reaches the log the
        // app was launched from, instead of a pipe nobody drains.
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    }

    let child = command
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", binary.display()))?;
    if let Ok(mut guard) = BUNDLED.lock() {
        // Reap a previous child first; a second server would only fail to bind.
        if let Some(mut old) = guard.replace(child) {
            let _ = old.kill();
            let _ = old.wait();
        }
    }
    tracing::info!(binary = %binary.display(), port, "started the bundled search server");

    for _ in 0..80 {
        if healthy(base).await {
            probe_json(base).await;
            return Ok(());
        }
        if exited() {
            // The child is gone; give the reason a chance to name the cause.
            return Err("the bundled search server exited during startup".to_string());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Err("the bundled search server did not answer /healthz within 20s".to_string())
}

fn exited() -> bool {
    let Ok(mut guard) = BUNDLED.lock() else {
        return false;
    };
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(Some(_)) | Err(_)),
        None => true,
    }
}

fn bundled_binary() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("QUILL_SEARXNG_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    crate::sidecar::bundled_tool("quill-searxng")
}

// --- Docker fallback -------------------------------------------------------

async fn start_docker(app: &tauri::AppHandle, base: &str, port: u16) -> Result<(), String> {
    let Some(docker) = docker_binary().await else {
        tracing::info!(
            "SearXNG is not answering and neither the bundled server nor Docker is available; \
             research will use the scrapers"
        );
        return Ok(());
    };
    tracing::info!(%docker, port, "starting the Docker search container");

    // A container created for another port boots and answers nowhere, and
    // `docker start` cannot re-map it. It holds no state, so replacing it is
    // cheap; the alternative is a silent timeout on every launch.
    if let Some(published) = published_port(&docker).await {
        if published != port {
            tracing::info!(
                published,
                port,
                "recreating the search container for a new port"
            );
            let _ = run(&docker, &["rm", "-f", CONTAINER], Duration::from_secs(20)).await;
        }
    }

    let started = run(&docker, &["start", CONTAINER], Duration::from_secs(30)).await;
    if !started.ok && !starts_container(&docker, app, port).await? {
        return Err("the search container could not be created".to_string());
    }

    for _ in 0..120 {
        if healthy(base).await {
            probe_json(base).await;
            tracing::info!(base = %base, "local search is ready");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!(
        "the search container did not answer {base}/healthz in 60s; see `docker logs {CONTAINER}`"
    ))
}

/// Create the container from the stock image, with Quill's settings mounted.
async fn starts_container(docker: &str, app: &tauri::AppHandle, port: u16) -> Result<bool, String> {
    let settings = settings_path(app)?;
    write_settings(&settings, port)?;
    let mount = format!("{}:/etc/searxng/settings.yml:ro", settings.display());
    let publish = format!("127.0.0.1:{port}:8080");

    // A first run pulls the image, which is minutes on a slow link. The window
    // is already usable, so a long timeout here costs nothing but a background
    // task.
    let result = run(
        docker,
        &[
            "run",
            "-d",
            "--name",
            CONTAINER,
            "--restart",
            "unless-stopped",
            "-p",
            &publish,
            "-v",
            &mount,
            IMAGE,
        ],
        Duration::from_secs(600),
    )
    .await;
    if !result.ok {
        tracing::warn!(stderr = %result.stderr.trim(), "the search container could not be started");
        return Ok(false);
    }
    Ok(true)
}

fn write_settings(path: &Path, port: u16) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    let settings = SETTINGS_TEMPLATE.replace("{port}", &port.to_string());
    std::fs::write(path, settings)
        .map_err(|error| format!("could not write {}: {error}", path.display()))
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(SETTINGS_FILE))
        .map_err(|error| format!("could not resolve the app-data directory: {error}"))
}

/// `Some(port)` when the named container exists and publishes 8080 somewhere.
async fn published_port(docker: &str) -> Option<u16> {
    let result = run(
        docker,
        &["port", CONTAINER, "8080/tcp"],
        Duration::from_secs(10),
    )
    .await;
    if !result.ok {
        return None;
    }
    result
        .stdout
        .lines()
        .next()
        .and_then(|line| line.rsplit(':').next())
        .and_then(|value| value.trim().parse().ok())
}

async fn docker_binary() -> Option<String> {
    let mut candidates = vec!["docker".to_string()];
    for path in [
        "/usr/bin/docker",
        "/usr/local/bin/docker",
        "/snap/bin/docker",
    ] {
        if std::path::Path::new(path).is_file() {
            candidates.push(path.to_string());
        }
    }
    for candidate in candidates {
        let result = run(&candidate, &["--version"], Duration::from_secs(5)).await;
        if result.ok {
            return Some(candidate);
        }
    }
    None
}

struct Output {
    ok: bool,
    stdout: String,
    stderr: String,
}

async fn run(program: &str, args: &[&str], timeout: Duration) -> Output {
    let mut command = tokio::process::Command::new(program);
    command.args(args).kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.as_std_mut().creation_flags(0x0800_0000);
    }
    match tokio::time::timeout(timeout, command.output()).await {
        Ok(Ok(output)) => Output {
            ok: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        Ok(Err(error)) => Output {
            ok: false,
            stdout: String::new(),
            stderr: error.to_string(),
        },
        Err(_) => Output {
            ok: false,
            stdout: String::new(),
            stderr: format!("{program} timed out after {}s", timeout.as_secs()),
        },
    }
}

async fn healthy(base: &str) -> bool {
    let probe = reqwest::Client::new()
        .get(format!("{base}/healthz"))
        .timeout(Duration::from_millis(900))
        .send()
        .await;
    matches!(probe, Ok(response) if response.status().is_success())
}

/// One JSON request after `/healthz` passes. A 403 here is the classic
/// misconfiguration, and logging it turns "flaky research" into a named fix.
async fn probe_json(base: &str) {
    let probe = reqwest::Client::new()
        .get(format!(
            "{base}/search?q=quill+health&format=json&categories=general&language=en"
        ))
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    match probe {
        Ok(response) if response.status().is_success() => {}
        Ok(response) if response.status().as_u16() == 403 => {
            tracing::warn!(
                "SearXNG answered 403 for format=json; its settings.yml is missing 'json' under search.formats"
            );
        }
        Ok(response) => {
            tracing::warn!(status = %response.status(), "the SearXNG JSON probe did not succeed")
        }
        Err(error) => tracing::warn!(%error, "the SearXNG JSON probe failed"),
    }
}

fn is_loopback(base: &str) -> bool {
    let rest = base
        .strip_prefix("http://")
        .or_else(|| base.strip_prefix("https://"))
        .unwrap_or(base);
    let host = rest.split(['/', ':']).next().unwrap_or("");
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

fn port_of(base: &str) -> u16 {
    let rest = base
        .strip_prefix("http://")
        .or_else(|| base.strip_prefix("https://"))
        .unwrap_or(base);
    let authority = rest.split('/').next().unwrap_or("");
    authority
        .rsplit(':')
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(8080)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_urls_are_the_ones_it_manages() {
        assert!(is_loopback("http://127.0.0.1:8080"));
        assert!(is_loopback("http://localhost:8080/"));
        assert!(!is_loopback("http://searx.internal:8080"));
        assert!(!is_loopback("https://search.example.org"));
    }

    #[test]
    fn the_port_defaults_to_8080() {
        assert_eq!(port_of("http://127.0.0.1:8080"), 8080);
        assert_eq!(port_of("http://127.0.0.1:9099"), 9099);
        assert_eq!(port_of("http://127.0.0.1"), 8080);
    }

    #[test]
    fn the_written_settings_enable_json_and_name_the_instance() {
        let rendered = SETTINGS_TEMPLATE.replace("{port}", "8080");
        assert!(rendered.contains("json"));
        assert!(rendered.contains("use_default_settings: true"));
        assert!(rendered.contains("contact_url"));
        assert!(rendered.contains("port: 8080"));
        assert!(!rendered.contains("{port}"));
    }
}

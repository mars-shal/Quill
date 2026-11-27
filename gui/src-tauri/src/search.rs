//! Starts the optional local search backend before research needs it.
//!
//! The AppImage carries Quill and the Python sidecar. It cannot carry Docker or
//! the SearXNG image: one is a system service and the other is a separately
//! licensed server. So the honest contract is "works when Docker is there, says
//! so when it is not": research already falls back to the DuckDuckGo and Bing
//! scrapers, and this module must never make launch wait for, or fail on, a
//! search helper.
//!
//! Everything here runs off the main thread, after the window is up. A first run
//! with no image can spend minutes pulling one, and blocking the editor behind
//! that would be a worse bug than the one it fixes.
//!
//! What it does, in order:
//!
//! 1. Leave a non-loopback or explicitly empty `QUILL_SEARXNG_URL` alone; those
//!    mean the operator manages the instance.
//! 2. Return immediately when something already answers `/healthz`.
//! 3. `docker start quill-searxng` if the container exists, recreating it when
//!    it was published on a different port (ports cannot be re-mapped by
//!    `docker start`).
//! 4. Otherwise write a minimal Settings file into the app-data directory and
//!    `docker run` the image with it mounted. That file is the one thing that
//!    makes `format=json` work; without it every search is a silent 403.
//!
//! Every step logs, because the failure this replaces was invisible: research
//! quietly degraded to scrapers and read as "flaky".

use std::path::PathBuf;
use std::time::Duration;

use tauri::Manager;

const CONTAINER: &str = "quill-searxng";
const IMAGE: &str = "searxng/searxng:latest";
const DEFAULT_URL: &str = "http://127.0.0.1:8080";
const SETTINGS_FILE: &str = "searxng-settings.yml";

/// Settings that must exist in the container. `json` under `search.formats` is
/// the line the whole provider depends on; `limiter: false` stops the bot
/// heuristics from 429ing a loopback JSON client after a few research rounds.
const SETTINGS: &str = r#"# Written by Quill for its local SearXNG container.
# Mounted read-only at /etc/searxng/settings.yml.
use_default_settings: true

server:
  secret_key: "quill-local-search-only-not-for-deployment"
  limiter: false

search:
  formats:
    - html
    - json
"#;

/// Kick off the check without waiting for it. Errors are logged, never surfaced
/// as a dialog: a reader who writes without research is still writing.
pub fn ensure_local_search(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(reason) = ensure(&app).await {
            tracing::info!(%reason, "local search was not started; research keeps its scraper fallback");
        }
    });
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
        tracing::debug!(base = %base, "search points at another host; the local container is not Quill's business");
        return Ok(());
    }
    if healthy(&base).await {
        tracing::debug!(base = %base, "local search is already answering");
        return Ok(());
    }

    let Some(docker) = docker_binary().await else {
        tracing::info!(
            "SearXNG is not answering and Docker is not installed; research will use the scrapers"
        );
        return Ok(());
    };
    let port = port_of(&base);
    tracing::info!(%docker, port, "starting the local search container");

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

    // A container boot is seconds, a first pull is not; the pull already
    // finished inside `starts_container`, so this window only covers boot.
    for _ in 0..120 {
        if healthy(&base).await {
            probe_json(&base).await;
            tracing::info!(base = %base, "local search is ready");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!(
        "the search container did not answer {base}/healthz in 60s; see `docker logs {CONTAINER}`"
    ))
}

/// Write the settings file if it is missing and create the container.
async fn starts_container(docker: &str, app: &tauri::AppHandle, port: u16) -> Result<bool, String> {
    let settings = settings_path(app)?;
    if !settings.exists() {
        if let Some(parent) = settings.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
        }
        std::fs::write(&settings, SETTINGS)
            .map_err(|error| format!("could not write {}: {error}", settings.display()))?;
    }
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
                "SearXNG answered 403 for format=json; add 'json' under search.formats in its settings.yml"
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
    fn the_written_settings_enable_json() {
        assert!(SETTINGS.contains("json"));
        assert!(SETTINGS.contains("use_default_settings: true"));
    }
}

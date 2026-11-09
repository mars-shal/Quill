//! Supervisor for the Python pipeline API (`api.py`).
//!
//! The app used to assume someone had already started the sidecar by hand, which
//! made an un-started pipeline indistinguishable from a broken one. The
//! supervisor owns the child instead: it resolves the interpreter and the project
//! root, spawns the server on the same port `pipeline.rs` talks to, and kills it
//! on the way out — a leaked Python process outlives the desktop app that
//! spawned it and keeps the port against the next launch.
//!
//! Boot failures are reported as a reason string rather than an error. Quill is
//! local-first, so "the pipeline could not start" is a state the reader should
//! see, not a dialog they have to dismiss before writing.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::sleep;

use crate::error::{AppError, AppResult};

/// Entry point the supervisor runs. Its presence in a directory is what marks
/// that directory as the project root.
const API_ENTRY: &str = "api.py";
const OUTPUT_DIR: &str = "output-api";

const ENV_PYTHON: &str = "QUILL_PIPELINE_PYTHON";
const ENV_ROOT: &str = "QUILL_PIPELINE_ROOT";
const ENV_BIN: &str = "QUILL_SIDECAR_BIN";

/// The only interface this sidecar may be reached on.
///
/// It spends the reader's provider key and authenticates nobody, so binding it
/// anywhere wider hands that key to the local network. `api.py` defaults to every
/// interface, which is right for a container and wrong for a desktop app that
/// already talks to `127.0.0.1`; the flag is passed explicitly so the child
/// cannot inherit a wider default from a different version of the script.
const LOOPBACK: &str = "127.0.0.1";

/// Importing the pipeline modules and binding the port is not instant, so
/// readiness is polled over a window rather than inferred from a live pid.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const READY_INTERVAL: Duration = Duration::from_millis(250);
/// One probe must never outlive the poll loop, or the timeout stops meaning
/// anything.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    /// Program the live child was spawned with. Reported verbatim so the
    /// status names the binary that is running rather than a re-resolved guess
    /// that could differ if the environment changed underneath us.
    program: PathBuf,
}

/// Managed state for the sidecar. The lock is only ever held across
/// syscall-free sections, so `shutdown` never queues behind a health poll.
#[derive(Default)]
pub struct Supervisor {
    inner: Mutex<Inner>,
}

impl Supervisor {
    /// Spawn the sidecar unless one is already alive, then wait for `/health`.
    ///
    /// `Ok(())` means ready. `Err(reason)` is the text the UI shows, and is also
    /// what `start` means by failure — see the module docs for why this is not
    /// an `AppError`.
    pub async fn start(&self, base: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let probe = inner.child.as_mut().map(|child| child.try_wait());
        match &probe {
            Some(Ok(None)) => {}
            Some(Ok(Some(exit))) => tracing::warn!(%exit, "the pipeline sidecar exited on its own"),
            Some(Err(err)) => tracing::warn!(%err, "the pipeline sidecar could not be probed"),
            None => {}
        }
        // Anything other than a confirmed-live child has to release the port
        // before a replacement can bind it.
        if !matches!(probe, Some(Ok(None))) {
            if let Some(mut child) = inner.child.take() {
                let _ = child.start_kill();
            }
            inner.program = PathBuf::new();
        }

        if inner.child.is_none() {
            let root = pipeline_root().map_err(|err| err.to_string())?;
            let bundled = env_path(ENV_BIN).or_else(bundled_binary);
            let (child, program) = if let Some(binary) = bundled {
                let child = spawn_binary(&binary, &root, &port_of(base))
                    .map_err(|err| format!("could not start {}: {err}", binary.display()))?;
                tracing::info!(binary = %binary.display(), root = %root.display(), "started the bundled pipeline sidecar");
                (child, binary)
            } else {
                let python = python_in(&root, env_path(ENV_PYTHON));
                let child = spawn_python(&python, &root, &port_of(base))
                    .map_err(|err| format!("could not start {}: {err}", python.display()))?;
                tracing::info!(python = %python.display(), root = %root.display(), "started the pipeline sidecar");
                (child, python)
            };
            inner.child = Some(child);
            inner.program = program;
        }

        let program = inner.program.clone();
        drop(inner);
        self.await_ready(base, &program).await
    }

    /// The interpreter of the live child, or `None` when nothing is running. A
    /// child that has exited is reaped here so a later `start` can respawn.
    pub async fn running(&self) -> Option<PathBuf> {
        let mut inner = self.inner.lock().await;
        let probe = inner.child.as_mut().map(|child| child.try_wait());
        match probe {
            Some(Ok(None)) => Some(inner.program.clone()),
            Some(_) => {
                tracing::info!("the pipeline sidecar is no longer running");
                inner.child = None;
                inner.program = PathBuf::new();
                None
            }
            None => None,
        }
    }

    /// Kill the child and reap it. Safe to call when nothing is running.
    pub async fn shutdown(&self) {
        let mut inner = self.inner.lock().await;
        let Some(mut child) = inner.child.take() else {
            return;
        };
        inner.program = PathBuf::new();
        // `kill` sends SIGKILL *and* awaits `wait`, so the child is reaped
        // instead of lingering as a zombie that still holds the port.
        if let Err(err) = child.kill().await {
            tracing::warn!(%err, "the pipeline sidecar could not be killed");
        }
    }

    async fn await_ready(&self, base: &str, program: &Path) -> Result<(), String> {
        let client = reqwest::Client::new();
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if health_ok(&client, base).await {
                return Ok(());
            }
            // A sidecar that died during boot will never become healthy; waiting
            // out the full window would only delay the reason the reader needs.
            if let Some(reason) = self.exited().await {
                return Err(reason);
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "{} did not answer /health within {}s",
                    program.display(),
                    READY_TIMEOUT.as_secs()
                ));
            }
            sleep(READY_INTERVAL).await;
        }
    }

    /// `Some(reason)` once the child is gone, so the poll loop can stop early.
    async fn exited(&self) -> Option<String> {
        let mut inner = self.inner.lock().await;
        match inner.child.as_mut()?.try_wait() {
            Ok(None) => None,
            Ok(Some(exit)) => Some(format!("the pipeline sidecar exited ({exit})")),
            Err(err) => Some(format!("the pipeline sidecar could not be probed: {err}")),
        }
    }
}

/// Is something answering `/health` at `base`?
///
/// Deliberately independent of the child handle: a sidecar can outlive the app
/// that spawned it — a leftover from a previous run, or an `api.py` started by
/// hand — and the reader should see a usable pipeline either way.
pub async fn serving(base: &str) -> bool {
    health_ok(&reqwest::Client::new(), base).await
}

async fn health_ok(client: &reqwest::Client, base: &str) -> bool {
    let probe = client
        .get(format!("{base}/health"))
        .timeout(PROBE_TIMEOUT)
        .send()
        .await;
    matches!(probe, Ok(res) if res.status().is_success())
}

fn spawn_python(python: &Path, root: &Path, port: &str) -> std::io::Result<Child> {
    let mut cmd = Command::new(python);
    cmd.arg(API_ENTRY)
        .arg("--host")
        .arg(LOOPBACK)
        .arg("--port")
        .arg(port)
        .arg("--bind")
        .arg(root.join(OUTPUT_DIR))
        // Pinned to the project root rather than inheriting the app's cwd,
        // which is `gui/src-tauri` in development and an install directory in
        // a packaged build. `PYTHONPATH` is set for the same reason: the
        // pipeline modules are imported by name, not by path.
        .current_dir(root)
        .env("PYTHONPATH", root)
        // Inherited so `api.py`'s own logging reaches the terminal the app was
        // launched from. A pipe nobody drains is worse than no log at all.
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    cmd.spawn()
}

fn spawn_binary(binary: &Path, root: &Path, port: &str) -> std::io::Result<Child> {
    let mut cmd = Command::new(binary);
    cmd.arg("--host")
        .arg(LOOPBACK)
        .arg("--port")
        .arg(port)
        .arg("--bind")
        .arg(root.join(OUTPUT_DIR))
        .current_dir(root)
        // Keep the embedding model in the app's data directory rather than in
        // whatever home cache the launching user happens to have.
        .env("FASTEMBED_CACHE_DIR", root.join("fastembed"))
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    cmd.spawn()
}

/// The sidecar Tauri copies beside the main executable for a bundled build.
///
/// Development has no such file and falls through to the project venv.
pub(crate) fn bundled_binary() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for name in ["quill-sidecar", "quill-sidecar.exe"] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // Tauri renames the target-suffixed source to the bare name when it bundles,
    // but a local `target/<profile>` next to a hand-copied build can still hold
    // the suffixed file. Accept either spelling.
    let entries = std::fs::read_dir(&dir).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with("quill-sidecar-") && entry.path().is_file() {
            return Some(entry.path());
        }
    }
    None
}

/// The port the sidecar must bind, taken from the URL the client already talks
/// to so the two can never disagree about where the server lives.
pub fn port_of(base: &str) -> String {
    let host = base.split_once("://").map_or(base, |(_, rest)| rest);
    let authority = host
        .split_once('/')
        .map_or(host, |(authority, _)| authority);
    match authority.rsplit_once(':') {
        Some((_, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            port.to_string()
        }
        _ => "8000".to_string(),
    }
}

pub(crate) fn pipeline_root() -> AppResult<PathBuf> {
    if let Some(root) = env_path(ENV_ROOT) {
        return Ok(root);
    }
    let cwd = std::env::current_dir()
        .map_err(|err| AppError::Other(format!("cannot read the working directory: {err}")))?;
    root_from(&cwd).ok_or_else(|| {
        AppError::Other(format!(
            "{API_ENTRY} is not in {} or any of its parent directories",
            cwd.display()
        ))
    })
}

/// The nearest ancestor of `start` — `start` included — that holds `api.py`.
fn root_from(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| dir.join(API_ENTRY).is_file())
        .map(Path::to_path_buf)
}

/// `override` (the env var) wins, then the project's own virtualenv, then
/// whatever `python3` is on `PATH`. That last one is a guess, which is why the
/// resolved path is reported in the status detail instead of being hidden.
fn python_in(root: &Path, override_python: Option<PathBuf>) -> PathBuf {
    if let Some(python) = override_python {
        return python;
    }
    let venv = root.join(".venv").join("bin").join("python");
    if venv.is_file() {
        venv
    } else {
        PathBuf::from("python3")
    }
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn the_port_comes_from_the_url_the_client_uses() {
        assert_eq!(port_of("http://127.0.0.1:9123"), "9123");
        assert_eq!(port_of("http://127.0.0.1:9123/"), "9123");
        assert_eq!(port_of("https://pipeline.local:8443/api"), "8443");
    }

    #[test]
    fn a_url_without_a_port_falls_back_to_the_api_default() {
        assert_eq!(port_of("http://127.0.0.1"), "8000");
        assert_eq!(port_of("http://127.0.0.1:8000"), "8000");
    }

    #[test]
    fn the_root_is_the_nearest_ancestor_holding_the_entry_point() {
        let dir = TempDir::new().expect("temp dir");
        let root = dir.path();
        std::fs::write(root.join(API_ENTRY), "").expect("write api.py");
        // The layout `npm run tauri:dev` runs from: cwd two levels below root.
        let nested = root.join("gui").join("src-tauri");
        std::fs::create_dir_all(&nested).expect("create nested dirs");
        assert_eq!(root_from(&nested).as_deref(), Some(root));
    }

    #[test]
    fn a_tree_without_the_entry_point_yields_no_root() {
        let dir = TempDir::new().expect("temp dir");
        assert_eq!(root_from(dir.path()), None);
    }

    #[test]
    fn the_project_virtualenv_is_preferred_over_path_python() {
        let dir = TempDir::new().expect("temp dir");
        assert_eq!(python_in(dir.path(), None), PathBuf::from("python3"));

        let venv = dir.path().join(".venv").join("bin").join("python");
        std::fs::create_dir_all(venv.parent().expect("venv bin")).expect("create venv");
        std::fs::write(&venv, "").expect("write interpreter");
        assert_eq!(python_in(dir.path(), None), venv);
    }

    #[test]
    fn an_explicit_interpreter_overrides_the_virtualenv() {
        let dir = TempDir::new().expect("temp dir");
        let venv = dir.path().join(".venv").join("bin").join("python");
        std::fs::create_dir_all(venv.parent().expect("venv bin")).expect("create venv");
        std::fs::write(&venv, "").expect("write interpreter");

        let chosen = python_in(dir.path(), Some(PathBuf::from("/opt/quill/bin/python")));
        assert_eq!(chosen, PathBuf::from("/opt/quill/bin/python"));
    }

    /// Spawns the real `api.py` and waits for it to answer `/health`.
    ///
    /// `#[ignore]` because it needs the project's virtualenv and a free port, so
    /// it cannot belong to a suite that has to pass on a machine with neither.
    /// It is the only check on the half that unit tests cannot reach: that the
    /// supervisor really launches a server, and that `shutdown` gives the port
    /// back. Run it with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore = "spawns a real Python sidecar; run with cargo test -- --ignored"]
    async fn a_real_sidecar_starts_serves_and_is_reaped() {
        let base = "http://127.0.0.1:8477";
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(|p| p.parent())
            .expect("repo root")
            .to_path_buf();
        assert!(
            root.join(API_ENTRY).is_file(),
            "expected {} beside the workspace",
            root.join(API_ENTRY).display()
        );

        let supervisor = Supervisor::default();
        supervisor
            .start(base)
            .await
            .unwrap_or_else(|reason| panic!("the sidecar did not come up: {reason}"));

        assert!(serving(base).await, "/health answered while starting");
        assert!(
            supervisor.running().await.is_some(),
            "a started sidecar reports its interpreter"
        );

        // Starting again must not spawn a second server against the same port.
        supervisor
            .start(base)
            .await
            .expect("a second start is idempotent");

        supervisor.shutdown().await;
        assert!(supervisor.running().await.is_none(), "the child was reaped");

        // The kill is what frees the port; if it leaked, the next launch would
        // fail to bind and the reader would see "service failed" for no reason.
        let mut released = false;
        for _ in 0..40 {
            if !serving(base).await {
                released = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(released, "the port stayed bound after shutdown");
    }
}

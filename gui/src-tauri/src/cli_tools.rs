//! Finds the coding tools already installed on this machine.
//!
//! Two different things are reported here, and the difference is the whole
//! point:
//!
//! * A **CLI agent** (`claude`, `codex`, `gemini`, `aider`, `opencode`, …) is a
//!   program the reader runs in a terminal. It answers a turn through its
//!   one-shot invocation (`exec`, `DetectedTool::exec` names the full command
//!   prefix), which the sidecar's `cli` protocol runs with the message as the
//!   last argument and reads off stdout. Its own login is the credential, so
//!   adopting one creates a provider that needs no key.
//! * A **local model server** (`ollama`, LM Studio) is a program *and* an
//!   endpoint. When it is running, its models are a real list and it can answer
//!   a turn, so it becomes a provider row with one click.
//!
//! So the shape is one row per tool, with `base_url` empty for the first kind
//! and set for the second, and `exec` set for the first kind -- the UI decides
//! what it can offer from that rather than from a hardcoded table of names that
//! would drift.
//!
//! Nothing here writes anything. Detection only reports; adopting a tool is a
//! separate, explicit call, exactly like creating any other provider.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;

use crate::model_catalog;

/// `--version` on a cold binary that has to start a runtime can take a moment;
/// a hang must not hold the settings page open for the rest of the session.
const VERSION_TIMEOUT: Duration = Duration::from_secs(3);

/// Local servers answer from memory. If they cannot do it in this long they are
/// not running, and waiting longer only delays the answer.
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);

/// One promoted tool: what to look for, and where it serves models from.
///
/// `base_url` is the OpenAI-compatible root a provider row would store, which is
/// what `model_catalog` and the pipeline both expect -- the native API is a
/// fallback probe only, never a stored endpoint.
struct Spec {
    id: &'static str,
    label: &'static str,
    bin: &'static str,
    base_url: &'static str,
    /// Arguments that turn the binary into a one-shot turn taker: the CLI gets
    /// the message as its final argument and prints the answer on stdout.
    /// Empty for servers, which speak an endpoint instead. The full `exec`
    /// recorded on a [`DetectedTool`] prepends the *resolved* binary path --
    /// the sidecar inherits this process's PATH, which may lack `~/.local/bin`.
    exec_args: &'static str,
    /// Endpoints that answer with this tool's model list. The first is the
    /// provider's own `/models`; the rest are native APIs that name the same
    /// models in a shape `model_catalog::parse_models` already understands.
    probes: &'static [&'static str],
}

const SPECS: &[Spec] = &[
    Spec {
        id: "ollama",
        label: "Ollama",
        bin: "ollama",
        base_url: "http://127.0.0.1:11434/v1",
        exec_args: "",
        probes: &[
            "http://127.0.0.1:11434/v1/models",
            "http://127.0.0.1:11434/api/tags",
        ],
    },
    Spec {
        id: "lmstudio",
        label: "LM Studio",
        bin: "lms",
        base_url: "http://127.0.0.1:1234/v1",
        exec_args: "",
        probes: &["http://127.0.0.1:1234/v1/models"],
    },
    Spec {
        id: "claude",
        label: "Claude Code",
        bin: "claude",
        base_url: "",
        exec_args: "-p --output-format json",
        probes: &[],
    },
    Spec {
        id: "codex",
        label: "Codex CLI",
        bin: "codex",
        base_url: "",
        exec_args: "exec --json",
        probes: &[],
    },
    Spec {
        id: "gemini",
        label: "Gemini CLI",
        bin: "gemini",
        base_url: "",
        exec_args: "-p",
        probes: &[],
    },
    Spec {
        id: "aider",
        label: "Aider",
        bin: "aider",
        base_url: "",
        exec_args: "--message",
        probes: &[],
    },
    Spec {
        id: "llm",
        label: "LLM",
        bin: "llm",
        base_url: "",
        exec_args: "",
        probes: &[],
    },
    Spec {
        id: "opencode",
        label: "opencode",
        bin: "opencode",
        base_url: "",
        exec_args: "run --format json",
        probes: &[],
    },
];

/// One detected tool, as the settings page renders it.
///
/// `command` is empty when the tool is not on `PATH` -- which is a real state
/// for a local server started from a desktop launcher rather than a shell, so
/// the row is still offered when its endpoint answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTool {
    pub id: String,
    pub label: String,
    pub command: String,
    pub version: String,
    pub base_url: String,
    /// The one-shot command prefix that receives a turn (`/path/to/opencode
    /// run --format json`), empty for tools that only serve an endpoint. The
    /// sidecar appends the message and reads the answer off stdout.
    pub exec: String,
    pub models: Vec<String>,
}

/// Every tool found, either installed or answering on its local port.
///
/// Ordered so the rows worth clicking come first: a tool with models beats a
/// bare CLI, and an installed CLI beats nothing at all.
pub async fn detect() -> Vec<DetectedTool> {
    let mut found = Vec::new();
    for spec in SPECS {
        let command = find_in_path(spec.bin);
        let models = if spec.probes.is_empty() {
            Vec::new()
        } else {
            probe_models(spec.probes).await
        };
        if command.is_none() && models.is_empty() {
            continue;
        }
        let version = match &command {
            Some(path) => version_of(path).await,
            None => String::new(),
        };
        let exec = match (&command, spec.exec_args.is_empty()) {
            (Some(path), false) => format!("{} {}", path.display(), spec.exec_args),
            (Some(path), true) if spec.base_url.is_empty() => path.display().to_string(),
            _ => String::new(),
        };
        found.push(DetectedTool {
            id: spec.id.to_string(),
            label: spec.label.to_string(),
            command: command
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
            version,
            base_url: if models.is_empty() {
                String::new()
            } else {
                spec.base_url.to_string()
            },
            exec,
            models,
        });
    }
    found.sort_by(|a, b| {
        b.models
            .is_empty()
            .cmp(&a.models.is_empty())
            .then_with(|| a.label.cmp(&b.label))
    });
    found
}

/// Where a program with this name actually is, or `None`.
///
/// `PATH` first, then the directories package managers install into without
/// touching it. A GUI process does not inherit a login shell's `PATH`, so
/// `~/.local/bin` is routinely missing here even though the reader's terminal
/// has it -- which would make the panel claim nothing is installed.
fn find_in_path(bin: &str) -> Option<PathBuf> {
    let file = format!("{bin}{}", std::env::consts::EXE_SUFFIX);
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        for relative in [
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".volta/bin",
            ".local/share/pnpm",
            ".npm-global/bin",
        ] {
            dirs.push(home.join(relative));
        }
    }
    for absolute in ["/usr/local/bin", "/opt/homebrew/bin"] {
        dirs.push(PathBuf::from(absolute));
    }

    dirs.into_iter()
        .map(|dir| dir.join(&file))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// The first line a tool prints for `--version`, trimmed and bounded.
///
/// Not an error when it fails: several of these exit non-zero for `--version`
/// or print to stderr, and an unknown version is a cosmetic gap, not a reason
/// to hide a tool that is plainly installed.
async fn version_of(path: &Path) -> String {
    let attempt = Command::new(path).arg("--version").output();
    let Ok(Ok(output)) = tokio::time::timeout(VERSION_TIMEOUT, attempt).await else {
        return String::new();
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(version_token)
        .unwrap_or_default()
}

/// The version number in a `--version` line.
///
/// Every one of these tools words the line differently -- `ollama version is
/// 0.21.0`, `codex-cli 0.144.3`, `2.2.1` -- so taking the first token, or
/// stripping a prefix, mangles most of them. The number is the only part they
/// agree on: a token with a dot and a digit in it.
fn version_token(line: &str) -> String {
    let token = line
        .split_whitespace()
        .map(|word| word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.'))
        .find(|word| word.contains('.') && word.chars().any(|c| c.is_ascii_digit()))
        .unwrap_or(line);
    token.chars().take(40).collect()
}

/// Models served by a running local server, or an empty list.
///
/// A first probe that answers nothing is followed by the native one, because
/// Ollama's OpenAI shim is the newer of its two surfaces and older builds only
/// have `/api/tags`.
async fn probe_models(probes: &[&str]) -> Vec<String> {
    let client = match reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() {
        Ok(client) => client,
        Err(_) => return Vec::new(),
    };
    for probe in probes {
        let Ok(response) = client.get(*probe).send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(body) = response.json::<serde_json::Value>().await else {
            continue;
        };
        let models = model_catalog::parse_models(&body);
        if !models.is_empty() {
            return models;
        }
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn every_spec_has_a_unique_id_and_binary() {
        let mut ids: Vec<&str> = SPECS.iter().map(|spec| spec.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "two specs share an id");
    }

    /// The stored base URL is what the pipeline appends `/chat/completions` to,
    /// and what `model_catalog` appends `/models` to. Both live under `/v1` on
    /// every one of these, so a row without it would 404 on both paths.
    #[test]
    fn server_specs_store_an_openai_root_and_probe_it() {
        for spec in SPECS.iter().filter(|spec| !spec.probes.is_empty()) {
            assert!(
                spec.base_url.ends_with("/v1"),
                "{} stores a base URL the OpenAI paths do not sit under",
                spec.id
            );
            assert!(
                spec.probes[0].starts_with(spec.base_url),
                "{} does not probe its own endpoint first",
                spec.id
            );
        }
    }

    #[test]
    fn cli_specs_serve_no_endpoint() {
        for spec in SPECS.iter().filter(|spec| spec.probes.is_empty()) {
            assert!(
                spec.base_url.is_empty(),
                "{} is a CLI but claims an endpoint",
                spec.id
            );
        }
    }

    /// A tool that is installed but has no models is still worth reporting;
    /// detection must not reduce to "did a port answer".
    #[test]
    fn detects_a_program_that_really_exists() {
        let found = find_in_path("sh");
        assert!(found.is_some(), "sh should be on PATH in this environment");
    }

    #[test]
    fn version_lines_are_reduced_to_the_number() {
        assert_eq!(version_token("ollama version is 0.21.0"), "0.21.0");
        assert_eq!(version_token("codex-cli 0.144.3"), "0.144.3");
        assert_eq!(version_token("2.2.1"), "2.2.1");
        assert_eq!(version_token("aider 0.86.1-dev"), "0.86.1-dev");
        // Nothing version-shaped: keep the line rather than reporting nothing.
        assert_eq!(version_token("unknown"), "unknown");
    }

    #[test]
    fn missing_program_is_not_reported() {
        assert!(find_in_path("quill-no-such-tool-9f3a").is_none());
    }

    #[tokio::test]
    async fn version_of_a_real_binary_is_trimmed_to_its_number() {
        let path = find_in_path("sh").expect("sh");
        // `sh --version` is not a thing, but it must come back as "" rather
        // than hanging or panicking -- the error path is the common one.
        let version = version_of(&path).await;
        assert!(version.chars().count() <= 40);
    }
}

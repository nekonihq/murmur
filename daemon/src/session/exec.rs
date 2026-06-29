//! One-shot command execution backing **agent mode**. Runs a command, captures
//! stdout/stderr/exit code, returns a single [`ExecResult`].

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::protocol::messages::ExecResult;

/// Per-stream capture cap. Output beyond this is dropped and `truncated` set —
/// keeps a runaway command from blowing up the BLE link or the LLM context.
pub const MAX_CAPTURE: usize = 256 * 1024;

/// Exit code reported when a command exceeds its timeout (matches coreutils
/// `timeout`).
pub const TIMEOUT_EXIT: i32 = 124;

/// Run `cmd` via `/bin/sh -c`, optionally bounded by `timeout_ms`.
pub async fn run_exec(cmd: &str, timeout_ms: Option<u64>) -> ExecResult {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(cmd)
        .stdin(Stdio::null())
        .kill_on_drop(true);

    let output_fut = command.output();
    let output = match timeout_ms {
        Some(ms) => match timeout(Duration::from_millis(ms), output_fut).await {
            Ok(res) => res,
            Err(_) => {
                return ExecResult {
                    stdout: String::new(),
                    stderr: format!("command timed out after {ms} ms"),
                    exit_code: TIMEOUT_EXIT,
                    truncated: false,
                };
            }
        },
        None => output_fut.await,
    };

    match output {
        Ok(out) => {
            let (stdout, t1) = cap(&out.stdout);
            let (stderr, t2) = cap(&out.stderr);
            ExecResult {
                stdout,
                stderr,
                exit_code: out.status.code().unwrap_or(-1),
                truncated: t1 || t2,
            }
        }
        Err(e) => ExecResult {
            stdout: String::new(),
            stderr: format!("failed to spawn command: {e}"),
            exit_code: -1,
            truncated: false,
        },
    }
}

/// Lossily decode up to [`MAX_CAPTURE`] bytes as UTF-8, flagging truncation.
fn cap(bytes: &[u8]) -> (String, bool) {
    if bytes.len() > MAX_CAPTURE {
        (
            String::from_utf8_lossy(&bytes[..MAX_CAPTURE]).into_owned(),
            true,
        )
    } else {
        (String::from_utf8_lossy(bytes).into_owned(), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn captures_stdout_and_exit_zero() {
        let r = run_exec("echo hello", None).await;
        assert_eq!(r.stdout.trim(), "hello");
        assert_eq!(r.exit_code, 0);
        assert!(!r.truncated);
    }

    #[tokio::test]
    async fn propagates_nonzero_exit() {
        let r = run_exec("exit 3", None).await;
        assert_eq!(r.exit_code, 3);
    }

    #[tokio::test]
    async fn captures_stderr() {
        let r = run_exec("echo oops 1>&2", None).await;
        assert_eq!(r.stderr.trim(), "oops");
        assert_eq!(r.exit_code, 0);
    }

    #[tokio::test]
    async fn timeout_is_enforced() {
        let r = run_exec("sleep 5", Some(100)).await;
        assert_eq!(r.exit_code, TIMEOUT_EXIT);
        assert!(r.stderr.contains("timed out"));
    }

    #[tokio::test]
    async fn large_output_is_truncated() {
        // Emit well over MAX_CAPTURE bytes.
        let r = run_exec("yes x | head -c 400000", None).await;
        assert!(r.truncated);
        assert!(r.stdout.len() <= MAX_CAPTURE);
    }
}

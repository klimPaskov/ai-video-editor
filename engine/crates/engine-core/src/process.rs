//! Supervised external tools (FFmpeg and ffprobe). Every tool runs without a
//! shell and without a window, under a watchdog that enforces an overall
//! time limit, a stall limit (no output for too long) and cancellation.

use crate::job::{Cancel, JobError, JobResult};
use crate::protocol::ErrorCode;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const STDERR_TAIL_BYTES: usize = 8 * 1024;
const MAX_CAPTURE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ToolSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Hard limit for the whole run.
    pub timeout: Duration,
    /// Longest silence tolerated between output lines or frames.
    pub stall: Option<Duration>,
    /// Working directory; lets filters name files without path escaping.
    pub cwd: Option<PathBuf>,
}

impl ToolSpec {
    pub fn new(program: impl Into<PathBuf>, args: Vec<String>, timeout: Duration) -> Self {
        Self {
            program: program.into(),
            args,
            timeout,
            stall: None,
            cwd: None,
        }
    }

    pub fn with_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn with_stall(mut self, stall: Duration) -> Self {
        self.stall = Some(stall);
        self
    }
}

#[derive(Debug)]
pub struct ToolOutput {
    pub stderr_tail: String,
}

const REASON_NONE: u8 = 0;
const REASON_CANCELLED: u8 = 1;
const REASON_TIMEOUT: u8 = 2;

/// A running tool plus its watchdog.
pub struct ToolHandle {
    child: Arc<Mutex<Child>>,
    done: Arc<AtomicBool>,
    reason: Arc<AtomicU8>,
    activity: Arc<AtomicU64>,
    started: Instant,
    watchdog: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<Vec<u8>>>,
}

fn kill(child: &Arc<Mutex<Child>>) {
    if let Ok(mut child) = child.lock() {
        let _ = child.kill();
    }
}

pub fn spawn(spec: &ToolSpec, cancel: &Cancel) -> JobResult<(ChildStdout, ToolHandle)> {
    cancel.check()?;
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            JobError::new(ErrorCode::ToolUnavailable, error.to_string())
        } else {
            JobError::new(ErrorCode::ToolUnavailable, format!("cannot start: {error}"))
        }
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| JobError::internal("no stdout"))?;
    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| JobError::internal("no stderr"))?;
    let stderr = thread::spawn(move || {
        // Keep only the tail so a chatty tool cannot grow memory.
        let mut tail: Vec<u8> = Vec::new();
        let mut buffer = [0u8; 4096];
        while let Ok(read) = stderr_pipe.read(&mut buffer) {
            if read == 0 {
                break;
            }
            tail.extend_from_slice(&buffer[..read]);
            if tail.len() > STDERR_TAIL_BYTES {
                tail.drain(..tail.len() - STDERR_TAIL_BYTES);
            }
        }
        tail
    });
    let child = Arc::new(Mutex::new(child));
    let done = Arc::new(AtomicBool::new(false));
    let reason = Arc::new(AtomicU8::new(REASON_NONE));
    let activity = Arc::new(AtomicU64::new(0));
    let started = Instant::now();
    let watchdog = {
        let (child, done, reason, activity, cancel) = (
            child.clone(),
            done.clone(),
            reason.clone(),
            activity.clone(),
            cancel.clone(),
        );
        let (timeout, stall) = (spec.timeout, spec.stall);
        thread::spawn(move || {
            while !done.load(Ordering::SeqCst) {
                let elapsed = started.elapsed();
                let silent =
                    elapsed.saturating_sub(Duration::from_millis(activity.load(Ordering::SeqCst)));
                let why = if cancel.is_cancelled() {
                    REASON_CANCELLED
                } else if elapsed > timeout || stall.is_some_and(|limit| silent > limit) {
                    REASON_TIMEOUT
                } else {
                    REASON_NONE
                };
                if why != REASON_NONE {
                    reason.store(why, Ordering::SeqCst);
                    kill(&child);
                    return;
                }
                thread::sleep(Duration::from_millis(25));
            }
        })
    };
    Ok((
        stdout,
        ToolHandle {
            child,
            done,
            reason,
            activity,
            started,
            watchdog: Some(watchdog),
            stderr: Some(stderr),
        },
    ))
}

impl ToolHandle {
    /// Records progress so the stall limit restarts.
    pub fn touch(&self) {
        let millis = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.activity.store(millis, Ordering::SeqCst);
    }

    /// Stops the tool now (used when the caller fails before it ends).
    pub fn abort(mut self) {
        kill(&self.child);
        let _ = self.wait();
        self.join();
    }

    fn wait(&self) -> std::io::Result<ExitStatus> {
        loop {
            if let Ok(mut child) = self.child.lock() {
                if let Some(status) = child.try_wait()? {
                    return Ok(status);
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn join(&mut self) -> String {
        self.done.store(true, Ordering::SeqCst);
        if let Some(watchdog) = self.watchdog.take() {
            let _ = watchdog.join();
        }
        self.stderr
            .take()
            .and_then(|handle| handle.join().ok())
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default()
    }

    /// Waits for the tool and classifies how it ended.
    pub fn finish(mut self) -> JobResult<ToolOutput> {
        let status = self.wait()?;
        let stderr_tail = self.join();
        match self.reason.load(Ordering::SeqCst) {
            REASON_CANCELLED => Err(JobError::new(ErrorCode::Cancelled, "cancelled")),
            REASON_TIMEOUT => Err(JobError::new(
                ErrorCode::Timeout,
                format!("tool timed out: {}", short(&stderr_tail)),
            )),
            _ if status.success() => Ok(ToolOutput { stderr_tail }),
            _ => {
                let lower = stderr_tail.to_lowercase();
                let code = if lower.contains("no space left") || lower.contains("disk full") {
                    ErrorCode::DiskFull
                } else {
                    ErrorCode::ToolFailed
                };
                Err(JobError::new(code, short(&stderr_tail)))
            }
        }
    }
}

impl Drop for ToolHandle {
    fn drop(&mut self) {
        // A handle dropped without finish() must not leave a tool running.
        if self.watchdog.is_some() {
            kill(&self.child);
            let _ = self.wait();
            self.join();
        }
    }
}

fn short(text: &str) -> String {
    let trimmed = text.trim();
    let start = trimmed.len().saturating_sub(600);
    let start = (start..=trimmed.len())
        .find(|index| trimmed.is_char_boundary(*index))
        .unwrap_or(0);
    trimmed[start..].to_string()
}

/// Runs a tool, handing each stdout line to `on_line`.
pub fn run_lines(
    spec: &ToolSpec,
    cancel: &Cancel,
    mut on_line: impl FnMut(&str),
) -> JobResult<ToolOutput> {
    let (stdout, handle) = spawn(spec, cancel)?;
    let mut reader = BufReader::new(stdout);
    let mut raw = Vec::new();
    loop {
        raw.clear();
        match reader.read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                handle.touch();
                on_line(String::from_utf8_lossy(&raw).trim_end());
            }
        }
    }
    handle.finish()
}

/// Runs a tool and returns its (bounded) standard output.
pub fn run_capture(spec: &ToolSpec, cancel: &Cancel) -> JobResult<String> {
    let mut text = String::new();
    let mut overflow = false;
    run_lines(spec, cancel, |line| {
        if text.len() + line.len() < MAX_CAPTURE_BYTES {
            text.push_str(line);
            text.push('\n');
        } else {
            overflow = true;
        }
    })?;
    if overflow {
        return Err(JobError::new(
            ErrorCode::OutputInvalid,
            "tool output too large",
        ));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str, timeout_ms: u64) -> ToolSpec {
        #[cfg(windows)]
        let (program, args) = (
            "powershell",
            vec![
                "-NoProfile".to_string(),
                "-Command".to_string(),
                script.to_string(),
            ],
        );
        #[cfg(not(windows))]
        let (program, args) = ("sh", vec!["-c".to_string(), script.to_string()]);
        ToolSpec::new(program, args, Duration::from_millis(timeout_ms))
    }

    #[test]
    fn captures_output_lines() {
        let spec = shell("echo one; echo two", 20_000);
        let text = run_capture(&spec, &Cancel::new()).unwrap();
        assert_eq!(text.lines().collect::<Vec<_>>(), ["one", "two"]);
    }

    #[test]
    fn kills_a_tool_that_exceeds_its_time_limit() {
        #[cfg(windows)]
        let script = "Start-Sleep -Seconds 30";
        #[cfg(not(windows))]
        let script = "sleep 30";
        let started = Instant::now();
        let error = run_capture(&shell(script, 1_500), &Cancel::new()).unwrap_err();
        assert_eq!(error.code, ErrorCode::Timeout);
        assert!(started.elapsed() < Duration::from_secs(15));
    }

    #[test]
    fn cancellation_stops_a_running_tool() {
        #[cfg(windows)]
        let script = "Start-Sleep -Seconds 30";
        #[cfg(not(windows))]
        let script = "sleep 30";
        let cancel = Cancel::new();
        let other = cancel.clone();
        let stopper = thread::spawn(move || {
            thread::sleep(Duration::from_millis(1_200));
            other.cancel();
        });
        let error = run_capture(&shell(script, 60_000), &cancel).unwrap_err();
        stopper.join().unwrap();
        assert_eq!(error.code, ErrorCode::Cancelled);
    }

    #[test]
    fn a_missing_program_is_reported_as_unavailable() {
        let spec = ToolSpec::new(
            "definitely-not-a-program-xyz",
            vec![],
            Duration::from_secs(5),
        );
        assert_eq!(
            run_capture(&spec, &Cancel::new()).unwrap_err().code,
            ErrorCode::ToolUnavailable
        );
    }
}

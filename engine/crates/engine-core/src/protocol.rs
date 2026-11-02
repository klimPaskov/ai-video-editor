//! Newline-delimited JSON messages between the desktop app and the engine.
//!
//! The app writes one request line, then optionally a `cancel` line (or closes
//! the pipe). The engine answers with `ready`, any number of `progress`
//! events, and exactly one `result` or `error`. Nothing else is written to
//! standard output; diagnostics go to standard error and stay hidden.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const PROTOCOL_VERSION: u32 = 1;

/// Stable machine-readable failure classes. The app maps each to plain text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidRequest,
    /// The request is valid but this engine cannot do it; use another path.
    Unsupported,
    Cancelled,
    Timeout,
    ToolUnavailable,
    ToolFailed,
    OutputInvalid,
    DiskFull,
    ModelUnavailable,
    Internal,
}

#[derive(Debug, Deserialize)]
pub struct Request {
    pub v: u32,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event<'a> {
    Ready {
        v: u32,
        engine: &'a str,
        methods: &'a [&'a str],
    },
    Progress {
        id: &'a str,
        phase: &'a str,
        fraction: f64,
    },
    Result {
        id: &'a str,
        result: Value,
    },
    Error {
        id: &'a str,
        code: ErrorCode,
        detail: &'a str,
    },
}

type Sink = Box<dyn Write + Send>;

/// Serialises events onto one stream. Cheap to clone; progress is throttled
/// so a fast tool cannot flood the app.
#[derive(Clone)]
pub struct Emitter {
    sink: Arc<Mutex<Sink>>,
    last: Arc<Mutex<(Instant, f64)>>,
}

impl Emitter {
    pub fn new(sink: Sink) -> Self {
        Self {
            sink: Arc::new(Mutex::new(sink)),
            last: Arc::new(Mutex::new((Instant::now() - Duration::from_secs(1), -1.0))),
        }
    }

    pub fn stdout() -> Self {
        Self::new(Box::new(std::io::stdout()))
    }

    /// Writes one event. A broken pipe means the app is gone; callers learn
    /// that through cancellation, so the error is ignored here.
    pub fn emit(&self, event: &Event) {
        let Ok(mut line) = serde_json::to_vec(event) else {
            return;
        };
        line.push(b'\n');
        if let Ok(mut sink) = self.sink.lock() {
            let _ = sink.write_all(&line);
            let _ = sink.flush();
        }
    }

    pub fn progress(&self, id: &str, phase: &str, fraction: f64) {
        let fraction = fraction.clamp(0.0, 1.0);
        let Ok(mut last) = self.last.lock() else {
            return;
        };
        let due =
            last.0.elapsed() >= Duration::from_millis(120) && (fraction - last.1).abs() >= 0.004;
        if due || fraction >= 1.0 || last.1 < 0.0 {
            *last = (Instant::now(), fraction);
            drop(last);
            self.emit(&Event::Progress {
                id,
                phase,
                fraction,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Default)]
    struct Buffer(Arc<Mutex<Vec<u8>>>);
    impl Write for Buffer {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn events_are_single_json_lines() {
        let buffer = Buffer::default();
        let emitter = Emitter::new(Box::new(buffer.clone()));
        emitter.emit(&Event::Error {
            id: "a",
            code: ErrorCode::DiskFull,
            detail: "x",
        });
        let text = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains("\"code\":\"DISK_FULL\""));
        assert!(text.contains("\"type\":\"error\""));
    }

    #[test]
    fn progress_is_throttled_but_first_and_last_pass() {
        let buffer = Buffer::default();
        let emitter = Emitter::new(Box::new(buffer.clone()));
        for step in 0..=100 {
            emitter.progress("a", "render", f64::from(step) / 100.0);
        }
        let text = String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap();
        let lines = text.lines().count();
        assert!((2..20).contains(&lines), "{lines} lines");
        assert!(text.lines().last().unwrap().contains("\"fraction\":1.0"));
    }

    #[test]
    fn requests_parse_with_default_params() {
        let request: Request =
            serde_json::from_str(r#"{"v":1,"id":"j","method":"cancel"}"#).unwrap();
        assert_eq!(request.method, "cancel");
        assert!(request.params.is_null());
    }
}

//! `urushi-engine`: one job per process. The app writes a request line to
//! standard input and reads events from standard output (docs/58). A
//! `cancel` line, or closing standard input, stops the job; killing the
//! process is always safe because outputs are staged and cleaned up.

use engine_core::protocol::{ErrorCode, Event, Request, PROTOCOL_VERSION};
use engine_core::{Cancel, Emitter, JobError, JobResult};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::process::ExitCode;
use std::thread;

mod loopback;

const METHODS: [&str; 3] = ["engine.hello", "clips.render", "clips.frame"];

fn dispatch(request: &Request, cancel: &Cancel, emitter: &Emitter) -> JobResult<Value> {
    let id = request.id.as_str();
    let progress = |phase: &str, fraction: f64| emitter.progress(id, phase, fraction);
    match request.method.as_str() {
        "engine.hello" => Ok(serde_json::json!({
            "engine": env!("CARGO_PKG_VERSION"),
            "protocol": PROTOCOL_VERSION,
            "methods": METHODS,
        })),
        "clips.render" | "clips.frame" => {
            let params: engine_clips::RenderParams = serde_json::from_value(request.params.clone())
                .map_err(|error| JobError::new(ErrorCode::InvalidRequest, error.to_string()))?;
            if request.method == "clips.frame" {
                engine_clips::plan_framing(&params, cancel, &progress)
            } else {
                let report = engine_clips::render(&params, cancel, &progress)?;
                serde_json::to_value(report).map_err(|error| JobError::internal(error.to_string()))
            }
        }
        other => Err(JobError::new(
            ErrorCode::InvalidRequest,
            format!("unknown method {other}"),
        )),
    }
}

fn main() -> ExitCode {
    // `urushi-engine loopback` records the computer's own sound (docs/06).
    if std::env::args().nth(1).as_deref() == Some("loopback") {
      return loopback::run();
    }
    let emitter = Emitter::stdout();
    let cancel = Cancel::new();
    let mut lines = BufReader::new(std::io::stdin()).lines();
    let request: Request = match lines.next() {
        Some(Ok(line)) => match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                emitter.emit(&Event::Error {
                    id: "",
                    code: ErrorCode::InvalidRequest,
                    detail: &error.to_string(),
                });
                return ExitCode::from(2);
            }
        },
        _ => return ExitCode::from(2),
    };
    if request.v != PROTOCOL_VERSION {
        emitter.emit(&Event::Error {
            id: &request.id,
            code: ErrorCode::InvalidRequest,
            detail: "unsupported protocol version",
        });
        return ExitCode::from(2);
    }
    emitter.emit(&Event::Ready {
        v: PROTOCOL_VERSION,
        engine: env!("CARGO_PKG_VERSION"),
        methods: &METHODS,
    });
    // The rest of standard input only carries `cancel`; EOF means the app is
    // gone, which also cancels.
    let listener = cancel.clone();
    thread::spawn(move || {
        for line in lines {
            let Ok(line) = line else { break };
            if let Ok(message) = serde_json::from_str::<Request>(&line) {
                if message.method == "cancel" {
                    break;
                }
            }
        }
        listener.cancel();
    });
    let outcome = catch_unwind(AssertUnwindSafe(|| dispatch(&request, &cancel, &emitter)))
        .unwrap_or_else(|_| Err(JobError::internal("the engine stopped unexpectedly")));
    match outcome {
        Ok(result) => emitter.emit(&Event::Result {
            id: &request.id,
            result,
        }),
        Err(error) => emitter.emit(&Event::Error {
            id: &request.id,
            code: error.code,
            detail: &error.detail,
        }),
    }
    ExitCode::SUCCESS
}

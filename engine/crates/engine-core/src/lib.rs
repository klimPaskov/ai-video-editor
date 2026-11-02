//! Shared plumbing for every Urushi engine module: the NDJSON protocol,
//! job errors and cancellation, supervised external tools, and file helpers.

pub mod files;
pub mod job;
pub mod process;
pub mod protocol;

pub use job::{Cancel, JobError, JobResult};
pub use protocol::{Emitter, ErrorCode, Event, Request, PROTOCOL_VERSION};

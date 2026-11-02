use crate::protocol::ErrorCode;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Shared cancellation flag. The protocol thread sets it; every long step
/// polls it and stops its external tools.
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> JobResult<()> {
        if self.is_cancelled() {
            Err(JobError::new(ErrorCode::Cancelled, "cancelled"))
        } else {
            Ok(())
        }
    }
}

/// A failure with a stable code and a technical detail that never reaches
/// ordinary users.
#[derive(Debug, Clone)]
pub struct JobError {
    pub code: ErrorCode,
    pub detail: String,
}

pub type JobResult<T> = Result<T, JobError>;

impl JobError {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, detail)
    }

    /// Whether another attempt on a safer path could help.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self.code,
            ErrorCode::ToolFailed
                | ErrorCode::OutputInvalid
                | ErrorCode::Timeout
                | ErrorCode::Internal
        )
    }
}

impl fmt::Display for JobError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.detail)
    }
}

impl std::error::Error for JobError {}

/// Windows ERROR_DISK_FULL / ERROR_HANDLE_DISK_FULL and POSIX ENOSPC / EDQUOT.
fn is_disk_full(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(28 | 112 | 39 | 122))
}

impl From<std::io::Error> for JobError {
    fn from(error: std::io::Error) -> Self {
        if is_disk_full(&error) {
            Self::new(ErrorCode::DiskFull, error.to_string())
        } else {
            Self::new(ErrorCode::Internal, error.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_flag_is_shared() {
        let cancel = Cancel::new();
        let other = cancel.clone();
        assert!(cancel.check().is_ok());
        other.cancel();
        assert_eq!(cancel.check().unwrap_err().code, ErrorCode::Cancelled);
    }

    #[test]
    fn disk_full_is_recognised() {
        let error = JobError::from(std::io::Error::from_raw_os_error(112));
        assert_eq!(error.code, ErrorCode::DiskFull);
        assert!(!error.is_retryable());
        assert!(JobError::new(ErrorCode::ToolFailed, "x").is_retryable());
    }
}

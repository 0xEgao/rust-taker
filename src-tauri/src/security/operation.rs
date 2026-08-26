use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::error::{AppError, ErrorCode};

pub fn ensure_main_window(window: &tauri::WebviewWindow) -> Result<(), AppError> {
    if window.label() != "main" {
        return Err(AppError::new(
            ErrorCode::AuthorizationDenied,
            "sensitive operations are available only from the main Portal window",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy)]
pub enum SensitiveOperation {
    SendTakerFunds,
    StartSwap,
    BackupPrivateKey,
    RestorePrivateKey,
}

pub struct SensitiveOperationGuard {
    active: Arc<AtomicBool>,
}

impl SensitiveOperationGuard {
    pub fn acquire(
        active: &Arc<AtomicBool>,
        _operation: SensitiveOperation,
    ) -> Result<Self, AppError> {
        active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| {
                AppError::new(
                    ErrorCode::SensitiveOperationInProgress,
                    "another sensitive operation is waiting for approval or execution",
                )
            })?;
        Ok(Self {
            active: active.clone(),
        })
    }
}

impl Drop for SensitiveOperationGuard {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_sensitive_operation_can_be_active() {
        let active = Arc::new(AtomicBool::new(false));
        let guard =
            SensitiveOperationGuard::acquire(&active, SensitiveOperation::SendTakerFunds).unwrap();
        assert!(
            SensitiveOperationGuard::acquire(&active, SensitiveOperation::BackupPrivateKey)
                .is_err()
        );
        drop(guard);
        assert!(
            SensitiveOperationGuard::acquire(&active, SensitiveOperation::BackupPrivateKey).is_ok()
        );
    }
}

//! Instant Replay capture-target ownership.
//!
//! Foreground window is used only to *find* a game. After IR starts, the
//! locked process ID is the capture authority until the process exits or the
//! user stops Instant Replay.

/// Decision for an Instant Replay (segmented, non-session) sync pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IrSyncAction {
    /// Keep the existing WGC/encoder session; ignore detection changes.
    KeepLocked { pid: u32 },
    /// Locked process is gone — stop capture.
    StopExited { pid: u32 },
    /// Not capturing; start against the detected game.
    StartDetected { pid: u32 },
    /// Idle with no game — leave capture stopped (caller may prune idle scratch).
    Idle,
}

/// Resolve Instant Replay ownership for one detection poll.
///
/// `locked_pid` is the PID already bound to the running IR session.
/// `detected_pid` is whatever game detection currently prefers (often focus-biased).
/// `process_alive` must return whether the locked PID still exists.
pub fn resolve_ir_sync(
    ir_running: bool,
    locked_pid: Option<u32>,
    detected_pid: Option<u32>,
    process_alive: impl Fn(u32) -> bool,
) -> IrSyncAction {
    if ir_running {
        let Some(pid) = locked_pid.filter(|id| *id != 0) else {
            // Running without a PID (monitor fallback). Do not tear down on focus.
            return IrSyncAction::KeepLocked { pid: 0 };
        };
        if process_alive(pid) {
            IrSyncAction::KeepLocked { pid }
        } else {
            IrSyncAction::StopExited { pid }
        }
    } else if let Some(pid) = detected_pid.filter(|id| *id != 0) {
        IrSyncAction::StartDetected { pid }
    } else {
        IrSyncAction::Idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alt_tab_keeps_locked_target_even_when_detection_clears() {
        let action = resolve_ir_sync(true, Some(42), None, |_| true);
        assert_eq!(action, IrSyncAction::KeepLocked { pid: 42 });
    }

    #[test]
    fn alt_tab_does_not_retarget_to_another_detected_pid() {
        let action = resolve_ir_sync(true, Some(42), Some(99), |_| true);
        assert_eq!(action, IrSyncAction::KeepLocked { pid: 42 });
    }

    #[test]
    fn game_exit_stops_locked_session() {
        let action = resolve_ir_sync(true, Some(42), None, |_| false);
        assert_eq!(action, IrSyncAction::StopExited { pid: 42 });
    }

    #[test]
    fn idle_starts_when_game_detected() {
        let action = resolve_ir_sync(false, None, Some(7), |_| true);
        assert_eq!(action, IrSyncAction::StartDetected { pid: 7 });
    }

    #[test]
    fn idle_stays_idle_without_detection() {
        let action = resolve_ir_sync(false, None, None, |_| true);
        assert_eq!(action, IrSyncAction::Idle);
    }
}

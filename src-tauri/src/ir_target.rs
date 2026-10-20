//! Instant Replay capture-target ownership.
//!
//! A normal foreground app cannot take the buffer. A different live catalog
//! game (detection slug is set) can: Instant Replay follows that process.
//! The lock stays when detection has no game PID, including Alt-Tab and a
//! learned window with no slug.

/// Decision for an Instant Replay (segmented, non-session) sync pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IrSyncAction {
    /// Keep the existing WGC/encoder session.
    KeepLocked { pid: u32 },
    /// Locked process is gone — stop capture.
    StopExited { pid: u32 },
    /// Detection reported a different live catalog-game process.
    Retarget { pid: u32 },
    /// Not capturing; start against the detected game.
    StartDetected { pid: u32 },
    /// Idle with no game — leave capture stopped (caller may prune idle scratch).
    Idle,
}

/// Resolve Instant Replay ownership for one detection poll.
///
/// `locked_pid` is the PID already bound to the running IR session.
/// `detected_pid` is the process game detection currently prefers.
/// `catalog_game` is true when that detection has a catalog slug.
/// `process_alive` must return whether a PID still exists.
pub fn resolve_ir_sync(
    ir_running: bool,
    locked_pid: Option<u32>,
    detected_pid: Option<u32>,
    catalog_game: bool,
    process_alive: impl Fn(u32) -> bool,
) -> IrSyncAction {
    let live_detected = detected_pid.filter(|id| *id != 0 && process_alive(*id));
    if ir_running {
        let Some(pid) = locked_pid.filter(|id| *id != 0) else {
            if catalog_game {
                if let Some(next) = live_detected {
                    return IrSyncAction::Retarget { pid: next };
                }
            }
            return IrSyncAction::KeepLocked { pid: 0 };
        };
        if !process_alive(pid) {
            return IrSyncAction::StopExited { pid };
        }
        if catalog_game {
            if let Some(next) = live_detected.filter(|next| *next != pid) {
                return IrSyncAction::Retarget { pid: next };
            }
        }
        IrSyncAction::KeepLocked { pid }
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
        let action = resolve_ir_sync(true, Some(42), None, true, |_| true);
        assert_eq!(action, IrSyncAction::KeepLocked { pid: 42 });
    }

    #[test]
    fn learned_window_without_a_slug_keeps_the_lock() {
        let action = resolve_ir_sync(true, Some(42), Some(99), false, |_| true);
        assert_eq!(action, IrSyncAction::KeepLocked { pid: 42 });
    }

    #[test]
    fn catalog_game_pid_retargets_a_running_buffer() {
        let action = resolve_ir_sync(true, Some(42), Some(99), true, |_| true);
        assert_eq!(action, IrSyncAction::Retarget { pid: 99 });
    }

    #[test]
    fn same_catalog_pid_stays_locked() {
        let action = resolve_ir_sync(true, Some(42), Some(42), true, |_| true);
        assert_eq!(action, IrSyncAction::KeepLocked { pid: 42 });
    }

    #[test]
    fn dead_detected_game_does_not_retarget() {
        let action = resolve_ir_sync(true, Some(42), Some(99), true, |pid| pid == 42);
        assert_eq!(action, IrSyncAction::KeepLocked { pid: 42 });
    }

    #[test]
    fn game_exit_stops_locked_session() {
        let action = resolve_ir_sync(true, Some(42), Some(99), true, |pid| pid != 42);
        assert_eq!(action, IrSyncAction::StopExited { pid: 42 });
    }

    #[test]
    fn idle_starts_when_game_detected() {
        let action = resolve_ir_sync(false, None, Some(7), true, |_| true);
        assert_eq!(action, IrSyncAction::StartDetected { pid: 7 });
    }

    #[test]
    fn idle_stays_idle_without_detection() {
        let action = resolve_ir_sync(false, None, None, false, |_| true);
        assert_eq!(action, IrSyncAction::Idle);
    }
}

//! Guards the fix that made `cargo test` runnable on Windows at all.
//!
//! `tauri-plugin-dialog` -> `rfd` statically imports `TaskDialogIndirect`, which only comctl32
//! 6.0 exports. Test binaries link without an application manifest, so the loader bound comctl32
//! 5.82 from System32 and every test binary died with STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139)
//! before running a single test. build.rs now embeds tests.manifest into test targets.
//!
//! This file also exists for a mechanical reason: `cargo:rustc-link-arg-tests` is rejected
//! outright by Cargo unless the package has at least one test target. Deleting it silently
//! re-breaks `cargo test`.
//!
//! Reaching `main` at all proves the process loaded, which is the whole assertion.

#[test]
fn test_binaries_load_with_a_comctl32_v6_manifest() {
    assert!(
        cfg!(windows) || cfg!(not(windows)),
        "the process started, so the loader resolved every static import"
    );
}

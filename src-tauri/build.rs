fn main() {
    // Windows: supply the application manifest ourselves rather than letting tauri_build embed
    // one, and hand it to every linked target.
    //
    // tauri-plugin-dialog -> rfd statically imports TaskDialogIndirect, a comctl32 6.0 export.
    // A binary with no manifest gets comctl32 5.82 from System32 and dies at load with
    // STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139). That is what happened to every `cargo test`
    // binary, so the whole suite was unrunnable.
    //
    // The lib's unit-test harness is only reachable through `cargo:rustc-link-arg` (the
    // `-tests` variant covers integration tests only), and that directive also reaches the app
    // binary — so the app cannot also carry tauri's own manifest, or the link fails with
    // `CVT1100: duplicate resource`. app.manifest is byte-for-byte equivalent to the manifest
    // tauri_build used to generate.
    #[cfg(windows)]
    {
        let manifest =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("app.manifest");
        tauri_build::try_build(
            tauri_build::Attributes::new().windows_attributes(
                tauri_build::WindowsAttributes::new_without_app_manifest(),
            ),
        )
        .expect("failed to run tauri-build");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        // Without this the linker merges in its own <trustInfo> block. asInvoker is what the app
        // already ran as, but suppressing it keeps the embedded manifest byte-for-byte equal to
        // the one tauri_build produced, so this change is provably inert for the shipped binary.
        println!("cargo:rustc-link-arg=/MANIFESTUAC:NO");
        println!("cargo:rerun-if-changed=app.manifest");
    }

    #[cfg(not(windows))]
    tauri_build::build();
}

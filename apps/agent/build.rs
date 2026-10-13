//! Links the Visual C++ runtime (`vcruntime140.dll`) into `rulebox-agent.exe`
//! statically, so the service starts on a clean Windows that has no Visual C++
//! Redistributable. Found on the VM: without this the agent exits with
//! `0xC0000135` (a DLL was not found) before it can log anything.
//!
//! Only the vcruntime part goes static; the Universal C Runtime is part of Windows
//! 10 and later. This is what the `static_vcruntime` crate does, without a
//! dependency. It applies to this package's binary only, so Tauri and the test
//! harnesses are untouched.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc");
    if !windows_msvc {
        return;
    }
    // Rust always links the release (non-debug) CRT, also in debug builds.
    println!("cargo:rustc-link-arg-bins=/NODEFAULTLIB:vcruntime.lib");
    println!("cargo:rustc-link-arg-bins=/NODEFAULTLIB:vcruntimed.lib");
    println!("cargo:rustc-link-arg-bins=libvcruntime.lib");
}

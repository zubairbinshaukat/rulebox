//! Links the Visual C++ runtime (`vcruntime140.dll`) into `rulebox-shell.exe`
//! statically, so the registered shell starts on a clean Windows that has no
//! Visual C++ Redistributable (a missing DLL would leave the Staff user with a
//! blank desktop). See `apps/agent/build.rs` for the details.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc");
    if !windows_msvc {
        return;
    }
    println!("cargo:rustc-link-arg-bins=/NODEFAULTLIB:vcruntime.lib");
    println!("cargo:rustc-link-arg-bins=/NODEFAULTLIB:vcruntimed.lib");
    println!("cargo:rustc-link-arg-bins=libvcruntime.lib");
}

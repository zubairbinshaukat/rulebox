//! Quick settings: volume, battery, network and the per-employee theme.
//!
//! Theme files live in
//! `%LOCALAPPDATA%\dev.rulebox.staff\employees\<employeeId>\prefs.json`
//! (`{ "theme": "auto"|"light"|"dark" }` only). They are not in the
//! employee's files. A broken file is ignored. An id that is not a plain
//! identifier is refused, so it can never become a path.

use std::fs;
use std::path::{Path, PathBuf};

use rulebox_desktop::net::Connectivity;
use rulebox_desktop::system::Snapshot;
use serde::Deserialize;

use crate::model::{BatteryDto, NetworkDto, NoticeTone, ThemeDto, VolumeDto};
use crate::state::AppState;

/// Which theme the signed-in session shows. A missing file keeps the
/// organization setting, so another employee's choice never leaks in.
pub fn theme_for_sign_in(org: ThemeDto, saved: Option<ThemeDto>) -> ThemeDto {
    saved.unwrap_or(org)
}

/// The sign-in screen after log out. Always the organization setting.
pub fn theme_after_sign_out(org: ThemeDto) -> ThemeDto {
    org
}

/// Letters, digits, `_` and `-` only. Empty, `.` and any slash are refused.
pub fn plain_employee_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn load_theme(employee_id: &str) -> Option<ThemeDto> {
    let root = employees_root()?;
    load_theme_at(&root, employee_id)
}

pub fn load_theme_at(root: &Path, employee_id: &str) -> Option<ThemeDto> {
    let path = prefs_file(root, employee_id).ok()?;
    let text = fs::read_to_string(path).ok()?;
    parse_theme(&text)
}

pub fn write_theme(employee_id: &str, theme: ThemeDto) -> Result<(), String> {
    let root = employees_root().ok_or_else(|| "LOCALAPPDATA is not set".to_string())?;
    write_theme_at(&root, employee_id, theme)
}

pub fn write_theme_at(root: &Path, employee_id: &str, theme: ThemeDto) -> Result<(), String> {
    let path = prefs_file(root, employee_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let body = format!("{{\"theme\":\"{}\"}}\n", theme_name(theme));
    fs::write(path, body).map_err(|error| error.to_string())
}

fn employees_root() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("dev.rulebox.staff").join("employees"))
}

fn prefs_file(root: &Path, employee_id: &str) -> Result<PathBuf, String> {
    if !plain_employee_id(employee_id) {
        return Err("employee id is not a plain identifier".into());
    }
    Ok(root.join(employee_id).join("prefs.json"))
}

fn theme_name(theme: ThemeDto) -> &'static str {
    match theme {
        ThemeDto::Light => "light",
        ThemeDto::Dark => "dark",
        ThemeDto::Auto => "auto",
    }
}

#[derive(Deserialize)]
struct PrefsFile {
    theme: ThemeDto,
}

fn parse_theme(text: &str) -> Option<ThemeDto> {
    serde_json::from_str::<PrefsFile>(text).ok().map(|file| file.theme)
}

/// Copy a worker snapshot and the battery into shell state, when it changed.
pub fn apply_snapshot(state: &AppState, snap: &Snapshot) {
    let volume = snap.volume.map(|volume| VolumeDto {
        level: volume.level,
        muted: volume.muted,
    });
    let network = match snap.network {
        Connectivity::None => NetworkDto::None,
        Connectivity::Local => NetworkDto::Local,
        Connectivity::Internet => NetworkDto::Internet,
    };
    let battery = rulebox_desktop::power::battery().map(|battery| BatteryDto {
        percent: battery.percent,
        charging: battery.charging,
        minutes_left: battery.minutes_left,
    });
    let brightness = snap.brightness;
    let changed = state.read(|shell| {
        shell.system.volume != volume
            || shell.system.network != network
            || shell.system.battery != battery
            || shell.system.brightness != brightness
    });
    if changed {
        state.update(|shell| {
            shell.system.volume = volume;
            shell.system.network = network;
            shell.system.battery = battery;
            shell.system.brightness = brightness;
        });
    }
}

/// Remember `theme` for this session. Signed in: also write the employee's
/// file. A write failure keeps the session choice and posts a notice.
/// Signed out: this is the organization setting the sign-in screen follows.
pub fn set_theme(state: &AppState, theme: ThemeDto) {
    let employee_id = state.read(|shell| match &shell.session {
        crate::model::SessionState::SignedIn { employee, .. } => Some(employee.id.clone()),
        _ => None,
    });
    state.update(|shell| {
        shell.display.theme = theme;
    });
    let Some(employee_id) = employee_id else {
        state.set_org_theme(theme);
        return;
    };
    if let Err(error) = write_theme(&employee_id, theme) {
        tracing::warn!(%error, "could not save the theme");
        state.notify(
            NoticeTone::Warning,
            "Theme was not saved",
            Some("It will apply until you log out.".into()),
        );
    }
}

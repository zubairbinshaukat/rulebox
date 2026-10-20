//! What a web app's page may be given when it asks (plan Step 15, PRD 24.1).
//! Pure: the WebView2 hook maps the raw request to these types and applies the answer.
//! No prompt is ever shown: the app's rules decide, and unknown kinds are refused.

use crate::model::WebPermissions;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionKind {
    Camera,
    Microphone,
    Geolocation,
    Notifications,
    ClipboardRead,
    /// Playing media without a click. Harmless, so it is not a policy item.
    Autoplay,
    /// Sensors, MIDI, local fonts, file handles, window management... and anything newer.
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny,
}

impl PermissionKind {
    /// "Microphone", for a notice such as "Microphone is not allowed for this app."
    pub fn label(self) -> &'static str {
        match self {
            PermissionKind::Camera => "Camera",
            PermissionKind::Microphone => "Microphone",
            PermissionKind::Geolocation => "Location",
            PermissionKind::Notifications => "Notifications",
            PermissionKind::ClipboardRead => "Reading the clipboard",
            PermissionKind::Autoplay => "Autoplay",
            PermissionKind::Other => "That permission",
        }
    }
}

/// `origin_allowed` is whether the asking page's address is on the app's allow-list.
pub fn decide(kind: PermissionKind, permissions: &WebPermissions, origin_allowed: bool) -> Decision {
    if !origin_allowed {
        return Decision::Deny;
    }
    let allowed = match kind {
        PermissionKind::Camera => permissions.camera,
        PermissionKind::Microphone => permissions.microphone,
        PermissionKind::Geolocation => permissions.geolocation,
        PermissionKind::Notifications => permissions.notifications,
        PermissionKind::ClipboardRead => permissions.clipboard_read,
        PermissionKind::Autoplay => true,
        PermissionKind::Other => false,
    };
    if allowed {
        Decision::Allow
    } else {
        Decision::Deny
    }
}

/// A denial worth telling the person about (not the quiet autoplay case).
pub fn denial_notice(kind: PermissionKind) -> String {
    format!("{} is not allowed for this app.", kind.label())
}

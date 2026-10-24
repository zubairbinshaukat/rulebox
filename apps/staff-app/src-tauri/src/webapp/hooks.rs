//! WebView2 settings and events for a web app window (plan Step 15).
//!
//! This is the only place outside `rulebox-desktop` that uses `unsafe`: the
//! raw WebView2 COM interfaces are the only way to see the origin of a
//! permission request, to cancel frame navigations and external protocol
//! launches, and to suspend a minimized page. Each handler delegates to a pure
//! decision in `permissions.rs` / `allow.rs`.
//!
//! A handler that the installed WebView2 runtime is too old for is skipped and
//! logged; the page then simply keeps the engine's default for that one thing.

use std::sync::Arc;

use tauri::{Url, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2PermissionRequestedEventArgs3, ICoreWebView2Settings3,
    ICoreWebView2Settings4, ICoreWebView2_18, ICoreWebView2_24, ICoreWebView2_27, ICoreWebView2_3, COREWEBVIEW2_PERMISSION_KIND,
    COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ, COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
};
use webview2_com::{
    take_pwstr, LaunchingExternalUriSchemeEventHandler, NavigationStartingEventHandler,
    NotificationReceivedEventHandler, PermissionRequestedEventHandler, ScreenCaptureStartingEventHandler,
    TrySuspendCompletedHandler,
};
use windows::core::{Interface, PWSTR};

use super::permissions::{decide, denial_notice, Decision, PermissionKind};
use super::WebWindow;
use crate::model::NoticeTone;
use crate::state::AppState;

/// What every handler of one window needs.
pub struct HookContext {
    pub window: Arc<WebWindow>,
    pub state: AppState,
}

fn kind_of(raw: COREWEBVIEW2_PERMISSION_KIND) -> PermissionKind {
    match raw {
        COREWEBVIEW2_PERMISSION_KIND_CAMERA => PermissionKind::Camera,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => PermissionKind::Microphone,
        COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => PermissionKind::Geolocation,
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => PermissionKind::Notifications,
        COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => PermissionKind::ClipboardRead,
        COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY => PermissionKind::Autoplay,
        _ => PermissionKind::Other,
    }
}

/// Put the hooks on the window's WebView2. The closure runs on the UI thread.
///
/// Fails closed: when the hooks cannot be installed the window is destroyed,
/// because without them the page runs with WebView2's defaults (permission
/// prompts, frames from any host).
///
/// The window is built at `about:blank`. Only after every hook is in place does
/// this same closure send it to `start`, so the first real page is already
/// hardened (no gap between the first navigation and the hooks).
pub fn install(window: &WebviewWindow, context: Arc<HookContext>, start: Url) {
    let label = window.label().to_string();
    let doomed = window.clone();
    let result = window.with_webview(move |platform| {
        // SAFETY: the controller is valid for the duration of this call, and
        // every handler below only holds `Arc`s and clones of COM interfaces.
        let controller = platform.controller();
        let outcome = unsafe { setup(&controller, &context) }
            // SAFETY: as above; `Navigate` is called on the UI thread, which this closure runs on.
            .and_then(|()| unsafe { navigate(&controller, &start) });
        if let Err(error) = outcome {
            tracing::error!(%error, "web app hooks could not be installed; closing the window");
            context.state.notify(
                NoticeTone::Warning,
                "This app could not be secured.",
                Some("Ask your administrator.".into()),
            );
            close_later(doomed);
        }
    });
    if let Err(error) = result {
        tracing::error!(%error, label, "could not reach the web view");
        close_later(window.clone());
    }
}

/// Destroy a window from another thread, so this one (the UI thread, inside
/// `with_webview`) is not waiting on itself.
fn close_later(window: WebviewWindow) {
    std::thread::spawn(move || {
        if let Err(error) = window.destroy() {
            tracing::warn!(%error, "could not close an unsecured web window");
        }
    });
}

/// Pause a page that is not on screen, and wake it again.
pub fn set_suspended(window: &WebviewWindow, suspended: bool) {
    let _ = window.with_webview(move |platform| {
        // SAFETY: as in `install`.
        unsafe {
            let controller = platform.controller();
            let _ = controller.SetIsVisible(!suspended);
            let Ok(core) = controller.CoreWebView2() else {
                return;
            };
            let Ok(core3) = core.cast::<ICoreWebView2_3>() else {
                return;
            };
            if suspended {
                let handler = TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
                let _ = core3.TrySuspend(&handler);
            } else {
                let _ = core3.Resume();
            }
        }
    });
}

/// Send the (hardened) window to its first real address.
unsafe fn navigate(controller: &ICoreWebView2Controller, start: &Url) -> windows::core::Result<()> {
    let target = windows::core::HSTRING::from(start.as_str());
    unsafe { controller.CoreWebView2()?.Navigate(&target) }
}

unsafe fn setup(controller: &ICoreWebView2Controller, context: &Arc<HookContext>) -> windows::core::Result<()> {
    let core: ICoreWebView2 = unsafe { controller.CoreWebView2()? };
    unsafe {
        settings(&core)?;
        permission_requests(&core, context)?;
        frame_navigation(&core, context)?;
    }
    // The newer events need a newer runtime: each one is skipped on its own.
    unsafe {
        if let Err(error) = external_schemes(&core) {
            tracing::warn!(%error, "external protocol launches could not be blocked on this WebView2 runtime");
        }
        if let Err(error) = screen_capture(&core, context) {
            tracing::warn!(%error, "screen capture could not be gated on this WebView2 runtime");
        }
        if let Err(error) = notifications(&core, context) {
            tracing::warn!(%error, "notifications could not be routed on this WebView2 runtime");
        }
    }
    Ok(())
}

/// No developer tools, no browser menus or shortcuts, no autofill, no zoom UI.
unsafe fn settings(core: &ICoreWebView2) -> windows::core::Result<()> {
    unsafe {
        let settings = core.Settings()?;
        settings.SetAreDevToolsEnabled(false)?;
        settings.SetAreDefaultContextMenusEnabled(false)?;
        settings.SetIsStatusBarEnabled(false)?;
        settings.SetIsZoomControlEnabled(false)?;
        if let Ok(more) = settings.cast::<ICoreWebView2Settings3>() {
            more.SetAreBrowserAcceleratorKeysEnabled(false)?;
        }
        if let Ok(more) = settings.cast::<ICoreWebView2Settings4>() {
            more.SetIsPasswordAutosaveEnabled(false)?;
            more.SetIsGeneralAutofillEnabled(false)?;
        }
    }
    Ok(())
}

/// Answer every permission request from the app's rules, with no prompt. The
/// request's own address is what is checked, not the window's.
unsafe fn permission_requests(core: &ICoreWebView2, context: &Arc<HookContext>) -> windows::core::Result<()> {
    let context = Arc::clone(context);
    let mut token = Default::default();
    unsafe {
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut raw = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut raw)?;
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);

                let kind = kind_of(raw);
                let origin_allowed = context.window.allow.allows(&uri);
                let decision = decide(kind, &context.window.permissions, origin_allowed);
                args.SetState(match decision {
                    Decision::Allow => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                    Decision::Deny => COREWEBVIEW2_PERMISSION_STATE_DENY,
                })?;
                // Without this the answer is stored in the profile and the
                // handler is never asked again for that site.
                if let Ok(more) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() {
                    let _ = more.SetSavesInProfile(false);
                }
                tracing::info!(app = %context.window.app_id, ?kind, origin_allowed, ?decision, "web permission request");
                if decision == Decision::Deny && kind != PermissionKind::Autoplay {
                    context.state.note_web_denial(&context.window.app_id);
                    context
                        .state
                        .notify(NoticeTone::Neutral, denial_notice(kind), Some(context.window.app_name.clone()));
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

/// Frames (embedded pages, ads) may only load from allowed hosts. The top
/// level is checked by Tauri's `on_navigation`, which does not see frames.
unsafe fn frame_navigation(core: &ICoreWebView2, context: &Arc<HookContext>) -> windows::core::Result<()> {
    let context = Arc::clone(context);
    let mut token = Default::default();
    unsafe {
        core.add_FrameNavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                // `about:blank` and `data:` frames carry no address of their own to judge.
                let neutral = uri.starts_with("about:") || uri.starts_with("blob:") || uri.starts_with("data:");
                if !neutral && !context.window.allow.allows(&uri) {
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

/// A page may not hand off to another program (`mailto:`, `ms-settings:`...).
unsafe fn external_schemes(core: &ICoreWebView2) -> windows::core::Result<()> {
    let core18: ICoreWebView2_18 = core.cast()?;
    let mut token = Default::default();
    unsafe {
        core18.add_LaunchingExternalUriScheme(
            &LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetCancel(true)?;
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

unsafe fn screen_capture(core: &ICoreWebView2, context: &Arc<HookContext>) -> windows::core::Result<()> {
    let core27: ICoreWebView2_27 = core.cast()?;
    let context = Arc::clone(context);
    let mut token = Default::default();
    unsafe {
        core27.add_ScreenCaptureStarting(
            &ScreenCaptureStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    if !context.window.permissions.screen_share {
                        args.SetCancel(true)?;
                        context.state.note_web_denial(&context.window.app_id);
                        context.state.notify(
                            NoticeTone::Neutral,
                            "Screen sharing is not allowed for this app.",
                            Some(context.window.app_name.clone()),
                        );
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

/// With notifications allowed, a page's notification becomes a Rulebox notice
/// instead of a Windows toast.
unsafe fn notifications(core: &ICoreWebView2, context: &Arc<HookContext>) -> windows::core::Result<()> {
    let core24: ICoreWebView2_24 = core.cast()?;
    let context = Arc::clone(context);
    let mut token = Default::default();
    unsafe {
        core24.add_NotificationReceived(
            &NotificationReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                if !context.window.permissions.notifications {
                    return Ok(());
                }
                let mut title = PWSTR::null();
                args.Notification()?.Title(&mut title)?;
                let title = take_pwstr(title);
                args.SetHandled(true)?;
                let shown: String = title.chars().take(120).collect();
                context
                    .state
                    .notify(NoticeTone::Neutral, shown, Some(context.window.app_name.clone()));
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

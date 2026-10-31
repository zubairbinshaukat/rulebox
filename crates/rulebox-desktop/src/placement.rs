//! Placement maths for the shell windows. Pure: no Win32 calls, so it is
//! unit-tested on any machine. All values are **physical pixels**.

use crate::mode::ShellMode;

/// A rectangle in physical pixels. `right` and `bottom` are exclusive, like a
/// Win32 `RECT`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect {
            left,
            top,
            right,
            bottom,
        }
    }

    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    pub fn center_x(&self) -> i32 {
        self.left + self.width() / 2
    }
}

/// The reserved bottom strip, in logical pixels (60 px bar + 12 + 12 gaps).
pub const TASKBAR_ZONE_LOGICAL: i32 = 84;

/// Gap between a popup and the control that opened it, in logical pixels.
pub const POPUP_GAP_LOGICAL: i32 = 8;

/// A popup's distance from the left and right screen edges, in logical
/// pixels: the taskbar's own inset (`--rb-taskbar-inset`), so they line up.
pub const POPUP_SIDE_LOGICAL: i32 = 12;

/// `logical` device-independent pixels at `scale` (1.0 = 100 %), rounded.
pub fn scale_px(logical: i32, scale: f64) -> i32 {
    (f64::from(logical) * scale).round() as i32
}

/// Height of the taskbar strip in physical pixels.
pub fn taskbar_zone_px(scale: f64) -> i32 {
    scale_px(TASKBAR_ZONE_LOGICAL, scale)
}

/// Shell mode: the strip along the bottom edge of the whole monitor.
pub fn shell_taskbar_rect(monitor: Rect, scale: f64) -> Rect {
    let zone = taskbar_zone_px(scale).min(monitor.height().max(1));
    Rect::new(monitor.left, monitor.bottom - zone, monitor.right, monitor.bottom)
}

/// Dev mode: the strip sits directly above the Windows taskbar, so it lines
/// up with the bottom of the current work area.
pub fn dev_taskbar_rect(work: Rect, scale: f64) -> Rect {
    let zone = taskbar_zone_px(scale).min(work.height().max(1));
    Rect::new(work.left, work.bottom - zone, work.right, work.bottom)
}

/// The taskbar strip for `mode`. `monitor` is the whole monitor, `work` the
/// Windows work area as it is right now.
pub fn taskbar_rect(mode: ShellMode, monitor: Rect, work: Rect, scale: f64) -> Rect {
    match mode {
        ShellMode::Shell => shell_taskbar_rect(monitor, scale),
        ShellMode::Dev => dev_taskbar_rect(work, scale),
    }
}

/// Room above the strip for toast notifications (three cards of up to about
/// 100 px, their gaps and the gap to the strip), in logical pixels. The taskbar window is this much
/// taller than the strip, and only its pills and cards (a window region) take
/// clicks, so the extra height is invisible and click-through.
pub const TOAST_AREA_LOGICAL: i32 = 360;

/// The taskbar **window**: the strip plus the toast area above it, kept inside
/// the usable monitor (shell) or work area (dev). Its bottom edge is the
/// strip's, so the page lays the pills out from the bottom.
pub fn taskbar_window_rect(mode: ShellMode, monitor: Rect, work: Rect, scale: f64) -> Rect {
    let strip = taskbar_rect(mode, monitor, work, scale);
    let top_limit = match mode {
        ShellMode::Shell => monitor.top,
        ShellMode::Dev => work.top,
    };
    let top = (strip.top - scale_px(TOAST_AREA_LOGICAL, scale)).max(top_limit).min(strip.top);
    Rect::new(strip.left, top, strip.right, strip.bottom)
}

/// The strip inside the taskbar window, in the window's own (client) pixels:
/// its bottom `TASKBAR_ZONE_LOGICAL` rows. The region used until the page says
/// where its pills are.
pub fn taskbar_strip_in_window(width: i32, height: i32, scale: f64) -> Rect {
    let zone = taskbar_zone_px(scale).min(height.max(1));
    Rect::new(0, (height - zone).max(0), width.max(1), height.max(1))
}

/// The work area to set in shell mode: the monitor minus the strip.
pub fn work_area_after_reserve(monitor: Rect, reserve_px: i32) -> Rect {
    let reserve = reserve_px.clamp(0, monitor.height().saturating_sub(1).max(0));
    Rect::new(monitor.left, monitor.top, monitor.right, monitor.bottom - reserve)
}

/// The area popups and app windows may use: everything above the strip.
pub fn usable_bounds(mode: ShellMode, monitor: Rect, work: Rect, scale: f64) -> Rect {
    let strip = taskbar_rect(mode, monitor, work, scale);
    let base = match mode {
        ShellMode::Shell => monitor,
        ShellMode::Dev => work,
    };
    Rect::new(base.left, base.top, base.right, strip.top.max(base.top + 1))
}

/// Move `rect` (keeping its size) so it lies inside `bounds`. A rectangle
/// larger than `bounds` is shrunk to fit.
pub fn clamp_into(rect: Rect, bounds: Rect) -> Rect {
    let width = rect.width().min(bounds.width()).max(1);
    let height = rect.height().min(bounds.height()).max(1);
    let left = rect.left.clamp(bounds.left, (bounds.right - width).max(bounds.left));
    let top = rect.top.clamp(bounds.top, (bounds.bottom - height).max(bounds.top));
    Rect::new(left, top, left + width, top + height)
}

/// `size` (width, height) centred in `bounds`, clamped into it (the app switcher).
pub fn centered_rect(size: (i32, i32), bounds: Rect) -> Rect {
    let (width, height) = (size.0.max(1), size.1.max(1));
    let left = bounds.left + (bounds.width() - width) / 2;
    let top = bounds.top + (bounds.height() - height) / 2;
    clamp_into(Rect::new(left, top, left + width, top + height), bounds)
}

/// Where a popup of `size` (width, height) goes.
///
/// With an `anchor` it is centred on the anchor and sits above it; if there
/// is no room above it goes below. Without an anchor it sits in the bottom
/// left corner of `bounds`. The result is always clamped into `bounds`, and
/// keeps `side` from its left and right edges when there is room for that, so
/// it lines up with the taskbar instead of touching the screen edge (where its
/// rounded corners are lost).
pub fn popup_rect(size: (i32, i32), anchor: Option<Rect>, bounds: Rect, gap: i32, side: i32) -> Rect {
    let (width, height) = (size.0.max(1), size.1.max(1));
    let raw = match anchor {
        Some(anchor) => {
            let left = anchor.center_x() - width / 2;
            let mut top = anchor.top - gap - height;
            if top < bounds.top {
                top = anchor.bottom + gap;
            }
            Rect::new(left, top, left + width, top + height)
        }
        None => {
            let left = bounds.left + side;
            let top = bounds.bottom - gap - height;
            Rect::new(left, top, left + width, top + height)
        }
    };
    let inset = if bounds.width() - 2 * side >= width {
        Rect::new(bounds.left + side, bounds.top, bounds.right - side, bounds.bottom)
    } else {
        bounds
    };
    clamp_into(raw, inset)
}

/// Corner radius of the taskbar's pills, in logical pixels (`--rb-r-22`).
pub const TASKBAR_PILL_RADIUS_LOGICAL: i32 = 22;

/// How far the clickable shape of a taskbar pill reaches past the pill, in
/// logical pixels. Zero: anything past the pill's own border would be a strip
/// that shows the window behind as a pale rim (a window region has no
/// anti-aliasing, so a margin cannot fade out). The page draws nothing outside
/// the pills (no outer shadow), so nothing is cut off.
pub const TASKBAR_SHAPE_MARGIN_LOGICAL: i32 = 0;

/// The part of a taskbar window that takes mouse input and is drawn for one
/// pill: `pill` grown by `margin` and kept inside the `width` x `height`
/// client area. `None` when nothing of it is left (empty, or off the window).
pub fn taskbar_shape_rect(pill: Rect, margin: i32, width: i32, height: i32) -> Option<Rect> {
    let grown = Rect::new(
        (pill.left - margin).max(0),
        (pill.top - margin).max(0),
        (pill.right + margin).min(width),
        (pill.bottom + margin).min(height),
    );
    (grown.width() > 0 && grown.height() > 0).then_some(grown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taskbar_shape_grows_a_pill_and_stays_in_the_window() {
        let pill = Rect::new(12, 12, 72, 72);
        assert_eq!(
            taskbar_shape_rect(pill, 2, 1366, 84),
            Some(Rect::new(10, 10, 74, 74))
        );
        // Clamped at the window edges, not pushed outside them.
        assert_eq!(
            taskbar_shape_rect(Rect::new(0, 0, 60, 84), 2, 1366, 84),
            Some(Rect::new(0, 0, 62, 84))
        );
        // Entirely off the window, or empty after clamping: nothing.
        assert_eq!(taskbar_shape_rect(Rect::new(2000, 0, 2100, 60), 2, 1366, 84), None);
        assert_eq!(taskbar_shape_rect(Rect::new(10, 10, 10, 10), 0, 1366, 84), None);
    }

    const M_1366: Rect = Rect::new(0, 0, 1366, 768);
    const M_1920: Rect = Rect::new(0, 0, 1920, 1080);

    #[test]
    fn switcher_is_centred_and_clamped_on_small_screens() {
        assert_eq!(centered_rect((720, 232), M_1920), Rect::new(600, 424, 1320, 656));
        let tight = Rect::new(0, 0, 600, 200);
        assert_eq!(centered_rect((720, 232), tight), Rect::new(0, 0, 600, 200));
    }

    #[test]
    fn zone_scales_with_dpi() {
        assert_eq!(taskbar_zone_px(1.0), 84);
        assert_eq!(taskbar_zone_px(1.25), 105);
        assert_eq!(taskbar_zone_px(1.5), 126);
    }

    #[test]
    fn shell_strip_1366x768_at_100() {
        let strip = shell_taskbar_rect(M_1366, 1.0);
        assert_eq!(strip, Rect::new(0, 684, 1366, 768));
    }

    #[test]
    fn shell_strip_1920x1080_at_125_and_150() {
        assert_eq!(shell_taskbar_rect(M_1920, 1.25), Rect::new(0, 975, 1920, 1080));
        assert_eq!(shell_taskbar_rect(M_1920, 1.5), Rect::new(0, 954, 1920, 1080));
    }

    #[test]
    fn dev_strip_sits_above_the_windows_taskbar() {
        // 1920x1080 @125 %: Windows taskbar of 60 px physical at the bottom.
        let work = Rect::new(0, 0, 1920, 1020);
        assert_eq!(dev_taskbar_rect(work, 1.25), Rect::new(0, 915, 1920, 1020));
    }

    #[test]
    fn taskbar_window_is_the_strip_plus_the_toast_area_above_it() {
        let window = taskbar_window_rect(ShellMode::Shell, M_1366, M_1366, 1.0);
        assert_eq!(window, Rect::new(0, 324, 1366, 768));
        // Same bottom edge as the strip, so the pills do not move.
        assert_eq!(window.bottom, shell_taskbar_rect(M_1366, 1.0).bottom);
        // Scaled like everything else.
        let scaled = taskbar_window_rect(ShellMode::Shell, M_1920, M_1920, 1.5);
        assert_eq!(scaled, Rect::new(0, 1080 - 126 - 540, 1920, 1080));
        // Dev mode stays inside the work area.
        let work = Rect::new(0, 0, 1366, 400);
        assert_eq!(taskbar_window_rect(ShellMode::Dev, M_1366, work, 1.0), Rect::new(0, 0, 1366, 400));
    }

    #[test]
    fn the_strip_is_the_bottom_of_the_taller_window() {
        assert_eq!(taskbar_strip_in_window(1366, 444, 1.0), Rect::new(0, 360, 1366, 444));
        assert_eq!(taskbar_strip_in_window(1920, 666, 1.5), Rect::new(0, 540, 1920, 666));
        // A window shorter than the strip is all strip.
        assert_eq!(taskbar_strip_in_window(800, 40, 1.0), Rect::new(0, 0, 800, 40));
    }

    #[test]
    fn shell_mode_ignores_the_current_work_area() {
        let work = Rect::new(0, 0, 1920, 1020);
        let strip = taskbar_rect(ShellMode::Shell, M_1920, work, 1.0);
        assert_eq!(strip.bottom, 1080);
    }

    #[test]
    fn reserve_leaves_the_rest_of_the_monitor() {
        assert_eq!(work_area_after_reserve(M_1366, 84), Rect::new(0, 0, 1366, 684));
        // A silly reserve never produces an empty work area.
        let silly = work_area_after_reserve(M_1366, 5000);
        assert!(silly.height() >= 1);
        assert_eq!(work_area_after_reserve(M_1366, -4), M_1366);
    }

    #[test]
    fn usable_bounds_end_at_the_strip() {
        let shell = usable_bounds(ShellMode::Shell, M_1366, M_1366, 1.0);
        assert_eq!(shell, Rect::new(0, 0, 1366, 684));
        let work = Rect::new(0, 0, 1366, 728);
        let dev = usable_bounds(ShellMode::Dev, M_1366, work, 1.0);
        assert_eq!(dev, Rect::new(0, 0, 1366, 644));
    }

    #[test]
    fn popup_sits_above_its_anchor() {
        let bounds = Rect::new(0, 0, 1366, 684);
        // An anchor in the middle of the usable area: gap above it is kept.
        let anchor = Rect::new(600, 500, 660, 550);
        let popup = popup_rect((400, 300), Some(anchor), bounds, 8, 12);
        assert_eq!(popup.width(), 400);
        assert_eq!(popup.height(), 300);
        assert_eq!(popup.bottom, 500 - 8);
        assert_eq!(popup.center_x(), anchor.center_x());
    }

    #[test]
    fn popup_opened_from_the_strip_stops_at_the_strip() {
        // The anchor is a taskbar button inside the strip (top = 700 > 684).
        let bounds = Rect::new(0, 0, 1366, 684);
        let anchor = Rect::new(600, 700, 660, 750);
        let popup = popup_rect((400, 300), Some(anchor), bounds, 8, 12);
        assert_eq!(popup.bottom, 684);
        assert_eq!(popup.height(), 300);
    }

    #[test]
    fn popup_is_clamped_at_the_right_edge() {
        let bounds = Rect::new(0, 0, 1366, 684);
        let anchor = Rect::new(1300, 700, 1360, 750);
        let popup = popup_rect((400, 300), Some(anchor), bounds, 8, 12);
        // The gap stays, so the panel keeps its rounded corners.
        assert_eq!(popup.right, 1366 - 12);
        assert_eq!(popup.width(), 400);
    }

    #[test]
    fn popup_is_clamped_at_the_left_edge() {
        let bounds = Rect::new(0, 0, 1366, 684);
        let anchor = Rect::new(0, 700, 40, 750);
        let popup = popup_rect((400, 300), Some(anchor), bounds, 8, 12);
        assert_eq!(popup.left, 12);
    }

    #[test]
    fn a_popup_wider_than_the_room_inside_the_gaps_still_fits() {
        let bounds = Rect::new(0, 0, 410, 684);
        let anchor = Rect::new(380, 700, 400, 750);
        let popup = popup_rect((400, 300), Some(anchor), bounds, 8, 12);
        assert!(popup.left >= 0 && popup.right <= 410);
        assert_eq!(popup.width(), 400);
    }

    #[test]
    fn popup_goes_below_when_there_is_no_room_above() {
        let bounds = Rect::new(0, 0, 1366, 684);
        let anchor = Rect::new(600, 10, 660, 60);
        let popup = popup_rect((400, 300), Some(anchor), bounds, 8, 12);
        assert_eq!(popup.top, 60 + 8);
    }

    #[test]
    fn popup_without_anchor_is_bottom_left() {
        let bounds = Rect::new(0, 0, 1366, 684);
        let popup = popup_rect((400, 300), None, bounds, 8, 12);
        assert_eq!(popup, Rect::new(12, 376, 412, 676));
    }

    #[test]
    fn popup_larger_than_the_area_is_shrunk() {
        let bounds = Rect::new(0, 0, 300, 200);
        let popup = popup_rect((900, 900), None, bounds, 8, 12);
        assert_eq!(popup, Rect::new(0, 0, 300, 200));
    }

    #[test]
    fn popup_on_a_second_monitor_with_negative_origin() {
        let bounds = Rect::new(-1920, 0, 0, 1000);
        let anchor = Rect::new(-1900, 1010, -1840, 1060);
        let popup = popup_rect((400, 300), Some(anchor), bounds, 8, 12);
        assert!(popup.left >= -1920 && popup.right <= 0);
        assert!(popup.bottom <= 1000);
    }
}

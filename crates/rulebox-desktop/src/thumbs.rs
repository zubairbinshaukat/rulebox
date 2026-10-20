//! Live window thumbnails drawn by DWM (plan Step 16, Standard mode only).
//!
//! The destination is the popup's own top-level window: the page leaves an
//! empty rectangle, tells us where it is, and DWM paints the live picture of
//! the source window there. Nothing is captured or copied by us. A minimized
//! or cloaked source, or an error, means the caller shows an icon and a title
//! instead. This works with Explorer running, so it is testable on a dev machine.

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmQueryThumbnailSourceSize, DwmRegisterThumbnail, DwmUnregisterThumbnail, DwmUpdateThumbnailProperties,
    DWM_THUMBNAIL_PROPERTIES, DWM_TNP_OPACITY, DWM_TNP_RECTDESTINATION, DWM_TNP_SOURCECLIENTAREAONLY,
    DWM_TNP_VISIBLE,
};

use crate::error::{DesktopError, Result};
use crate::placement::Rect;

/// A registered thumbnail. Dropping it unregisters it.
pub struct Thumb {
    handle: isize,
}

impl Drop for Thumb {
    fn drop(&mut self) {
        // SAFETY: the handle came from DwmRegisterThumbnail and is released once.
        let _ = unsafe { DwmUnregisterThumbnail(self.handle) };
    }
}

fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut std::ffi::c_void)
}

/// The largest rectangle with the source's shape that fits in `bounds`,
/// centred in it. A degenerate source or box gives `bounds` back.
pub fn fit_rect(source: (i32, i32), bounds: Rect) -> Rect {
    let (sw, sh) = source;
    let (bw, bh) = (bounds.width(), bounds.height());
    if sw <= 0 || sh <= 0 || bw <= 0 || bh <= 0 {
        return bounds;
    }
    // Compare sw/sh with bw/bh without floating point.
    let (w, h) = if i64::from(sw) * i64::from(bh) > i64::from(bw) * i64::from(sh) {
        // Wider than the box: fill the width.
        (bw, ((i64::from(sh) * i64::from(bw)) / i64::from(sw)) as i32)
    } else {
        (((i64::from(sw) * i64::from(bh)) / i64::from(sh)) as i32, bh)
    };
    let (w, h) = (w.max(1), h.max(1));
    let left = bounds.left + (bw - w) / 2;
    let top = bounds.top + (bh - h) / 2;
    Rect::new(left, top, left + w, top + h)
}

/// Show a live thumbnail of `source` inside `bounds` (physical pixels,
/// client coordinates of `dest`). The picture keeps the window's shape.
pub fn show(dest: isize, source: isize, bounds: Rect) -> Result<Thumb> {
    // SAFETY: both handles are windows; DWM validates them and reports an error for a dead one.
    let handle = unsafe { DwmRegisterThumbnail(hwnd(dest), hwnd(source)) }
        .map_err(|error| DesktopError::win32("DwmRegisterThumbnail", &error))?;
    let thumb = Thumb { handle };
    // SAFETY: the thumbnail handle is valid until `thumb` drops.
    let size = unsafe { DwmQueryThumbnailSourceSize(handle) }
        .map_err(|error| DesktopError::win32("DwmQueryThumbnailSourceSize", &error))?;
    let target = fit_rect((size.cx, size.cy), bounds);
    let properties = DWM_THUMBNAIL_PROPERTIES {
        dwFlags: DWM_TNP_RECTDESTINATION | DWM_TNP_VISIBLE | DWM_TNP_OPACITY | DWM_TNP_SOURCECLIENTAREAONLY,
        rcDestination: RECT {
            left: target.left,
            top: target.top,
            right: target.right,
            bottom: target.bottom,
        },
        opacity: 255,
        fVisible: true.into(),
        fSourceClientAreaOnly: true.into(),
        ..Default::default()
    };
    // SAFETY: as above; `properties` outlives the call.
    unsafe { DwmUpdateThumbnailProperties(handle, &properties) }
        .map_err(|error| DesktopError::win32("DwmUpdateThumbnailProperties", &error))?;
    Ok(thumb)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wide_window_fills_the_width_and_is_centred_vertically() {
        let fitted = fit_rect((1920, 1080), Rect::new(0, 0, 272, 196));
        assert_eq!(fitted.width(), 272);
        assert_eq!(fitted.height(), 153);
        assert_eq!(fitted.top, (196 - 153) / 2);
        assert_eq!(fitted.left, 0);
    }

    #[test]
    fn a_tall_window_fills_the_height_and_is_centred_horizontally() {
        let fitted = fit_rect((600, 1200), Rect::new(10, 10, 282, 206));
        assert_eq!(fitted.height(), 196);
        assert_eq!(fitted.width(), 98);
        assert_eq!(fitted.left, 10 + (272 - 98) / 2);
        assert_eq!(fitted.top, 10);
    }

    #[test]
    fn the_shape_is_kept_and_the_box_is_never_exceeded() {
        for source in [(1366, 768), (800, 800), (100, 900), (3840, 2160), (7, 3)] {
            let bounds = Rect::new(5, 7, 5 + 272, 7 + 196);
            let fitted = fit_rect(source, bounds);
            assert!(fitted.left >= bounds.left && fitted.right <= bounds.right, "{source:?}");
            assert!(fitted.top >= bounds.top && fitted.bottom <= bounds.bottom, "{source:?}");
            let source_ratio = f64::from(source.0) / f64::from(source.1);
            let fitted_ratio = f64::from(fitted.width()) / f64::from(fitted.height());
            assert!((source_ratio - fitted_ratio).abs() / source_ratio < 0.05, "{source:?} -> {fitted:?}");
        }
    }

    #[test]
    fn a_zero_sized_source_or_box_returns_the_box() {
        let bounds = Rect::new(0, 0, 100, 100);
        assert_eq!(fit_rect((0, 0), bounds), bounds);
        assert_eq!(fit_rect((100, 100), Rect::new(0, 0, 0, 0)), Rect::new(0, 0, 0, 0));
    }

    #[test]
    fn the_box_at_125_percent_scales_with_the_screen() {
        // The page measures in CSS pixels and sends physical pixels (x devicePixelRatio).
        let css = (272.0_f64, 196.0_f64);
        let ratio = 1.25;
        let bounds = Rect::new(0, 0, (css.0 * ratio).round() as i32, (css.1 * ratio).round() as i32);
        assert_eq!((bounds.width(), bounds.height()), (340, 245));
        let fitted = fit_rect((1920, 1080), bounds);
        assert_eq!(fitted.width(), 340);
        assert_eq!(fitted.height(), 191);
    }
}

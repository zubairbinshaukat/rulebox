//! Window and program icons as PNG bytes (plan Step 7).
//!
//! `icon_png` can wait on another program (`WM_GETICON` has a 1 s timeout),
//! so call both functions from a worker thread, never from the message loop.
//!
//! The pixel work (mask handling, resizing, PNG encoding) is pure and tested
//! without any window.

use std::ffi::c_void;
use std::mem::size_of;
use std::path::Path;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_ICONONLY};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassLongPtrW, GetIconInfo, SendMessageTimeoutW, GCLP_HICON, GCLP_HICONSM, HICON,
    ICONINFO, SMTO_ABORTIFHUNG, WM_GETICON,
};

/// How long to wait for a program to hand over its icon.
const GETICON_TIMEOUT_MS: u32 = 1000;
/// Anything larger is almost certainly not an icon; refuse to allocate it.
const MAX_ICON_SIDE: i32 = 512;

// ---------------------------------------------------------------------------
// Pure pixel functions.
// ---------------------------------------------------------------------------

/// Swap B and R in place-copy: Windows hands out BGRA, PNG wants RGBA.
pub fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bgra.len());
    for pixel in bgra.as_chunks::<4>().0 {
        out.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    out
}

/// Build RGBA from the two bitmaps of an `HICON`, both read as 32-bit BGRA.
///
/// * `color` with real alpha: used as is.
/// * `color` without alpha (alpha is zero everywhere, the legacy case): the
///   AND mask decides which pixels are visible.
/// * no `color` (a monochrome, "mask-only" icon): `mask` holds the AND mask
///   in its top `h` rows and the XOR mask in the bottom `h` rows.
///
/// In a mask a set bit reads back as white, so "black" means "opaque" for
/// the AND mask.
pub fn icon_to_rgba(color: Option<&[u8]>, mask: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pixels = width * height;
    match color {
        Some(color) if color.len() >= pixels * 4 => {
            let has_alpha = color.as_chunks::<4>().0.iter().any(|pixel| pixel[3] != 0);
            let mut rgba = bgra_to_rgba(&color[..pixels * 4]);
            if !has_alpha {
                for (index, pixel) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                    let and_bit_set = mask.get(index * 4).is_none_or(|&byte| byte != 0);
                    pixel[3] = if and_bit_set { 0 } else { 255 };
                }
            }
            rgba
        }
        _ => {
            let mut rgba = vec![0u8; pixels * 4];
            let xor_offset = pixels * 4;
            for index in 0..pixels {
                let and_set = mask.get(index * 4).is_some_and(|&byte| byte != 0);
                let xor_set = mask.get(xor_offset + index * 4).is_some_and(|&byte| byte != 0);
                let (value, alpha) = match (and_set, xor_set) {
                    (true, false) => (0, 0),     // screen shows through
                    (false, false) => (0, 255),  // black
                    (false, true) => (255, 255), // white
                    (true, true) => (0, 255),    // "invert": drawn black
                };
                rgba[index * 4..index * 4 + 4].copy_from_slice(&[value, value, value, alpha]);
            }
            rgba
        }
    }
}

/// Undo premultiplied alpha (what `IShellItemImageFactory` returns).
pub fn unpremultiply(rgba: &mut [u8]) {
    for pixel in rgba.as_chunks_mut::<4>().0 {
        let alpha = u32::from(pixel[3]);
        if alpha == 0 || alpha == 255 {
            continue;
        }
        for channel in &mut pixel[..3] {
            *channel = ((u32::from(*channel) * 255 + alpha / 2) / alpha).min(255) as u8;
        }
    }
}

/// Resize an RGBA image: box average when shrinking, bilinear when growing.
/// Colour is averaged premultiplied so transparent pixels do not bleed.
pub fn resize_rgba(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 || src.len() < sw * sh * 4 {
        return vec![0; dw * dh * 4];
    }
    if sw == dw && sh == dh {
        return src[..sw * sh * 4].to_vec();
    }
    let sample = |x: usize, y: usize| -> [f32; 4] {
        let at = (y.min(sh - 1) * sw + x.min(sw - 1)) * 4;
        let alpha = f32::from(src[at + 3]) / 255.0;
        [
            f32::from(src[at]) * alpha,
            f32::from(src[at + 1]) * alpha,
            f32::from(src[at + 2]) * alpha,
            alpha,
        ]
    };
    let mut out = vec![0u8; dw * dh * 4];
    for dy in 0..dh {
        for dx in 0..dw {
            let mut acc = [0f32; 4];
            if dw <= sw && dh <= sh {
                // Box: every source pixel whose centre falls in this cell.
                let x0 = dx * sw / dw;
                let x1 = ((dx + 1) * sw).div_ceil(dw).max(x0 + 1);
                let y0 = dy * sh / dh;
                let y1 = ((dy + 1) * sh).div_ceil(dh).max(y0 + 1);
                let mut count = 0f32;
                for y in y0..y1 {
                    for x in x0..x1 {
                        let value = sample(x, y);
                        for (slot, part) in acc.iter_mut().zip(value) {
                            *slot += part;
                        }
                        count += 1.0;
                    }
                }
                for slot in &mut acc {
                    *slot /= count;
                }
            } else {
                // Bilinear at the pixel centre.
                let fx = ((dx as f32 + 0.5) * sw as f32 / dw as f32 - 0.5).max(0.0);
                let fy = ((dy as f32 + 0.5) * sh as f32 / dh as f32 - 0.5).max(0.0);
                let (x0, y0) = (fx as usize, fy as usize);
                let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
                let corners = [
                    (sample(x0, y0), (1.0 - tx) * (1.0 - ty)),
                    (sample(x0 + 1, y0), tx * (1.0 - ty)),
                    (sample(x0, y0 + 1), (1.0 - tx) * ty),
                    (sample(x0 + 1, y0 + 1), tx * ty),
                ];
                for (value, weight) in corners {
                    for (slot, part) in acc.iter_mut().zip(value) {
                        *slot += part * weight;
                    }
                }
            }
            let alpha = acc[3];
            let at = (dy * dw + dx) * 4;
            if alpha > 0.0 {
                for channel in 0..3 {
                    out[at + channel] = (acc[channel] / alpha).round().clamp(0.0, 255.0) as u8;
                }
            }
            out[at + 3] = (alpha * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// Encode RGBA pixels as a PNG.
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    if rgba.len() != (width as usize) * (height as usize) * 4 || width == 0 || height == 0 {
        return None;
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(bytes)
}

/// Fit to `size` × `size` (icons are square) and encode.
fn finish(rgba: Vec<u8>, width: usize, height: usize, size: u32) -> Option<Vec<u8>> {
    let side = size.max(1) as usize;
    if width == side && height == side {
        return encode_png(&rgba, side as u32, side as u32);
    }
    let resized = resize_rgba(&rgba, width, height, side, side);
    encode_png(&resized, side as u32, side as u32)
}

// ---------------------------------------------------------------------------
// GDI / shell part.
// ---------------------------------------------------------------------------

/// Deletes a GDI bitmap on drop.
struct Bitmap(HBITMAP);

impl Drop for Bitmap {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // SAFETY: the bitmap is owned by this guard and not selected into
            // any device context.
            let _ = unsafe { DeleteObject(HGDIOBJ(self.0 .0)) };
        }
    }
}

/// Deletes a memory device context on drop.
struct Dc(HDC);

impl Drop for Dc {
    fn drop(&mut self) {
        // SAFETY: created by CreateCompatibleDC and owned here.
        let _ = unsafe { DeleteDC(self.0) };
    }
}

/// Uninitialises COM on drop, when this guard initialised it.
struct Com(bool);

impl Com {
    fn init() -> Com {
        // SAFETY: balanced in Drop. S_FALSE (already initialised) also needs
        // the matching call and `is_ok` covers it; a mode conflict does not.
        Com(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: matches the successful init.
            unsafe { CoUninitialize() };
        }
    }
}

/// Read `rows` rows of a bitmap as top-down 32-bit BGRA.
fn read_bgra(dc: &Dc, bitmap: HBITMAP, width: i32, rows: i32) -> Option<Vec<u8>> {
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative height: top-down rows.
            biHeight: -rows,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buffer = vec![0u8; width as usize * rows as usize * 4];
    // SAFETY: the buffer holds exactly `rows` rows of `width` 32-bit pixels,
    // as the header says; the bitmap is not selected into a DC.
    let copied = unsafe {
        GetDIBits(
            dc.0,
            bitmap,
            0,
            rows as u32,
            Some(buffer.as_mut_ptr() as *mut c_void),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    (copied == rows).then_some(buffer)
}

fn bitmap_size(bitmap: HBITMAP) -> Option<(i32, i32)> {
    let mut object = BITMAP::default();
    // SAFETY: `object` is a BITMAP and the size says so.
    let written = unsafe {
        GetObjectW(
            HGDIOBJ(bitmap.0),
            size_of::<BITMAP>() as i32,
            Some(&mut object as *mut BITMAP as *mut c_void),
        )
    };
    (written != 0 && object.bmWidth > 0 && object.bmHeight > 0)
        .then_some((object.bmWidth, object.bmHeight))
}

/// RGBA pixels and size of an `HICON`.
fn hicon_to_rgba(icon: HICON) -> Option<(Vec<u8>, usize, usize)> {
    let mut info = ICONINFO::default();
    // SAFETY: `info` is a valid out structure; both bitmaps it returns are
    // owned by the guards below.
    unsafe { GetIconInfo(icon, &mut info) }.ok()?;
    let color_bitmap = Bitmap(info.hbmColor);
    let mask_bitmap = Bitmap(info.hbmMask);
    let has_color = !color_bitmap.0.is_invalid();

    let (width, total_rows) = bitmap_size(if has_color {
        color_bitmap.0
    } else {
        mask_bitmap.0
    })?;
    // A monochrome icon stacks its AND and XOR masks in one bitmap.
    let height = if has_color { total_rows } else { total_rows / 2 };
    if width > MAX_ICON_SIDE || height > MAX_ICON_SIDE || height <= 0 {
        return None;
    }

    // SAFETY: a screen-compatible memory DC owned by the guard.
    let dc = Dc(unsafe { CreateCompatibleDC(None) });
    let color = if has_color {
        Some(read_bgra(&dc, color_bitmap.0, width, height)?)
    } else {
        None
    };
    // With a colour bitmap the mask is `height` rows; without one it is both
    // stacked masks.
    let mask_rows = if has_color { height } else { height * 2 };
    let mask = read_bgra(&dc, mask_bitmap.0, width, mask_rows)?;
    let rgba = icon_to_rgba(color.as_deref(), &mask, width as usize, height as usize);
    Some((rgba, width as usize, height as usize))
}

/// The icon a window offers, as a PNG of `size` × `size` pixels. Asks the
/// window (`ICON_SMALL2`, `ICON_SMALL`, `ICON_BIG`, 1 s timeout each), then
/// its class, and finally the program file's own icon.
pub fn icon_png(hwnd: isize, size: u32) -> Option<Vec<u8>> {
    let window = HWND(hwnd as *mut c_void);
    // ICON_SMALL2 = 2, ICON_SMALL = 0, ICON_BIG = 1. For ICON_SMALL2 the
    // lParam is the DPI to size the icon for; 96 is the base.
    for (kind, dpi) in [(2usize, 96isize), (0, 0), (1, 0)] {
        let mut result = 0usize;
        // SAFETY: `result` outlives the call; SMTO_ABORTIFHUNG returns at once
        // for a window that has stopped answering.
        let sent = unsafe {
            SendMessageTimeoutW(
                window,
                WM_GETICON,
                WPARAM(kind),
                LPARAM(dpi),
                SMTO_ABORTIFHUNG,
                GETICON_TIMEOUT_MS,
                Some(&mut result),
            )
        };
        if sent.0 != 0 && result != 0 {
            // The handle belongs to the window; it is read, never destroyed.
            if let Some((rgba, w, h)) = hicon_to_rgba(HICON(result as *mut c_void)) {
                return finish(rgba, w, h, size);
            }
        }
    }
    for index in [GCLP_HICONSM, GCLP_HICON] {
        // SAFETY: handle query only.
        let handle = unsafe { GetClassLongPtrW(window, index) };
        if handle != 0 {
            if let Some((rgba, w, h)) = hicon_to_rgba(HICON(handle as *mut c_void)) {
                return finish(rgba, w, h, size);
            }
        }
    }
    None
}

/// The icon the shell shows for a program file, as a PNG of `size` × `size`.
pub fn exe_icon_png(exe: &Path, size: u32) -> Option<Vec<u8>> {
    shell_item_icon_png(exe.as_os_str(), size)
}

/// The icon of a packaged (Store / UWP) app, from its AppUserModelID. Their
/// windows belong to ApplicationFrameHost and only offer its generic icon.
pub fn app_icon_png(aumid: &str, size: u32) -> Option<Vec<u8>> {
    let name = format!(r"shell:AppsFolder\{aumid}");
    shell_item_icon_png(std::ffi::OsStr::new(&name), size)
}

fn shell_item_icon_png(name: &std::ffi::OsStr, size: u32) -> Option<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;

    let _com = Com::init();
    let wide: Vec<u16> = name.encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is nul-terminated and outlives the call.
    let factory: IShellItemImageFactory =
        unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None::<&IBindCtx>) }.ok()?;
    let side = size.clamp(16, 256) as i32;
    // SAFETY: plain COM call; the bitmap it returns is owned by the guard.
    let bitmap = Bitmap(
        unsafe { factory.GetImage(SIZE { cx: side, cy: side }, SIIGBF_ICONONLY) }.ok()?,
    );
    let (width, height) = bitmap_size(bitmap.0)?;
    if width > MAX_ICON_SIDE || height > MAX_ICON_SIDE {
        return None;
    }
    // SAFETY: as in `hicon_to_rgba`.
    let dc = Dc(unsafe { CreateCompatibleDC(None) });
    let bgra = read_bgra(&dc, bitmap.0, width, height)?;
    let mut rgba = bgra_to_rgba(&bgra);
    unpremultiply(&mut rgba);
    finish(rgba, width as usize, height as usize, size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bgra_becomes_rgba() {
        assert_eq!(bgra_to_rgba(&[1, 2, 3, 4, 10, 20, 30, 40]), [3, 2, 1, 4, 30, 20, 10, 40]);
    }

    #[test]
    fn colour_with_alpha_is_kept() {
        let color = [10, 20, 30, 128];
        let mask = [255, 255, 255, 255];
        assert_eq!(icon_to_rgba(Some(&color), &mask, 1, 1), [30, 20, 10, 128]);
    }

    #[test]
    fn colour_without_alpha_takes_it_from_the_and_mask() {
        // Two pixels, alpha zero in both; the mask hides the second.
        let color = [1, 2, 3, 0, 4, 5, 6, 0];
        let mask = [0, 0, 0, 255, 255, 255, 255, 255];
        let rgba = icon_to_rgba(Some(&color), &mask, 2, 1);
        assert_eq!(rgba, [3, 2, 1, 255, 6, 5, 4, 0]);
    }

    #[test]
    fn a_mask_only_icon_uses_both_stacked_masks() {
        // 2x1 icon: AND row then XOR row (BGRA, 4 bytes a pixel).
        //   pixel 0: and=1 xor=0 -> transparent
        //   pixel 1: and=0 xor=1 -> white
        let and_row = [255, 255, 255, 255, 0, 0, 0, 255];
        let xor_row = [0, 0, 0, 255, 255, 255, 255, 255];
        let mask: Vec<u8> = and_row.iter().chain(xor_row.iter()).copied().collect();
        let rgba = icon_to_rgba(None, &mask, 2, 1);
        assert_eq!(rgba, [0, 0, 0, 0, 255, 255, 255, 255]);
    }

    #[test]
    fn a_mask_only_icon_black_pixel_is_opaque_black() {
        // and=0 xor=0 -> black.
        let mask = [0, 0, 0, 255, 0, 0, 0, 255];
        assert_eq!(icon_to_rgba(None, &mask, 1, 1), [0, 0, 0, 255]);
    }

    #[test]
    fn premultiplied_colour_is_restored() {
        let mut pixel = [64, 32, 0, 128];
        unpremultiply(&mut pixel);
        // 64 / (128 / 255) = 127.5, rounded up.
        assert_eq!(pixel, [128, 64, 0, 128]);
        let mut opaque = [10, 20, 30, 255];
        unpremultiply(&mut opaque);
        assert_eq!(opaque, [10, 20, 30, 255]);
    }

    #[test]
    fn resize_keeps_a_flat_colour() {
        let src: Vec<u8> = std::iter::repeat_n([200u8, 100, 50, 255], 16)
            .flatten()
            .collect();
        for (dw, dh) in [(2, 2), (8, 8), (4, 4)] {
            let out = resize_rgba(&src, 4, 4, dw, dh);
            assert_eq!(out.len(), dw * dh * 4);
            for pixel in out.as_chunks::<4>().0 {
                assert_eq!(pixel, &[200, 100, 50, 255]);
            }
        }
    }

    #[test]
    fn resize_does_not_bleed_transparent_pixels() {
        // Left half opaque red, right half fully transparent "black".
        let mut src = Vec::new();
        for _ in 0..2 {
            src.extend_from_slice(&[255, 0, 0, 255, 0, 0, 0, 0]);
        }
        let out = resize_rgba(&src, 2, 2, 1, 1);
        assert_eq!(out[0], 255);
        assert_eq!(out[1], 0);
        assert_eq!(out[2], 0);
        assert_eq!(out[3], 128);
    }

    #[test]
    fn png_has_the_signature_and_rejects_bad_sizes() {
        let png = encode_png(&[0, 0, 0, 255], 1, 1).expect("png");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert!(encode_png(&[0, 0, 0], 1, 1).is_none());
        assert!(encode_png(&[], 0, 0).is_none());
    }

    #[test]
    fn a_missing_window_gives_no_icon() {
        assert!(icon_png(0, 32).is_none());
    }

    #[test]
    fn an_unknown_packaged_app_has_no_icon() {
        assert!(app_icon_png("Rulebox.DoesNotExist_0000!App", 32).is_none());
    }

    #[test]
    fn a_real_program_has_an_icon() {
        let exe = std::path::Path::new(r"C:\Windows\System32\notepad.exe");
        if exe.exists() {
            let png = exe_icon_png(exe, 32).expect("icon");
            assert_eq!(&png[..4], b"\x89PNG");
        }
    }
}

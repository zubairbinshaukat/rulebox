//! The app's own icon on a web app window (plan 7.10: "Native title bar showing the page
//! title and the app's icon").
//!
//! A web window is a native frame, so its title bar, its Rulebox taskbar button (when the
//! app is not pinned) and its thumbnail all read the **window** icon. The catalogue carries
//! the app's icon as a `data:image/png;base64` URL (a manifest icon or favicon that the
//! dashboard stored); this module turns it into the RGBA a window icon needs, once, when the
//! window is opened. Nothing is drawn per frame and nothing is fetched.

use std::io::Cursor;

use base64::Engine as _;

/// The largest side kept. Windows only ever asks for 16 to 48 px (title bar, taskbar
/// thumbnail), so a big manifest icon is shrunk once instead of being held at full size.
pub const MAX_SIDE: u32 = 64;
const DATA_URL_PNG: &str = "data:image/png;base64,";
/// A PNG larger than this is not decoded (the agent already caps icons at 32 KiB).
const MAX_PNG_BYTES: usize = 192 * 1024;
/// Refuse absurd dimensions before allocating the decode buffer.
const MAX_DECODE_SIDE: u32 = 1024;

/// RGBA8 pixels, row by row.
#[derive(Debug, PartialEq, Eq)]
pub struct Rgba {
    pub pixels: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// Pure: the window icon for a catalogue `icon_url`, or `None` (the window keeps the default
/// icon) when it is not a small, valid PNG data URL.
pub fn window_icon(data_url: &str) -> Option<Rgba> {
    let encoded = data_url.strip_prefix(DATA_URL_PNG)?;
    if encoded.len() > MAX_PNG_BYTES * 4 / 3 + 4 {
        return None;
    }
    let png = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).ok()?;
    let decoded = decode_png(&png)?;
    // A logo in a padded square is cut out and cropped to the logo first, like the shell's small icons
    // (`iconCutout.ts`); anything else is just shrunk.
    Some(crop_to_logo(&decoded, MAX_SIDE).unwrap_or_else(|| shrink(decoded, MAX_SIDE)))
}

/// Share of the output left empty on each side of the logo's longer side (3.5%: the logo spans 93%).
const LOGO_MARGIN: f32 = 0.035;
/// A pixel this far (RGB distance) from the flat background is part of the logo (bounding box).
const LOGO_DISTANCE: f32 = 16.0;
/// Alpha below this is clear; above it a pixel of a transparent icon is part of the logo.
const CLEAR_ALPHA: u8 = 24;
const LOGO_ALPHA: u8 = 48;
/// Keying a flat background out: reach of the flood fill from the border and the start of the soft edge.
const REACH: f32 = 40.0;
const SOFT: f32 = 10.0;
/// Pixels this close to the background are cleared even if the border does not reach them (a letter's hole).
const HOLE_REACH: f32 = 14.0;
const HOLE_SOFT: f32 = 5.0;
/// The working size of the crop before it is shrunk to the window icon size.
const WORK_SIDE: u32 = 128;
/// How the logo is told from the rest of an icon: by its alpha (a logo on clear pixels) or by
/// its distance from one flat background colour (a logo on a flat square).
enum Backdrop {
    Clear,
    Flat([u8; 3]),
}

fn border(image: &Rgba) -> Vec<usize> {
    let (w, h) = (image.width as usize, image.height as usize);
    let mut ring = Vec::with_capacity(2 * (w + h));
    for x in 0..w {
        ring.push(x);
        ring.push((h - 1) * w + x);
    }
    for y in 1..h.saturating_sub(1) {
        ring.push(y * w);
        ring.push(y * w + w - 1);
    }
    ring
}

fn backdrop(image: &Rgba) -> Option<Backdrop> {
    if image.width < 2 || image.height < 2 {
        return None;
    }
    let ring = border(image);
    let alpha = |i: usize| image.pixels[i * 4 + 3];
    let clear = ring.iter().filter(|&&i| alpha(i) <= CLEAR_ALPHA).count();
    if clear * 5 >= ring.len() * 4 {
        return Some(Backdrop::Clear);
    }
    let solid: Vec<usize> = ring.iter().copied().filter(|&i| alpha(i) >= 200).collect();
    if solid.len() * 10 < ring.len() * 3 {
        return None;
    }
    let median = |c: usize| {
        let mut values: Vec<u8> = solid.iter().map(|&i| image.pixels[i * 4 + c]).collect();
        values.sort_unstable();
        values[values.len() / 2]
    };
    let background = [median(0), median(1), median(2)];
    let near = solid.iter().filter(|&&i| distance(&image.pixels[i * 4..i * 4 + 3], background) <= 24.0).count();
    (near * 10 >= solid.len() * 9).then_some(Backdrop::Flat(background))
}

fn distance(pixel: &[u8], background: [u8; 3]) -> f32 {
    let d = |c: usize| f32::from(pixel[c]) - f32::from(background[c]);
    (d(0) * d(0) + d(1) * d(1) + d(2) * d(2)).sqrt()
}

/// The logo's box `(x0, y0, x1, y1)` in pixels (`x1`, `y1` exclusive), or `None` when the icon has
/// no flat or clear backdrop to tell a logo from.
fn logo_box(image: &Rgba) -> Option<(usize, usize, usize, usize)> {
    let backdrop = backdrop(image)?;
    let (w, h) = (image.width as usize, image.height as usize);
    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0, 0);
    for y in 0..h {
        for x in 0..w {
            let at = (y * w + x) * 4;
            let p = &image.pixels[at..at + 4];
            let logo = match backdrop {
                Backdrop::Clear => p[3] >= LOGO_ALPHA,
                Backdrop::Flat(bg) => p[3] >= 128 && distance(p, bg) > LOGO_DISTANCE,
            };
            if logo {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
            }
        }
    }
    (x1 > x0 && y1 > y0).then_some((x0, y0, x1, y1))
}

/// Crop `image` to a square round its logo (plus `LOGO_MARGIN`), take the logo off its flat
/// background (the cut-out keeps its own colours on transparent pixels, never a square of the old
/// background), and shrink it to at most `max_side`, so the logo fills the title-bar and taskbar
/// icon. `None` when the icon has no separable logo (a picture, one flat colour).
fn crop_to_logo(image: &Rgba, max_side: u32) -> Option<Rgba> {
    let (x0, y0, x1, y1) = logo_box(image)?;
    let longest = (x1 - x0).max(y1 - y0) as f32;
    let side = longest / (1.0 - 2.0 * LOGO_MARGIN);
    let cx = (x0 + x1) as f32 / 2.0;
    let cy = (y0 + y1) as f32 / 2.0;
    let work = (side.round() as u32).clamp(16, WORK_SIDE);
    let background = match backdrop(image)? {
        Backdrop::Clear => None,
        Backdrop::Flat(bg) => Some(bg),
    };
    let pad = background.map_or([0, 0, 0, 0], |bg| [bg[0], bg[1], bg[2], 255]);
    let mut crop = resample(image, cx - side / 2.0, cy - side / 2.0, side, work, pad);
    if let Some(bg) = background {
        key_out(&mut crop, bg);
    }
    Some(shrink(crop, max_side))
}

/// Key a flat background out of a square crop whose border is that background. Pixels connected to
/// the border and close to the background become clear with a soft edge (`SOFT`..`REACH`), so a
/// letter's inside or a pale part of the logo is kept. The anti-aliased rim is then matted: its
/// colour becomes the logo's own colour (the strongest nearby pixel) and its alpha the share of
/// that colour in the pixel, so nothing of the old background tints the edge on any surface.
fn key_out(image: &mut Rgba, bg: [u8; 3]) {
    let side = image.width as usize;
    let count = side * side;
    let dist = |px: &[u8], at: usize| distance(&px[at * 4..at * 4 + 3], bg);
    let ramp = |d: f32, soft: f32, reach: f32| (255.0 * ((d - soft) / (reach - soft)).clamp(0.0, 1.0)).round() as u8;

    let mut alpha = vec![255_u8; count];
    let mut seen = vec![false; count];
    let mut queue: Vec<usize> = border(image).into_iter().filter(|&i| image.pixels[i * 4 + 3] < 128 || dist(&image.pixels, i) <= REACH).collect();
    for &i in &queue {
        seen[i] = true;
    }
    let mut head = 0;
    while head < queue.len() {
        let i = queue[head];
        head += 1;
        alpha[i] = if image.pixels[i * 4 + 3] < 128 { 0 } else { ramp(dist(&image.pixels, i), SOFT, REACH) };
        let (x, y) = (i % side, i / side);
        let mut next = [None; 4];
        if x > 0 { next[0] = Some(i - 1); }
        if x + 1 < side { next[1] = Some(i + 1); }
        if y > 0 { next[2] = Some(i - side); }
        if y + 1 < side { next[3] = Some(i + side); }
        for n in next.into_iter().flatten() {
            if !seen[n] && (image.pixels[n * 4 + 3] < 128 || dist(&image.pixels, n) <= REACH) {
                seen[n] = true;
                queue.push(n);
            }
        }
    }
    for i in 0..count {
        if !seen[i] {
            let d = dist(&image.pixels, i);
            if d <= HOLE_REACH {
                alpha[i] = alpha[i].min(ramp(d, HOLE_SOFT, HOLE_REACH));
            }
        }
    }

    // Matte the rim: pixels with a not fully opaque neighbour.
    let src = image.pixels.clone();
    let mut out = vec![0_u8; count * 4];
    for y in 0..side {
        for x in 0..side {
            let i = y * side + x;
            let a = alpha[i];
            if a == 0 {
                continue;
            }
            let at = i * 4;
            let mut colour = [src[at], src[at + 1], src[at + 2]];
            let mut cover = a;
            let mut matted = false;
            let near_edge = (y.saturating_sub(1)..=(y + 1).min(side - 1))
                .any(|ny| (x.saturating_sub(1)..=(x + 1).min(side - 1)).any(|nx| alpha[ny * side + nx] < 255));
            if near_edge {
                // The logo's own colour: the opaque pixel furthest from the background within 3 px.
                let mut best: Option<(f32, usize)> = None;
                for ny in y.saturating_sub(3)..=(y + 3).min(side - 1) {
                    for nx in x.saturating_sub(3)..=(x + 3).min(side - 1) {
                        let n = ny * side + nx;
                        if alpha[n] == 255 {
                            let d = dist(&src, n);
                            if best.is_none_or(|(b, _)| d > b) {
                                best = Some((d, n));
                            }
                        }
                    }
                }
                if let Some((_, n)) = best {
                    let f = [src[n * 4], src[n * 4 + 1], src[n * 4 + 2]];
                    let delta: Vec<f32> = (0..3).map(|c| f32::from(f[c]) - f32::from(bg[c])).collect();
                    let span: f32 = delta.iter().map(|v| v * v).sum();
                    if span >= 40.0 * 40.0 {
                        let rel: Vec<f32> = (0..3).map(|c| f32::from(src[at + c]) - f32::from(bg[c])).collect();
                        let share = (rel.iter().zip(&delta).map(|(r, d)| r * d).sum::<f32>() / span).clamp(0.0, 1.0);
                        let residual: f32 = rel.iter().zip(&delta).map(|(r, d)| (r - share * d).powi(2)).sum::<f32>().sqrt();
                        if residual <= 40.0 {
                            colour = f;
                            cover = (share * 255.0).round() as u8;
                            matted = true;
                        }
                    }
                }
                if !matted && a < 255 {
                    // Not a blend with the logo's colour: lift the logo off the background by alpha.
                    let k = f32::from(a) / 255.0;
                    for c in 0..3 {
                        colour[c] = ((f32::from(src[at + c]) - (1.0 - k) * f32::from(bg[c])) / k).round().clamp(0.0, 255.0) as u8;
                    }
                }
            }
            out[at..at + 3].copy_from_slice(&colour);
            out[at + 3] = cover;
        }
    }
    image.pixels = out;
}
/// The square `(left, top, side)` of `image` resampled to `out` x `out`: every output pixel is the
/// average of `k x k` bilinear samples, weighted by alpha. Outside the image the colour is `pad`.
fn resample(image: &Rgba, left: f32, top: f32, side: f32, out: u32, pad: [u8; 4]) -> Rgba {
    let (w, h) = (image.width as i64, image.height as i64);
    let step = side / out as f32;
    let k = step.ceil().max(1.0) as u32;
    let texel = |x: i64, y: i64| -> [f32; 4] {
        if x < 0 || y < 0 || x >= w || y >= h {
            return pad.map(f32::from);
        }
        let at = (y as usize * w as usize + x as usize) * 4;
        [0, 1, 2, 3].map(|c| f32::from(image.pixels[at + c]))
    };
    let mut pixels = Vec::with_capacity(out as usize * out as usize * 4);
    for oy in 0..out {
        for ox in 0..out {
            let (mut r, mut g, mut b, mut a) = (0.0_f32, 0.0_f32, 0.0_f32, 0.0_f32);
            for sy in 0..k {
                for sx in 0..k {
                    let u = left + (ox as f32 + (sx as f32 + 0.5) / k as f32) * step - 0.5;
                    let v = top + (oy as f32 + (sy as f32 + 0.5) / k as f32) * step - 0.5;
                    let (ix, iy) = (u.floor(), v.floor());
                    let (fx, fy) = (u - ix, v - iy);
                    for n in 0..4_i64 {
                        let (dx, dy) = (n & 1, n >> 1);
                        let weight = (if dx == 1 { fx } else { 1.0 - fx }) * (if dy == 1 { fy } else { 1.0 - fy });
                        let t = texel(ix as i64 + dx, iy as i64 + dy);
                        let alpha = t[3] / 255.0 * weight;
                        r += t[0] * alpha;
                        g += t[1] * alpha;
                        b += t[2] * alpha;
                        a += alpha;
                    }
                }
            }
            if a > 0.0 {
                let samples = (k * k) as f32;
                pixels.extend_from_slice(&[
                    (r / a).round().clamp(0.0, 255.0) as u8,
                    (g / a).round().clamp(0.0, 255.0) as u8,
                    (b / a).round().clamp(0.0, 255.0) as u8,
                    (a / samples * 255.0).round().clamp(0.0, 255.0) as u8,
                ]);
            } else {
                pixels.extend_from_slice(&[0, 0, 0, 0]);
            }
        }
    }
    Rgba { pixels, width: out, height: out }
}

fn decode_png(png: &[u8]) -> Option<Rgba> {
    let mut decoder = png::Decoder::new(Cursor::new(png));
    // Palette, low bit depth and 16-bit images all come out as 8-bit samples.
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().ok()?;
    let info = reader.info();
    let (width, height) = (info.width, info.height);
    if width == 0 || height == 0 || width > MAX_DECODE_SIDE || height > MAX_DECODE_SIDE {
        return None;
    }
    let mut buffer = vec![0; reader.output_buffer_size()?];
    let frame = reader.next_frame(&mut buffer).ok()?;
    let data = &buffer[..frame.buffer_size()];
    if frame.bit_depth != png::BitDepth::Eight {
        return None;
    }
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    match frame.color_type {
        png::ColorType::Rgba => pixels.extend_from_slice(data),
        png::ColorType::Rgb => data.as_chunks::<3>().0.iter().for_each(|p| pixels.extend_from_slice(&[p[0], p[1], p[2], 255])),
        png::ColorType::GrayscaleAlpha => {
            data.as_chunks::<2>().0.iter().for_each(|p| pixels.extend_from_slice(&[p[0], p[0], p[0], p[1]]));
        }
        png::ColorType::Grayscale => data.iter().for_each(|&g| pixels.extend_from_slice(&[g, g, g, 255])),
        png::ColorType::Indexed => return None,
    }
    (pixels.len() == width as usize * height as usize * 4).then_some(Rgba { pixels, width, height })
}

/// Area-average (box) downscale so the longest side is at most `max_side`; a smaller image is
/// returned as it is. Colour is averaged weighted by alpha, so a transparent corner does not
/// bleed a dark fringe into the edge.
fn shrink(image: Rgba, max_side: u32) -> Rgba {
    let longest = image.width.max(image.height);
    if longest <= max_side {
        return image;
    }
    let out_w = (u64::from(image.width) * u64::from(max_side) / u64::from(longest)).max(1) as u32;
    let out_h = (u64::from(image.height) * u64::from(max_side) / u64::from(longest)).max(1) as u32;
    let mut pixels = Vec::with_capacity(out_w as usize * out_h as usize * 4);
    for y in 0..out_h {
        let y0 = (u64::from(y) * u64::from(image.height) / u64::from(out_h)) as u32;
        let y1 = ((u64::from(y + 1) * u64::from(image.height)).div_ceil(u64::from(out_h)) as u32).min(image.height);
        for x in 0..out_w {
            let x0 = (u64::from(x) * u64::from(image.width) / u64::from(out_w)) as u32;
            let x1 = ((u64::from(x + 1) * u64::from(image.width)).div_ceil(u64::from(out_w)) as u32).min(image.width);
            let (mut r, mut g, mut b, mut a, mut n) = (0_u64, 0_u64, 0_u64, 0_u64, 0_u64);
            for sy in y0..y1.max(y0 + 1) {
                for sx in x0..x1.max(x0 + 1) {
                    let at = (sy as usize * image.width as usize + sx as usize) * 4;
                    let alpha = u64::from(image.pixels[at + 3]);
                    r += u64::from(image.pixels[at]) * alpha;
                    g += u64::from(image.pixels[at + 1]) * alpha;
                    b += u64::from(image.pixels[at + 2]) * alpha;
                    a += alpha;
                    n += 1;
                }
            }
            match (r.checked_div(a), g.checked_div(a), b.checked_div(a), a.checked_div(n)) {
                (Some(r), Some(g), Some(b), Some(alpha)) => pixels.extend_from_slice(&[r as u8, g as u8, b as u8, alpha as u8]),
                _ => pixels.extend_from_slice(&[0, 0, 0, 0]),
            }
        }
    }
    Rgba { pixels, width: out_w, height: out_h }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `size` x `size` PNG of one colour.
    fn flat_png(size: u32, color: png::ColorType, pixel: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, size, size);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let data: Vec<u8> = pixel.iter().copied().cycle().take(size as usize * size as usize * pixel.len()).collect();
        writer.write_image_data(&data).unwrap();
        writer.finish().unwrap();
        out
    }

    fn url(png: &[u8]) -> String {
        format!("{DATA_URL_PNG}{}", base64::engine::general_purpose::STANDARD.encode(png))
    }

    #[test]
    fn a_big_icon_is_shrunk_once_to_64_px_keeping_its_colour() {
        let icon = window_icon(&url(&flat_png(180, png::ColorType::Rgb, &[28, 29, 32]))).expect("an icon");
        assert_eq!((icon.width, icon.height), (64, 64));
        assert_eq!(icon.pixels.len(), 64 * 64 * 4);
        assert!(icon.pixels.as_chunks::<4>().0.iter().all(|p| *p == [28, 29, 32, 255]));
    }

    #[test]
    fn a_small_icon_is_kept_as_it_is_and_transparency_survives() {
        let icon = window_icon(&url(&flat_png(32, png::ColorType::Rgba, &[10, 20, 30, 0]))).expect("an icon");
        assert_eq!((icon.width, icon.height), (32, 32));
        assert!(icon.pixels.as_chunks::<4>().0.iter().all(|p| p[3] == 0));
        let grey = window_icon(&url(&flat_png(8, png::ColorType::Grayscale, &[7]))).expect("a grey icon");
        assert_eq!(&grey.pixels[..4], [7, 7, 7, 255]);
    }

    #[test]
    fn the_real_zubyr_icon_is_decoded_to_64_px() {
        // The file the agent fixture embeds (apps/agent/assets/icons/zubyr.png).
        let png = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../agent/assets/icons/zubyr.png"));
        let Ok(png) = png else { return };
        let icon = window_icon(&url(&png)).expect("an icon");
        assert_eq!((icon.width, icon.height), (64, 64));
        // The site's warm paper square is keyed out: the corners are clear, and nothing cream is
        // left (every visible pixel is the near-black Z).
        assert_eq!(icon.pixels[3], 0, "the corner is transparent");
        assert!(icon.pixels.as_chunks::<4>().0.iter().any(|p| p[3] == 255 && p[0] < 60));
        // Over a black surface nothing cream shows: no pale fringe on the Z's edge.
        assert!(icon.pixels.as_chunks::<4>().0.iter().all(|p| u32::from(p[0]) * u32::from(p[3]) / 255 < 60), "no cream in the cut-out");
    }

    fn shipped(name: &str) -> Option<Vec<u8>> {
        std::fs::read(format!("{}/../../agent/assets/icons/{name}.png", env!("CARGO_MANIFEST_DIR"))).ok()
    }

    /// The longest side of the logo's box as a share of the icon's side.
    fn fill(icon: &Rgba) -> f32 {
        let (x0, y0, x1, y1) = logo_box(icon).expect("a logo in the icon");
        (x1 - x0).max(y1 - y0) as f32 / icon.width.max(icon.height) as f32
    }

    #[test]
    fn the_shipped_icons_are_cut_out_and_enlarged_to_fill_the_window_icon() {
        for name in ["zubyr", "batwa", "zahras-pos"] {
            let Some(png) = shipped(name) else { return };
            let original = decode_png(&png).expect("a png");
            let icon = window_icon(&url(&png)).expect("an icon");
            assert_eq!((icon.width, icon.height), (64, 64), "{name}");
            assert!(fill(&icon) >= 0.90, "{name}: the logo spans {:.2} of the icon", fill(&icon));
            assert!(fill(&icon) <= 0.97, "{name}: the logo is not cut off");
            // No square of the old background: the corners are clear.
            for corner in [0, 63, 63 * 64, 63 * 64 + 63] {
                assert_eq!(icon.pixels[corner * 4 + 3], 0, "{name}: corner {corner} is transparent");
            }
            // The padded originals are the reason: the logo was under that before (the Z of
            // Zahras POS already spans the height).
            if name != "zahras-pos" {
                assert!(fill(&original) < 0.85, "{name}: {:.2}", fill(&original));
            }
        }
    }

    #[test]
    fn a_small_logo_in_a_padded_flat_square_is_cropped_and_loses_the_square() {
        // A black disc (radius 10) centred in a 100 px cream square.
        let mut pixels = Vec::new();
        for y in 0..100_u32 {
            for x in 0..100_u32 {
                let inside = (x as i32 - 50).pow(2) + (y as i32 - 50).pow(2) <= 100;
                pixels.extend_from_slice(if inside { &[0, 0, 0, 255] } else { &[242, 240, 230, 255] });
            }
        }
        let icon = crop_to_logo(&Rgba { pixels, width: 100, height: 100 }, 64).expect("cropped");
        assert_eq!((icon.width, icon.height), (23, 23));
        assert_eq!(icon.pixels[3], 0, "the cream square is gone");
        assert!(icon.pixels.as_chunks::<4>().0.iter().all(|p| u32::from(p[0]) * u32::from(p[3]) / 255 < 40), "only the black disc is left");
        assert!(fill(&icon) >= 0.90);
    }

    #[test]
    fn a_flat_square_with_no_logo_and_a_picture_are_left_alone() {
        let full = Rgba { pixels: [0, 0, 0, 255].repeat(40 * 40), width: 40, height: 40 };
        assert!(crop_to_logo(&full, 64).is_none());
        let mut gradient = Vec::new();
        for _y in 0..40_u32 {
            for x in 0..40_u32 {
                gradient.extend_from_slice(&[(x * 6) as u8, 90, 160, 255]);
            }
        }
        assert!(crop_to_logo(&Rgba { pixels: gradient, width: 40, height: 40 }, 64).is_none());
    }

    #[test]
    fn anything_that_is_not_a_small_png_data_url_gives_no_icon() {
        assert_eq!(window_icon("http://rbicon.localhost/app:1"), None);
        assert_eq!(window_icon("data:image/svg+xml;base64,PHN2Zz4="), None);
        assert_eq!(window_icon("data:image/png;base64,@@@"), None);
        assert_eq!(window_icon(&url(b"not a png")), None);
        let huge = format!("{DATA_URL_PNG}{}", "A".repeat(MAX_PNG_BYTES * 2));
        assert_eq!(window_icon(&huge), None);
    }
}

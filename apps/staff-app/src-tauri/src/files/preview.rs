//! Reading files for the viewers (plan Step 12). Everything is capped so a
//! 4 GB laptop never loads a huge file into memory.

use std::io::Read;

use serde::Serialize;
use ts_rs::TS;

use super::saferoot::FileError;

pub const TEXT_LIMIT: usize = 2 * 1024 * 1024;
pub const CSV_ROWS: usize = 5_000;
pub const OFFICE_MAX_BYTES: u64 = 25 * 1024 * 1024;
pub const ZIP_MAX_ENTRIES: usize = 2_000;
pub const ZIP_MAX_UNPACKED: u64 = 200 * 1024 * 1024;
pub const IMAGE_MAX_PIXELS: u64 = 40_000_000;

#[derive(Serialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TextPreview {
    pub text: String,
    pub truncated: bool,
    pub encoding: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvPreview {
    pub rows: Vec<Vec<String>>,
    pub truncated: bool,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
}

/// BOM first, then a guess. Cuts the file at `limit` bytes.
pub fn read_text(file: impl Read, limit: usize) -> Result<TextPreview, FileError> {
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    Ok(decode(&bytes, truncated))
}

fn decode(bytes: &[u8], truncated: bool) -> TextPreview {
    let (encoding, body) = match encoding_rs::Encoding::for_bom(bytes) {
        Some((encoding, bom_len)) => (encoding, &bytes[bom_len..]),
        None => {
            let mut detector = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
            detector.feed(bytes, !truncated);
            (detector.guess(None, chardetng::Utf8Detection::Allow), bytes)
        }
    };
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let capacity = decoder
        .max_utf8_buffer_length(body.len())
        .unwrap_or(body.len() * 3 + 16);
    let mut text = String::with_capacity(capacity);
    // `last = false` while truncated, so a character cut in half at the end is dropped, not shown as �.
    let _ = decoder.decode_to_string(body, &mut text, !truncated);
    TextPreview {
        text,
        truncated,
        encoding: encoding.name().to_string(),
    }
}

/// The first `CSV_ROWS` rows. Ragged and badly quoted rows are kept as they are.
pub fn read_csv(file: impl Read) -> Result<CsvPreview, FileError> {
    let preview = read_text(file, TEXT_LIMIT)?;
    let first_line = preview.text.lines().next().unwrap_or("");
    let delimiter = if first_line.matches(';').count() > first_line.matches(',').count() {
        b';'
    } else {
        b','
    };
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delimiter)
        .from_reader(preview.text.as_bytes());
    let mut rows = Vec::new();
    let mut truncated = preview.truncated;
    for record in reader.records() {
        let Ok(record) = record else { continue };
        if rows.len() >= CSV_ROWS {
            truncated = true;
            break;
        }
        rows.push(record.iter().map(str::to_string).collect());
    }
    Ok(CsvPreview { rows, truncated })
}

/// DOCX / XLSX are zip files. Refuse big ones and zip bombs before any viewer sees them.
pub fn office_precheck(file: std::fs::File) -> Result<(), FileError> {
    if file.metadata()?.len() > OFFICE_MAX_BYTES {
        return Err(FileError::TooLarge);
    }
    check_archive(file, ZIP_MAX_ENTRIES, ZIP_MAX_UNPACKED)
}

/// The zip checks with the limits as parameters. The sizes an archive declares
/// are only a hint (a hostile file can state 1 KB and unpack to gigabytes), so
/// the declared total is a cheap first filter and the real limit is enforced on
/// the bytes that actually come out of the decompressor, through a bounded
/// reader that stops one byte past what is left of the budget.
pub fn check_archive(file: impl Read + std::io::Seek, max_entries: usize, max_unpacked: u64) -> Result<(), FileError> {
    let mut archive = zip::ZipArchive::new(file).map_err(|_| FileError::Damaged)?;
    if archive.len() > max_entries {
        return Err(FileError::TooLarge);
    }
    let mut declared: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(|_| FileError::Damaged)?;
        declared = declared.saturating_add(entry.size());
        if declared > max_unpacked {
            return Err(FileError::TooLarge);
        }
    }
    let mut unpacked: u64 = 0;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|_| FileError::Damaged)?;
        let left = max_unpacked - unpacked;
        let read = drain_bounded(entry, left)?;
        unpacked += read;
    }
    Ok(())
}

/// Read `reader` to its end into nowhere, and fail with `TooLarge` as soon as
/// more than `limit` bytes have come out. Returns the bytes read.
pub fn drain_bounded(reader: impl Read, limit: u64) -> Result<u64, FileError> {
    let read = std::io::copy(&mut reader.take(limit.saturating_add(1)), &mut std::io::sink())
        .map_err(|_| FileError::Damaged)?;
    if read > limit {
        return Err(FileError::TooLarge);
    }
    Ok(read)
}

/// Pixel size from the header alone; over 40 megapixels is `TooLarge`.
pub fn image_info(head: &[u8]) -> Result<ImageInfo, FileError> {
    let (width, height) = dimensions(head).ok_or(FileError::Damaged)?;
    if u64::from(width) * u64::from(height) > IMAGE_MAX_PIXELS {
        return Err(FileError::TooLarge);
    }
    Ok(ImageInfo { width, height })
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le16(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?)))
}

fn le24(bytes: &[u8], at: usize) -> Option<u32> {
    let b = bytes.get(at..at + 3)?;
    Some(u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16)
}

fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some((be32(bytes, 16)?, be32(bytes, 20)?));
    }
    if bytes.starts_with(b"GIF8") {
        return Some((le16(bytes, 6)?, le16(bytes, 8)?));
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12)? == b"WEBP" {
        return match bytes.get(12..16)? {
            b"VP8X" => Some((le24(bytes, 24)? + 1, le24(bytes, 27)? + 1)),
            b"VP8L" => {
                let bits = u32::from_le_bytes(bytes.get(21..25)?.try_into().ok()?);
                Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
            }
            b"VP8 " => Some((le16(bytes, 26)? & 0x3fff, le16(bytes, 28)? & 0x3fff)),
            _ => None,
        };
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        // Walk the JPEG segments to the first "start of frame".
        let mut at = 2;
        while at + 9 < bytes.len() {
            if bytes[at] != 0xff {
                at += 1;
                continue;
            }
            let marker = bytes[at + 1];
            if marker == 0xff {
                at += 1;
                continue;
            }
            if matches!(marker, 0xc0..=0xcf) && !matches!(marker, 0xc4 | 0xc8 | 0xcc) {
                let height = u32::from(u16::from_be_bytes([bytes[at + 5], bytes[at + 6]]));
                let width = u32::from(u16::from_be_bytes([bytes[at + 7], bytes[at + 8]]));
                return Some((width, height));
            }
            let length = usize::from(u16::from_be_bytes([bytes[at + 2], bytes[at + 3]]));
            at += 2 + length.max(2);
        }
    }
    None
}

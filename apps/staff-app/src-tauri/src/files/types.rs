//! What a file may be opened with (pure). The deny-list comes first and
//! nothing, not even `fileHandlers`, can override it (PRD 7.3).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::saferoot::FileError;

/// A kind of file the Files sidebar and the desktop's My files panel group by.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FileKind {
    All,
    Documents,
    Audio,
    Video,
    Images,
    /// Audio, video and images together.
    Media,
}

const DOCUMENT_EXTS: &[&str] = &[
    "csv", "doc", "docx", "md", "odp", "ods", "odt", "pdf", "ppt", "pptx", "rtf", "txt", "xls", "xlsx",
];
const AUDIO_EXTS: &[&str] = &["aac", "flac", "m4a", "mp3", "ogg", "wav"];
const VIDEO_EXTS: &[&str] = &["avi", "mkv", "mov", "mp4", "webm"];
const IMAGE_EXTS: &[&str] = &["bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"];

impl FileKind {
    /// Pure: does a file called `name` belong to this kind (by its extension)?
    pub fn matches(self, name: &str) -> bool {
        let ext = match name.rsplit_once('.') {
            Some((stem, ext)) if !stem.is_empty() => ext.to_ascii_lowercase(),
            _ => String::new(),
        };
        let has = |list: &[&str]| list.contains(&ext.as_str());
        match self {
            FileKind::All => true,
            FileKind::Documents => has(DOCUMENT_EXTS),
            FileKind::Audio => has(AUDIO_EXTS),
            FileKind::Video => has(VIDEO_EXTS),
            FileKind::Images => has(IMAGE_EXTS),
            FileKind::Media => has(AUDIO_EXTS) || has(VIDEO_EXTS) || has(IMAGE_EXTS),
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ViewerKind {
    Image,
    Media,
    Pdf,
    Text,
    Csv,
    Docx,
    Xlsx,
}

impl ViewerKind {
    pub fn name(self) -> &'static str {
        match self {
            ViewerKind::Image => "image",
            ViewerKind::Media => "media",
            ViewerKind::Pdf => "pdf",
            ViewerKind::Text => "text",
            ViewerKind::Csv => "csv",
            ViewerKind::Docx => "docx",
            ViewerKind::Xlsx => "xlsx",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Opener {
    Viewer(ViewerKind),
    Handler { app_id: String },
    None,
    Blocked,
}

/// Outlook's blocked-attachment list plus additions (macro-enabled Office
/// files, disk images, scripting hosts). Sorted, lower-case, no duplicates;
/// a test keeps it that way.
pub const DENY: &[&str] = &[
    "ade", "adp", "app", "appinstaller", "application", "appref-ms", "appx", "appxbundle",
    "asp", "bas", "bat", "cab", "cer", "chm", "cmd", "cnt", "com", "cpl", "crt", "csh", "der",
    "diagcab", "dll", "dmg", "docm", "dotm", "drv", "exe", "fxp", "gadget", "grp", "hlp", "hpj",
    "hta", "htm", "html", "img", "inf", "ins", "iso", "isp", "its", "jar", "jnlp", "job", "js",
    "jse", "ksh", "library-ms", "lnk", "mad", "maf", "mag", "mam", "maq", "mar", "mas", "mat",
    "mau", "mav", "maw", "mcf", "mda", "mdb", "mde", "mdt", "mdw", "mdz", "mht", "mhtml", "msc",
    "msh", "msh1", "msh1xml", "msh2", "msh2xml", "mshxml", "msi", "msix", "msixbundle", "msp",
    "mst", "ocx", "ops", "osd", "pcd", "pif", "pl", "plg", "potm", "ppam", "pptm", "prf", "prg",
    "printerexport", "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "psd1", "psm1", "pst",
    "py", "pyc", "pyw", "pyz", "pyzw", "rb", "rdp", "reg", "scf", "scr", "sct", "search-ms",
    "settingcontent-ms", "sh", "shb", "shs", "sldm", "svg", "sys", "theme", "tmp", "url", "vb",
    "vbe", "vbp", "vbs", "vbscript", "vhd", "vhdx", "vsmacros", "vss", "vst", "vsw", "wll",
    "ws", "wsc", "wsf", "wsh", "xbap", "xlam", "xll", "xlsm", "xltm", "xml", "xnk",
];

/// The last extension, lower-cased, after trimming dots and spaces.
pub fn extension(name: &str) -> Option<String> {
    let trimmed = name.trim_matches(|c| c == '.' || c == ' ');
    let (_, ext) = trimmed.rsplit_once('.')?;
    let ext = ext.trim_matches(|c| c == '.' || c == ' ').to_lowercase();
    (!ext.is_empty()).then_some(ext)
}

fn viewer_for(ext: &str) -> Option<ViewerKind> {
    Some(match ext {
        "jpg" | "jpeg" | "png" | "gif" | "webp" => ViewerKind::Image,
        "mp3" | "wav" | "m4a" | "aac" | "ogg" | "mp4" | "webm" => ViewerKind::Media,
        "pdf" => ViewerKind::Pdf,
        "txt" => ViewerKind::Text,
        "csv" => ViewerKind::Csv,
        "docx" => ViewerKind::Docx,
        "xlsx" => ViewerKind::Xlsx,
        _ => return None,
    })
}

/// The built-in viewer for a file name, by its last extension.
pub fn viewer_for_name(name: &str) -> Option<ViewerKind> {
    viewer_for(&extension(name)?)
}

/// Order: (1) deny-list, (2) built-in viewer, (3) `fileHandlers`, (4) none.
pub fn opener_for(name: &str, handlers: &BTreeMap<String, String>) -> Opener {
    let Some(ext) = extension(name) else {
        return Opener::None;
    };
    if DENY.binary_search(&ext.as_str()).is_ok() {
        return Opener::Blocked;
    }
    if let Some(kind) = viewer_for(&ext) {
        return Opener::Viewer(kind);
    }
    let key = format!(".{ext}");
    handlers
        .iter()
        .find(|(candidate, _)| candidate.to_lowercase() == key)
        .map_or(Opener::None, |(_, app_id)| Opener::Handler {
            app_id: app_id.clone(),
        })
}

/// The `Content-Type` of every format the protocol may serve. Anything not in
/// the table is refused. Never HTML, never SVG.
pub fn content_type(name: &str) -> Option<&'static str> {
    Some(match extension(name)?.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "txt" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => return None,
    })
}

const OLE_MAGIC: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const LNK_MAGIC: [u8; 8] = [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0x00];

/// Looks at the first bytes (8 KB is plenty). Refuses an executable, an
/// installer or a shortcut whatever the extension says, and a `.pdf` that is
/// not a PDF. The viewer formats are never OLE containers (that is how an
/// `.msi` hides), so an OLE header on one of them is refused too.
pub fn check_content(name: &str, head: &[u8]) -> Result<(), FileError> {
    let head = &head[..head.len().min(8192)];
    if head.starts_with(b"MZ") || head.starts_with(&LNK_MAGIC) || head.starts_with(b"\x7fELF") {
        return Err(FileError::BlockedType);
    }
    if let Some(kind) = infer::get(head) {
        let mime = kind.mime_type();
        if mime.contains("executable")
            || mime.contains("msdownload")
            || mime.contains("portable-executable")
            || mime.contains("mach-binary")
            || mime.contains("x-msi")
            || mime.contains("x-ms-shortcut")
        {
            return Err(FileError::BlockedType);
        }
    }
    let ext = extension(name).unwrap_or_default();
    if viewer_for(&ext).is_some() && head.starts_with(&OLE_MAGIC) {
        return Err(FileError::BlockedType);
    }
    if ext == "pdf" && !head.starts_with(b"%PDF-") {
        return Err(FileError::BlockedType);
    }
    Ok(())
}

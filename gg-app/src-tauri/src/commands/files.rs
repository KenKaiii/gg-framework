//! File/URL commands: dropped paths, attachments, opening paths, images and URLs.

use crate::*;

#[tauri::command]
pub(crate) fn dropped_path_info(paths: Vec<String>) -> Vec<DroppedPathInfo> {
    paths
        .into_iter()
        .map(|path| {
            let is_dir = std::fs::metadata(&path)
                .map(|m| m.is_dir())
                .unwrap_or(false);
            DroppedPathInfo { path, is_dir }
        })
        .collect()
}

/// Cap on a single dropped file's size for base64 attachment — large drops
/// (e.g. multi-GB video) would blow up the base64 payload and the IPC/agent
/// prompt pipeline; point the user at the file path instead via the error.
pub(crate) const MAX_DROPPED_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// Guess a media type from the file extension. Covers the kinds the chat
/// input already accepts (image/video via the attach button, everything else
/// falls back to a generic binary type like a browser's File.type would for
/// an unrecognized extension).
pub(crate) fn guess_media_type(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// A native drag-drop only gives us absolute paths (no browser File object),
/// so a regular file dropped on the window (as opposed to a folder, handled
/// separately by inserting its path into the draft) is read here and handed
/// back as base64 — the same shape `fileToPending` builds for a pasted/picked
/// file — so it attaches identically regardless of how it entered the input.
#[tauri::command]
pub(crate) fn read_dropped_file_attachment(path: String) -> Result<serde_json::Value, String> {
    let p = Path::new(&path);
    let metadata = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if metadata.len() > MAX_DROPPED_FILE_BYTES {
        return Err(format!(
            "{} is too large to attach ({} MB, limit {} MB)",
            path,
            metadata.len() / (1024 * 1024),
            MAX_DROPPED_FILE_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let media_type = guess_media_type(p);
    Ok(serde_json::json!({ "name": name, "mediaType": media_type, "data": data }))
}

pub(crate) fn strip_file_location_suffix(path: &str) -> &str {
    let mut end = path.len();
    for _ in 0..2 {
        let Some(colon) = path[..end].rfind(':') else {
            break;
        };
        let suffix = &path[colon + 1..end];
        if suffix.is_empty() || !suffix.chars().all(|c| c.is_ascii_digit()) {
            break;
        }
        let last_sep = path[..colon].rfind(['/', '\\']).unwrap_or(0);
        if colon <= last_sep {
            break;
        }
        end = colon;
    }
    &path[..end]
}

/// Open a project file linked from the chat. Relative paths resolve against this
/// window's sidecar cwd; `:line[:col]` and `#Lline` decorations are tolerated.
#[tauri::command]
pub(crate) fn open_project_path(webview: WebviewWindow, path: String) -> Result<(), String> {
    let cwd = cwd_for(&webview).ok_or("sidecar not ready")?;
    let canonical = resolve_chat_path(&cwd, &path)?;
    open_with_default(&canonical.to_string_lossy())
}

/// Resolve a file path written in the chat (`src/a.ts:12`, `/abs/x.png`,
/// `file://…#L3`) to a canonical, existing path. Relative paths join `cwd`.
pub(crate) fn resolve_chat_path(cwd: &Path, path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".into());
    }
    if trimmed.contains("://") && !trimmed.starts_with("file://") {
        return Err("not a file path".into());
    }

    let without_file_scheme = trimmed.strip_prefix("file://").unwrap_or(trimmed);
    let without_anchor = without_file_scheme
        .split_once("#L")
        .map(|(p, _)| p)
        .unwrap_or(without_file_scheme);
    let without_query = without_anchor
        .split_once('?')
        .map(|(p, _)| p)
        .unwrap_or(without_anchor);
    let cleaned = strip_file_location_suffix(without_query);
    let candidate = PathBuf::from(cleaned);
    let resolved = if candidate.is_absolute() {
        candidate
    } else {
        cwd.join(candidate)
    };
    Ok(strip_extended_prefix(
        resolved
            .canonicalize()
            .map_err(|_| format!("file not found: {}", cleaned))?,
    ))
}

/// Cap for an image shown inline in a reply; it travels to the webview as base64.
pub(crate) const MAX_CHAT_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

/// Media type from the file's leading bytes. Only raster formats the webview
/// can show in an `<img>`; SVG is left out (it is a document, not pixels).
pub(crate) fn sniff_image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

/// Read a local image referenced by a reply (`![](/tmp/shot.png)`) so the chat
/// can show it: the webview can't load disk paths itself. Only real image
/// files (checked by content, not just name) under the size cap are returned.
#[tauri::command]
pub(crate) fn read_chat_image(
    webview: WebviewWindow,
    path: String,
) -> Result<serde_json::Value, String> {
    let cwd = cwd_for(&webview).ok_or("sidecar not ready")?;
    let file = resolve_chat_path(&cwd, &path)?;
    let metadata = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if metadata.len() > MAX_CHAT_IMAGE_BYTES {
        return Err(format!("image too large to show: {path}"));
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let media_type = sniff_image_type(&bytes).ok_or_else(|| format!("not an image: {path}"))?;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(serde_json::json!({ "mediaType": media_type, "data": data }))
}

/// Image types `open_image_data` will write, mapped to the extension it uses.
/// The extension comes from this fixed list (never from the caller), so the
/// webview cannot drop an executable or script into the temp folder.
pub(crate) fn image_extension_for(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        _ => None,
    }
}

/// Temp file for a chat image that has no file of its own. Named by a hash of
/// the bytes so clicking the same image again reuses one file.
pub(crate) fn image_temp_path(dir: &Path, extension: &str, bytes: &[u8]) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    dir.join(format!("image-{:016x}.{}", hasher.finish(), extension))
}

/// Open a pasted/attached chat image in the default image viewer. These images
/// live only in memory (base64), so write a copy into the app's per-user cache
/// folder (not the shared system temp dir) and open that.
#[tauri::command]
pub(crate) fn open_image_data(
    webview: WebviewWindow,
    media_type: String,
    data: String,
) -> Result<(), String> {
    let extension =
        image_extension_for(&media_type).ok_or_else(|| format!("not an image: {media_type}"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("invalid image data: {e}"))?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_DROPPED_FILE_BYTES {
        return Err("image is empty or too large to open".into());
    }
    let dir = webview
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("chat-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = image_temp_path(&dir, extension, &bytes);
    if !file.is_file() {
        std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
    }
    open_with_default(&file.to_string_lossy())
}

/// The bytes of a chat image and the name it was shown with: a file the chat
/// links to (`path`), or an in-memory image with no file of its own (`data`).
pub(crate) fn chat_image_bytes(
    cwd: Option<&Path>,
    path: Option<&str>,
    media_type: Option<&str>,
    data: Option<&str>,
) -> Result<(Vec<u8>, Option<String>), String> {
    let (bytes, name) = if let Some(path) = path {
        let file = resolve_chat_path(cwd.ok_or("sidecar not ready")?, path)?;
        let metadata = std::fs::metadata(&file).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.len() > MAX_DROPPED_FILE_BYTES {
            return Err(format!("not a file that can be saved: {path}"));
        }
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned());
        (std::fs::read(&file).map_err(|e| e.to_string())?, name)
    } else {
        let media_type = media_type.ok_or("no image to save")?;
        image_extension_for(media_type).ok_or_else(|| format!("not an image: {media_type}"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.ok_or("no image to save")?.as_bytes())
            .map_err(|e| format!("invalid image data: {e}"))?;
        if bytes.len() as u64 > MAX_DROPPED_FILE_BYTES {
            return Err("image is too large to save".into());
        }
        (bytes, None)
    };
    // Checked by content, so this only ever writes images.
    sniff_image_type(&bytes).ok_or("not an image")?;
    Ok((bytes, name))
}

/// The name the save dialog suggests: the image's own name when its extension
/// matches what the bytes are, else `image` with the right extension.
pub(crate) fn suggested_image_name(name: Option<&str>, extension: &str) -> String {
    let Some(name) = name.filter(|n| !n.trim().is_empty()) else {
        return format!("image.{extension}");
    };
    let path = Path::new(name);
    let current = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let matches = match current.as_deref() {
        Some("jpeg") => extension == "jpg",
        Some(other) => other == extension,
        None => false,
    };
    if matches {
        return name.to_string();
    }
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("image");
    format!("{stem}.{extension}")
}

/// Extensions the save dialog's filter accepts for an image of this type.
pub(crate) fn image_filter_extensions(extension: &str) -> &[&str] {
    match extension {
        "jpg" => &["jpg", "jpeg"],
        "png" => &["png"],
        "gif" => &["gif"],
        "webp" => &["webp"],
        "bmp" => &["bmp"],
        _ => &[],
    }
}

/// Some dialogs (GTK, or a name typed without one on Windows) return a path
/// with no extension; give it the image's own so it opens as a picture.
pub(crate) fn with_image_extension(path: PathBuf, extension: &str) -> PathBuf {
    if path.extension().is_some() {
        path
    } else {
        path.with_extension(extension)
    }
}

/// Save a chat image wherever the user picks. The native save dialog opens
/// here rather than in the webview, so only a place the user chose is written.
/// Returns the saved path, or None when the dialog was cancelled.
#[tauri::command]
pub(crate) async fn save_chat_image(
    webview: WebviewWindow,
    path: Option<String>,
    media_type: Option<String>,
    data: Option<String>,
    directory: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let cwd = cwd_for(&webview);
    let (bytes, name) = chat_image_bytes(
        cwd.as_deref(),
        path.as_deref(),
        media_type.as_deref(),
        data.as_deref(),
    )?;
    let extension = sniff_image_type(&bytes)
        .and_then(image_extension_for)
        .ok_or("not an image")?;
    let mut dialog = webview
        .dialog()
        .file()
        .set_title("Save image")
        .set_file_name(suggested_image_name(name.as_deref(), extension))
        .add_filter("Image", image_filter_extensions(extension))
        .set_can_create_directories(true)
        .set_parent(&webview);
    if let Some(dir) = directory.filter(|d| Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    // The blocking dialog must not run on the main thread.
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let target = with_image_extension(picked.into_path().map_err(|e| e.to_string())?, extension);
    // The webview's toast adds "Could not save image:" in front.
    std::fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// What the in-app preview can show, decided from the file's name and content.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum PreviewKind {
    Markdown,
    Image,
    Pdf,
    Video,
}

impl PreviewKind {
    fn as_str(self) -> &'static str {
        match self {
            PreviewKind::Markdown => "markdown",
            PreviewKind::Image => "image",
            PreviewKind::Pdf => "pdf",
            PreviewKind::Video => "video",
        }
    }

    /// Size cap per kind: bytes travel to the webview as base64 over IPC, so
    /// video and PDF stay smaller than the 100 MB attachment cap.
    fn max_bytes(self) -> u64 {
        match self {
            PreviewKind::Markdown => 5 * 1024 * 1024,
            PreviewKind::Image => MAX_CHAT_IMAGE_BYTES,
            PreviewKind::Pdf => 50 * 1024 * 1024,
            PreviewKind::Video => 80 * 1024 * 1024,
        }
    }
}

/// Kind and media type from the extension alone. Content is checked after
/// reading (`preview_media_type`), so a renamed file is refused, not shown.
pub(crate) fn preview_kind_for(path: &Path) -> Option<(PreviewKind, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "md" | "markdown" | "mdx" => (PreviewKind::Markdown, "text/markdown"),
        "png" => (PreviewKind::Image, "image/png"),
        "jpg" | "jpeg" => (PreviewKind::Image, "image/jpeg"),
        "gif" => (PreviewKind::Image, "image/gif"),
        "webp" => (PreviewKind::Image, "image/webp"),
        "bmp" => (PreviewKind::Image, "image/bmp"),
        "svg" => (PreviewKind::Image, "image/svg+xml"),
        "pdf" => (PreviewKind::Pdf, "application/pdf"),
        "mp4" | "m4v" => (PreviewKind::Video, "video/mp4"),
        "mov" => (PreviewKind::Video, "video/quicktime"),
        "webm" => (PreviewKind::Video, "video/webm"),
        _ => return None,
    })
}

/// Confirm the bytes match the kind the extension claimed; returns the media
/// type to hand the webview.
pub(crate) fn preview_media_type(
    kind: PreviewKind,
    by_extension: &'static str,
    bytes: &[u8],
) -> Result<&'static str, String> {
    match kind {
        PreviewKind::Markdown => std::str::from_utf8(bytes)
            .map(|_| by_extension)
            .map_err(|_| "not a UTF-8 text file".to_string()),
        PreviewKind::Image if by_extension == "image/svg+xml" => {
            let head =
                String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).to_ascii_lowercase();
            if head.contains("<svg") {
                Ok(by_extension)
            } else {
                Err("not an SVG image".into())
            }
        }
        PreviewKind::Image => sniff_image_type(bytes).ok_or_else(|| "not an image".to_string()),
        PreviewKind::Pdf => {
            if bytes.starts_with(b"%PDF-") {
                Ok(by_extension)
            } else {
                Err("not a PDF".into())
            }
        }
        PreviewKind::Video => {
            let is_mp4 = bytes.len() >= 12 && &bytes[4..8] == b"ftyp";
            let is_webm = bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]);
            if is_mp4 || is_webm {
                Ok(by_extension)
            } else {
                Err("not a video the viewer can play".into())
            }
        }
    }
}

/// Read a generated document (Markdown, image, PDF, video) for the in-app
/// preview. Resolves the path like other chat links, refuses anything that is
/// not a regular file of a known kind whose content matches, and caps the size.
/// Text is returned as `text`; everything else as base64 `data`.
#[tauri::command]
pub(crate) fn read_preview_file(
    webview: WebviewWindow,
    path: String,
) -> Result<serde_json::Value, String> {
    let cwd = cwd_for(&webview).ok_or("sidecar not ready")?;
    let file = resolve_chat_path(&cwd, &path)?;
    let (kind, by_extension) =
        preview_kind_for(&file).ok_or_else(|| format!("no preview for this file type: {path}"))?;
    let metadata = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if metadata.len() > kind.max_bytes() {
        return Err(format!(
            "too large to preview ({} MB): {path}",
            metadata.len() / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    let media_type = preview_media_type(kind, by_extension, &bytes)?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let path_text = file.to_string_lossy().into_owned();
    if kind == PreviewKind::Markdown {
        let text = String::from_utf8(bytes).map_err(|_| "not a UTF-8 text file".to_string())?;
        return Ok(serde_json::json!({
            "kind": kind.as_str(), "mediaType": media_type, "name": name, "path": path_text, "text": text
        }));
    }
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(serde_json::json!({
        "kind": kind.as_str(), "mediaType": media_type, "name": name, "path": path_text, "data": data
    }))
}

/// Open a web/mail/phone link in the user's default app (chat links, title-bar
/// GitHub links, OAuth pages). Scheme-validated so the webview can't turn this
/// into a local-file opener.
#[tauri::command]
pub(crate) fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !is_openable_url(trimmed) {
        return Err("only http(s), mailto: and tel: links can be opened".into());
    }
    open_with_default(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_kinds_come_from_the_extension() {
        assert_eq!(
            preview_kind_for(Path::new("a/Report.MD")).map(|k| k.0),
            Some(PreviewKind::Markdown)
        );
        assert_eq!(
            preview_kind_for(Path::new("x.pdf")).map(|k| k.0),
            Some(PreviewKind::Pdf)
        );
        assert_eq!(
            preview_kind_for(Path::new("x.mov")).map(|k| k.0),
            Some(PreviewKind::Video)
        );
        assert_eq!(
            preview_kind_for(Path::new("x.svg")).map(|k| k.0),
            Some(PreviewKind::Image)
        );
        assert_eq!(preview_kind_for(Path::new("x.sh")), None);
        assert_eq!(preview_kind_for(Path::new("noext")), None);
    }

    #[test]
    fn preview_refuses_content_that_does_not_match_the_extension() {
        assert!(preview_media_type(PreviewKind::Pdf, "application/pdf", b"%PDF-1.7 x").is_ok());
        assert!(preview_media_type(PreviewKind::Pdf, "application/pdf", b"<html>").is_err());
        assert!(
            preview_media_type(PreviewKind::Image, "image/png", b"\x89PNG\r\n\x1a\nrest").is_ok()
        );
        assert!(preview_media_type(PreviewKind::Image, "image/png", b"hello").is_err());
        assert!(
            preview_media_type(PreviewKind::Image, "image/svg+xml", b"<?xml?><svg></svg>").is_ok()
        );
        assert!(preview_media_type(PreviewKind::Image, "image/svg+xml", b"<html></html>").is_err());
        assert!(preview_media_type(PreviewKind::Video, "video/mp4", b"\0\0\0\x18ftypmp42").is_ok());
        assert!(
            preview_media_type(PreviewKind::Video, "video/mp4", b"not a video at all").is_err()
        );
        assert!(preview_media_type(PreviewKind::Markdown, "text/markdown", b"# hi").is_ok());
        assert!(
            preview_media_type(PreviewKind::Markdown, "text/markdown", &[0xFF, 0xFE, 0x00])
                .is_err()
        );
    }

    #[test]
    fn open_image_data_only_writes_known_image_extensions() {
        assert_eq!(image_extension_for("image/png"), Some("png"));
        assert_eq!(image_extension_for("image/jpeg"), Some("jpg"));
        assert_eq!(image_extension_for("application/x-sh"), None);
        assert_eq!(image_extension_for("image/svg+xml"), None);
    }

    #[test]
    fn saved_images_keep_their_name_with_the_right_extension() {
        assert_eq!(suggested_image_name(Some("loop.gif"), "gif"), "loop.gif");
        assert_eq!(suggested_image_name(Some("shot.JPEG"), "jpg"), "shot.JPEG");
        assert_eq!(suggested_image_name(Some("shot.png"), "gif"), "shot.gif");
        assert_eq!(suggested_image_name(Some("notes"), "png"), "notes.png");
        assert_eq!(suggested_image_name(None, "webp"), "image.webp");
    }

    #[test]
    fn saved_images_always_get_an_extension() {
        assert_eq!(
            with_image_extension(PathBuf::from("/tmp/frog"), "gif"),
            PathBuf::from("/tmp/frog.gif")
        );
        assert_eq!(
            with_image_extension(PathBuf::from("/tmp/frog.GIF"), "gif"),
            PathBuf::from("/tmp/frog.GIF")
        );
        assert_eq!(image_filter_extensions("jpg"), &["jpg", "jpeg"]);
    }

    #[test]
    fn only_image_bytes_can_be_saved() {
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
        let (bytes, name) =
            chat_image_bytes(None, None, Some("image/png"), Some(&png)).expect("a png saves");
        assert!(bytes.starts_with(b"\x89PNG"));
        assert_eq!(name, None);
        let script = base64::engine::general_purpose::STANDARD.encode(b"#!/bin/sh\nrm -rf ~");
        assert!(chat_image_bytes(None, None, Some("image/png"), Some(&script)).is_err());
        assert!(chat_image_bytes(None, None, Some("application/x-sh"), Some(&script)).is_err());

        let dir = std::env::temp_dir().join(format!("gg-save-image-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("loop.gif"), b"GIF89a....").unwrap();
        std::fs::write(dir.join("fake.png"), b"not really").unwrap();
        let (bytes, name) = chat_image_bytes(Some(&dir), Some("loop.gif"), None, None).unwrap();
        assert!(bytes.starts_with(b"GIF89a"));
        assert_eq!(name.as_deref(), Some("loop.gif"));
        assert!(chat_image_bytes(Some(&dir), Some("fake.png"), None, None).is_err());
        assert!(chat_image_bytes(None, Some("loop.gif"), None, None).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn chat_images_are_recognised_by_content_not_name() {
        assert_eq!(
            sniff_image_type(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(
            sniff_image_type(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_type(b"GIF89a.."), Some("image/gif"));
        assert_eq!(
            sniff_image_type(b"RIFF\0\0\0\0WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(
            sniff_image_type(b"-----BEGIN OPENSSH PRIVATE KEY-----"),
            None
        );
        assert_eq!(
            sniff_image_type(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
            None
        );
        assert_eq!(sniff_image_type(b""), None);
    }

    #[test]
    fn chat_paths_resolve_relative_and_decorated_forms() {
        let dir = std::env::temp_dir().join(format!("gg-chat-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("shot.png");
        std::fs::write(&file, b"x").unwrap();
        let want = strip_extended_prefix(file.canonicalize().unwrap());
        assert_eq!(resolve_chat_path(&dir, "shot.png").unwrap(), want);
        assert_eq!(resolve_chat_path(&dir, "shot.png:12").unwrap(), want);
        let url = format!("file://{}#L3", file.to_string_lossy());
        assert_eq!(resolve_chat_path(Path::new("/"), &url).unwrap(), want);
        assert!(resolve_chat_path(&dir, "https://example.com/a.png").is_err());
        assert!(resolve_chat_path(&dir, "missing.png").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn image_temp_path_is_stable_per_image() {
        let dir = Path::new("/tmp/gg");
        let a = image_temp_path(dir, "png", b"one");
        assert_eq!(a, image_temp_path(dir, "png", b"one"));
        assert_ne!(a, image_temp_path(dir, "png", b"two"));
        assert_eq!(a.extension().and_then(|e| e.to_str()), Some("png"));
        assert_eq!(a.parent(), Some(dir));
    }
}

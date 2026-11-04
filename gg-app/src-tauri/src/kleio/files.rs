//! Files an agent on the Kleio host wrote and linked in chat by relative name.
//!
//! The webview names such a file by its owner (a Blob, a Blob inside a Group,
//! or a Chat/Code session's folder on the host) plus the relative path — never
//! by a local path. Rust validates both, downloads the bytes over the
//! device-authenticated client into the app cache and previews (Quick Look
//! thumbnail), opens (default app) or saves (native dialog) the cached copy.
//!
//!   GET {base}/kleio/blobs/{blobId}/files/{path}
//!   GET {base}/kleio/groups/{groupId}/members/{blobId}/files/{path}
//!   GET {base}/kleio/workspace/files/{path}?cwd={absolute host folder}
//!
//! 200 = raw bytes; errors are JSON `{"error": "..."}` (400 bad path, 404 no
//! such agent/group/workspace/file, 413 over the host's 50 MiB cap).
//!
//! Paths are plain names only, never hidden ones, with one exception for a
//! Chat/Code session: the pictures its tools made, `.gg/generated/<picture>`
//! and `.gg/screenshots/<picture>` (`owner_path_segments`).
//!
//! A download has no limit on its length, only on a wait: it stops when no
//! byte has come for [`NO_PROGRESS`]. A file arriving slowly, such as through
//! a shared relay, carries on, and the webview hears how much has come and
//! about how long is left ([`Progress`]) when it asks.
//!
//! Each file comes down once ([`Downloads`]):
//! - A fetch, open or save of a file already coming joins that download.
//! - The cache keeps the host's tag for its copy ([`CopyMeta`]) and sends it
//!   as `If-None-Match`. The host answers 304 when the copy is current. A
//!   host that doesn't, as before Phase 2, sends the copy's own tag with a
//!   200, and the rest isn't read.
//! - Through a relay, a card doesn't fetch a file over [`HOLD_OVER_BYTES`] on
//!   its own: it reads only the answer's size, and waits for a tap.
//!
//! Web pages are never downloaded or opened here: `kleio_site_open` asks the
//! host for a short-lived link on its separate, sandboxed preview origin
//! (`POST {base}/kleio/previews`) and hands that to the browser. It opens only
//! a link on the preview origin the pairing keeps ([`preview_origin`]).

use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::future::Future;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::JavaScriptChannelId;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "ios")]
use tauri_plugin_opener::OpenerExt;
use tokio::sync::watch;

use super::commands::{api_client, root_cause};

/// The host's cap (it answers 413 above it); we never buffer more than this.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_SEGMENTS: usize = 16;
const MAX_PATH_BYTES: usize = 1024;
/// A workspace cwd is an absolute host path; the host caps it at 1024 too.
const MAX_CWD_BYTES: usize = 1024;
const MAX_CWD_SEGMENTS: usize = 64;
/// How long a download may go with no byte from the host: the wait for its
/// answer, then each wait for more of the file. A file still coming, however
/// slowly, carries on: n0's shared relay passes about 1 MB/s.
const NO_PROGRESS: Duration = Duration::from_secs(20);
/// A whole download's backstop, in place of the shared client's 60 s: the
/// largest file at about 30 KB/s. Only a host trickling bytes reaches it.
const DOWNLOAD_BACKSTOP: Duration = Duration::from_secs(30 * 60);
/// The host didn't answer within [`NO_PROGRESS`].
const NO_ANSWER: &str = "Your host didn't answer within 20 seconds. Try again.";
/// The file stopped coming for [`NO_PROGRESS`].
const STALLED: &str =
    "The download stalled: nothing came from your host for 20 seconds. Try again.";
/// How often a download reports its progress, at most.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);
/// The time left goes by the rate over about this long, so a fast start (a
/// relay lets the first few MB through at twice the speed) soon stops counting.
const RATE_WINDOW: Duration = Duration::from_secs(5);
/// The least time a rate is worked out over.
const RATE_MIN_SPAN: Duration = Duration::from_secs(1);
/// Through a relay, a card doesn't fetch a file bigger than this on its own:
/// it shows the file's size and waits for a tap. 20 MB as the card counts
/// them (`formatBytes`), which the relay passes in about 20 s.
const HOLD_OVER_BYTES: u64 = 20 * 1024 * 1024;
/// Cached files live at `<app_cache_dir>/kleio-files/<owner key>/<segments…>`.
const CACHE_DIR: &str = "kleio-files";

/// Whose workspace a file lives in, exactly as the webview sends it (and as
/// the host's preview route takes it):
/// `{ "kind": "blob", "blobId": "b_1234abcd" }`,
/// `{ "kind": "group", "groupId": "g_1234abcd", "blobId": "b_1234abcd" }` or
/// `{ "kind": "workspace", "cwd": "/Users/me/kleio-projects/app" }`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum FileOwner {
    Blob {
        blob_id: String,
    },
    Group {
        group_id: String,
        blob_id: String,
    },
    /// A Chat or Code session, keyed by its cwd on the host (session ids do
    /// not survive a restart; the folder does). The host only serves it when
    /// the folder is inside Kleio's projects folders.
    Workspace {
        cwd: String,
    },
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    /// The file name (last path segment).
    pub name: String,
    pub size: u64,
    /// The response's Content-Type essence, e.g. `application/pdf`.
    pub mime: String,
    /// `data:image/png;base64,…` from Quick Look (macOS), else null.
    pub thumbnail: Option<String>,
    /// Not fetched: it's over [`HOLD_OVER_BYTES`] and would come through a
    /// relay, so the card waits for a tap. `size` is the host's.
    pub held: bool,
}

/// `prefix` followed by exactly 8 lowercase hex digits, e.g. `b_1234abcd`.
fn valid_id(id: &str, prefix: &str) -> bool {
    id.strip_prefix(prefix).is_some_and(|hex| {
        hex.len() == 8 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

/// The cwd's segments when it is an absolute POSIX path (the host is a Mac)
/// made only of plain names: no empty, `.`, `..` or hidden segments, no control
/// characters or backslashes. None otherwise.
fn cwd_segments(cwd: &str) -> Option<Vec<&str>> {
    if cwd.len() > MAX_CWD_BYTES {
        return None;
    }
    let segs: Vec<&str> = cwd.strip_prefix('/')?.split('/').collect();
    (segs.len() <= MAX_CWD_SEGMENTS && segs.iter().all(|s| plain_segment(s))).then_some(segs)
}

impl FileOwner {
    fn validate(&self) -> Result<(), String> {
        let ok = match self {
            FileOwner::Blob { blob_id } => valid_id(blob_id, "b_"),
            FileOwner::Group { group_id, blob_id } => {
                valid_id(group_id, "g_") && valid_id(blob_id, "b_")
            }
            FileOwner::Workspace { cwd } => {
                return cwd_segments(cwd)
                    .map(|_| ())
                    .ok_or_else(|| "kleio_file: bad folder".to_string());
            }
        };
        if ok {
            Ok(())
        } else {
            Err("kleio_file: bad agent id".to_string())
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            FileOwner::Blob { .. } => "blob",
            FileOwner::Group { .. } => "group",
            FileOwner::Workspace { .. } => "workspace",
        }
    }

    /// Host route up to (not including) the file path. Ids validated first.
    fn route(&self) -> String {
        match self {
            FileOwner::Blob { blob_id } => format!("/kleio/blobs/{blob_id}/files"),
            FileOwner::Group { group_id, blob_id } => {
                format!("/kleio/groups/{group_id}/members/{blob_id}/files")
            }
            FileOwner::Workspace { .. } => "/kleio/workspace/files".to_string(),
        }
    }

    /// The query string after the file path (with its `?`), or "".
    fn query(&self) -> String {
        match self {
            FileOwner::Workspace { cwd } => format!("?cwd={}", encode_segment(cwd)),
            _ => String::new(),
        }
    }

    /// Push this owner's cache sub-directory onto `p`: one per Blob or member,
    /// and `ws/<cwd segments…>` per session folder (segments already plain).
    fn push_cache_dir(&self, p: &mut PathBuf) {
        match self {
            FileOwner::Blob { blob_id } => p.push(format!("blob-{blob_id}")),
            FileOwner::Group { group_id, blob_id } => p.push(format!("group-{group_id}-{blob_id}")),
            FileOwner::Workspace { cwd } => {
                p.push("ws");
                p.extend(cwd_segments(cwd).unwrap_or_default());
            }
        }
    }
}

fn bad_path(why: &str) -> String {
    format!("kleio_file: bad path ({why})")
}

/// The relative path's segments, or why it is refused. The host checks again;
/// this keeps a hostile path out of both the URL and the local cache dir.
fn path_segments(path: &str) -> Result<Vec<&str>, String> {
    if path.is_empty() {
        return Err(bad_path("empty"));
    }
    if path.len() > MAX_PATH_BYTES {
        return Err(bad_path("too long"));
    }
    let segs: Vec<&str> = path.split('/').collect();
    if segs.len() > MAX_SEGMENTS {
        return Err(bad_path("too deep"));
    }
    if !segs.iter().all(|s| plain_segment(s)) {
        return Err(bad_path("segment"));
    }
    Ok(segs)
}

/// The hidden folders a Chat or Code session's pictures come from: what its
/// `generate_image` and `screenshot` tools made (the host serves only these).
const PICTURE_FOLDERS: &[&str] = &["generated", "screenshots"];
/// The pictures read from them, by lowercase extension.
const PICTURE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

fn is_picture(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| PICTURE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// The path's segments for this owner, or why it is refused. A Chat or Code
/// session may also name the pictures its tools made, `.gg/generated/<picture>`
/// and `.gg/screenshots/<picture>`, one level deep; every other path goes
/// through `path_segments`, which refuses any hidden name.
fn owner_path_segments<'a>(owner: &FileOwner, path: &'a str) -> Result<Vec<&'a str>, String> {
    if matches!(owner, FileOwner::Workspace { .. }) && path.len() <= MAX_PATH_BYTES {
        let segs: Vec<&str> = path.split('/').collect();
        let picture = matches!(
            segs.as_slice(),
            [".gg", folder, name]
                if PICTURE_FOLDERS.contains(folder) && plain_segment(name) && is_picture(name)
        );
        if picture {
            return Ok(segs);
        }
    }
    path_segments(path)
}

/// One plain file or folder name. A leading '.' also rules out "." and ".."
/// (and dotfiles).
fn plain_segment(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('.')
        && !s.chars().any(|c| c == '\\' || c.is_control())
        // Exactly one normal component on this OS as well (no `C:` drive
        // prefix on Windows), so pushing it can never leave the cache dir.
        && Path::new(s)
            .components()
            .eq([Component::Normal(OsStr::new(s))])
}

/// Percent-encode one path segment: RFC 3986 unreserved bytes stay, every
/// other UTF-8 byte becomes `%XX` (uppercase hex).
fn encode_segment(seg: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(seg.len() * 3);
    for b in seg.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[usize::from(b >> 4)] as char);
            out.push(HEX[usize::from(b & 0x0f)] as char);
        }
    }
    out
}

fn file_url(base: &str, owner: &FileOwner, segs: &[&str]) -> String {
    let encoded: Vec<String> = segs.iter().map(|s| encode_segment(s)).collect();
    format!(
        "{base}{}/{}{}",
        owner.route(),
        encoded.join("/"),
        owner.query()
    )
}

fn cache_file(cache_root: &Path, owner: &FileOwner, segs: &[&str]) -> PathBuf {
    let mut p = cache_root.join(CACHE_DIR);
    owner.push_cache_dir(&mut p);
    p.extend(segs);
    p
}

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map_err(|e| format!("kleio_file: no cache dir: {e}"))
}

/// The host's `{"error": "..."}` message, else the status (as `host_auth`).
pub(crate) fn host_error(status: u16, body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error")?.as_str().map(str::to_string))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("Your host answered {status}"))
}

/// `text/plain` of `text/plain; charset=utf-8`, lowercase; octet-stream when
/// the header is absent or unreadable.
pub(super) fn mime_of(content_type: Option<&str>) -> String {
    content_type
        .and_then(|s| s.split(';').next())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

fn too_large() -> String {
    format!(
        "That file is larger than {} MB.",
        MAX_FILE_BYTES / (1024 * 1024)
    )
}

/// Write-then-rename (as `store::save`) so the cache never holds a half file.
/// The temp name starts with '.', which no validated segment can.
fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = dest.parent().ok_or("no parent dir")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(
        ".kleio-dl.{}.{}.tmp",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, bytes)
        .and_then(|()| std::fs::rename(&tmp, dest))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })
}

/// What the cache keeps beside a downloaded file: the host's tag for that
/// version of it, sent back as `If-None-Match`, and its type and size.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
struct CopyMeta {
    etag: String,
    mime: String,
    size: u64,
}

/// Where the meta for the copy at `dest` lives: beside it, its name starting
/// with '.', which no validated segment can.
fn meta_path(dest: &Path) -> Option<PathBuf> {
    let name = dest.file_name()?.to_str()?;
    Some(dest.with_file_name(format!(".{name}.kleio-copy")))
}

/// The copy at `dest` and what the host said of it, when both are here and
/// agree on its size.
fn read_copy(dest: &Path) -> Option<CopyMeta> {
    let meta: CopyMeta = serde_json::from_slice(&std::fs::read(meta_path(dest)?).ok()?).ok()?;
    let file = std::fs::metadata(dest)
        .ok()
        .filter(std::fs::Metadata::is_file)?;
    (file.len() == meta.size && !meta.etag.is_empty()).then_some(meta)
}

/// Keeps `bytes` as the copy at `dest`, then the host's `etag` for it. The
/// old tag goes first, so a copy is never paired with a tag of another
/// version: one left without a tag is only fetched again.
fn write_copy(dest: &Path, bytes: &[u8], etag: Option<&str>, mime: &str) -> Result<(), String> {
    let meta = meta_path(dest).ok_or("The cache has no name for this file.")?;
    match std::fs::remove_file(&meta) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    write_atomic(dest, bytes)?;
    let Some(etag) = etag.filter(|tag| !tag.is_empty()) else {
        return Ok(());
    };
    let json = serde_json::to_vec(&CopyMeta {
        etag: etag.to_string(),
        mime: mime.to_string(),
        size: bytes.len() as u64,
    })
    .map_err(|e| e.to_string())?;
    write_atomic(&meta, &json)
}

/// How much of a download has come, for the webview: when the host answers,
/// then at most every [`PROGRESS_EVERY`] while the file comes, and once it's
/// all here.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Bytes so far.
    pub received: u64,
    /// The file's size, when the host gave it.
    pub total: Option<u64>,
    /// Seconds to go at the recent rate, once there's a rate and a size to go by.
    pub seconds_left: Option<u64>,
}

/// Counts a download's bytes, and says when to report them and how long is
/// left. It's given the time, so its sums are the same each run.
struct Meter {
    total: Option<u64>,
    received: u64,
    /// When each report was, and the bytes by then, the oldest first: the
    /// latest one at least [`RATE_WINDOW`] old, and every one since.
    seen: VecDeque<(Instant, u64)>,
    reported: Option<Instant>,
}

impl Meter {
    fn new(total: Option<u64>, now: Instant) -> Self {
        Self {
            total,
            received: 0,
            seen: VecDeque::from([(now, 0)]),
            reported: None,
        }
    }

    /// Counts `bytes` more: the progress to report, if one is due.
    fn add(&mut self, bytes: u64, now: Instant) -> Option<Progress> {
        self.received += bytes;
        let due = self
            .reported
            .is_none_or(|at| now.duration_since(at) >= PROGRESS_EVERY);
        due.then(|| self.report(now))
    }

    /// The progress now, due or not: when the host answers, and at the end.
    fn report(&mut self, now: Instant) -> Progress {
        self.seen.push_back((now, self.received));
        while self.seen.len() >= 2 && now.duration_since(self.seen[1].0) >= RATE_WINDOW {
            self.seen.pop_front();
        }
        self.reported = Some(now);
        Progress {
            received: self.received,
            total: self.total,
            seconds_left: self.seconds_left(now),
        }
    }

    /// The bytes still to come over the rate since the oldest report kept.
    fn seconds_left(&self, now: Instant) -> Option<u64> {
        let total = self.total?;
        let &(since, then) = self.seen.front()?;
        let span = now.duration_since(since);
        if span < RATE_MIN_SPAN || self.received <= then {
            return None;
        }
        let rate = (self.received - then) as f64 / span.as_secs_f64();
        let left = total.saturating_sub(self.received) as f64;
        Some((left / rate).ceil() as u64)
    }
}

/// Where a download's progress goes: to the webview's channel when it asked
/// for one, else nowhere.
fn reporter(
    webview: tauri::Webview,
    channel: Option<JavaScriptChannelId>,
) -> impl FnMut(Progress) + Send {
    let channel = channel.map(|id| id.channel_on::<_, Progress>(webview));
    move |progress| {
        if let Some(channel) = &channel {
            // The webview may have gone: the download carries on regardless.
            let _ = channel.send(progress);
        }
    }
}

/// What a file request came back with.
#[derive(Debug, PartialEq, Eq)]
enum Fetched {
    /// The whole file: its bytes, its type, and the host's tag for this
    /// version of it.
    Body {
        bytes: Vec<u8>,
        mime: String,
        etag: Option<String>,
    },
    /// The copy here is this version: the host said 304, or sent the copy's
    /// own tag, and the rest wasn't read.
    Current,
    /// Bigger than it may be: not read, so it waits for a tap.
    Held { size: u64, mime: String },
}

/// GET one file into memory (capped) from `client`, reporting its progress,
/// and stopping after `no_progress` without a byte. Nothing else limits it
/// but [`DOWNLOAD_BACKSTOP`].
/// - `copy_etag`: the copy here's tag, sent as `If-None-Match`.
/// - `hold_over`: a size the file may not be over, else it's left unread.
///
/// Err carries the host's message. Logs route kind, status, bytes and
/// elapsed ms only.
async fn fetch_from(
    client: &reqwest::Client,
    kind: &str,
    url: &str,
    no_progress: Duration,
    copy_etag: Option<&str>,
    hold_over: Option<u64>,
    mut progress: impl FnMut(Progress) + Send,
) -> Result<Fetched, String> {
    use tokio::time::timeout;

    let started = Instant::now();
    let fail = |status: Option<u16>, e: String| {
        let status = status.map_or_else(|| "no answer".to_string(), |s| s.to_string());
        let ms = started.elapsed().as_millis();
        log::warn!("kleio: file fetch ({kind}) failed ({status}) after {ms} ms: {e}");
        e
    };
    let mut request = client.get(url).timeout(DOWNLOAD_BACKSTOP);
    if let Some(etag) = copy_etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let mut res = match timeout(no_progress, request.send()).await {
        Ok(Ok(res)) => res,
        Ok(Err(e)) => return Err(fail(None, root_cause(&e))),
        Err(_) => return Err(fail(None, NO_ANSWER.to_string())),
    };
    let status = res.status().as_u16();
    if res.status() == reqwest::StatusCode::NOT_MODIFIED && copy_etag.is_some() {
        log::info!(
            "kleio: file fetch ({kind}) → 304: the copy here is current, in {} ms",
            started.elapsed().as_millis()
        );
        return Ok(Fetched::Current);
    }
    if !res.status().is_success() {
        let text = match timeout(no_progress, res.text()).await {
            Ok(Ok(text)) => text,
            _ => String::new(),
        };
        return Err(fail(Some(status), host_error(status, &text)));
    }
    let etag = res
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if copy_etag.is_some() && etag.as_deref() == copy_etag {
        // A host that doesn't answer If-None-Match: dropping the answer
        // stops the rest coming.
        log::info!(
            "kleio: file fetch ({kind}) → {status} with the copy's own tag: the copy here is \
             current, in {} ms",
            started.elapsed().as_millis()
        );
        return Ok(Fetched::Current);
    }
    let mime = mime_of(
        res.headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
    );
    let declared = res.content_length();
    if declared.is_some_and(|n| n > MAX_FILE_BYTES) {
        return Err(fail(Some(status), too_large()));
    }
    if let (Some(limit), Some(size)) = (hold_over, declared) {
        if size > limit {
            log::info!(
                "kleio: file fetch ({kind}) → {status}, {size} bytes: over {limit} through a \
                 relay, so it waits for a tap"
            );
            return Ok(Fetched::Held { size, mime });
        }
    }
    let mut meter = Meter::new(declared, Instant::now());
    progress(meter.report(Instant::now()));
    let mut bytes = Vec::with_capacity(declared.unwrap_or(0) as usize);
    loop {
        match timeout(no_progress, res.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                if (bytes.len() + chunk.len()) as u64 > MAX_FILE_BYTES {
                    return Err(fail(Some(status), too_large()));
                }
                bytes.extend_from_slice(&chunk);
                if let Some(due) = meter.add(chunk.len() as u64, Instant::now()) {
                    progress(due);
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return Err(fail(Some(status), root_cause(&e))),
            Err(_) => return Err(fail(Some(status), STALLED.to_string())),
        }
    }
    progress(meter.report(Instant::now()));
    log::info!(
        "kleio: file fetch ({kind}) → {status}, {} bytes in {} ms",
        bytes.len(),
        started.elapsed().as_millis()
    );
    Ok(Fetched::Body { bytes, mime, etag })
}

/// What a fetch is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Want {
    /// A card fetching its file on its own, as it comes into view: through a
    /// relay, a file over [`HOLD_OVER_BYTES`] waits for a tap.
    Shown,
    /// A tap on Download: the file, however big.
    Tapped,
    /// Open or Save: the copy here as it is, if there is one, else the file.
    Copy,
}

/// What a fetch got: the file (the copy here, current), or only its size,
/// as it waits for a tap.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Got {
    File {
        path: PathBuf,
        size: u64,
        mime: String,
    },
    Held {
        size: u64,
        mime: String,
    },
}

/// A download, as those waiting on it see it. Each carries how far it got,
/// once the host answered, so one who looks only at the end still hears it.
#[derive(Clone, Debug)]
enum Flight {
    /// Still coming.
    Coming(Option<Progress>),
    /// Over, with what it got.
    Done(Result<Got, String>, Option<Progress>),
}

type Flights = Arc<Mutex<HashMap<PathBuf, watch::Receiver<Flight>>>>;

/// One download per file at a time, keyed by its place in the cache: a
/// fetch, open or save of a file already coming joins that download, its
/// progress and then what it got, rather than starting another. The
/// download carries on when the card that started it goes, so the card
/// coming back joins it too. Managed state (`lib.rs`).
#[derive(Default)]
pub struct Downloads {
    coming: Flights,
}

/// Takes a download off the list when it's over, even by a panic, so the
/// next fetch starts afresh.
struct OffTheList {
    coming: Flights,
    key: PathBuf,
}

impl Drop for OffTheList {
    fn drop(&mut self) {
        lock(&self.coming).remove(&self.key);
    }
}

/// Each update is one insert or remove, so the list is whole even if a
/// holder panicked.
fn lock(flights: &Flights) -> MutexGuard<'_, HashMap<PathBuf, watch::Receiver<Flight>>> {
    flights.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Downloads {
    /// Whether a download of `key` is under way.
    fn is_coming(&self, key: &Path) -> bool {
        lock(&self.coming).contains_key(key)
    }

    /// Joins the download of `key` under way, or starts one with `start`
    /// (given where to report its progress), as it's called. The future it
    /// gives passes the download's progress to `progress`, then what it got.
    fn join_or_start<'a, F, Fut>(
        &self,
        key: &Path,
        start: F,
        progress: &'a mut (dyn FnMut(Progress) + Send),
    ) -> impl Future<Output = Result<Got, String>> + Send + 'a
    where
        F: FnOnce(Box<dyn FnMut(Progress) + Send>) -> Fut,
        Fut: Future<Output = Result<Got, String>> + Send + 'static,
    {
        follow(self.join_or_spawn(key, start), progress)
    }

    fn join_or_spawn<F, Fut>(&self, key: &Path, start: F) -> watch::Receiver<Flight>
    where
        F: FnOnce(Box<dyn FnMut(Progress) + Send>) -> Fut,
        Fut: Future<Output = Result<Got, String>> + Send + 'static,
    {
        let mut flights = lock(&self.coming);
        if let Some(flight) = flights.get(key) {
            log::info!("kleio: file fetch joins the download already coming");
            return flight.clone();
        }
        let (tx, rx) = watch::channel(Flight::Coming(None));
        flights.insert(key.to_path_buf(), rx.clone());
        drop(flights);
        let tx = Arc::new(tx);
        let report = {
            let tx = Arc::clone(&tx);
            move |at: Progress| {
                tx.send_replace(Flight::Coming(Some(at)));
            }
        };
        let download = start(Box::new(report));
        let off = OffTheList {
            coming: Arc::clone(&self.coming),
            key: key.to_path_buf(),
        };
        tauri::async_runtime::spawn(async move {
            let got = download.await;
            // Off the list before it's over, so a fetch from now on starts
            // afresh and finds the copy.
            drop(off);
            tx.send_modify(|flight| {
                let at = match flight {
                    Flight::Coming(at) | Flight::Done(_, at) => at.take(),
                };
                *flight = Flight::Done(got, at);
            });
        });
        rx
    }

    /// The file at `key` for `want`, coming once however many ask:
    /// - Open or Save takes the copy here when no download is coming.
    /// - Otherwise it joins the download coming, or starts one with `start`.
    /// - A tap, an open or a save that joined a card's fetch that left the
    ///   file unread starts its own.
    async fn get<S, Fut>(
        &self,
        key: &Path,
        want: Want,
        start: S,
        progress: &mut (dyn FnMut(Progress) + Send),
    ) -> Result<Got, String>
    where
        S: Fn(Box<dyn FnMut(Progress) + Send>) -> Fut,
        Fut: Future<Output = Result<Got, String>> + Send + 'static,
    {
        for _ in 0..3 {
            if want == Want::Copy && !self.is_coming(key) {
                if let Some(copy) = copy_here(key) {
                    return Ok(copy);
                }
            }
            match self.join_or_start(key, &start, progress).await? {
                Got::Held { .. } if want != Want::Shown => continue,
                got => return Ok(got),
            }
        }
        Err("The file didn't come. Try again.".to_string())
    }
}

/// Passes a download's progress to `progress` as it changes, and at the end
/// the last of it if that wasn't passed yet, then gives what it got.
async fn follow(
    mut flight: watch::Receiver<Flight>,
    progress: &mut (dyn FnMut(Progress) + Send),
) -> Result<Got, String> {
    let mut told: Option<Progress> = None;
    loop {
        let (at, done) = match flight.borrow_and_update().clone() {
            Flight::Coming(at) => (at, None),
            Flight::Done(got, at) => (at, Some(got)),
        };
        if let Some(at) = at.filter(|at| told.as_ref() != Some(at)) {
            progress(at.clone());
            told = Some(at);
        }
        if let Some(got) = done {
            return got;
        }
        if flight.changed().await.is_err() {
            return Err("The download stopped. Try again.".to_string());
        }
    }
}

/// The copy at `key` as it is, for Open or Save.
fn copy_here(key: &Path) -> Option<Got> {
    let file = std::fs::metadata(key)
        .ok()
        .filter(std::fs::Metadata::is_file)?;
    let mime = read_copy(key).map_or_else(|| "application/octet-stream".to_string(), |c| c.mime);
    Some(Got::File {
        path: key.to_path_buf(),
        size: file.len(),
        mime,
    })
}

/// Whether a download now would come through a relay: over the link, with
/// no direct path open.
async fn through_relay(app: &AppHandle, r: &super::Remote) -> bool {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    if r.transport.is_link() {
        return super::link::through_relay(app).await;
    }
    let _ = (app, r);
    false
}

/// One download into the cache at `dest`, for `want`: the copy's tag goes
/// with it, and through a relay a card's fetch of a big file stops at the
/// answer.
async fn download(
    app: &AppHandle,
    owner: &FileOwner,
    segs: &[String],
    dest: &Path,
    want: Want,
    progress: impl FnMut(Progress) + Send,
) -> Result<Got, String> {
    let r = super::remote().ok_or("Not connected to your host.")?;
    let segs: Vec<&str> = segs.iter().map(String::as_str).collect();
    let url = file_url(&r.base, owner, &segs);
    let copy = read_copy(dest);
    let hold_over = (want == Want::Shown && through_relay(app, r).await).then_some(HOLD_OVER_BYTES);
    let started = Instant::now();
    let fetched = fetch_from(
        api_client(r)?,
        owner.kind(),
        &url,
        NO_PROGRESS,
        copy.as_ref().map(|c| c.etag.as_str()),
        hold_over,
        progress,
    )
    .await?;
    let (bytes, mime, etag) = match fetched {
        Fetched::Current => {
            let copy = copy.ok_or("The copy here went.")?;
            return Ok(Got::File {
                path: dest.to_path_buf(),
                size: copy.size,
                mime: copy.mime,
            });
        }
        Fetched::Held { size, mime } => return Ok(Got::Held { size, mime }),
        Fetched::Body { bytes, mime, etag } => (bytes, mime, etag),
    };
    let size = bytes.len() as u64;
    // How fast it came says whether a relay is slowing the link.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    if r.transport.is_link() {
        super::link::note_download(app, size, started.elapsed()).await;
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    let _ = started;
    let target = dest.to_path_buf();
    let kept = mime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        write_copy(&target, &bytes, etag.as_deref(), &kept)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Got::File {
        path: dest.to_path_buf(),
        size,
        mime,
    })
}

/// The file for `want`, from the app's one download of it ([`Downloads`]).
async fn get(
    app: &AppHandle,
    owner: &FileOwner,
    segs: &[&str],
    want: Want,
    mut progress: impl FnMut(Progress) + Send,
) -> Result<Got, String> {
    let downloads = app.state::<Downloads>();
    let dest = cache_file(&cache_root(app)?, owner, segs);
    let segs: Vec<String> = segs.iter().map(|s| (*s).to_string()).collect();
    let start = |report: Box<dyn FnMut(Progress) + Send>| {
        let (app, owner, segs, dest) = (app.clone(), owner.clone(), segs.clone(), dest.clone());
        async move { download(&app, &owner, &segs, &dest, want, report).await }
    };
    downloads.get(&dest, want, start, &mut progress).await
}

/// The copy here if there is one, else the file (no thumbnail): for Open and
/// Save, which a tap asked for, so it's never held.
async fn cached_or_fetch(
    app: &AppHandle,
    owner: &FileOwner,
    segs: &[&str],
    progress: impl FnMut(Progress) + Send,
) -> Result<PathBuf, String> {
    match get(app, owner, segs, Want::Copy, progress).await? {
        Got::File { path, .. } => Ok(path),
        Got::Held { .. } => Err("The file didn't come. Try again.".to_string()),
    }
}

/// Quick Look thumbnail as a PNG data URL. Any failure is None, never an error.
#[cfg(target_os = "macos")]
fn thumbnail(cache_root: &Path, file: &Path) -> Option<String> {
    use base64::Engine as _;
    use std::process::{Command, Stdio};

    const LIMIT: Duration = Duration::from_secs(10);
    static N: AtomicU32 = AtomicU32::new(0);
    // qlmanage waits forever on a missing file rather than failing.
    if !file.is_file() {
        return None;
    }
    let dir = cache_root.join(CACHE_DIR).join(format!(
        ".thumb.{}.{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).ok()?;
    let render = || -> Option<String> {
        let mut child = Command::new("/usr/bin/qlmanage")
            .args([OsStr::new("-t"), OsStr::new("-s"), OsStr::new("640")])
            .arg("-o")
            .arg(&dir)
            .arg(file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let deadline = Instant::now() + LIMIT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        // qlmanage names its output `<file name>.png`.
        let mut png = file.file_name()?.to_os_string();
        png.push(".png");
        let bytes = std::fs::read(dir.join(png))
            .ok()
            .filter(|b| !b.is_empty())?;
        Some(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    };
    let out = render();
    let _ = std::fs::remove_dir_all(&dir);
    out
}

/// Quick Look thumbnail (QuickLookThumbnailing) as a PNG data URL. Any failure
/// is None, never an error; blocks at most `LIMIT` waiting for the generator.
#[cfg(target_os = "ios")]
fn thumbnail(_cache_root: &Path, file: &Path) -> Option<String> {
    use base64::Engine as _;
    use block2::RcBlock;
    use objc2::AllocAnyThread as _;
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{NSError, NSString, NSURL};
    use objc2_quick_look_thumbnailing::{
        QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
        QLThumbnailGenerator, QLThumbnailRepresentation,
    };
    use std::sync::mpsc;

    const LIMIT: Duration = Duration::from_secs(10);
    if !file.is_file() {
        return None;
    }
    let path = file.to_str()?;
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
    objc2::rc::autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        // SAFETY: a freshly allocated request initialised with a valid file
        // URL, a finite size, scale 1.0 (mirrors the Mac's 640 px) and a valid
        // representation-type mask; types match the framework header.
        let request = unsafe {
            QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
                QLThumbnailGenerationRequest::alloc(),
                &url,
                CGSize::new(640.0, 640.0),
                1.0,
                QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
            )
        };
        let handler = RcBlock::new(
            move |rep: *mut QLThumbnailRepresentation, _err: *mut NSError| {
                // SAFETY: the framework passes either nil or a valid
                // representation that lives for the duration of this call.
                let png = unsafe { rep.as_ref() }.and_then(|rep| {
                    objc2::rc::autoreleasepool(|_| {
                        // SAFETY: plain property getter on a valid
                        // representation; UIImage is thread-safe to read.
                        let image = unsafe { rep.UIImage() };
                        image.png_representation().map(|d| d.to_vec())
                    })
                });
                // The receiver may have timed out and gone; that's fine.
                let _ = tx.send(png.filter(|b| !b.is_empty()));
            },
        );
        // SAFETY: the shared generator is thread-safe; the block is copied
        // by the callee and only captures a Sender, so it may outlive us.
        unsafe {
            QLThumbnailGenerator::sharedGenerator()
                .generateBestRepresentationForRequest_completionHandler(&request, &handler);
        }
    });
    let bytes = rx.recv_timeout(LIMIT).ok().flatten()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn thumbnail(_cache_root: &Path, _file: &Path) -> Option<String> {
    None
}

/// Bring a linked file into the cache, checked against the host so it's the
/// current version, and describe it, reporting its progress on `on_progress`
/// if the webview gives one. `auto`: a card fetching it as it comes into
/// view, so through a relay a big one waits for a tap (`FileInfo::held`).
#[tauri::command]
pub async fn kleio_file_fetch(
    app: AppHandle,
    webview: tauri::Webview,
    owner: FileOwner,
    path: String,
    on_progress: Option<JavaScriptChannelId>,
    auto: Option<bool>,
) -> Result<FileInfo, String> {
    owner.validate()?;
    let segs = owner_path_segments(&owner, &path)?;
    let name = segs.last().copied().unwrap_or_default().to_string();
    let progress = reporter(webview, on_progress);
    let want = if auto.unwrap_or(false) {
        Want::Shown
    } else {
        Want::Tapped
    };
    let (file, size, mime) = match get(&app, &owner, &segs, want, progress).await? {
        Got::File { path, size, mime } => (path, size, mime),
        Got::Held { size, mime } => {
            return Ok(FileInfo {
                name,
                size,
                mime,
                thumbnail: None,
                held: true,
            })
        }
    };
    let root = cache_root(&app)?;
    let thumbnail = tauri::async_runtime::spawn_blocking(move || thumbnail(&root, &file))
        .await
        .ok()
        .flatten();
    Ok(FileInfo {
        name,
        size,
        mime,
        thumbnail,
        held: false,
    })
}

/// File types handed to their default app: documents, images and media only.
/// An agent reads untrusted web pages, so what it writes is untrusted too, and
/// some types act the moment they are opened (`.terminal` runs a command,
/// `.webloc` opens any URL, `.html`/`.svg` run script in a browser). Anything
/// not listed can still be saved; it is never opened from Kleio.
const OPENABLE: &[&str] = &[
    "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "txt", "md", "csv", "json", "docx", "xlsx",
    "pptx", "mp3", "m4a", "wav", "mp4", "mov",
];

fn openable(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| OPENABLE.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Open the file with its default app (downloading it first if not cached,
/// with its progress on `on_progress` if the webview gives one). Only
/// `OPENABLE` types; the rest are refused before any download.
#[tauri::command]
pub async fn kleio_file_open(
    app: AppHandle,
    webview: tauri::Webview,
    owner: FileOwner,
    path: String,
    on_progress: Option<JavaScriptChannelId>,
) -> Result<(), String> {
    owner.validate()?;
    let segs = owner_path_segments(&owner, &path)?;
    if !segs.last().is_some_and(|name| openable(name)) {
        log::warn!(
            "kleio: file open ({}) refused: type not openable",
            owner.kind()
        );
        return Err("Kleio doesn't open this kind of file. Save a copy instead.".to_string());
    }
    let progress = reporter(webview, on_progress);
    let file = cached_or_fetch(&app, &owner, &segs, progress).await?;
    log::info!("kleio: file open ({})", owner.kind());
    open_downloaded(&app, file).await
}

/// Hand a downloaded file to the desktop's default app for it.
#[cfg(not(target_os = "ios"))]
async fn open_downloaded(_app: &AppHandle, file: PathBuf) -> Result<(), String> {
    crate::process::open_with_default(&file.to_string_lossy())
}

/// The iPhone has no default apps to hand a file to: show it in iOS's viewer.
#[cfg(target_os = "ios")]
async fn open_downloaded(app: &AppHandle, file: PathBuf) -> Result<(), String> {
    let window = app
        .webview_windows()
        .into_values()
        .next()
        .ok_or_else(|| "The file viewer is unavailable.".to_string())?;
    super::phone::preview_file(&window, file).await
}

/// Save a copy where the user picks (downloading it first if not cached, with
/// its progress on `on_progress` if the webview gives one). Ok(false) when
/// the dialog is cancelled.
#[tauri::command]
pub async fn kleio_file_save(
    app: AppHandle,
    webview: tauri::Webview,
    owner: FileOwner,
    path: String,
    on_progress: Option<JavaScriptChannelId>,
) -> Result<bool, String> {
    owner.validate()?;
    let segs = owner_path_segments(&owner, &path)?;
    let name = segs.last().copied().unwrap_or_default().to_string();
    let progress = reporter(webview, on_progress);
    let cached = cached_or_fetch(&app, &owner, &segs, progress).await?;
    // The dialog posts to the main thread; block a worker, not the runtime.
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_file_name(name)
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(picked) = picked else {
        return Ok(false);
    };
    let dest = picked.into_path().map_err(|e| e.to_string())?;
    let started = Instant::now();
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::copy(&cached, &dest))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    log::info!(
        "kleio: file save ({}) → {bytes} bytes in {} ms",
        owner.kind(),
        started.elapsed().as_millis()
    );
    Ok(true)
}

/// An agent-written web page (`.html`/`.htm`).
fn is_site(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| matches!(ext.to_ascii_lowercase().as_str(), "html" | "htm"))
}

/// The host's answer to `POST /kleio/previews` (it also sends `expiresAt`).
#[derive(Deserialize)]
struct MintedPreview {
    url: String,
}

/// A link pairing to a host with no preview origin, one without Tailscale.
const PREVIEWS_NEED_TAILSCALE: &str = "Site previews need Tailscale for now.";
/// A link pairing whose preview origin, on Tailscale, doesn't answer.
const PREVIEWS_OVER_TAILSCALE: &str =
    "Site previews open over Tailscale for now: turn Tailscale on, then open again.";
/// How long the preview origin gets to answer before a link pairing says
/// Tailscale is off.
const PREVIEW_REACH_TIMEOUT: Duration = Duration::from_secs(5);

/// A scheme a preview link may have: https, or http to exactly 127.0.0.1 in
/// a debug build, for a host on this Mac (`gg-app/scripts/dev-host.mjs`).
fn preview_scheme_ok(u: &reqwest::Url) -> bool {
    u.scheme() == "https"
        || (cfg!(debug_assertions) && u.scheme() == "http" && u.host_str() == Some("127.0.0.1"))
}

/// The preview origin a pairing keeps, from the host's `previewOrigin`:
/// exactly an origin as one is written, e.g.
/// `https://mini.tail1234.ts.net:8444`, with a scheme [`preview_scheme_ok`]
/// takes. None for anything else (mirrors `isPreviewOrigin` in
/// packages/kleio-host/src/pair-code.ts).
pub(super) fn preview_origin(raw: &str) -> Option<String> {
    let u = reqwest::Url::parse(raw).ok()?;
    let origin = u.origin().ascii_serialization();
    (origin == raw && preview_scheme_ok(&u)).then_some(origin)
}

/// Where a preview link must point.
#[derive(Debug, PartialEq, Eq)]
enum PreviewPlace<'a> {
    /// Exactly the preview origin the pairing keeps.
    Origin(&'a str),
    /// The base URL's host name, on any port: a Tailscale pairing from before
    /// hosts gave their preview origin.
    BaseHost(&'a str),
}

/// Where this pairing's previews may open, or why it has none. Over the
/// link, the host's preview origin is the only place there is: a link
/// pairing without one is to a host without Tailscale.
fn preview_place<'a>(
    origin: Option<&'a str>,
    base: &'a str,
    over_link: bool,
) -> Result<PreviewPlace<'a>, String> {
    match origin {
        Some(origin) => Ok(PreviewPlace::Origin(origin)),
        None if over_link => Err(PREVIEWS_NEED_TAILSCALE.to_string()),
        None => Ok(PreviewPlace::BaseHost(base)),
    }
}

/// The preview link, only if it points back at the paired host's preview
/// origin ([`PreviewPlace`]), with a scheme [`preview_scheme_ok`] takes and no
/// credentials. Anything else is refused rather than opened.
fn checked_preview_url(url: &str, place: &PreviewPlace) -> Result<String, String> {
    let refused = || "Your host sent a site link Kleio won't open.".to_string();
    let u = reqwest::Url::parse(url).map_err(|_| refused())?;
    let placed = match place {
        PreviewPlace::Origin(origin) => u.origin().ascii_serialization() == *origin,
        PreviewPlace::BaseHost(base) => {
            let paired = reqwest::Url::parse(base).map_err(|_| refused())?;
            u.host_str().is_some() && u.host_str() == paired.host_str()
        }
    };
    if placed && preview_scheme_ok(&u) && u.username().is_empty() && u.password().is_none() {
        Ok(u.to_string())
    } else {
        Err(refused())
    }
}

/// Whether the preview origin answers this device at all, whatever it says.
/// A link pairing checks first: the origin is on Tailscale, and with that
/// off, a browser would only show an error. The device's token never goes
/// there, and neither does a preview link's.
async fn preview_origin_answers(origin: &str) -> bool {
    let client = match super::commands::host_client(&super::Transport::Url)
        .timeout(PREVIEW_REACH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            log::warn!("kleio: can't check the preview origin: {e}");
            return false;
        }
    };
    match client.get(format!("{origin}/")).send().await {
        Ok(_) => true,
        Err(e) => {
            log::info!(
                "kleio: the preview origin didn't answer: {}",
                root_cause(&e)
            );
            false
        }
    }
}

/// Open an agent-written web page in the browser (Safari on the iPhone).
/// The page is never downloaded or rendered in Kleio: the host mints a
/// short-lived link on its sandboxed preview origin and the browser loads it.
/// The link carries a capability token, so it is never logged.
#[tauri::command]
pub async fn kleio_site_open(app: AppHandle, owner: FileOwner, path: String) -> Result<(), String> {
    owner.validate()?;
    let segs = path_segments(&path)?;
    if !segs.last().is_some_and(|name| is_site(name)) {
        return Err("Only web pages open as a site.".to_string());
    }
    let r = super::remote().ok_or("Not connected to your host.")?;
    let kind = owner.kind();
    let started = Instant::now();
    let fail = |status: Option<u16>, e: String| {
        let status = status.map_or_else(|| "no answer".to_string(), |s| s.to_string());
        let ms = started.elapsed().as_millis();
        log::warn!("kleio: site open ({kind}) failed ({status}) after {ms} ms: {e}");
        e
    };
    let over_link = r.transport.is_link();
    let place = preview_place(r.preview_origin.as_deref(), &r.base, over_link)
        .map_err(|e| fail(None, e))?;
    // Previews still open over Tailscale. Over the link, check that this
    // device reaches the origin before minting a link a browser can't open.
    if let (true, PreviewPlace::Origin(origin)) = (over_link, &place) {
        if !preview_origin_answers(origin).await {
            return Err(fail(None, PREVIEWS_OVER_TAILSCALE.to_string()));
        }
    }
    let res = match api_client(r)?
        .post(format!("{}/kleio/previews", r.base))
        .json(&serde_json::json!({ "owner": owner, "path": path }))
        .send()
        .await
    {
        Ok(res) => res,
        Err(e) => return Err(fail(None, root_cause(&e))),
    };
    let status = res.status().as_u16();
    if !res.status().is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(fail(Some(status), host_error(status, &text)));
    }
    let minted: MintedPreview = res
        .json()
        .await
        .map_err(|e| fail(Some(status), root_cause(&e)))?;
    let url = checked_preview_url(&minted.url, &place).map_err(|e| fail(Some(status), e))?;
    log::info!(
        "kleio: site open ({kind}) → {status} in {} ms",
        started.elapsed().as_millis()
    );
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        crate::process::open_with_default(&url)
    }
    #[cfg(target_os = "ios")]
    {
        app.opener()
            .open_url(url, None::<String>)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One dir per call, even for tests running in parallel (see store.rs).
    fn tmp_dir() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "kleio-files-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn blob() -> FileOwner {
        FileOwner::Blob {
            blob_id: "b_1234abcd".into(),
        }
    }

    fn group() -> FileOwner {
        FileOwner::Group {
            group_id: "g_00ff00ff".into(),
            blob_id: "b_1234abcd".into(),
        }
    }

    #[test]
    fn owner_deserializes_from_the_webview_shape() {
        let o: FileOwner =
            serde_json::from_str(r#"{ "kind": "blob", "blobId": "b_1234abcd" }"#).unwrap();
        assert_eq!(o, blob());
        let o: FileOwner = serde_json::from_str(
            r#"{ "kind": "group", "groupId": "g_00ff00ff", "blobId": "b_1234abcd" }"#,
        )
        .unwrap();
        assert_eq!(o, group());
        for bad in [
            r#"{ "kind": "Blob", "blobId": "b_1234abcd" }"#,
            r#"{ "kind": "blob", "blob_id": "b_1234abcd" }"#,
            r#"{ "kind": "group", "blobId": "b_1234abcd" }"#,
            r#"{ "kind": "file", "blobId": "b_1234abcd" }"#,
            r#"{ "blobId": "b_1234abcd" }"#,
        ] {
            assert!(serde_json::from_str::<FileOwner>(bad).is_err(), "{bad}");
        }
    }

    fn workspace(cwd: &str) -> FileOwner {
        FileOwner::Workspace { cwd: cwd.into() }
    }

    #[test]
    fn workspace_owner_round_trips_the_webview_and_host_shape() {
        let o: FileOwner = serde_json::from_str(
            r#"{ "kind": "workspace", "cwd": "/Users/me/kleio-projects/app" }"#,
        )
        .unwrap();
        assert_eq!(o, workspace("/Users/me/kleio-projects/app"));
        // The preview route takes the owner in the same shape.
        assert_eq!(
            serde_json::to_value(&o).unwrap(),
            serde_json::json!({ "kind": "workspace", "cwd": "/Users/me/kleio-projects/app" })
        );
        assert_eq!(
            serde_json::to_value(group()).unwrap(),
            serde_json::json!({ "kind": "group", "groupId": "g_00ff00ff", "blobId": "b_1234abcd" })
        );
        for bad in [
            r#"{ "kind": "workspace" }"#,
            r#"{ "kind": "workspace", "cwd": 7 }"#,
            r#"{ "kind": "Workspace", "cwd": "/a" }"#,
        ] {
            assert!(serde_json::from_str::<FileOwner>(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn workspace_cwd_validation_table() {
        let deep_ok = format!("/{}", vec!["a"; 64].join("/"));
        let too_deep = format!("/{}", vec!["a"; 65].join("/"));
        let long_ok = format!("/{}", "a".repeat(1023));
        let too_long = format!("/{}", "a".repeat(1024));
        let cases: &[(&str, bool)] = &[
            ("/Users/me/kleio-projects", true),
            ("/Users/me/kleio-projects/My App — v2", true),
            ("/Users/me/projects/a..b", true),
            (&deep_ok, true),
            (&long_ok, true),
            ("", false),
            ("/", false),
            ("Users/me/app", false),
            ("relative", false),
            ("/Users/me/app/", false),
            ("/Users//me", false),
            ("/Users/me/../other", false),
            ("/Users/me/./app", false),
            ("/Users/me/.secret/app", false),
            ("/Users/me/app\u{0}x", false),
            ("/Users/me/app\nx", false),
            ("/Users/me\\app", false),
            ("C:\\Users\\me", false),
            (&too_deep, false),
            (&too_long, false),
        ];
        for (cwd, ok) in cases {
            assert_eq!(workspace(cwd).validate().is_ok(), *ok, "{cwd:?}");
        }
        assert_eq!(
            workspace("/a/../b").validate().unwrap_err(),
            "kleio_file: bad folder"
        );
    }

    #[test]
    fn workspace_url_carries_the_cwd_as_an_encoded_query() {
        let segs = path_segments("out/Q3 report.pdf").unwrap();
        let owner = workspace("/Users/me/kleio-projects/My App+1");
        assert_eq!(
            file_url("https://host:8443", &owner, &segs),
            "https://host:8443/kleio/workspace/files/out/Q3%20report.pdf\
             ?cwd=%2FUsers%2Fme%2Fkleio-projects%2FMy%20App%2B1"
        );
        // What the host's URLSearchParams reads back.
        let url = reqwest::Url::parse(&file_url("https://host:8443", &owner, &segs)).unwrap();
        let cwd: Vec<_> = url.query_pairs().collect();
        assert_eq!(cwd.len(), 1);
        assert_eq!(cwd[0].0, "cwd");
        assert_eq!(cwd[0].1, "/Users/me/kleio-projects/My App+1");
        assert_eq!(url.path(), "/kleio/workspace/files/out/Q3%20report.pdf");
        // Blob and group routes carry no query.
        assert!(!file_url("https://host:8443", &blob(), &segs).contains('?'));
    }

    #[test]
    fn workspace_cache_path_stays_inside_the_cache_dir() {
        let segs = path_segments("site/index.md").unwrap();
        let root = Path::new("cache");
        let p = cache_file(root, &workspace("/Users/me/kleio-projects/app"), &segs);
        assert_eq!(
            p,
            root.join("kleio-files")
                .join("ws")
                .join("Users")
                .join("me")
                .join("kleio-projects")
                .join("app")
                .join("site")
                .join("index.md")
        );
        assert!(p.starts_with(root.join(CACHE_DIR).join("ws")));
        assert!(p.components().all(|c| matches!(c, Component::Normal(_))));
    }

    #[test]
    fn only_web_pages_open_as_sites() {
        for ok in ["index.html", "Report.HTM", "a.b.html"] {
            assert!(is_site(ok), "{ok}");
        }
        for no in [
            "index.html.pdf",
            "page.xhtml",
            "html",
            "notes.md",
            "art.svg",
        ] {
            assert!(!is_site(no), "{no}");
        }
    }

    /// A Tailscale pairing from before hosts gave their preview origin.
    #[test]
    fn preview_links_must_point_back_at_the_paired_host() {
        let base = &PreviewPlace::BaseHost("https://mini.tail1234.ts.net:8443");
        assert_eq!(
            checked_preview_url("https://mini.tail1234.ts.net:8444/p/tok/index.html", base)
                .unwrap(),
            "https://mini.tail1234.ts.net:8444/p/tok/index.html"
        );
        assert!(checked_preview_url("https://MINI.tail1234.ts.net:8444/p/t/i.html", base).is_ok());
        for bad in [
            "https://evil.example:8444/p/tok/index.html",
            "https://mini.tail1234.ts.net.evil.example/p/t/i.html",
            "http://mini.tail1234.ts.net:8444/p/tok/index.html",
            "https://user:pw@mini.tail1234.ts.net:8444/p/t/i.html",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "/p/tok/index.html",
            "",
        ] {
            assert!(checked_preview_url(bad, base).is_err(), "{bad}");
        }
        // A local (loopback) host only works in debug builds.
        let local = checked_preview_url(
            "http://127.0.0.1:8444/p/t/i.html",
            &PreviewPlace::BaseHost("http://127.0.0.1:8443"),
        );
        assert_eq!(local.is_ok(), cfg!(debug_assertions));
    }

    #[test]
    fn preview_links_must_be_on_the_preview_origin_the_pairing_keeps() {
        let place = &PreviewPlace::Origin("https://mini.tail1234.ts.net:8444");
        assert_eq!(
            checked_preview_url("https://mini.tail1234.ts.net:8444/p/tok/index.html", place)
                .unwrap(),
            "https://mini.tail1234.ts.net:8444/p/tok/index.html"
        );
        assert!(checked_preview_url("https://MINI.tail1234.ts.net:8444/p/t/i.html", place).is_ok());
        for bad in [
            // The API's port, and the host's name on its own, aren't the origin.
            "https://mini.tail1234.ts.net:8443/p/tok/index.html",
            "https://mini.tail1234.ts.net/p/tok/index.html",
            "https://evil.example:8444/p/tok/index.html",
            "http://mini.tail1234.ts.net:8444/p/tok/index.html",
            "https://someone@mini.tail1234.ts.net:8444/p/t/i.html",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "/p/tok/index.html",
            "",
        ] {
            assert!(checked_preview_url(bad, place).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_pairing_keeps_a_preview_origin_only_as_an_origin_is_written() {
        assert_eq!(
            preview_origin("https://mini.tail1234.ts.net:8444").as_deref(),
            Some("https://mini.tail1234.ts.net:8444")
        );
        for bad in [
            "https://mini.tail1234.ts.net:8444/",
            "https://mini.tail1234.ts.net:8444/p",
            "https://mini.tail1234.ts.net:8444?x=1",
            "https://MINI.tail1234.ts.net:8444",
            "https://mini.tail1234.ts.net:443",
            "https://someone@mini.tail1234.ts.net:8444",
            "http://mini.tail1234.ts.net:8444",
            "http://localhost:8444",
            "mini.tail1234.ts.net:8444",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(preview_origin(bad), None, "{bad}");
        }
        // A host on this Mac, in debug builds only.
        assert_eq!(
            preview_origin("http://127.0.0.1:52715").is_some(),
            cfg!(debug_assertions)
        );
    }

    #[test]
    fn over_the_link_previews_open_only_at_the_hosts_preview_origin() {
        let link = crate::kleio::LINK_BASE;
        let base = "https://mini.tail1234.ts.net:8443";
        let origin = "https://mini.tail1234.ts.net:8444";
        assert_eq!(
            preview_place(Some(origin), link, true),
            Ok(PreviewPlace::Origin(origin))
        );
        // A host without Tailscale gives no preview origin.
        assert_eq!(
            preview_place(None, link, true),
            Err(PREVIEWS_NEED_TAILSCALE.to_string())
        );
        assert_eq!(
            preview_place(Some(origin), base, false),
            Ok(PreviewPlace::Origin(origin))
        );
        assert_eq!(
            preview_place(None, base, false),
            Ok(PreviewPlace::BaseHost(base))
        );
    }

    #[test]
    fn only_documents_images_and_media_open() {
        for ok in [
            "Report.pdf",
            "chart.PNG",
            "notes.md",
            "Budget.xlsx",
            "clip.mov",
        ] {
            assert!(openable(ok), "{ok}");
        }
        for refused in [
            "run.terminal",
            "link.webloc",
            "link.inetloc",
            "place.fileloc",
            "page.html",
            "page.htm",
            "art.svg",
            "script.command",
            "tool.jar",
            "setup.pkg",
            "image.dmg",
            "profile.mobileconfig",
            "macro.docm",
            "Makefile",
            "report.pdf.terminal",
        ] {
            assert!(!openable(refused), "{refused}");
        }
    }

    #[test]
    fn owner_ids_are_validated() {
        assert!(blob().validate().is_ok());
        assert!(group().validate().is_ok());
        for id in [
            "",
            "b_",
            "b_1234abc",
            "b_1234abcde",
            "b_1234ABCD",
            "b_1234abcg",
            "g_1234abcd",
            "B_1234abcd",
            "b_1234ab/d",
            "b_../../x",
        ] {
            let o = FileOwner::Blob { blob_id: id.into() };
            assert!(o.validate().is_err(), "{id}");
        }
        let swapped = FileOwner::Group {
            group_id: "b_1234abcd".into(),
            blob_id: "g_00ff00ff".into(),
        };
        assert!(swapped.validate().is_err());
    }

    #[test]
    fn path_validation_table() {
        let deep_ok = vec!["a"; 16].join("/");
        let too_deep = vec!["a"; 17].join("/");
        let long_ok = "a".repeat(1024);
        let too_long = "a".repeat(1025);
        let cases: &[(&str, bool)] = &[
            ("report.md", true),
            ("out/summary 2026.pdf", true),
            ("a/b/c.txt", true),
            ("日本/レポート — final.md", true),
            ("a..b", true),
            ("v1.2/notes.", true),
            (&deep_ok, true),
            (&long_ok, true),
            ("", false),
            ("/abs/path", false),
            ("a//b", false),
            ("a/", false),
            (".", false),
            ("..", false),
            ("./a", false),
            ("a/./b", false),
            ("../x", false),
            ("a/../b", false),
            (".hidden", false),
            ("a/.git/config", false),
            ("a\\b", false),
            ("..\\x", false),
            ("a\u{0}b", false),
            ("a\nb", false),
            ("a\tb", false),
            ("a\u{7f}", false),
            ("a\u{85}", false),
            (&too_deep, false),
            (&too_long, false),
        ];
        for (path, ok) in cases {
            assert_eq!(path_segments(path).is_ok(), *ok, "{path:?}");
        }
        assert_eq!(
            path_segments("out/summary 2026.pdf").unwrap(),
            ["out", "summary 2026.pdf"]
        );
    }

    #[test]
    fn a_session_may_name_the_pictures_its_tools_made() {
        let ws = workspace("/Users/me/kleio-projects/app");
        for ok in [
            ".gg/generated/x.png",
            ".gg/screenshots/x.jpeg",
            ".gg/screenshots/Shot 1.WEBP",
            ".gg/generated/a.gif",
            ".gg/generated/b.jpg",
        ] {
            assert_eq!(
                owner_path_segments(&ws, ok).map(|s| s.join("/")),
                Ok(ok.to_string()),
                "{ok}"
            );
        }
        let too_long = format!(".gg/generated/{}.png", "a".repeat(1020));
        for refused in [
            ".gg/plans/x.md",
            ".gg/plans/x.png",
            ".gg/generated/x.md",
            ".gg/generated/x.svg",
            ".gg/generated/x",
            ".gg/generated/sub/x.png",
            ".gg/generated/.x.png",
            ".gg/generated/..",
            ".gg/x.png",
            ".gg/generated",
            ".gg/generated/",
            ".gg",
            ".gg/Generated/x.png",
            ".gg/generated/x\\y.png",
            ".gg/generated/x\u{0}.png",
            "a/.gg/generated/x.png",
            ".git/generated/x.png",
            &too_long,
        ] {
            assert!(owner_path_segments(&ws, refused).is_err(), "{refused:?}");
        }
        // Every other path as before.
        assert_eq!(
            owner_path_segments(&ws, "out/r.md").unwrap(),
            ["out", "r.md"]
        );
        assert!(owner_path_segments(&ws, ".env").is_err());
        // An agent's or a group member's hidden folders stay closed, pictures included.
        for owner in [blob(), group()] {
            for p in [".gg/generated/x.png", ".gg/screenshots/x.jpeg"] {
                assert!(owner_path_segments(&owner, p).is_err(), "{p}");
            }
        }
        // The host gets the two folders spelled out, and the cache stays in its folder.
        let segs = owner_path_segments(&ws, ".gg/screenshots/Shot 1.png").unwrap();
        assert_eq!(
            file_url("https://host:8443", &ws, &segs),
            "https://host:8443/kleio/workspace/files/.gg/screenshots/Shot%201.png\
             ?cwd=%2FUsers%2Fme%2Fkleio-projects%2Fapp"
        );
        let root = Path::new("cache");
        let p = cache_file(root, &ws, &segs);
        assert!(p.starts_with(root.join(CACHE_DIR).join("ws")));
        assert!(p.components().all(|c| matches!(c, Component::Normal(_))));
    }

    #[test]
    fn segments_are_percent_encoded() {
        assert_eq!(encode_segment("AZaz09-._~"), "AZaz09-._~");
        assert_eq!(encode_segment("my report.md"), "my%20report.md");
        assert_eq!(encode_segment("a — b"), "a%20%E2%80%94%20b");
        assert_eq!(encode_segment("café"), "caf%C3%A9");
        assert_eq!(encode_segment("日本"), "%E6%97%A5%E6%9C%AC");
        assert_eq!(
            encode_segment("100%+?#&=:;,"),
            "100%25%2B%3F%23%26%3D%3A%3B%2C"
        );
    }

    #[test]
    fn url_and_cache_path_per_owner() {
        let segs = path_segments("out/Q3 report — v2.pdf").unwrap();
        assert_eq!(
            file_url("https://host:8443", &blob(), &segs),
            "https://host:8443/kleio/blobs/b_1234abcd/files/out/Q3%20report%20%E2%80%94%20v2.pdf"
        );
        assert_eq!(
            file_url("https://host:8443", &group(), &segs),
            "https://host:8443/kleio/groups/g_00ff00ff/members/b_1234abcd/files/out/Q3%20report%20%E2%80%94%20v2.pdf"
        );
        let root = Path::new("cache");
        assert_eq!(
            cache_file(root, &blob(), &segs),
            root.join("kleio-files")
                .join("blob-b_1234abcd")
                .join("out")
                .join("Q3 report — v2.pdf")
        );
        assert_eq!(
            cache_file(root, &group(), &segs),
            root.join("kleio-files")
                .join("group-g_00ff00ff-b_1234abcd")
                .join("out")
                .join("Q3 report — v2.pdf")
        );
    }

    #[test]
    fn host_error_prefers_the_hosts_message() {
        assert_eq!(
            host_error(404, r#"{"error":"no such file"}"#),
            "no such file"
        );
        assert_eq!(
            host_error(413, r#"{"error":"file too large"}"#),
            "file too large"
        );
        assert_eq!(
            host_error(502, "<html>bad gateway</html>"),
            "Your host answered 502"
        );
        assert_eq!(host_error(500, r#"{"error":""}"#), "Your host answered 500");
        assert_eq!(host_error(401, ""), "Your host answered 401");
    }

    #[test]
    fn mime_is_the_content_type_essence() {
        assert_eq!(mime_of(Some("application/pdf")), "application/pdf");
        assert_eq!(
            mime_of(Some("Text/Markdown; charset=utf-8")),
            "text/markdown"
        );
        assert_eq!(mime_of(Some("")), "application/octet-stream");
        assert_eq!(mime_of(None), "application/octet-stream");
    }

    #[test]
    fn write_atomic_replaces_and_leaves_no_temp() {
        let dir = tmp_dir();
        let dest = dir.join("blob-b_1234abcd").join("out").join("r.md");
        write_atomic(&dest, b"first").unwrap();
        write_atomic(&dest, b"second").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"second");
        let names: Vec<_> = std::fs::read_dir(dest.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, [OsStr::new("r.md")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn thumbnail_failure_is_none_and_cleans_up() {
        let dir = tmp_dir();
        assert_eq!(thumbnail(&dir, &dir.join("missing.pdf")), None);
        let left = std::fs::read_dir(dir.join(CACHE_DIR))
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(left, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Quick Look may be unavailable on a headless CI runner, so only a local
    /// macOS run insists on a thumbnail; every run checks the shape + cleanup.
    #[cfg(target_os = "macos")]
    #[test]
    fn thumbnail_of_a_real_file_is_a_png_data_url() {
        let dir = tmp_dir();
        let file = dir
            .join(CACHE_DIR)
            .join("blob-b_1234abcd")
            .join("my report — v2.md");
        write_atomic(&file, b"# Report\n\nhello\n").unwrap();
        let thumb = thumbnail(&dir, &file);
        if std::env::var_os("CI").is_none() {
            assert!(thumb.is_some(), "qlmanage gave no thumbnail");
        }
        if let Some(t) = thumb {
            assert!(t.starts_with("data:image/png;base64,iVBOR"), "{}", &t[..40]);
        }
        let left: Vec<_> = std::fs::read_dir(dir.join(CACHE_DIR))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, [OsStr::new("blob-b_1234abcd")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A one-request HTTP server on 127.0.0.1. Once a request has come, it
    /// writes `parts`, waiting `gap` before each, then holds the connection
    /// open for `hold`. Gives its address and the request's head.
    fn serve_once(
        parts: Vec<Vec<u8>>,
        gap: Duration,
        hold: Duration,
    ) -> (std::net::SocketAddr, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut buf = [0u8; 1024];
            while !head.windows(4).any(|w| w == b"\r\n\r\n") {
                match conn.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => head.extend_from_slice(&buf[..n]),
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&head).into_owned());
            for part in parts {
                std::thread::sleep(gap);
                if conn.write_all(&part).is_err() {
                    return;
                }
            }
            std::thread::sleep(hold);
        });
        (addr, rx)
    }

    fn file_head(len: usize) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/pdf\r\ncontent-length: {len}\r\nconnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    fn plain_client() -> reqwest::Client {
        crate::install_rustls_provider();
        crate::kleio::commands::host_client(&crate::kleio::Transport::Url)
            .build()
            .unwrap()
    }

    #[test]
    fn a_download_that_keeps_coming_carries_on_past_the_limit_and_says_how_far_it_is() {
        let body = vec![b'x'; 10_000];
        let mut parts = vec![file_head(body.len())];
        parts.extend(body.chunks(1000).map(<[u8]>::to_vec));
        // 11 waits of 150 ms, 1.65 s in all, against a limit of 1 s on any one.
        let (addr, _) = serve_once(parts, Duration::from_millis(150), Duration::ZERO);
        let url = format!("http://{addr}/kleio/blobs/b_1234abcd/files/report.pdf");
        let mut seen = Vec::new();
        let started = Instant::now();
        let fetched = tauri::async_runtime::block_on(fetch_from(
            &plain_client(),
            "blob",
            &url,
            Duration::from_secs(1),
            None,
            None,
            |p| seen.push(p),
        ))
        .expect("it all came");
        let took = started.elapsed();
        assert!(took > Duration::from_secs(1));
        assert_eq!(
            fetched,
            Fetched::Body {
                bytes: body,
                mime: "application/pdf".into(),
                etag: None
            }
        );
        // Once the host answered, some way through, and at the end.
        let first = seen.first().expect("progress at the answer");
        assert_eq!((first.received, first.total), (0, Some(10_000)));
        assert!(seen.iter().any(|p| p.received > 0 && p.received < 10_000));
        let last = seen.last().expect("progress at the end");
        assert_eq!((last.received, last.total), (10_000, Some(10_000)));
        assert_eq!(last.seconds_left, Some(0));
        assert!(seen.windows(2).all(|w| w[0].received <= w[1].received));
        // At most the two ends and one report each quarter second it took: a
        // slow machine stretches the waits, and so the reports due.
        let most = 2 + took.as_millis() / PROGRESS_EVERY.as_millis();
        assert!(
            seen.len() as u128 <= most,
            "{} reports in {took:?}",
            seen.len()
        );
    }

    #[test]
    fn a_download_stops_once_nothing_has_come_for_the_limit() {
        let limit = Duration::from_millis(500);
        // The answer and the first bytes, then nothing, the connection held open.
        let (addr, _) = serve_once(
            vec![file_head(100), vec![b'x'; 10]],
            Duration::ZERO,
            Duration::from_secs(5),
        );
        let url = format!("http://{addr}/kleio/blobs/b_1234abcd/files/report.pdf");
        let started = Instant::now();
        let stalled = tauri::async_runtime::block_on(fetch_from(
            &plain_client(),
            "blob",
            &url,
            limit,
            None,
            None,
            |_| {},
        ));
        let took = started.elapsed();
        assert_eq!(stalled, Err(STALLED.to_string()));
        assert!(took >= limit && took < Duration::from_secs(4), "{took:?}");

        // No answer at all.
        let (addr, _) = serve_once(Vec::new(), Duration::ZERO, Duration::from_secs(5));
        let url = format!("http://{addr}/kleio/blobs/b_1234abcd/files/report.pdf");
        let silent = tauri::async_runtime::block_on(fetch_from(
            &plain_client(),
            "blob",
            &url,
            limit,
            None,
            None,
            |_| {},
        ));
        assert_eq!(silent, Err(NO_ANSWER.to_string()));
    }

    /// A 200's head for `len` bytes with the host's `etag` for them.
    fn tagged_head(len: usize, etag: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/pdf\r\ncontent-length: {len}\r\netag: {etag}\r\nconnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    const TAG: &str = "\"47185920-1729800000000\"";

    /// A fetch of a file whose copy here has `TAG`, from a server that sends
    /// `parts` and then holds the connection for 5 s.
    fn fetch_with_tag(parts: Vec<Vec<u8>>) -> (Result<Fetched, String>, Duration, String) {
        let (addr, head) = serve_once(parts, Duration::ZERO, Duration::from_secs(5));
        let url = format!("http://{addr}/kleio/blobs/b_1234abcd/files/report.pdf");
        let started = Instant::now();
        let fetched = tauri::async_runtime::block_on(fetch_from(
            &plain_client(),
            "blob",
            &url,
            Duration::from_secs(10),
            Some(TAG),
            None,
            |_| {},
        ));
        let head = head
            .recv_timeout(Duration::from_secs(2))
            .unwrap_or_default();
        (fetched, started.elapsed(), head.to_ascii_lowercase())
    }

    #[test]
    fn a_fetch_sends_the_copys_tag_and_a_304_keeps_the_copy() {
        let not_modified =
            format!("HTTP/1.1 304 Not Modified\r\netag: {TAG}\r\nconnection: close\r\n\r\n");
        let (fetched, took, head) = fetch_with_tag(vec![not_modified.into_bytes()]);
        assert!(head.contains(&format!("if-none-match: {TAG}")), "{head}");
        assert_eq!(fetched, Ok(Fetched::Current));
        assert!(took < Duration::from_secs(4), "{took:?}");
    }

    #[test]
    fn a_host_without_304_that_sends_the_copys_own_tag_is_not_read() {
        // The head, then 10 bytes of 47 MB, then nothing: the rest is never waited for.
        let (fetched, took, _) = fetch_with_tag(vec![tagged_head(47_185_920, TAG), vec![b'x'; 10]]);
        assert_eq!(fetched, Ok(Fetched::Current));
        assert!(took < Duration::from_secs(4), "{took:?}");
    }

    #[test]
    fn a_new_version_comes_whole_with_its_own_tag() {
        let body = b"%PDF-1.7 the second version".to_vec();
        let (fetched, _, head) = fetch_with_tag(vec![
            tagged_head(body.len(), "\"27-1729800009999\""),
            body.clone(),
        ]);
        assert!(head.contains("if-none-match:"), "{head}");
        assert_eq!(
            fetched,
            Ok(Fetched::Body {
                bytes: body,
                mime: "application/pdf".into(),
                etag: Some("\"27-1729800009999\"".into()),
            })
        );
    }

    #[test]
    fn a_304_with_no_copy_here_is_an_error_not_a_copy() {
        let (addr, _) = serve_once(
            vec![b"HTTP/1.1 304 Not Modified\r\nconnection: close\r\n\r\n".to_vec()],
            Duration::ZERO,
            Duration::ZERO,
        );
        let url = format!("http://{addr}/kleio/blobs/b_1234abcd/files/report.pdf");
        let fetched = tauri::async_runtime::block_on(fetch_from(
            &plain_client(),
            "blob",
            &url,
            Duration::from_secs(5),
            None,
            None,
            |_| {},
        ));
        assert!(
            matches!(fetched, Err(ref e) if e.contains("304")),
            "{fetched:?}"
        );
    }

    #[test]
    fn a_file_over_the_hold_is_left_unread_and_says_its_size() {
        let size = 30 * 1024 * 1024;
        let (addr, head) = serve_once(
            vec![file_head(size), vec![b'x'; 10]],
            Duration::ZERO,
            Duration::from_secs(5),
        );
        let url = format!("http://{addr}/kleio/blobs/b_1234abcd/files/big.pdf");
        let started = Instant::now();
        let fetched = tauri::async_runtime::block_on(fetch_from(
            &plain_client(),
            "blob",
            &url,
            Duration::from_secs(10),
            None,
            Some(HOLD_OVER_BYTES),
            |_| {},
        ));
        assert_eq!(
            fetched,
            Ok(Fetched::Held {
                size: size as u64,
                mime: "application/pdf".into()
            })
        );
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(!head
            .recv()
            .unwrap()
            .to_ascii_lowercase()
            .contains("if-none-match"));

        // At the hold or under it, it comes.
        let body = vec![b'y'; 4096];
        let mut parts = vec![file_head(body.len())];
        parts.push(body.clone());
        let (addr, _) = serve_once(parts, Duration::ZERO, Duration::ZERO);
        let url = format!("http://{addr}/kleio/blobs/b_1234abcd/files/small.pdf");
        let fetched = tauri::async_runtime::block_on(fetch_from(
            &plain_client(),
            "blob",
            &url,
            Duration::from_secs(10),
            None,
            Some(4096),
            |_| {},
        ));
        assert!(matches!(fetched, Ok(Fetched::Body { ref bytes, .. }) if *bytes == body));
    }

    // 20 MB as the card counts them: check 4's 45 MiB file is held, and a
    // 19 MB one isn't.
    const _: () = assert!(
        HOLD_OVER_BYTES == 20 * 1024 * 1024
            && 47_185_920 > HOLD_OVER_BYTES
            && 19 * 1024 * 1024 < HOLD_OVER_BYTES
    );

    #[test]
    fn a_copy_keeps_its_tag_beside_it_and_never_another_versions() {
        let dir = tmp_dir();
        let dest = dir.join("blob-b_1234abcd").join("out").join("report.pdf");
        write_copy(&dest, b"first", Some(TAG), "application/pdf").unwrap();
        let meta = read_copy(&dest).expect("its tag");
        assert_eq!(
            meta,
            CopyMeta {
                etag: TAG.into(),
                mime: "application/pdf".into(),
                size: 5
            }
        );
        assert_eq!(
            meta_path(&dest).unwrap().file_name().unwrap(),
            ".report.pdf.kleio-copy"
        );
        // A file that changed size since isn't taken for the tag's version.
        std::fs::write(&dest, b"first, and more").unwrap();
        assert_eq!(read_copy(&dest), None);
        // A new version with no tag leaves no tag at all.
        write_copy(&dest, b"second", None, "application/pdf").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"second");
        assert!(!meta_path(&dest).unwrap().exists());
        assert_eq!(read_copy(&dest), None);
        // No copy, no tag.
        assert_eq!(read_copy(&dir.join("missing.pdf")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn file_got(path: &str) -> Got {
        Got::File {
            path: PathBuf::from(path),
            size: 10,
            mime: "application/pdf".into(),
        }
    }

    fn at(received: u64) -> Progress {
        Progress {
            received,
            total: Some(10),
            seconds_left: None,
        }
    }

    #[test]
    fn a_second_fetch_of_a_file_coming_joins_it_and_hears_its_progress() {
        let downloads = Downloads::default();
        let key = PathBuf::from("/cache/kleio-files/blob-b_1234abcd/report.pdf");
        let starts = Arc::new(AtomicU32::new(0));
        let (go, wait) = tokio::sync::oneshot::channel::<()>();
        let wait = Arc::new(Mutex::new(Some(wait)));
        let start = |mut report: Box<dyn FnMut(Progress) + Send>| {
            starts.fetch_add(1, Ordering::SeqCst);
            let wait = lock_wait(&wait);
            async move {
                report(at(0));
                if let Some(wait) = wait {
                    let _ = wait.await;
                }
                report(at(10));
                Ok(file_got("/cache/report.pdf"))
            }
        };
        let (mut first, mut second) = (Vec::new(), Vec::new());
        let mut hear_first = |p: Progress| first.push(p.received);
        let mut hear_second = |p: Progress| second.push(p.received);
        // The first starts it, and it waits for `go`; the second joins it.
        let a = downloads.join_or_start(&key, &start, &mut hear_first);
        assert!(downloads.is_coming(&key));
        let b = downloads.join_or_start(&key, &start, &mut hear_second);
        let _ = go.send(());
        let (a, b) = tauri::async_runtime::block_on(async { futures_util::join!(a, b) });
        assert_eq!(starts.load(Ordering::SeqCst), 1, "one download, not two");
        assert_eq!(a, Ok(file_got("/cache/report.pdf")));
        assert_eq!(b, a);
        assert_eq!(first.last(), Some(&10));
        assert_eq!(second.last(), Some(&10));
        // Over, so it's off the list: the next fetch starts afresh.
        assert!(!downloads.is_coming(&key));
    }

    fn lock_wait(
        wait: &Arc<Mutex<Option<tokio::sync::oneshot::Receiver<()>>>>,
    ) -> Option<tokio::sync::oneshot::Receiver<()>> {
        wait.lock().unwrap().take()
    }

    #[test]
    fn a_tap_that_joined_a_cards_held_fetch_starts_its_own_and_gets_the_file() {
        let downloads = Downloads::default();
        let key = PathBuf::from("/cache/kleio-files/blob-b_1234abcd/big.pdf");
        let wants = Arc::new(Mutex::new(Vec::new()));
        let starter = |want: Want| {
            let wants = Arc::clone(&wants);
            move |_report: Box<dyn FnMut(Progress) + Send>| {
                wants.lock().unwrap().push(want);
                async move {
                    Ok(if want == Want::Shown {
                        Got::Held {
                            size: 47_185_920,
                            mime: "application/pdf".into(),
                        }
                    } else {
                        file_got("/cache/big.pdf")
                    })
                }
            }
        };
        tauri::async_runtime::block_on(async {
            // The card: held.
            let shown = downloads
                .get(&key, Want::Shown, starter(Want::Shown), &mut |_| {})
                .await;
            assert!(matches!(
                shown,
                Ok(Got::Held {
                    size: 47_185_920,
                    ..
                })
            ));
            // A tap that finds a held fetch (as if it joined one) gets the file.
            let held_first = Arc::new(AtomicU32::new(0));
            let tap = {
                let held_first = Arc::clone(&held_first);
                let wants = Arc::clone(&wants);
                move |_report: Box<dyn FnMut(Progress) + Send>| {
                    let first = held_first.fetch_add(1, Ordering::SeqCst) == 0;
                    wants.lock().unwrap().push(Want::Tapped);
                    async move {
                        Ok(if first {
                            Got::Held {
                                size: 47_185_920,
                                mime: "application/pdf".into(),
                            }
                        } else {
                            file_got("/cache/big.pdf")
                        })
                    }
                }
            };
            let tapped = downloads.get(&key, Want::Tapped, tap, &mut |_| {}).await;
            assert_eq!(tapped, Ok(file_got("/cache/big.pdf")));
        });
        assert_eq!(
            *wants.lock().unwrap(),
            [Want::Shown, Want::Tapped, Want::Tapped]
        );
    }

    #[test]
    fn open_and_save_take_the_copy_here_unless_a_download_is_coming() {
        let dir = tmp_dir();
        let key = dir.join("blob-b_1234abcd").join("report.pdf");
        write_copy(&key, b"the copy", Some(TAG), "application/pdf").unwrap();
        let downloads = Downloads::default();
        let starts = Arc::new(AtomicU32::new(0));
        let start = |_report: Box<dyn FnMut(Progress) + Send>| {
            starts.fetch_add(1, Ordering::SeqCst);
            async { Ok(file_got("/cache/new.pdf")) }
        };
        let got =
            tauri::async_runtime::block_on(downloads.get(&key, Want::Copy, &start, &mut |_| {}));
        assert_eq!(
            got,
            Ok(Got::File {
                path: key.clone(),
                size: 8,
                mime: "application/pdf".into()
            })
        );
        assert_eq!(
            starts.load(Ordering::SeqCst),
            0,
            "no download for a copy here"
        );
        // A card's fetch (Shown) always asks the host.
        let shown =
            tauri::async_runtime::block_on(downloads.get(&key, Want::Shown, &start, &mut |_| {}));
        assert_eq!(shown, Ok(file_got("/cache/new.pdf")));
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A download with a bug in it: it panics.
    async fn a_buggy_download() -> Result<Got, String> {
        panic!("a bug in a download")
    }

    #[test]
    fn a_download_that_panics_comes_off_the_list() {
        let downloads = Downloads::default();
        let key = PathBuf::from("/cache/kleio-files/blob-b_1234abcd/boom.pdf");
        let got = tauri::async_runtime::block_on(downloads.join_or_start(
            &key,
            |_report: Box<dyn FnMut(Progress) + Send>| a_buggy_download(),
            &mut |_| {},
        ));
        assert_eq!(got, Err("The download stopped. Try again.".to_string()));
        assert!(!downloads.is_coming(&key));
    }

    #[test]
    fn the_wait_messages_say_the_limit() {
        let limit = format!("{} seconds", NO_PROGRESS.as_secs());
        assert!(NO_ANSWER.contains(&limit), "{NO_ANSWER}");
        assert!(STALLED.contains(&limit), "{STALLED}");
    }

    #[test]
    fn progress_comes_at_most_every_quarter_second_and_at_the_ends() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut meter = Meter::new(Some(1000), t0);
        assert_eq!(
            meter.report(t0),
            Progress {
                received: 0,
                total: Some(1000),
                seconds_left: None,
            }
        );
        assert_eq!(meter.add(100, at(100)), None);
        assert_eq!(meter.add(100, at(249)), None);
        assert_eq!(meter.add(100, at(250)).map(|p| p.received), Some(300));
        assert_eq!(meter.add(100, at(300)), None);
        // The end is reported whenever it comes.
        assert_eq!(meter.report(at(310)).received, 400);
    }

    #[test]
    fn the_time_left_goes_by_the_last_few_seconds() {
        const MB: u64 = 1_000_000;
        let t0 = Instant::now();
        let quarter = Duration::from_millis(250);
        let mut meter = Meter::new(Some(45 * MB), t0);
        meter.report(t0);
        let mut now = t0;
        // The first 5 MB at 2 MB/s, as n0's relay let them through.
        for _ in 0..10 {
            now += quarter;
            meter.add(MB / 2, now);
        }
        // No rate to go by within the first second.
        let mut early = Meter::new(Some(45 * MB), t0);
        early.report(t0);
        assert_eq!(early.add(MB / 2, t0 + quarter).unwrap().seconds_left, None);
        // Then 10 s at 1 MB/s: 15 MB in 12.5 s, 30 MB to go.
        let mut last = None;
        for _ in 0..40 {
            now += quarter;
            last = meter.add(MB / 4, now);
        }
        let last = last.expect("reported each quarter second");
        assert_eq!(last.received, 15 * MB);
        // 30 s at the last 5 s' 1 MB/s, where the average since the start
        // (1.2 MB/s) would say 25.
        assert_eq!(last.seconds_left, Some(30));
        // Without a size, there's no time left to give.
        let mut unsized_meter = Meter::new(None, t0);
        unsized_meter.report(t0);
        assert_eq!(
            unsized_meter.add(MB, t0 + Duration::from_secs(2)),
            Some(Progress {
                received: MB,
                total: None,
                seconds_left: None,
            })
        );
    }

    #[test]
    fn a_preview_origin_answers_with_anything_and_never_gets_the_device_token() {
        // A preview origin answers 404 at its root: that's an answer.
        let (addr, head) = serve_once(
            vec![
                b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                    .to_vec(),
            ],
            Duration::ZERO,
            Duration::ZERO,
        );
        let origin = format!("http://{addr}");
        crate::install_rustls_provider();
        assert!(tauri::async_runtime::block_on(preview_origin_answers(
            &origin
        )));
        let head = head.recv().unwrap().to_ascii_lowercase();
        assert!(head.starts_with("get / http/1.1\r\n"), "{head}");
        assert!(!head.contains(crate::kleio::DEVICE_TOKEN_HEADER), "{head}");
        assert!(!head.contains(crate::kleio::CONTROL_HEADER), "{head}");
        // Nothing listening there: Tailscale is off, say.
        let closed = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        assert!(!tauri::async_runtime::block_on(preview_origin_answers(
            &closed
        )));
    }
}

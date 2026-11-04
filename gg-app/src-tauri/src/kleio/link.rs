//! Kleio's link (`docs/adr/0002-kleio-link-replaces-tailscale.md`), on macOS
//! and iOS: this app reaching its host over iroh instead of Tailscale. The
//! kleio-link library does the dialling, the forwarding, the pairing call and
//! the path log.
//!
//! - **Its own pairing.** `kleio_link_pair` redeems a scanned or pasted v4
//!   ticket's code on `kleio/pair/0`, in the library's three steps, then
//!   waits for an admin's Allow on the host. It tells the webview each step
//!   as it begins, the wait with this device's code, and each failure in its
//!   own words. `kleio_link_pair_cancel` stops the wait. It's
//!   kept apart from the Tailscale pairing: `link.json`
//!   beside `remote.json` holds the host's key, the relay it was reached
//!   through, and its relay list and direct addresses, and the Keychain
//!   entries go under `link-<host>`, with this device's own iroh key.
//!   `remote.json` and its token aren't touched here: after a switch from
//!   them, `switch.rs` removes them once the link has had a good session.
//! - **At boot** a link pairing wins over `remote.json` (`super::from_paired`).
//!   Pairing by the host's address instead (`kleio_pair`, the Connection
//!   page's "Advanced: connect over your own network") sets it aside. The
//!   app's requests to the host then go to the link's socket
//!   ([`socket_path`]), which only this process can use, and the link
//!   carries each of their connections over one cached connection to the
//!   host, dialled again when it has closed, within 10 s. The boot read binds
//!   the socket before it hands the pairing out, so nothing can send to it
//!   before it's up; `setup` then forwards on it.
//! - **Back on screen** after at least the host's idle timeout in the
//!   background, it closes the connection and dials again at once: the host
//!   may have dropped it, and a suspended phone can't tell. After a shorter
//!   absence it tells iroh the network may have changed and dials again only
//!   if the connection has closed. It times each resume, from coming back on
//!   screen to the first byte back from the host.
//! - **Finding the host again:** after each new connection it asks the host
//!   for its relay list, direct addresses and whether its relay is
//!   rate-limiting it (`GET /kleio/link`), for the next dial, and keeps the
//!   list and addresses in `link.json` for the next launch.
//! - **Why it can't reach the host,** for the app's words
//!   (`diagnoseLink` in connectionDiagnosis.ts): `kleio_link_status` says
//!   whether a dial is under way, when the host was last heard, why the last
//!   dial found no host, and whether a relay is slowing the link: the relay
//!   said so to this device or the host, or a big download through it came
//!   slower than [`SLOW_RELAY_BYTES_PER_S`].
//! - **Logs:** the library writes path events, and each path's numbers every
//!   30 s, through `tracing`. `LogBridge` passes them, and iroh's warnings, to
//!   the app's log, and the last 20 path events are kept for the Link card.
//! - **The pairing QR (iPhone):** the barcode-scanner plugin, registered in
//!   `lib.rs` for the iPhone only. Its permission is granted here, on the
//!   iPhone only, so no other build names a plugin it lacks:
//!   [`scanner_capability`].

use std::fmt;
use std::future::Future;
use std::net::SocketAddr;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use kleio_link::endpoint::{bind_client, EndpointOptions, IDLE_TIMEOUT};
use kleio_link::forward::Forward;
use kleio_link::iroh::{Endpoint, EndpointId, RelayUrl, SecretKey};
use kleio_link::link::{Link, LinkError, Route, Unreached};
use kleio_link::pair::{pair_until, PairStage};
use kleio_link::paths::{PathEvents, PathLine};
use kleio_link::probe::HttpsProbe;
use kleio_link::relays::{
    check_relay_entry, check_relay_list, check_relay_url, is_n0_relay, RelayEntry,
};
use kleio_link::ticket::{check_direct_addr, Ticket};
use tauri::ipc::JavaScriptChannelId;
use tauri::{AppHandle, Manager, State};

use super::{commands, keychain, store, OnScreen, Presence, Remote, Transport, LINK_BASE};

/// The link's socket, which only this process can use
/// ([`Forward::listen_private`]), in a folder of its own. A socket's path
/// can't be over 103 bytes here, so on the iPhone it's in the container's
/// `tmp`: 96 bytes at most, where `Library/Application Support` would make
/// it 118.
pub fn socket_path(home: &Path) -> PathBuf {
    socket_path_on(home, cfg!(target_os = "ios"))
}

fn socket_path_on(home: &Path, iphone: bool) -> PathBuf {
    if iphone {
        home.join("tmp/kl/link")
    } else {
        super::state_dir(home).join("run/link.sock")
    }
}

/// The scanner commands the main window may call, as 4e grants them: scan,
/// cancel and the permission checks. Not the plugin's default set, which
/// also opens the app's settings and vibrates.
#[cfg(any(target_os = "ios", test))]
const SCANNER_PERMISSIONS: [&str; 4] = [
    "barcode-scanner:allow-scan",
    "barcode-scanner:allow-cancel",
    "barcode-scanner:allow-check-permissions",
    "barcode-scanner:allow-request-permissions",
];

/// The capability for the scanner, granted at setup rather than in
/// `capabilities/`: a capability file naming a plugin the build lacks fails
/// the build without the feature. Only the iPhone build has the plugin.
#[cfg(any(target_os = "ios", test))]
pub(crate) fn scanner_capability() -> tauri::ipc::CapabilityBuilder {
    SCANNER_PERMISSIONS.iter().fold(
        tauri::ipc::CapabilityBuilder::new("kleio-link-scanner").window("main"),
        |capability, permission| capability.permission(*permission),
    )
}

/// Path events kept for the Link card.
const KEPT_EVENTS: usize = 20;

/// How long boot waits for the link to start before going on without it.
const START_TIMEOUT: Duration = Duration::from_secs(5);

/// The host drops a connection it has heard nothing on for this long, QUIC's
/// idle timeout ([`IDLE_TIMEOUT`]: iroh's default, which neither end
/// changes). Back from the background after at least this long, the phone's
/// connection may be dead though it looks open. On 2026-10-21 the app trusted
/// such a connection twice, and requests stalled about 30 s, until its own
/// idle timeout closed it.
const HOST_IDLE_TIMEOUT: Duration = IDLE_TIMEOUT;

/// A download through a relay at least this big says how fast the relay lets
/// bytes through: n0's let the first 5 MiB through faster (2.12 MB/s on
/// 2026-10-20), then 1.06–1.31 MB/s.
const SLOW_CHECK_BYTES: u64 = 10_000_000;

/// Slower than this through a relay, and the relay is slowing the link.
const SLOW_RELAY_BYTES_PER_S: f64 = 1_500_000.0;

/// How long the host gets to answer `GET /kleio/link`.
const LINK_INFO_TIMEOUT: Duration = Duration::from_secs(10);

// ── The link pairing ────────────────────────────────────────────────────────

/// The link pairing, `link.json` beside `remote.json`. Nothing secret: the
/// device token, the control credential and this device's iroh key are in
/// the Keychain, under [`keychain_host`]. A field it doesn't know, such as
/// the prototype's `mode`, is ignored.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRecord {
    /// The host's iroh key: the app dials it, and the handshake proves it.
    pub host_key: String,
    /// The relay the host was last reached through, at first the one it
    /// paired through: dials start there.
    pub relay: String,
    /// The host's relay list, as its ticket gave it and the host has given it
    /// since (`GET /kleio/link`): relay addresses, and `n0` for n0's relays.
    /// A dial tries them all if the host isn't on `relay`. Empty in a pairing
    /// from before lists.
    #[serde(default)]
    pub relays: Vec<String>,
    /// The host's direct addresses, as the host has given them since the
    /// Allow (`GET /kleio/link`). A v5 ticket gives none; a v4 one did.
    #[serde(default)]
    pub addrs: Vec<String>,
    /// The host's name, as it reports it.
    pub host: String,
    pub device_id: String,
    pub label: String,
    #[serde(default)]
    pub admin: bool,
    /// ISO-8601, display only.
    pub paired_at: String,
    /// Where the host's site previews open, over Tailscale for now
    /// (`files::preview_origin`). Absent from a host without Tailscale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_origin: Option<String>,
}

/// A link pairing that passed its checks, and the route to the host from it.
struct Loaded {
    record: LinkRecord,
    route: Route,
}

pub fn path(home: &Path) -> PathBuf {
    super::state_dir(home).join("link.json")
}

/// The link pairing, if there is one that can be dialled. Why one can't is
/// logged.
fn load(home: &Path) -> Option<Loaded> {
    let raw = match std::fs::read_to_string(path(home)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("kleio-link: can't read link.json: {e}");
            return None;
        }
    };
    let record: LinkRecord = match serde_json::from_str(&raw) {
        Ok(record) => record,
        Err(e) => {
            log::warn!("kleio-link: ignoring an unreadable link.json: {e}");
            return None;
        }
    };
    let Some(route) = dialled(&record) else {
        log::warn!("kleio-link: ignoring link.json (bad host key, relay, host or device id)");
        return None;
    };
    // A preview origin this build won't open is as good as none.
    let preview_origin = record
        .preview_origin
        .as_deref()
        .and_then(super::files::preview_origin);
    Some(Loaded {
        record: LinkRecord {
            preview_origin,
            ..record
        },
        route,
    })
}

/// The route to the host, if the record names one the app can dial. A list
/// entry or address it can't read is left out: the relay alone still reaches
/// the host, and a list that leaves nothing is the relay alone.
fn dialled(record: &LinkRecord) -> Option<Route> {
    let key: EndpointId = record.host_key.parse().ok()?;
    let relay = check_relay_url(&record.relay)?;
    let named = !record.host.trim().is_empty() && !record.device_id.trim().is_empty();
    let mut relays: Vec<RelayEntry> = record
        .relays
        .iter()
        .filter_map(|entry| check_relay_entry(entry))
        .collect();
    if relays.is_empty() {
        relays.push(RelayEntry::Url(relay.clone()));
    }
    let addrs = record
        .addrs
        .iter()
        .filter_map(|addr| check_direct_addr(addr))
        .collect();
    named.then(|| Route::new(key, Some(relay), addrs, relays))
}

/// Write-then-rename, as `store::save` does, so a crash mid-write never
/// leaves a half file.
fn save(home: &Path, record: &LinkRecord) -> Result<(), String> {
    let p = path(home);
    let dir = p.parent().ok_or("no parent dir")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".kleio-link.{}.tmp", std::process::id()));
    let body = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Where the link pairing's Keychain entries go: `link-<host>`, so they never
/// meet the Tailscale pairing's entries for the same host.
fn keychain_host(host: &str) -> String {
    format!("link-{host}")
}

/// The link pairing as the paired host, for `kleio_remote_status`: boot reads
/// it first, so while there's one it's the pairing the next launch uses.
pub(super) fn paired_record(home: &Path) -> Option<store::HostRecord> {
    let Loaded { record, .. } = load(home)?;
    Some(store::HostRecord {
        base_url: LINK_BASE.to_string(),
        host: record.host,
        device_id: record.device_id,
        label: record.label,
        admin: record.admin,
        paired_at: record.paired_at,
        preview_origin: record.preview_origin,
    })
}

/// Forgets the link pairing, for `kleio_forget`: its Keychain entries and
/// `link.json`. `false` if there's none to forget. The link keeps running
/// until the next launch, as a forgotten Tailscale pairing does.
pub(super) fn forget(home: &Path) -> Result<bool, String> {
    let Some(Loaded { record, .. }) = load(home) else {
        return Ok(false);
    };
    let account = keychain_host(&record.host);
    keychain::delete(&account, keychain::Secret::DeviceToken)?;
    keychain::delete(&account, keychain::Secret::ControlCredential)?;
    keychain::delete(&account, keychain::Secret::IrohKey)?;
    match std::fs::remove_file(path(home)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    // No link pairing: nothing for a switch's cleanup to finish.
    if let Err(e) = super::switch::clear(home) {
        log::warn!("kleio-switch: couldn't clear switch.json: {e}");
    }
    log::info!("kleio-link: forgot the pairing to {}", record.host);
    Ok(true)
}

/// This device's iroh key, as the Keychain keeps it.
fn encode_key(key: &SecretKey) -> String {
    base64::engine::general_purpose::STANDARD.encode(key.to_bytes())
}

fn decode_key(text: &str) -> Option<SecretKey> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(text)
        .ok()?;
    let bytes: [u8; 32] = bytes.try_into().ok()?;
    Some(SecretKey::from_bytes(&bytes))
}

/// What a launch on the link needs to run it: the route to the host, this
/// device's key, and the socket the boot read bound.
pub struct LinkBoot {
    route: Route,
    key: SecretKey,
    /// Where the link's socket is: every client of the host sends there
    /// (`commands::host_client`).
    socket: PathBuf,
    /// Bound before the pairing was handed out (`from_link`); `setup`
    /// forwards on it.
    listener: Mutex<Option<UnixListener>>,
}

impl LinkBoot {
    /// Where the link's socket is.
    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// The listener the boot read bound, for `setup`: once.
    fn take_listener(&self) -> Option<UnixListener> {
        self.listener
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take()
    }
}

/// The link pairing as the app's host, for boot (`super::from_paired`).
/// `None` when there's none or it can't be used; why is logged.
pub(super) fn from_link() -> Option<Remote> {
    let Loaded { record, route } = load(&crate::home_dir())?;
    let account = keychain_host(&record.host);
    let secret = |which| match keychain::get(&account, which) {
        Ok(found) => found,
        Err(e) => {
            log::warn!("kleio-link: {e}");
            None
        }
    };
    let Some(device_token) = secret(keychain::Secret::DeviceToken) else {
        log::warn!(
            "kleio-link: paired to {} but its token is not in the Keychain; not using the link",
            record.host
        );
        return None;
    };
    let Some(key) = secret(keychain::Secret::IrohKey).and_then(|text| decode_key(&text)) else {
        log::warn!(
            "kleio-link: paired to {} but this device's link key is not in the Keychain; not using the link",
            record.host
        );
        return None;
    };
    let control_credential = if record.admin {
        secret(keychain::Secret::ControlCredential)
    } else {
        None
    };
    // Whatever sends to the host reads the pairing here first, so the boot
    // read binds the socket before handing the pairing out: a request sent
    // before `setup` forwards, such as the Live Activity token iOS can
    // report as soon as `live::begin` runs, waits in its backlog instead of
    // being refused. Later reads bind nothing: after an in-place pairing the
    // link is listening already (`activate_paired`), and `remote_now`'s isn't
    // running.
    let socket = socket_path(&crate::home_dir());
    let listener = if super::BOOT.is_completed() {
        None
    } else {
        listen_at_boot(&socket)
    };
    log::info!(
        "kleio: remote host mode → {} over the link ({})",
        record.host,
        record.label
    );
    Some(Remote {
        base: LINK_BASE.to_string(),
        host: record.host,
        device_id: record.device_id,
        label: record.label,
        device_token,
        control_credential,
        admin: record.admin,
        preview_origin: record.preview_origin,
        transport: Transport::Link(Box::new(LinkBoot {
            route,
            key,
            socket,
            listener: Mutex::new(listener),
        })),
    })
}

/// The link's socket, listening now (see `from_link`). `None` if it can't
/// be: `setup` then tries again, and says why if it still can't.
fn listen_at_boot(path: &Path) -> Option<UnixListener> {
    match Forward::listen_private(path) {
        Ok(listener) => {
            log::info!("kleio-link: listening on its socket ({})", path.display());
            Some(listener)
        }
        Err(e) => {
            log::warn!("kleio-link: can't listen on its socket at boot: {e}");
            None
        }
    }
}

// ── The running link ────────────────────────────────────────────────────────

/// The link in this launch (Tauri state).
pub struct LinkRuntime {
    running: tokio::sync::Mutex<Option<Running>>,
    /// Why it couldn't start, if it couldn't.
    failure: Mutex<Option<String>>,
    /// The latest path events, for the Link card, kept for the launch.
    events: PathEvents,
    /// When the app went to the background, until it's back on screen.
    away_since: Mutex<Option<WentAway>>,
}

impl Default for LinkRuntime {
    fn default() -> Self {
        Self {
            running: tokio::sync::Mutex::default(),
            failure: Mutex::default(),
            events: PathEvents::new(KEPT_EVENTS),
            away_since: Mutex::default(),
        }
    }
}

/// The link while it runs: its endpoint (in the `Link`) and socket.
struct Running {
    link: Link,
    /// Forwarding on the socket; `None` only while a new listener takes over
    /// (`forward_again`).
    forward: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Where the socket is.
    socket: PathBuf,
    throttle: Arc<Throttle>,
    /// Asks the host for its relay list after each new connection
    /// ([`refresh_route`]). It runs until Kleio quits; only the tests stop it.
    #[cfg_attr(not(test), allow(dead_code))]
    refresher: tauri::async_runtime::JoinHandle<()>,
}

/// Signs that a relay is slowing the link, besides this device's own relay
/// saying so (`Link::rate_limited`).
#[derive(Debug, Default)]
struct Throttle {
    /// The host's relay told the host it's rate-limiting it, as the host last
    /// said (`GET /kleio/link`).
    host: AtomicBool,
    /// The connection a big download through a relay came slower than
    /// [`SLOW_RELAY_BYTES_PER_S`] on: its number (`Link::watch_connections`)
    /// plus one; 0 for none.
    slow_on: AtomicU64,
}

/// Whether a download of `bytes` in `took` says a relay is slowing the link:
/// `None` when it can't tell, as for one that went direct, or was too small.
fn slowed_by_relay(bytes: u64, took: Duration, through_relay: bool) -> Option<bool> {
    if !through_relay || bytes < SLOW_CHECK_BYTES || took.is_zero() {
        return None;
    }
    Some((bytes as f64 / took.as_secs_f64()) < SLOW_RELAY_BYTES_PER_S)
}

impl Running {
    /// The connection open now's number, as [`Throttle::slow_on`] keeps it.
    fn connection_number(&self) -> u64 {
        *self.link.watch_connections().borrow()
    }

    /// Whether a relay is slowing the connection open now: its relay told
    /// this device or the host so, or a big download through it was slow.
    fn rate_limited(&self, through_relay: bool) -> bool {
        through_relay
            && (self.link.rate_limited()
                || self.throttle.host.load(Ordering::Acquire)
                || self.throttle.slow_on.load(Ordering::Acquire)
                    == self.connection_number().saturating_add(1))
    }

    /// A download over the link finished: `bytes` in `took`.
    fn note_download(&self, bytes: u64, took: Duration) {
        let through_relay = self.link.path().is_some_and(|path| !path.direct);
        match slowed_by_relay(bytes, took, through_relay) {
            Some(true) => {
                log::info!(
                    "kleio-link: {bytes} bytes through the relay took {:.1} s: the relay is \
                     slowing the link",
                    took.as_secs_f64()
                );
                let on = self.connection_number().saturating_add(1);
                self.throttle.slow_on.store(on, Ordering::Release);
            }
            Some(false) => self.throttle.slow_on.store(0, Ordering::Release),
            None => {}
        }
    }
}

impl Running {
    /// The endpoint, then forwarding on `listener` (the boot read's) or on a
    /// new socket at `socket`. Connections waiting on `listener` are
    /// forwarded too; if the endpoint can't start, they're refused as it's
    /// dropped.
    async fn start(
        key: SecretKey,
        route: Route,
        events: PathEvents,
        socket: PathBuf,
        listener: Option<UnixListener>,
    ) -> Result<Self, String> {
        // The route's relay is the endpoint's only one: the link moves it to
        // whichever relay it finds the host on.
        let relays: Vec<_> = route.relay().cloned().into_iter().collect();
        let endpoint = bind_client(key, &relays, &EndpointOptions::default())
            .await
            .map_err(|e| format!("the link's endpoint didn't start: {e}"))?;
        Self::start_on(endpoint, route, events, socket, listener).await
    }

    /// [`start`](Self::start), on an endpoint bound already.
    async fn start_on(
        endpoint: Endpoint,
        route: Route,
        events: PathEvents,
        socket: PathBuf,
        listener: Option<UnixListener>,
    ) -> Result<Self, String> {
        let host = route.key();
        let link = match HttpsProbe::new(&EndpointOptions::default().trust) {
            Ok(probe) => Link::watched(endpoint, route, events, probe),
            Err(e) => {
                log::warn!("kleio-link: {e}; it won't ask relays why the host isn't there");
                Link::with_path_events(endpoint, route, events)
            }
        };
        let forward = match listener {
            Some(listener) => Forward::from_std_private(listener, link.clone()),
            None => Forward::bind_private(&socket, link.clone()),
        };
        let forward = match forward {
            Ok(forward) => forward,
            Err(e) => {
                link.endpoint().close().await;
                return Err(format!("the link couldn't listen on its socket: {e}"));
            }
        };
        log::info!("kleio-link: its socket forwards to {}", host.fmt_short());
        let forward = Some(tauri::async_runtime::spawn(forward.run()));
        let throttle = Arc::new(Throttle::default());
        let refresher = {
            let (link, throttle) = (link.clone(), throttle.clone());
            tauri::async_runtime::spawn(async move {
                let mut made = link.watch_connections();
                while made.changed().await.is_ok() {
                    refresh_route(&link, &throttle).await;
                }
            })
        };
        Ok(Self {
            link,
            forward,
            socket,
            throttle,
            refresher,
        })
    }

    /// Stops listening, then closes the endpoint, which ends its connection.
    /// Only the tests stop it: in the app the link runs until Kleio quits.
    #[cfg(test)]
    async fn stop(mut self) {
        self.refresher.abort();
        self.stop_forwarding().await;
        self.link.endpoint().close().await;
    }

    /// Stops forwarding, which closes the listener.
    async fn stop_forwarding(&mut self) {
        if let Some(forward) = self.forward.take() {
            forward.abort();
            let _ = forward.await;
        }
    }

    /// Forwards on a new socket in place of one iOS took away
    /// ([`listen_again`]): `listener` if the main thread could bind one, else
    /// a new one at the same path. The old listener's task never ends by
    /// itself: iOS leaves it waiting forever.
    async fn forward_again(&mut self, listener: Option<UnixListener>) -> Result<(), String> {
        self.stop_forwarding().await;
        let forward = listener
            .map_or_else(|| Forward::listen_private(&self.socket), Ok)
            .and_then(|listener| Forward::from_std_private(listener, self.link.clone()))
            .map_err(|e| format!("the link couldn't listen on its socket again: {e}"))?;
        self.forward = Some(tauri::async_runtime::spawn(forward.run()));
        Ok(())
    }
}

impl LinkRuntime {
    /// Starts the link, unless it's running already, forwarding on
    /// `listener` if there's one (the boot read's), else on a new socket at
    /// `socket`.
    async fn start(
        &self,
        key: SecretKey,
        route: Route,
        socket: PathBuf,
        listener: Option<UnixListener>,
    ) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Ok(());
        }
        let started = Running::start(key, route, self.events.clone(), socket, listener).await;
        self.set_failure(started.as_ref().err().cloned());
        *running = Some(started?);
        Ok(())
    }

    /// See [`listen_again`]: forwards on `listener`, or on a new one once the
    /// old has closed. Nothing to do if the link isn't running.
    async fn forward_again(&self, listener: Option<UnixListener>) {
        let mut running = self.running.lock().await;
        let Some(run) = running.as_mut() else {
            return;
        };
        match run.forward_again(listener).await {
            Ok(()) => log::info!("kleio-link: forwarding on the new listener"),
            Err(e) => {
                log::error!("kleio-link: {e}; the host can't be reached until Kleio opens again");
                self.set_failure(Some(e));
            }
        }
    }

    /// The app is back on screen: time the resume, and dial again if the
    /// connection may be dead. After at least the host's idle timeout away
    /// ([`redial_on_resume`]) the connection is closed and dialled again at
    /// once, whatever it looks like. After less, today's path: tell iroh the
    /// network may have changed, and dial again only if it has closed.
    async fn resume(&self) {
        let away = self.away_since().take().map(|went| went.ago());
        let Some(link) = self
            .running
            .lock()
            .await
            .as_ref()
            .map(|run| run.link.clone())
        else {
            return;
        };
        link.begin_resume();
        let away_text = away.map_or_else(
            || "an unknown time".to_owned(),
            |away| format!("{:.1} s", away.as_secs_f64()),
        );
        let limit = HOST_IDLE_TIMEOUT.as_secs();
        if redial_on_resume(away) {
            // First, so a request sent on coming back fails at once on the old
            // connection, if at all, and then shares the dial.
            let closed = link.close_connection();
            log::info!(
                "kleio-link: back on screen after {away_text} away, at least the host's idle \
                 timeout ({limit} s): {}",
                if closed {
                    "closing the connection and dialling again"
                } else {
                    "the connection had closed; dialling again"
                }
            );
            link.endpoint().network_change().await;
            // The library logs how the dial went.
            let _ = link.connection().await;
            return;
        }
        link.endpoint().network_change().await;
        if link.status().connected {
            log::info!(
                "kleio-link: back on screen after {away_text} away, under the host's idle timeout \
                 ({limit} s), with the connection open"
            );
        } else {
            log::info!(
                "kleio-link: back on screen after {away_text} away, under the host's idle timeout \
                 ({limit} s), and the connection has closed: dialling again"
            );
            let _ = link.connection().await;
        }
    }

    /// A download over the link finished: see [`note_download`].
    async fn note_download(&self, bytes: u64, took: Duration) {
        if let Some(run) = self.running.lock().await.as_ref() {
            run.note_download(bytes, took);
        }
    }

    /// See [`through_relay`].
    async fn through_relay(&self) -> bool {
        self.running
            .lock()
            .await
            .as_ref()
            .and_then(|run| run.link.path())
            .is_none_or(|path| !path.direct)
    }

    /// The app went to the background: note when, unless it's noted already
    /// for this absence.
    fn note_background(&self) {
        self.away_since().get_or_insert_with(WentAway::now);
    }

    fn away_since(&self) -> MutexGuard<'_, Option<WentAway>> {
        // Every update is one assignment, so it's whole even if a holder
        // panicked.
        self.away_since
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    async fn status(&self) -> LinkStatusView {
        let loaded = load(&crate::home_dir());
        let running = self.running.lock().await;
        let link = running.as_ref().map(|run| &run.link);
        let status = link.map(Link::status);
        let path = link.and_then(Link::path);
        let record = loaded.as_ref().map(|loaded| &loaded.record);
        let through_relay = path.as_ref().is_some_and(|path| !path.direct);
        let relay = link
            .and_then(|link| link.route().relay().map(ToString::to_string))
            .or_else(|| record.map(|record| record.relay.clone()));
        let relay_n0 = relay
            .as_deref()
            .and_then(|relay| relay.parse::<RelayUrl>().ok())
            .is_some_and(|relay| is_n0_relay(&relay));
        LinkStatusView {
            paired: record.is_some(),
            active: super::remote().is_some_and(|r| r.link().is_some()),
            running: running.is_some(),
            error: self.failure().clone(),
            host: record.map(|record| record.host.clone()),
            host_key: record.map(|record| record.host_key.clone()),
            relay,
            relay_n0,
            refused: link
                .and_then(Link::refusal)
                .map(|refusal| refusal.to_string()),
            refusal: link
                .and_then(Link::refusal)
                .and_then(|refusal| refusal_kind(&refusal)),
            connected: status.is_some_and(|status| status.connected),
            dialling: link.is_some_and(Link::dialling),
            unreached: link.and_then(Link::unreached).map(UnreachedView::from),
            last_reached_ms: link
                .and_then(Link::last_heard)
                .and_then(|ago| SystemTime::now().checked_sub(ago))
                .map(epoch_ms),
            path: path
                .as_ref()
                .map(|path| if path.direct { "direct" } else { "relay" }),
            path_addr: path.as_ref().map(|path| path.addr.clone()),
            path_n0: through_relay
                && path
                    .as_ref()
                    .and_then(|path| path.addr.parse::<RelayUrl>().ok())
                    .is_some_and(|relay| is_n0_relay(&relay)),
            rate_limited: running
                .as_ref()
                .is_some_and(|run| run.rate_limited(through_relay)),
            rtt_ms: path.as_ref().map(|path| millis(path.rtt)),
            connected_since_ms: status
                .and_then(|status| status.connected_for)
                .and_then(|up| SystemTime::now().checked_sub(up))
                .map(epoch_ms),
            redials: status.map_or(0, |status| status.redials),
            last_resume_ms: link.and_then(Link::last_resume).map(millis),
            events: self
                .events
                .lines()
                .into_iter()
                .map(LinkEvent::from)
                .collect(),
            debug_build: cfg!(debug_assertions),
        }
    }

    fn failure(&self) -> MutexGuard<'_, Option<String>> {
        // Every update is one assignment, so it's whole even if a holder
        // panicked.
        self.failure.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set_failure(&self, failure: Option<String>) {
        *self.failure() = failure;
    }
}

/// At app setup: the link's state and log and, when this launch reaches the
/// host over the link, the link itself, forwarding on the listener the boot
/// read bound (`from_link`). Requests sent before this wait on that listener.
pub fn setup(app: &AppHandle) {
    // Fails only if a subscriber is set already, which then keeps the lines.
    let _ = tracing::subscriber::set_global_default(LogBridge);
    app.manage(LinkRuntime::default());
    app.manage(PairCancel::default());
    // The pairing QR's scanner: only the iPhone build has the plugin. Without
    // the grant, a scan fails and the pairing form says so.
    #[cfg(target_os = "ios")]
    if let Err(e) = app.add_capability(scanner_capability()) {
        log::warn!("kleio-link: the QR scanner isn't allowed: {e}");
    }
    watch_presence(app.clone());
    let Some(boot) = super::remote().and_then(Remote::link) else {
        return;
    };
    let runtime = app.state::<LinkRuntime>();
    let start = runtime.start(
        boot.key.clone(),
        boot.route.clone(),
        boot.socket.clone(),
        boot.take_listener(),
    );
    // Setup runs on the main thread, outside the async runtime, so it may
    // block here, briefly: starting binds sockets and waits for no network.
    match block_on_within(START_TIMEOUT, start) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => log::error!("kleio-link: {e}; the host can't be reached this launch"),
        Err(_) => {
            let e = format!("the link didn't start within {} s", START_TIMEOUT.as_secs());
            log::error!("kleio-link: {e}; the host can't be reached this launch");
            runtime.set_failure(Some(e));
        }
    }
    // A switch's cleanup, at launch: a good session from an earlier launch lets
    // it go on, or finish what it left (`switch.rs`).
    tauri::async_runtime::spawn(super::switch::run(crate::home_dir()));
}

/// Runs `task` on the async runtime from outside it, as setup does on the
/// main thread, and gives up after `limit`. The timer is made inside the
/// runtime: tokio panics when one is made outside, and a panic during launch
/// aborts the app.
fn block_on_within<F: Future>(
    limit: Duration,
    task: F,
) -> Result<F::Output, tokio::time::error::Elapsed> {
    tauri::async_runtime::block_on(async move { tokio::time::timeout(limit, task).await })
}

/// The app is coming back on screen (iPhone: `WindowEvent::Resumed`, before
/// `Presence` tells anything else). iOS can take a suspended app's listening
/// socket away (Apple's TN2277): the app's requests to the link are then
/// refused, and the listener never says so. So this checks something still
/// listens, and if not listens again at once, before anything sends, then
/// forwards on the new listener as soon as the runtime gets to it.
#[cfg_attr(desktop, allow(dead_code))]
pub fn listen_again(app: &AppHandle) {
    let Some(boot) = super::remote().and_then(Remote::link) else {
        return;
    };
    let Some(bound) = listen_if_gone(boot.socket()) else {
        return;
    };
    log::info!(
        "kleio-link: back on screen, and nothing was listening on its socket (iOS can close a \
         suspended app's sockets): listening again"
    );
    let listener = match bound {
        Ok(listener) => Some(listener),
        Err(e) => {
            log::warn!("kleio-link: can't listen on its socket here yet: {e}");
            None
        }
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        app.state::<LinkRuntime>().forward_again(listener).await;
    });
}

/// What [`listen_again`] does on the main thread: nothing while something
/// still listens on the socket at `path`, else a new listener there, bound
/// now, or why it couldn't be.
fn listen_if_gone(path: &Path) -> Option<std::io::Result<UnixListener>> {
    (!Forward::listening_private(path)).then(|| Forward::listen_private(path))
}

/// Each time the app goes to the background the link notes when, and each
/// time it comes back on screen the link resumes. If it went and came back
/// between two looks, the time away isn't known, and counts as long.
fn watch_presence(app: AppHandle) {
    let mut presence = app.state::<Presence>().subscribe();
    tauri::async_runtime::spawn(async move {
        let mut seen = *presence.borrow_and_update();
        while presence.changed().await.is_ok() {
            let now = *presence.borrow_and_update();
            let runtime = app.state::<LinkRuntime>();
            if !now.visible {
                runtime.note_background();
            } else if came_back(seen, now) {
                runtime.resume().await;
            }
            seen = now;
        }
    });
}

/// Whether coming back on screen after `away` in the background closes the
/// connection and dials again at once, rather than trusting it. After at
/// least the host's idle timeout, the host may have dropped it. A time not
/// known counts as long: a dial took 0.14–0.85 s on 2026-10-21, and a dead
/// connection cost about 30 s.
fn redial_on_resume(away: Option<Duration>) -> bool {
    away.is_none_or(|away| away >= HOST_IDLE_TIMEOUT)
}

/// When the app went to the background, by two clocks. `Instant` doesn't
/// count time the phone sleeps (on iOS it's Darwin's `CLOCK_UPTIME_RAW`), so
/// a locked phone's absence would read short; the wall clock counts it. The
/// longer of the two counts, which also covers the wall clock being set back.
#[derive(Debug, Clone, Copy)]
struct WentAway {
    wall: SystemTime,
    uptime: Instant,
}

impl WentAway {
    fn now() -> Self {
        Self {
            wall: SystemTime::now(),
            uptime: Instant::now(),
        }
    }

    /// How long ago, by the clock that says longer.
    fn ago(&self) -> Duration {
        let wall = SystemTime::now()
            .duration_since(self.wall)
            .unwrap_or_default();
        wall.max(self.uptime.elapsed())
    }
}

/// Whether the app came back on screen between two looks at `Presence`: it's
/// on screen now, and it was away then, or went away and came back between.
fn came_back(seen: OnScreen, now: OnScreen) -> bool {
    now.visible && (!seen.visible || now.changes.wrapping_sub(seen.changes) >= 2)
}

/// A download over the link finished: `bytes` in `took`, from asking to
/// the last byte (`files.rs`). One of at least [`SLOW_CHECK_BYTES`] through a
/// relay that came slower than [`SLOW_RELAY_BYTES_PER_S`] marks the
/// connection as slowed by its relay; a faster one clears the mark.
pub async fn note_download(app: &AppHandle, bytes: u64, took: Duration) {
    if let Some(runtime) = app.try_state::<LinkRuntime>() {
        runtime.note_download(bytes, took).await;
    }
}

/// Whether a download over the link now would come through a relay: yes,
/// unless the connection open now goes direct. Before one is open it's
/// taken to, as a connection starts on the relay (`files.rs`).
pub async fn through_relay(app: &AppHandle) -> bool {
    let Some(runtime) = app.try_state::<LinkRuntime>() else {
        return true;
    };
    runtime.through_relay().await
}

// ── Finding the host again ──────────────────────────────────────────────────

/// `GET /kleio/link`'s answer, as far as the app reads it
/// (packages/kleio-host/src/link.ts, `LinkInfo`).
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkInfo {
    key: String,
    relays: Vec<String>,
    addrs: Vec<String>,
    rate_limited: bool,
}

/// What the app takes from the host's answer.
#[derive(Debug, PartialEq, Eq)]
struct HostRoute {
    relays: Vec<RelayEntry>,
    addrs: Vec<SocketAddr>,
    rate_limited: bool,
}

/// The host's relay list and direct addresses, for the next dial, and
/// whether its relay is rate-limiting it: only from the host the link
/// dials, `host`, and only a list that passes the checks a ticket's does.
/// An address that doesn't is left out.
fn read_link_info(info: &LinkInfo, host: EndpointId) -> Result<HostRoute, String> {
    let key: EndpointId = info
        .key
        .parse()
        .map_err(|_| "its key isn't a key".to_string())?;
    if key != host {
        return Err(format!("it names another host ({})", key.fmt_short()));
    }
    let relays = check_relay_list(info.relays.iter().map(String::as_str))
        .ok_or_else(|| "its relay list isn't one".to_string())?;
    let addrs = info
        .addrs
        .iter()
        .filter_map(|addr| check_direct_addr(addr))
        .collect();
    Ok(HostRoute {
        relays,
        addrs,
        rate_limited: info.rate_limited,
    })
}

/// `record` with the route's relay, list and addresses, if any differs, for
/// the next launch. `None` when nothing has changed, or the record is for
/// another host, as after pairing again during this launch.
fn refreshed(record: &LinkRecord, route: &Route) -> Option<LinkRecord> {
    if record.host_key != route.key().to_string() {
        return None;
    }
    let mut next = record.clone();
    if let Some(relay) = route.relay() {
        next.relay = relay.to_string();
    }
    next.relays = route
        .relays()
        .iter()
        .map(|entry| entry.as_str().to_string())
        .collect();
    next.addrs = route.addrs().iter().map(ToString::to_string).collect();
    (next != *record).then_some(next)
}

/// After each new connection: the host's relay list, direct addresses and
/// rate-limit word, from `GET /kleio/link`, for the next dial and for
/// `link.json`. A host from before the route answers 404. A failure is
/// logged, and changes nothing. Only for the host boot chose: in the app it
/// has by now (`setup` asks first), and a test's link has none.
async fn refresh_route(link: &Link, throttle: &Throttle) {
    let Some(r) = super::remote_if_booted().filter(|r| r.link().is_some()) else {
        return;
    };
    let answer = fetch_link_info(r).await;
    if is_good_session(&answer) {
        // The switch's cleanup may go on (`switch.rs`).
        super::switch::after_good_session(&r.host, &r.device_id);
    }
    let info = match answer {
        Ok(Some(info)) => info,
        Ok(None) => return,
        Err(e) => {
            log::warn!("kleio-link: couldn't ask the host for its relays: {e}");
            return;
        }
    };
    let host = match read_link_info(&info, link.route().key()) {
        Ok(host) => host,
        Err(e) => {
            log::warn!("kleio-link: not taking the host's relays: {e}");
            return;
        }
    };
    throttle.host.store(host.rate_limited, Ordering::Release);
    link.refresh(host.relays, host.addrs);
    let home = crate::home_dir();
    let Some(Loaded { record, .. }) = load(&home) else {
        return;
    };
    if let Some(next) = refreshed(&record, &link.route()) {
        match save(&home, &next) {
            Ok(()) => log::info!(
                "kleio-link: kept the host's relays ({}) and addresses for the next launch",
                next.relays.join(", ")
            ),
            Err(e) => log::warn!("kleio-link: couldn't keep the host's relays: {e}"),
        }
    }
}

/// A good link session, for a switch's cleanup (`switch.rs`): the host
/// answered `GET /kleio/link` over the link, with this pairing's token, so the
/// link reaches it and it knows this pairing. No answer, or a host without the
/// route (404), isn't one.
fn is_good_session(answer: &Result<Option<LinkInfo>, String>) -> bool {
    matches!(answer, Ok(Some(_)))
}

/// `GET /kleio/link` over the link, with this device's token. `None` from a
/// host without it.
async fn fetch_link_info(r: &Remote) -> Result<Option<LinkInfo>, String> {
    let res = commands::api_client(r)?
        .get(format!("{}/kleio/link", r.base))
        .timeout(LINK_INFO_TIMEOUT)
        .send()
        .await
        .map_err(|e| commands::root_cause(&e))?;
    match res.status().as_u16() {
        200 => res
            .json::<LinkInfo>()
            .await
            .map(Some)
            .map_err(|e| commands::root_cause(&e)),
        404 => Ok(None),
        status => Err(format!("it answered HTTP {status}")),
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// What the confirm step shows for a scanned ticket.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketCheck {
    /// The host's name, as the ticket gives it.
    pub name: String,
    /// The host key's first 10 characters, as `kleio-host status` shows it.
    pub key_prefix: String,
    /// The pairing relay's host name.
    pub relay_host: String,
    /// The pair code, `ABC-DEF`.
    pub code: String,
}

/// Checks a scanned (or pasted) pairing ticket, for the confirm step. Its
/// errors say what's wrong in words a person can act on.
#[tauri::command]
pub fn kleio_link_check_ticket(ticket: String) -> Result<TicketCheck, String> {
    let ticket = parse_ticket(&ticket)?;
    Ok(TicketCheck {
        name: ticket.name().to_string(),
        key_prefix: ticket.key_prefix(),
        relay_host: ticket.relay_host().to_string(),
        code: ticket.code().to_string(),
    })
}

fn parse_ticket(raw: &str) -> Result<Ticket, String> {
    raw.trim().parse::<Ticket>().map_err(|e| e.to_string())
}

/// What `kleio_link_pair` ends with once `kleio_link_pair_cancel` stopped
/// it. The waiting screen's Cancel asked for that, so it shows nothing more.
pub const PAIRING_CANCELLED: &str = "Pairing was cancelled.";

/// Cancel on the phone's waiting screen (Tauri state): a link pairing under
/// way stops when `kleio_link_pair_cancel` bumps this.
pub struct PairCancel(tokio::sync::watch::Sender<u64>);

impl Default for PairCancel {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(0).0)
    }
}

impl PairCancel {
    /// Completes at the next cancel, so one before a pairing starts doesn't
    /// stop it.
    fn stopped(&self) -> impl Future<Output = ()> + Send + 'static {
        let mut cancels = self.0.subscribe();
        async move {
            // An error means the state is gone, and the app with it.
            let _ = cancels.changed().await;
        }
    }

    fn cancel(&self) {
        self.0
            .send_modify(|cancels| *cancels = cancels.wrapping_add(1));
    }
}

/// Stops the link pairing under way, if one is: Cancel on its waiting
/// screen. `kleio_link_pair` then asks the host no more, saves nothing and
/// ends with [`PAIRING_CANCELLED`].
#[tauri::command]
pub fn kleio_link_pair_cancel(cancel: State<'_, PairCancel>) {
    log::info!("kleio-link: cancelling the pairing under way");
    cancel.cancel();
}

/// Pairs over the link with the host a ticket names: reaches the ticket's
/// relay, dials the host's pairing key on `kleio/pair/0` and redeems the
/// ticket's code with a new key for this device, then waits for an admin's
/// Allow on the host. It tells `on_stage` each of those steps as it begins, if the
/// webview gave a channel: the wait with this device's code, which the
/// admin is asked about too. Each way that can fail has its own error
/// (`PairError`), and `kleio_link_pair_cancel` stops it with
/// [`PAIRING_CANCELLED`]. It saves the pairing apart from the
/// Tailscale one. Then it switches the pairing on as
/// `kleio_activate_pairing` does after `kleio_pair` (`super::activate_paired`):
/// in place on an iPhone that wasn't paired, at the next launch otherwise.
/// So don't call `kleio_activate_pairing` after this; `kleio_link_status`
/// says whether the link is active.
#[tauri::command]
pub async fn kleio_link_pair(
    app: AppHandle,
    webview: tauri::Webview,
    ticket: String,
    label: String,
    on_stage: Option<JavaScriptChannelId>,
) -> Result<store::HostRecord, String> {
    let ticket = parse_ticket(&ticket)?;
    let label = commands::label_or_default(&label);
    let home = crate::home_dir();
    let key = SecretKey::generate();
    let options = EndpointOptions::default();
    let probe =
        HttpsProbe::new(&options.trust).map_err(|e| format!("Can't start the link: {e}"))?;
    let stages = on_stage.map(|id| id.channel_on::<_, PairStage>(webview));
    let stage = |stage: PairStage| {
        log::info!("kleio-link: {}", stage.text());
        if let Some(stages) = &stages {
            // The webview may have gone: pairing carries on regardless.
            let _ = stages.send(stage);
        }
    };
    let stopped = app.state::<PairCancel>().stopped();
    let pairing = pair_until(
        key.clone(),
        &ticket,
        &label,
        &options,
        &probe,
        stage,
        stopped,
    );
    let Some(answer) = pairing.await else {
        log::info!("kleio-link: pairing cancelled");
        return Err(PAIRING_CANCELLED.to_string());
    };
    let payload = commands::checked_link_payload(answer.map_err(|e| e.to_string())?)?;
    let account = keychain_host(&payload.host);
    commands::keep_secrets(&account, &payload)?;
    keychain::put(&account, keychain::Secret::IrohKey, &encode_key(&key))?;
    let record = LinkRecord {
        host_key: ticket.key().to_string(),
        relay: ticket.relay().to_string(),
        relays: ticket
            .relays()
            .iter()
            .map(|entry| entry.as_str().to_string())
            .collect(),
        addrs: ticket.addrs().iter().map(ToString::to_string).collect(),
        preview_origin: payload.kept_preview_origin(),
        host: payload.host,
        device_id: payload.device_id,
        label: payload.label,
        admin: payload.control_credential.is_some(),
        paired_at: commands::now_iso(),
    };
    save(&home, &record)?;
    // A new link pairing starts a switch's cleanup afresh: an earlier
    // pairing's marks name another device, and count for nothing.
    if let Err(e) = super::switch::clear(&home) {
        log::warn!("kleio-switch: couldn't clear switch.json: {e}");
    }
    log::info!(
        "kleio-link: paired to {} as {} (admin={})",
        record.host,
        record.label,
        record.admin
    );
    // Switching on in place starts a session at once, so the listener goes
    // up first. `kleio_activate_pairing` switches in place exactly then.
    if cfg!(mobile) && super::remote().is_none() {
        app.state::<LinkRuntime>()
            .start(key, Route::from_ticket(&ticket), socket_path(&home), None)
            .await
            .map_err(|e| format!("Paired, but {e}."))?;
    }
    crate::kleio_activate_pairing(app).await?;
    Ok(store::HostRecord {
        base_url: LINK_BASE.to_string(),
        host: record.host,
        device_id: record.device_id,
        label: record.label,
        admin: record.admin,
        paired_at: record.paired_at,
        preview_origin: record.preview_origin,
    })
}

/// What `kleio_link_status` reports, for the Link card.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatusView {
    /// A link pairing is saved.
    pub paired: bool,
    /// This launch reaches the host over the link.
    pub active: bool,
    /// The link is running in this launch.
    pub running: bool,
    /// Why it couldn't start, if it couldn't.
    pub error: Option<String>,
    /// The host's name, as it reports it.
    pub host: Option<String>,
    /// The host's iroh key.
    pub host_key: Option<String>,
    /// The relay the host was last reached through.
    pub relay: Option<String>,
    /// `relay` is one of n0's public relays.
    pub relay_n0: bool,
    /// Why the host turned this device away, if it did: not paired, or
    /// removed.
    pub refused: Option<String>,
    /// How: `not-paired` or `revoked`.
    pub refusal: Option<&'static str>,
    /// A connection to the host is open now.
    pub connected: bool,
    /// A dial to the host is under way.
    pub dialling: bool,
    /// Why the latest dial found no host, once the link has looked.
    pub unreached: Option<UnreachedView>,
    /// When bytes last came from the host, in milliseconds since 1970.
    pub last_reached_ms: Option<u64>,
    /// The open connection's path: `"relay"` or `"direct"`.
    pub path: Option<&'static str>,
    /// The relay's URL, or the direct path's `ip:port`.
    pub path_addr: Option<String>,
    /// The open connection goes through one of n0's public relays.
    pub path_n0: bool,
    /// A relay is slowing the open connection: it told this device or the
    /// host so, or a big download through it came slower than
    /// [`SLOW_RELAY_BYTES_PER_S`].
    pub rate_limited: bool,
    pub rtt_ms: Option<u64>,
    /// When the open connection came up, in milliseconds since 1970.
    pub connected_since_ms: Option<u64>,
    /// Dials since the first connection, whether or not they connected.
    pub redials: u64,
    /// The latest resume, from coming back on screen to the first byte back.
    pub last_resume_ms: Option<u64>,
    /// The latest path events, oldest first.
    pub events: Vec<LinkEvent>,
    /// A debug build, whose pairing form on the iPhone also takes pasted
    /// pairing text, as the Mac's always does: the simulator has no camera.
    /// The webview can't tell, as `tauri build --debug` still builds it in
    /// production mode.
    pub debug_build: bool,
}

/// Why the latest dial found no host (`Unreached`), for the app's words.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreachedView {
    /// `host-silent`: a relay answered, the host didn't. `no-relay`: no relay
    /// answered. `relay-refused`: the relay turned this version away.
    pub kind: &'static str,
    /// Every relay tried (`no-relay`), or the one that turned this version
    /// away (`relay-refused`).
    pub relays: Vec<RelayName>,
}

/// A relay, as the app names it.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayName {
    /// Its host name, without the final dot n0's addresses have.
    pub host: String,
    /// One of n0's public relays.
    pub n0: bool,
}

impl From<&RelayUrl> for RelayName {
    fn from(relay: &RelayUrl) -> Self {
        Self {
            host: relay
                .host_str()
                .unwrap_or_default()
                .trim_end_matches('.')
                .to_string(),
            n0: is_n0_relay(relay),
        }
    }
}

impl From<Unreached> for UnreachedView {
    fn from(why: Unreached) -> Self {
        let (kind, relays) = match why {
            Unreached::HostSilent => ("host-silent", Vec::new()),
            Unreached::NoRelay { tried } => ("no-relay", tried),
            Unreached::RelayRefused { relay } => ("relay-refused", vec![relay]),
        };
        Self {
            kind,
            relays: relays.iter().map(RelayName::from).collect(),
        }
    }
}

/// The host's refusal, as `kleio_link_status` names it.
fn refusal_kind(refusal: &LinkError) -> Option<&'static str> {
    match refusal {
        LinkError::NotPaired => Some("not-paired"),
        LinkError::Revoked => Some("revoked"),
        LinkError::Dial(_) | LinkError::TimedOut => None,
    }
}

/// One path event, for the Link card.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEvent {
    /// When it happened, in milliseconds since 1970.
    pub at_ms: u64,
    pub text: String,
}

impl From<PathLine> for LinkEvent {
    fn from(line: PathLine) -> Self {
        Self {
            at_ms: epoch_ms(line.at),
            text: line.text,
        }
    }
}

/// The link, for the Link card. Never dials.
#[tauri::command]
pub async fn kleio_link_status(runtime: State<'_, LinkRuntime>) -> Result<LinkStatusView, String> {
    Ok(runtime.status().await)
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn epoch_ms(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH).map_or(0, millis)
}

// ── The log ─────────────────────────────────────────────────────────────────

/// Passes the kleio-link library's `tracing` lines at info and up, and every
/// other crate's at warn and up (iroh's relay warnings, say), to the app's
/// `log`. Spans are left out: nothing here reads them.
struct LogBridge;

/// The quietest level passed on from `target`.
fn threshold(target: &str) -> tracing::Level {
    let ours = target == "kleio_link" || target.starts_with("kleio_link::");
    if ours {
        tracing::Level::INFO
    } else {
        tracing::Level::WARN
    }
}

fn passes(meta: &tracing::Metadata<'_>) -> bool {
    meta.is_event() && *meta.level() <= threshold(meta.target())
}

impl tracing::Subscriber for LogBridge {
    fn register_callsite(
        &self,
        meta: &'static tracing::Metadata<'static>,
    ) -> tracing::subscriber::Interest {
        if passes(meta) {
            tracing::subscriber::Interest::always()
        } else {
            tracing::subscriber::Interest::never()
        }
    }

    fn enabled(&self, meta: &tracing::Metadata<'_>) -> bool {
        passes(meta)
    }

    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        Some(tracing::level_filters::LevelFilter::INFO)
    }

    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        // Never called: `enabled` turns every span away.
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let meta = event.metadata();
        let level = match *meta.level() {
            tracing::Level::ERROR => log::Level::Error,
            tracing::Level::WARN => log::Level::Warn,
            tracing::Level::INFO => log::Level::Info,
            tracing::Level::DEBUG => log::Level::Debug,
            _ => log::Level::Trace,
        };
        let logger = log::logger();
        let wanted = log::Metadata::builder()
            .level(level)
            .target(meta.target())
            .build();
        if level > log::max_level() || !logger.enabled(&wanted) {
            return;
        }
        logger.log(
            &log::Record::builder()
                .metadata(wanted)
                .module_path(meta.module_path())
                .file(meta.file())
                .line(meta.line())
                .args(format_args!("{}", render(event)))
                .build(),
        );
    }

    fn enter(&self, _: &tracing::span::Id) {}

    fn exit(&self, _: &tracing::span::Id) {}
}

/// An event's message, then its other fields as `name=value`.
fn render(event: &tracing::Event<'_>) -> String {
    let mut line = Line::default();
    event.record(&mut line);
    line.message + &line.fields
}

#[derive(Default)]
struct Line {
    message: String,
    fields: String,
}

impl tracing::field::Visit for Line {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
        use fmt::Write as _;
        let _ = if field.name() == "message" {
            write!(self.message, "{value:?}")
        } else {
            write!(self.fields, " {}={value:?}", field.name())
        };
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;

    use kleio_link::iroh::EndpointAddr;

    use super::*;

    /// One dir per call, as `store.rs`'s tests make them.
    fn tmp_home() -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "kleio-link-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const RELAY: &str = "https://euc1-1.relay.n0.iroh.link./";

    fn host_key() -> EndpointId {
        SecretKey::from_bytes(&[7; 32]).public()
    }

    /// The host's pairing key, which a v5 ticket carries beside its key.
    fn pair_key() -> EndpointId {
        SecretKey::from_bytes(&[8; 32]).public()
    }

    fn record() -> LinkRecord {
        LinkRecord {
            host_key: host_key().to_string(),
            relay: RELAY.into(),
            relays: vec![RELAY.into(), "n0".into()],
            addrs: vec!["192.168.1.20:52043".into()],
            host: "mac-mini-1.x.ts.net".into(),
            device_id: "dev-1".into(),
            label: "iPhone".into(),
            admin: false,
            paired_at: "2026-10-17T00:00:00Z".into(),
            preview_origin: Some("https://mac-mini-1.x.ts.net:8444".into()),
        }
    }

    #[test]
    fn cancel_stops_a_pairing_under_way_but_not_one_started_after() {
        let cancel = PairCancel::default();
        let ms = Duration::from_millis;
        assert!(block_on_within(ms(20), cancel.stopped()).is_err());
        let under_way = cancel.stopped();
        cancel.cancel();
        assert_eq!(block_on_within(Duration::from_secs(5), under_way), Ok(()));
        assert!(block_on_within(ms(20), cancel.stopped()).is_err());
    }

    #[test]
    fn a_big_slow_download_through_a_relay_says_the_relay_is_slowing_it() {
        const MIB_45: u64 = 45 * 1024 * 1024;
        // 45 MiB in 44.6 s, as through n0's relay on 2026-10-20: 1.06 MB/s.
        assert_eq!(
            slowed_by_relay(MIB_45, Duration::from_millis(44_600), true),
            Some(true)
        );
        assert_eq!(
            slowed_by_relay(MIB_45, Duration::from_secs(20), true),
            Some(false),
            "2.4 MB/s"
        );
        // Under 10 MB says nothing: n0's relays let the first 5 MiB through
        // faster. Nor does a direct path, however slow.
        assert_eq!(
            slowed_by_relay(9_000_000, Duration::from_secs(60), true),
            None
        );
        assert_eq!(
            slowed_by_relay(MIB_45, Duration::from_secs(300), false),
            None
        );
        assert_eq!(slowed_by_relay(MIB_45, Duration::ZERO, true), None);
    }

    fn link_info(key: &str, relays: &[&str], addrs: &[&str], rate_limited: bool) -> LinkInfo {
        LinkInfo {
            key: key.to_string(),
            relays: relays.iter().map(ToString::to_string).collect(),
            addrs: addrs.iter().map(ToString::to_string).collect(),
            rate_limited,
        }
    }

    #[test]
    fn only_the_hosts_answer_over_the_link_is_a_good_session_for_the_switch() {
        // GET /kleio/link answered with this pairing's token: the link works.
        let answered = Ok(Some(link_info(
            &host_key().to_string(),
            &["n0"],
            &[],
            false,
        )));
        assert!(is_good_session(&answered));
        // No answer, or a host without the route: the old pairing stays.
        assert!(!is_good_session(&Ok(None)));
        assert!(!is_good_session(&Err("it answered HTTP 401".to_string())));
        assert!(!is_good_session(&Err("connection refused".to_string())));
    }

    #[test]
    fn takes_the_hosts_relays_only_from_the_host_it_dials() {
        let host = host_key().to_string();
        // kleio-host's answer as it is (link.ts `readLinkInfo`).
        let answer = format!(
            r#"{{"key":"{host}","relays":["https://relay.example.com/","n0"],"listVersion":3,
                "running":true,"relay":"https://relay.example.com/",
                "addrs":["203.0.113.7:7842","not an address","127.0.0.1:7842"],
                "rateLimited":true,"updatedAt":"2026-10-23T12:00:00.000Z"}}"#
        );
        let info: LinkInfo = serde_json::from_str(&answer).expect("reads");
        assert_eq!(
            read_link_info(&info, host_key()),
            Ok(HostRoute {
                relays: vec![
                    RelayEntry::Url("https://relay.example.com/".parse().unwrap()),
                    RelayEntry::N0
                ],
                addrs: vec!["203.0.113.7:7842".parse().unwrap()],
                rate_limited: true,
            })
        );
        // Another host's answer, or a list a ticket couldn't carry, changes
        // nothing.
        let other = SecretKey::from_bytes(&[9; 32]).public().to_string();
        for (info, why) in [
            (link_info(&other, &["n0"], &[], false), "another host"),
            (link_info("not a key", &["n0"], &[], false), "isn't a key"),
            (link_info(&host, &[], &[], false), "isn't one"),
            (
                link_info(&host, &["http://relay.example.com/"], &[], false),
                "isn't one",
            ),
            (link_info(&host, &["n0", "n0"], &[], false), "isn't one"),
        ] {
            let read = read_link_info(&info, host_key());
            assert!(
                read.as_ref().is_err_and(|e| e.contains(why)),
                "{info:?}: {read:?}"
            );
        }
    }

    #[test]
    fn keeps_what_the_host_said_for_the_next_launch() {
        let record = record();
        let route = dialled(&record).expect("dials");
        assert_eq!(refreshed(&record, &route), None, "nothing new");

        let moved: RelayUrl = "https://relay.example.com/".parse().unwrap();
        let route = Route::new(
            host_key(),
            Some(moved.clone()),
            vec!["203.0.113.7:7842".parse().unwrap()],
            vec![RelayEntry::Url(moved.clone()), RelayEntry::N0],
        );
        let next = refreshed(&record, &route).expect("something changed");
        assert_eq!(next.relay, "https://relay.example.com/");
        assert_eq!(next.relays, ["https://relay.example.com/", "n0"]);
        assert_eq!(next.addrs, ["203.0.113.7:7842"]);
        let rest = LinkRecord {
            relay: record.relay.clone(),
            relays: record.relays.clone(),
            addrs: record.addrs.clone(),
            ..next
        };
        assert_eq!(rest, record, "and nothing else");

        // A pairing to another host, as after pairing again during this
        // launch, is left alone.
        let other = LinkRecord {
            host_key: SecretKey::from_bytes(&[9; 32]).public().to_string(),
            ..record
        };
        assert_eq!(refreshed(&other, &route), None);
    }

    #[test]
    fn names_the_relays_it_couldnt_reach() {
        let n0: RelayUrl = RELAY.parse().unwrap();
        let own: RelayUrl = "https://relay.example.com/".parse().unwrap();
        let view = UnreachedView::from(Unreached::NoRelay {
            tried: vec![own, n0.clone()],
        });
        assert_eq!(
            serde_json::to_value(&view).unwrap(),
            serde_json::json!({"kind": "no-relay", "relays": [
                {"host": "relay.example.com", "n0": false},
                {"host": "euc1-1.relay.n0.iroh.link", "n0": true},
            ]})
        );
        assert_eq!(
            UnreachedView::from(Unreached::HostSilent),
            UnreachedView {
                kind: "host-silent",
                relays: Vec::new()
            }
        );
        let refused = UnreachedView::from(Unreached::RelayRefused { relay: n0 });
        assert_eq!((refused.kind, refused.relays.len()), ("relay-refused", 1));
        assert_eq!(refusal_kind(&LinkError::NotPaired), Some("not-paired"));
        assert_eq!(refusal_kind(&LinkError::Revoked), Some("revoked"));
        assert_eq!(refusal_kind(&LinkError::TimedOut), None);
    }

    #[test]
    fn the_links_socket_fits_where_a_socket_can_be() {
        // An iPhone app's container, as its HOME names it: 84 bytes.
        let container = Path::new(
            "/private/var/mobile/Containers/Data/Application/0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D",
        );
        let iphone = socket_path_on(container, true);
        assert_eq!(iphone, container.join("tmp/kl/link"));
        assert_eq!(iphone.as_os_str().len(), 96);
        assert!(iphone.as_os_str().len() <= kleio_link::forward::SOCKET_PATH_MAX);
        assert_eq!(
            socket_path_on(Path::new("/Users/someone"), false),
            Path::new("/Users/someone/.kleio/run/link.sock")
        );
    }

    #[test]
    fn keeps_the_link_pairing_apart_from_the_tailscale_one() {
        let home = tmp_home();
        assert!(load(&home).is_none());
        save(&home, &record()).unwrap();
        let loaded = load(&home).expect("loads");
        assert_eq!(loaded.record, record());
        let relay = check_relay_url(RELAY).unwrap();
        assert_eq!(
            loaded.route,
            Route::new(
                host_key(),
                Some(relay.clone()),
                vec!["192.168.1.20:52043".parse().unwrap()],
                vec![RelayEntry::Url(relay), RelayEntry::N0],
            )
        );
        // Beside remote.json, which it leaves alone, and 0600 with no temp
        // file left behind.
        let dir = super::super::state_dir(&home);
        assert_eq!(path(&home), dir.join("link.json"));
        assert!(!store::path(&home).exists());
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["link.json"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path(&home)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // Its Keychain entries go under their own name, too.
        assert_eq!(
            keychain_host("mac-mini-1.x.ts.net"),
            "link-mac-mini-1.x.ts.net"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn grants_the_main_window_only_scan_cancel_and_the_permission_checks() {
        use tauri::ipc::RuntimeCapability;
        use tauri::utils::acl::capability::CapabilityFile;
        let CapabilityFile::Capability(capability) = scanner_capability().build() else {
            panic!("one capability");
        };
        assert_eq!(capability.windows, ["main"]);
        let granted: Vec<&str> = capability
            .permissions
            .iter()
            .map(|p| p.identifier().get())
            .collect();
        assert_eq!(
            granted,
            [
                "barcode-scanner:allow-scan",
                "barcode-scanner:allow-cancel",
                "barcode-scanner:allow-check-permissions",
                "barcode-scanner:allow-request-permissions",
            ]
        );
    }

    #[test]
    fn shows_the_link_pairing_as_the_paired_host_at_the_links_url() {
        let home = tmp_home();
        assert_eq!(paired_record(&home), None);
        save(&home, &record()).unwrap();
        assert_eq!(
            paired_record(&home),
            Some(store::HostRecord {
                base_url: LINK_BASE.to_string(),
                host: "mac-mini-1.x.ts.net".into(),
                device_id: "dev-1".into(),
                label: "iPhone".into(),
                admin: false,
                paired_at: "2026-10-17T00:00:00Z".into(),
                preview_origin: Some("https://mac-mini-1.x.ts.net:8444".into()),
            })
        );
        // One it can't dial isn't shown, as boot doesn't use it.
        save(
            &home,
            &LinkRecord {
                host_key: "not a key".into(),
                ..record()
            },
        )
        .unwrap();
        assert_eq!(paired_record(&home), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn ignores_a_link_pairing_it_cant_dial() {
        let home = tmp_home();
        for bad in [
            LinkRecord {
                host_key: "not a key".into(),
                ..record()
            },
            LinkRecord {
                relay: "http://euc1-1.relay.n0.iroh.link./".into(),
                ..record()
            },
            LinkRecord {
                host: " ".into(),
                ..record()
            },
            LinkRecord {
                device_id: String::new(),
                ..record()
            },
        ] {
            save(&home, &bad).unwrap();
            assert!(load(&home).is_none(), "{bad:?}");
        }
        std::fs::write(path(&home), "not json").unwrap();
        assert!(load(&home).is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The pairing the next launch uses (`super::paired_now`, in
    /// `super::from_paired`'s order): the link pairing, then `remote.json`.
    /// A link record it can't dial, or none, leaves `remote.json`'s.
    #[test]
    fn the_next_launch_takes_the_link_pairing_before_remote_json() {
        let home = tmp_home();
        let by_address = store::HostRecord {
            base_url: "https://mac-mini-1.x.ts.net:8443".into(),
            host: "mac-mini-1.x.ts.net".into(),
            device_id: "dev-0".into(),
            label: "Laptop".into(),
            admin: true,
            paired_at: "2026-10-01T00:00:00Z".into(),
            preview_origin: None,
        };
        assert_eq!(super::super::paired_now(&home), None);
        store::save(&home, &by_address).unwrap();
        assert_eq!(super::super::paired_now(&home), Some(by_address.clone()));

        save(&home, &record()).unwrap();
        let next = super::super::paired_now(&home).expect("a pairing");
        assert_eq!(next.base_url, LINK_BASE);
        assert_eq!(Some(next), paired_record(&home));

        let undialable = LinkRecord {
            host_key: "not a key".into(),
            ..record()
        };
        save(&home, &undialable).unwrap();
        assert_eq!(super::super::paired_now(&home), Some(by_address.clone()));
        std::fs::remove_file(path(&home)).unwrap();
        assert_eq!(super::super::paired_now(&home), Some(by_address));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A pairing from before relay lists dials its relay alone, and an entry
    /// or address that can't be read is left out rather than losing the
    /// pairing.
    #[test]
    fn a_record_without_a_relay_list_dials_its_relay() {
        let home = tmp_home();
        let relay = check_relay_url(RELAY).unwrap();
        for (relays, addrs) in [
            (vec![], vec![]),
            (
                vec!["http://not.a.relay/".to_string()],
                vec!["127.0.0.1:1".to_string()],
            ),
        ] {
            save(
                &home,
                &LinkRecord {
                    relays,
                    addrs,
                    ..record()
                },
            )
            .unwrap();
            let route = load(&home).expect("loads").route;
            assert_eq!(route.relays(), [RelayEntry::Url(relay.clone())]);
            assert_eq!(route.addrs(), []);
            assert_eq!(route.relay(), Some(&relay));
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_record_without_an_admin_flag_is_not_admin() {
        let home = tmp_home();
        std::fs::create_dir_all(super::super::state_dir(&home)).unwrap();
        let written = serde_json::json!({
            "hostKey": host_key().to_string(),
            "relay": RELAY,
            "host": "h",
            "deviceId": "d",
            "label": "l",
            "pairedAt": "t",
        });
        std::fs::write(path(&home), written.to_string()).unwrap();
        let loaded = load(&home).expect("loads");
        assert!(!loaded.record.admin);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The prototype's builds saved a mode, which is gone: such a pairing
    /// still loads, as it was.
    #[test]
    fn a_record_from_before_with_a_mode_still_loads() {
        let home = tmp_home();
        std::fs::create_dir_all(super::super::state_dir(&home)).unwrap();
        let mut written = serde_json::to_value(record()).unwrap();
        written["mode"] = "relayOnly".into();
        std::fs::write(path(&home), written.to_string()).unwrap();
        assert_eq!(load(&home).expect("loads").record, record());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn keeps_this_devices_key_as_text() {
        let key = SecretKey::from_bytes(&[9; 32]);
        let text = encode_key(&key);
        assert_eq!(decode_key(&text).map(|k| k.public()), Some(key.public()));
        assert!(decode_key("not base64!").is_none());
        let short = base64::engine::general_purpose::STANDARD.encode([9u8; 31]);
        assert!(decode_key(&short).is_none());
    }

    #[test]
    fn a_ticket_check_shows_what_the_confirm_step_needs() {
        let ticket = serde_json::json!({
            "v": 5,
            "type": "kleio-pair",
            "name": "mac-mini-1",
            "key": host_key().to_string(),
            "pair": pair_key().to_string(),
            "relays": [RELAY, "n0"],
            "code": "ABC-DEF",
        });
        // The host's key, not the pairing key: the one `kleio-host status`
        // shows, and the one this device reaches once allowed.
        let shown = || TicketCheck {
            name: "mac-mini-1".into(),
            key_prefix: host_key().to_string()[..10].to_string(),
            relay_host: "euc1-1.relay.n0.iroh.link.".into(),
            code: "ABC-DEF".into(),
        };
        assert_eq!(kleio_link_check_ticket(format!(" {ticket}\n")), Ok(shown()));
        // A host not yet updated makes v4 tickets, with addresses.
        let v4 = serde_json::json!({
            "v": 4,
            "type": "kleio-pair",
            "name": "mac-mini-1",
            "key": host_key().to_string(),
            "relays": [RELAY, "n0"],
            "addrs": ["192.168.1.20:52043"],
            "code": "ABC-DEF",
        });
        assert_eq!(kleio_link_check_ticket(v4.to_string()), Ok(shown()));
        assert_eq!(
            kleio_link_check_ticket("{}".into()),
            Err("That isn't a Kleio pairing code.".to_string())
        );
        // The prototype's v3 ticket says where it came from.
        let v3 = format!(
            r#"{{"v":3,"type":"kleio-pair","key":"{}","relay":"{RELAY}","code":"ABC-DEF"}}"#,
            host_key()
        );
        assert!(kleio_link_check_ticket(v3)
            .unwrap_err()
            .contains("test build"));
    }

    #[test]
    fn a_resume_is_coming_back_on_screen_after_going_away() {
        let at = |changes, visible| OnScreen { changes, visible };
        assert!(came_back(at(1, false), at(2, true)));
        // Away and back between two looks.
        assert!(came_back(at(0, true), at(2, true)));
        // Going away, or a foreground while already on screen, isn't one.
        assert!(!came_back(at(0, true), at(1, false)));
        assert!(!came_back(at(0, true), at(1, true)));
        assert!(!came_back(at(0, true), at(3, false)));
    }

    /// Back from the background, the connection is kept under the host's idle
    /// timeout, and closed and dialled again at once from it on, or after a
    /// time not known.
    #[test]
    fn resuming_redials_at_once_from_the_hosts_idle_timeout_on() {
        assert!(!redial_on_resume(Some(Duration::ZERO)));
        assert!(!redial_on_resume(Some(Duration::from_secs(29))));
        assert!(!redial_on_resume(Some(
            HOST_IDLE_TIMEOUT - Duration::from_millis(1)
        )));
        assert!(redial_on_resume(Some(HOST_IDLE_TIMEOUT)));
        // About the 2026-10-21 15:04 return's 6.6 minutes.
        assert!(redial_on_resume(Some(Duration::from_secs(400))));
        assert!(redial_on_resume(None));
    }

    /// The time away is the longer of the two clocks': the wall clock's, which
    /// counts a sleeping phone's time, or `Instant`'s, if the wall clock was set
    /// back meanwhile.
    #[test]
    fn the_time_away_is_the_longer_clocks() {
        let now = Instant::now();
        let slept = WentAway {
            wall: SystemTime::now() - Duration::from_secs(400),
            uptime: now,
        };
        assert!(slept.ago() >= Duration::from_secs(400));
        let set_back = WentAway {
            wall: SystemTime::now() + Duration::from_secs(3600),
            uptime: now
                .checked_sub(Duration::from_secs(40))
                .expect("an earlier instant"),
        };
        let ago = set_back.ago();
        assert!(ago >= Duration::from_secs(40), "{ago:?}");
        assert!(ago < Duration::from_secs(60), "{ago:?}");
    }

    /// An absence is timed from the first move to the background seen, and
    /// the resume takes it, so the next absence starts afresh.
    #[test]
    fn times_an_absence_from_its_start_until_the_resume() {
        let runtime = LinkRuntime::default();
        runtime.note_background();
        let first = runtime.away_since().expect("noted").wall;
        std::thread::sleep(Duration::from_millis(5));
        runtime.note_background();
        assert_eq!(runtime.away_since().map(|went| went.wall), Some(first));
        // No link runs here: the resume only takes the time.
        tauri::async_runtime::block_on(runtime.resume());
        assert!(runtime.away_since().is_none(), "the resume took it");
    }

    /// Setup starts a saved link from the main thread, outside the async
    /// runtime. Its timer used to be made there, which panicked, so every
    /// launch with a link pairing saved aborted.
    #[test]
    fn starts_from_outside_the_runtime_and_gives_up_after_the_limit() {
        assert_eq!(block_on_within(Duration::from_secs(5), async { 7 }), Ok(7));
        let hung = block_on_within(Duration::from_millis(10), std::future::pending::<()>());
        assert!(hung.is_err(), "{hung:?}");
    }

    /// A loopback endpoint with no relay, as kleio-link's own tests make
    /// them: the test needs no network.
    async fn loopback_endpoint(seed: u8, alpns: &[&[u8]]) -> Endpoint {
        kleio_link::endpoint::builder(
            SecretKey::from_bytes(&[seed; 32]),
            kleio_link::iroh::RelayMode::Disabled,
            &EndpointOptions::default(),
        )
        .alpns(alpns.iter().map(|alpn| alpn.to_vec()).collect())
        .bind_addr("127.0.0.1:0")
        .expect("a loopback address")
        .bind_addr("[::1]:0")
        .expect("a loopback address")
        .bind()
        .await
        .expect("an endpoint binds on loopback")
    }

    /// A host that answers each stream with what the app sent on it.
    async fn echo_host(endpoint: Endpoint) {
        while let Some(incoming) = endpoint.accept().await {
            let Ok(conn) = incoming.await else { continue };
            tauri::async_runtime::spawn(async move {
                while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                    tauri::async_runtime::spawn(async move {
                        if let Ok(body) = recv.read_to_end(1 << 16).await {
                            let _ = send.write_all(&body).await;
                            let _ = send.finish();
                        }
                    });
                }
            });
        }
    }

    /// A host that answers each request with an HTTP reply carrying the
    /// request's head, as kleio-host got it.
    async fn http_host(endpoint: Endpoint) {
        while let Some(incoming) = endpoint.accept().await {
            let Ok(conn) = incoming.await else { continue };
            tauri::async_runtime::spawn(async move {
                while let Ok((mut send, mut recv)) = conn.accept_bi().await {
                    tauri::async_runtime::spawn(async move {
                        let mut head = Vec::new();
                        let mut chunk = [0; 1024];
                        while !head.windows(4).any(|end| end == b"\r\n\r\n") {
                            match recv.read(&mut chunk).await {
                                Ok(Some(read)) => head.extend_from_slice(&chunk[..read]),
                                _ => return,
                            }
                        }
                        let reply = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            head.len()
                        );
                        let _ = send.write_all(reply.as_bytes()).await;
                        let _ = send.write_all(&head).await;
                        let _ = send.finish();
                    });
                }
            });
        }
    }

    /// How long a test waits on loopback before it fails.
    const WAIT: Duration = Duration::from_secs(20);

    /// A request on a new connection to the socket at `path`, half-closed
    /// once sent.
    fn send_request(path: &Path, body: &[u8]) -> UnixStream {
        use std::io::Write;
        let mut stream = UnixStream::connect(path).expect("taken at once");
        stream.set_read_timeout(Some(WAIT)).expect("a read timeout");
        stream.write_all(body).expect("the request is taken");
        stream
            .shutdown(std::net::Shutdown::Write)
            .expect("half-closes");
        stream
    }

    /// The whole answer to a request.
    fn read_reply(mut stream: UnixStream) -> Vec<u8> {
        use std::io::Read;
        let mut back = Vec::new();
        stream.read_to_end(&mut back).expect("an answer");
        back
    }

    /// The link between loopback endpoints (keys from `seed` and `seed + 1`),
    /// forwarding on `listener`, at `socket`, as setup does on the boot
    /// read's, to a host that echoes what it gets.
    async fn running_on(listener: UnixListener, socket: PathBuf, seed: u8) -> Running {
        running_with(listener, socket, seed, echo_host).await
    }

    /// [`running_on`], to a host that does what `host_does`.
    async fn running_with<H, F>(
        listener: UnixListener,
        socket: PathBuf,
        seed: u8,
        host_does: H,
    ) -> Running
    where
        H: FnOnce(Endpoint) -> F,
        F: Future<Output = ()> + Send + 'static,
    {
        let host = loopback_endpoint(seed, &[kleio_link::ALPN_HTTP]).await;
        let phone = loopback_endpoint(seed + 1, &[]).await;
        tauri::async_runtime::spawn(host_does(host.clone()));
        let udp = host
            .bound_sockets()
            .into_iter()
            .find(|socket| socket.is_ipv4())
            .expect("a bound IPv4 loopback socket");
        Running::start_on(
            phone,
            EndpointAddr::from(host.id()).with_ip_addr(udp).into(),
            PathEvents::new(KEPT_EVENTS),
            socket,
            Some(listener),
        )
        .await
        .expect("starts")
    }

    /// A slow download through a relay marks the connection it came on, and
    /// only that one; a direct one says nothing either way.
    #[test]
    fn marks_only_the_connection_a_slow_download_came_on() {
        let home = tmp_home();
        let path = socket_path_on(&home, false);
        let listener = Forward::listen_private(&path).expect("listens on its socket");
        let running = block_on_within(WAIT, running_on(listener, path, 41)).expect("starts");
        block_on_within(WAIT, running.link.connection())
            .expect("within 20 s")
            .expect("connects");
        assert!(!running.rate_limited(true), "nothing has said so");

        // As `note_download` marks one through a relay (this one's direct).
        let on = running.connection_number() + 1;
        running.throttle.slow_on.store(on, Ordering::Release);
        assert!(running.rate_limited(true));
        assert!(!running.rate_limited(false), "a direct path isn't slowed");

        running.link.close_connection();
        block_on_within(WAIT, running.link.connection())
            .expect("within 20 s")
            .expect("dials again");
        assert!(
            !running.rate_limited(true),
            "a new connection starts unmarked"
        );
        // A download that went direct says nothing either way.
        running.note_download(SLOW_CHECK_BYTES * 5, Duration::from_secs(600));
        assert_eq!(running.throttle.slow_on.load(Ordering::Acquire), on);
        assert!(!running.rate_limited(true));
        block_on_within(WAIT, running.stop()).expect("stops");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The listener is up from the boot read, so a request sent before setup
    /// forwards (step 16's Live Activity token) is taken at once and answered
    /// once setup has started; and as soon as setup's start returns, a new
    /// connection is forwarded too, on that same listener.
    #[test]
    fn the_boot_listener_takes_requests_at_once_and_setup_forwards_them() {
        // The boot read's socket, under a test home. Nothing forwards yet, and
        // a request is taken all the same: it waits in the backlog.
        let home = tmp_home();
        let path = socket_path_on(&home, false);
        let listener = Forward::listen_private(&path).expect("listens on its socket");
        let early = send_request(&path, b"sent before setup");
        let boot = LinkBoot {
            route: EndpointAddr::from(SecretKey::from_bytes(&[31; 32]).public()).into(),
            key: SecretKey::from_bytes(&[32; 32]),
            socket: path.clone(),
            listener: Mutex::new(Some(listener)),
        };

        // What setup does with it, between loopback endpoints.
        let listener = boot.take_listener().expect("the boot read's listener");
        assert!(boot.take_listener().is_none(), "setup takes it once");
        let running = block_on_within(WAIT, running_on(listener, path.clone(), 31))
            .expect("starts within 20 s");

        // As soon as that returns, a new request is forwarded, and the one
        // sent before setup has its answer too.
        assert_eq!(
            read_reply(send_request(&path, b"sent after setup")),
            b"sent after setup"
        );
        assert_eq!(read_reply(early), b"sent before setup");
        block_on_within(WAIT, running.stop()).expect("stops");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A link pairing's clients send to the link's socket, which only this
    /// process can use, and the link takes their requests to the host, named
    /// as kleio-host expects on the link.
    #[test]
    fn a_link_pairings_clients_reach_the_host_through_its_socket() {
        let home = tmp_home();
        let path = socket_path_on(&home, false);
        let listener = Forward::listen_private(&path).expect("listens on its socket");
        let running = block_on_within(WAIT, running_with(listener, path.clone(), 35, http_host))
            .expect("starts within 20 s");
        let transport = Transport::Link(Box::new(LinkBoot {
            route: EndpointAddr::from(SecretKey::from_bytes(&[35; 32]).public()).into(),
            key: SecretKey::from_bytes(&[36; 32]),
            socket: path.clone(),
            listener: Mutex::new(None),
        }));
        // As `run()` does first: a client can't be built without one.
        crate::install_rustls_provider();
        let client = commands::host_client(&transport).build().expect("a client");
        let (status, head) = block_on_within(WAIT, async {
            let res = client
                .get(format!("{LINK_BASE}/kleio/health"))
                .send()
                .await
                .expect("an answer");
            (res.status().as_u16(), res.text().await.expect("a body"))
        })
        .expect("within 20 s");
        assert_eq!(status, 200);
        assert!(
            head.starts_with("GET /kleio/health HTTP/1.1\r\n"),
            "{head:?}"
        );
        assert!(
            head.to_ascii_lowercase()
                .contains("\r\nhost: link.kleio.invalid\r\n"),
            "{head:?}"
        );
        block_on_within(WAIT, running.stop()).expect("stops");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// iOS can take a suspended app's listener away (TN2277), and the app's
    /// requests to the link are then refused (step 16, after a stay in the
    /// background). Coming back, the app finds nothing listening and listens
    /// again at once, before anything sends: a request is taken straight
    /// away, and answered once forwarding has moved to the new listener.
    #[test]
    fn a_listener_ios_took_away_is_replaced_before_anything_sends() {
        // No child may be mid-spawn while a closed listener is checked.
        let _no_spawns = crate::process::SPAWN_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let home = tmp_home();
        let path = socket_path_on(&home, false);
        let listener = Forward::listen_private(&path).expect("listens on its socket");
        let mut running = block_on_within(WAIT, running_on(listener, path.clone(), 33))
            .expect("starts within 20 s");
        assert_eq!(read_reply(send_request(&path, b"first")), b"first");
        // Still listening: nothing to do, and the check (a connection that
        // sends nothing) leaves forwarding as it was.
        assert!(listen_if_gone(&path).is_none(), "it was listening");
        assert_eq!(read_reply(send_request(&path, b"second")), b"second");

        // What iOS does while the app is away: the listener goes, and a
        // request is refused.
        block_on_within(WAIT, running.stop_forwarding()).expect("within 20 s");
        assert!(
            !Forward::listening_private(&path),
            "a request would be refused"
        );

        // Coming back: listening again at once, so a request is taken before
        // forwarding moves to the new listener...
        let again = listen_if_gone(&path)
            .expect("finds nothing listening")
            .expect("listens again");
        let early = send_request(&path, b"sent on coming back");
        // ...and answered once it has.
        block_on_within(WAIT, running.forward_again(Some(again)))
            .expect("within 20 s")
            .expect("forwards again");
        assert_eq!(read_reply(early), b"sent on coming back");

        // Had the main thread not listened again, forwarding does.
        block_on_within(WAIT, running.stop_forwarding()).expect("within 20 s");
        block_on_within(WAIT, running.forward_again(None))
            .expect("within 20 s")
            .expect("forwards again");
        assert_eq!(read_reply(send_request(&path, b"after")), b"after");
        block_on_within(WAIT, running.stop()).expect("stops");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn passes_the_links_lines_at_info_and_the_rest_at_warn() {
        use tracing::Level;
        assert_eq!(threshold("kleio_link"), Level::INFO);
        assert_eq!(threshold("kleio_link::paths"), Level::INFO);
        assert_eq!(threshold("kleio_linker"), Level::WARN);
        assert_eq!(threshold("iroh::socket"), Level::WARN);
    }

    /// Each event's line as `LogBridge` writes it, for the test's own
    /// subscriber.
    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<String>>>);

    impl tracing::Subscriber for Capture {
        fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
        fn event(&self, event: &tracing::Event<'_>) {
            self.0.lock().unwrap().push(render(event));
        }
        fn enter(&self, _: &tracing::span::Id) {}
        fn exit(&self, _: &tracing::span::Id) {}
    }

    #[test]
    fn writes_the_message_then_the_other_fields() {
        let capture = Capture::default();
        tracing::subscriber::with_default(capture.clone(), || {
            tracing::info!(target: "kleio_link::paths", "6ef5181507 +17.4s path selected: direct 192.168.4.68:56829");
            tracing::warn!(target: "iroh::relay", relay = "euc1-1", "relay throttled");
        });
        assert_eq!(
            *capture.0.lock().unwrap(),
            [
                "6ef5181507 +17.4s path selected: direct 192.168.4.68:56829",
                "relay throttled relay=\"euc1-1\"",
            ]
        );
    }
}

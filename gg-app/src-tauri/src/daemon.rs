//! The shared Node daemon: spawn/respawn, per-window session lifecycle, session lookups.

use crate::*;

pub(crate) fn sidecar_base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Total deadline on every proxied request that does not set its own. A
/// backstop, not a speed target: nothing legitimate runs this long, so a
/// request that reaches it belongs to a handler that will never answer, and the
/// command fails with "operation timed out" instead of leaving the webview
/// waiting for good. Call sites that can only be slow locally (history, export,
/// the quit snapshot) bound themselves tighter.
pub(crate) const SIDECAR_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// An HTTP client for the sidecar daemon: authenticated with the launch token
/// and quick to give up connecting (the daemon is on loopback, so a connect
/// that doesn't land fast never will). `total_timeout` bounds each request end
/// to end, body reads included. Only the SSE bridge passes `None`, because its
/// stream is long-lived by design. With a deadline set, reqwest starts its
/// timer as `send` is called, so that call has to be made inside the runtime
/// (an `async fn`, or `block_on(async { .. })`), as every call site does.
pub(crate) fn sidecar_http_client(
    daemon_token: &str,
    total_timeout: Option<std::time::Duration>,
) -> reqwest::Client {
    let mut default_headers = reqwest::header::HeaderMap::new();
    default_headers.insert(
        "x-gg-token",
        reqwest::header::HeaderValue::from_str(daemon_token)
            .expect("daemon token is valid header ASCII"),
    );
    let builder = reqwest::Client::builder()
        .default_headers(default_headers)
        .connect_timeout(std::time::Duration::from_secs(5));
    let builder = match total_timeout {
        Some(timeout) => builder.timeout(timeout),
        None => builder,
    };
    builder.build().unwrap_or_else(|_| reqwest::Client::new())
}

/// The shared daemon port (same for every window). Named `port_for` so the ~35
/// proxy commands keep their call shape; the per-window routing is the session
/// id (`session_for`), attached as the `x-gg-session` header.
pub(crate) fn port_for(webview: &WebviewWindow) -> Option<u16> {
    let daemon: State<Daemon> = webview.state();
    let port = *daemon.port.lock_or_recover();
    port
}

/// The daemon session id for the window that issued a command, or `None` until
/// the daemon's `POST /session` has returned for this window.
pub(crate) fn session_for(webview: &WebviewWindow) -> Option<String> {
    let windows: State<Windows> = webview.state();
    let map = windows.map.lock_or_recover();
    map.get(webview.label()).and_then(|w| w.session_id.clone())
}

pub(crate) fn cwd_for(webview: &WebviewWindow) -> Option<PathBuf> {
    let windows: State<Windows> = webview.state();
    let map = windows.map.lock_or_recover();
    map.get(webview.label()).and_then(|w| w.cwd.clone())
}

/// How long a session start waits for the daemon's port. Deliberately generous:
/// a first launch after install/update can spend well over 30s while macOS
/// Gatekeeper/XProtect scans `ggnode` and the native modules, and the crash-loop
/// backoff alone sums to 31s. A daemon that has failed for good ends the wait
/// early through `Daemon::failure`.
pub(crate) const DAEMON_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

/// Await the daemon's HTTP port (set by its `GG_APP_LISTENING` handshake).
/// Fails with the daemon's terminal failure as soon as one is recorded, or
/// after `DAEMON_START_TIMEOUT` if the daemon neither listens nor fails.
pub(crate) async fn await_daemon_port(app: &tauri::AppHandle) -> Result<u16, String> {
    let deadline = std::time::Instant::now() + DAEMON_START_TIMEOUT;
    loop {
        let daemon: State<Daemon> = app.state();
        if let Some(port) = *daemon.port.lock_or_recover() {
            return Ok(port);
        }
        if let Some(failure) = daemon.failure.lock_or_recover().clone() {
            return Err(failure);
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "The agent daemon did not start within {} seconds.",
                DAEMON_START_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

/// A window's readiness as `sidecar_port` reports it: the failed start's
/// reason, else the daemon port once the window has a session, else `None`
/// (still starting).
pub(crate) fn window_readiness(
    window: Option<&WindowSession>,
    port: Option<u16>,
) -> Result<Option<u16>, String> {
    let Some(window) = window else {
        return Ok(None);
    };
    if let Some(error) = &window.start_error {
        return Err(error.clone());
    }
    Ok(window.session_id.as_ref().and(port))
}

/// Frontend polls this until it returns a port. Returns the daemon port only
/// once THIS window has a session (so `waitForReady` still gates correctly:
/// a window isn't "ready" until its session exists), mirroring `sidecar-ready`.
/// Errors with the concrete reason once this window's session start has failed.
#[tauri::command]
pub(crate) fn sidecar_port(webview: WebviewWindow) -> Result<Option<u16>, String> {
    let window = {
        let windows: State<Windows> = webview.state();
        let map = windows.map.lock_or_recover();
        map.get(webview.label()).cloned()
    };
    window_readiness(window.as_ref(), port_for(&webview))
}

/// "Try again" after a failed start. A daemon that gave up (spawn failure or
/// crash circuit breaker) is respawned with a fresh retry budget and every
/// window's session restarted; otherwise only this window's failed session is
/// restarted. No-op while a start is in flight or the session is live.
#[tauri::command]
pub(crate) fn retry_window_session(webview: WebviewWindow) {
    let app = webview.app_handle().clone();
    let daemon_failure = app.state::<Daemon>().failure.lock_or_recover().take();
    if let Some(reason) = daemon_failure {
        log::info!("retrying daemon after failure: {reason}");
        {
            let daemon: State<Daemon> = app.state();
            *daemon.respawn_attempts.lock_or_recover() = 0;
            *daemon.last_fatal.lock_or_recover() = None;
        }
        spawn_daemon(app.clone(), false);
        recreate_all_window_sessions(app);
        return;
    }

    let target = {
        let windows: State<Windows> = app.state();
        let map = windows.map.lock_or_recover();
        map.get(webview.label()).and_then(|window| {
            window.start_error.as_ref()?;
            let cwd = window.cwd.clone()?;
            Some((
                window.mode,
                window.chat_agent,
                cwd,
                window.session_path.clone(),
            ))
        })
    };
    if let Some((mode, chat_agent, cwd, session_path)) = target {
        start_window_session(
            app,
            webview.label().to_string(),
            mode,
            chat_agent,
            cwd,
            session_path,
        );
    }
}

pub(crate) const DAEMON_STABLE_UPTIME: std::time::Duration = std::time::Duration::from_secs(60);
pub(crate) const DAEMON_MAX_RESPAWNS: u32 = 5;

/// Exponential crash-loop backoff: 1s, 2s, 4s, 8s, 16s, then stop.
/// A hard retry budget prevents a broken sidecar/signature/configuration from
/// turning the desktop shell into an unbounded process-spawn and disk-write loop.
pub(crate) fn daemon_respawn_delay(attempt: u32) -> Option<std::time::Duration> {
    if attempt == 0 || attempt > DAEMON_MAX_RESPAWNS {
        return None;
    }
    Some(std::time::Duration::from_secs(1 << (attempt - 1)))
}

/// The user-facing reason once the crash loop exhausts its respawn budget,
/// carrying the last `GG_APP_FATAL` reason when the daemon reported one.
pub(crate) fn crash_loop_message(last_fatal: Option<&str>) -> String {
    let reason = last_fatal
        .map(|line| line.strip_prefix("GG_APP_FATAL").unwrap_or(line).trim())
        .filter(|reason| !reason.is_empty());
    match reason {
        Some(reason) => format!("The agent daemon kept crashing on startup: {reason}"),
        None => "The agent daemon stopped after repeated crashes.".to_string(),
    }
}

/// Record a terminal daemon failure so waiting session starts end with it.
pub(crate) fn fail_daemon(app: &tauri::AppHandle, message: String) {
    log::error!("{message}");
    *app.state::<Daemon>().failure.lock_or_recover() = Some(message.clone());
    emit_daemon_error(app, &message);
}

pub(crate) fn emit_daemon_error(app: &tauri::AppHandle, message: &str) {
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "sidecar-error",
            message,
        );
    }
}

/// Spawn the ONE shared Node daemon. Reads its `GG_APP_LISTENING` handshake to
/// learn the shared port; on an unexpected exit it reaps the dead child, applies
/// bounded exponential backoff, and re-creates every live window's session.
/// Five short-lived respawns exhaust the retry budget; one minute of stable
/// uptime resets it.
///
/// The daemon is a process-group leader (Unix), so `terminate_child` reaps its
/// entire descendant tree (every session's MCP stdio children + LSP servers) in
/// one group-kill — no orphans on quit.
pub(crate) fn spawn_daemon(app: tauri::AppHandle, is_respawn: bool) {
    let started_at = std::time::Instant::now();
    let script = resolve_sidecar(&app);
    let node = resolve_node(&app);
    log::info!("spawning daemon: {} {}", node.display(), script.display());

    let mut cmd = Command::new(node);
    hide_console(&mut cmd);
    cmd.arg(&script)
        // Port 0 → the OS assigns a free port, reported back via the
        // GG_APP_LISTENING handshake.
        .env("GG_APP_PORT", "0")
        .env("GG_APP_TOKEN", &app.state::<Daemon>().token)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);

    let mut child = match cmd.spawn() {
        Ok(c) => {
            // Record the sidecar PID (== its process-group id on Unix, since it's
            // a group leader). The startup orphan sweep uses this ledger to
            // recognise this sidecar's MCP/LSP children by lineage if the app is
            // later crashed/force-quit — works for ANY MCP server, no name list.
            record_sidecar_pid(c.id() as i32);
            c
        }
        Err(e) => {
            fail_daemon(&app, format!("Couldn't start the agent daemon: {e}"));
            return;
        }
    };

    // Publish the child before starting pipe readers. A process can fail before
    // the reader thread starts; storing first guarantees the crash handler can
    // still take and reap that exact child instead of leaving a zombie behind.
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let daemon: State<Daemon> = app.state();
        *daemon.child.lock_or_recover() = Some(child);
    }

    if let Some(stdout) = stdout {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if let Some(rest) = line.strip_prefix("GG_APP_LISTENING ") {
                    // Format: `GG_APP_LISTENING <port> <token>` (token consumed
                    // by non-Rust spawners; ours arrives via GG_APP_TOKEN).
                    if let Ok(port) = rest.split_whitespace().next().unwrap_or("").parse::<u16>() {
                        log::info!("daemon listening on port {port}");
                        *app2.state::<Daemon>().port.lock_or_recover() = Some(port);
                        // On a respawn the windows already exist with (now
                        // stale) sessions — re-create them all. On the initial
                        // spawn `restore_or_default_windows` drives creation.
                        if is_respawn {
                            recreate_all_window_sessions(app2.clone());
                        }
                    }
                } else {
                    log::debug!("[daemon] {line}");
                }
            }

            // stdout closed → the daemon exited (or lost its control pipe). If
            // the app isn't quitting, remove the stale port and reap/terminate
            // the exact child before considering a bounded respawn.
            if app2.state::<AppExiting>().0.load(Ordering::SeqCst) {
                return;
            }

            let attempt = {
                let daemon: State<Daemon> = app2.state();
                *daemon.port.lock_or_recover() = None;
                if let Some(mut old_child) = daemon.child.lock_or_recover().take() {
                    match old_child.try_wait() {
                        Ok(Some(_)) => {
                            let _ = old_child.wait();
                        }
                        _ => terminate_child(old_child),
                    }
                }
                // A daemon that died on its own leaves its MCP/LSP children
                // running in its (now leaderless) process group, and on Windows
                // `taskkill /T` can no longer reach them through the dead
                // parent. The ledger sweep kills dead-leader groups, so run it
                // now rather than waiting for the next app launch.
                sweep_orphan_sidecars();
                let mut attempts = daemon.respawn_attempts.lock_or_recover();
                if started_at.elapsed() >= DAEMON_STABLE_UPTIME {
                    *attempts = 0;
                }
                *attempts += 1;
                *attempts
            };

            let Some(delay) = daemon_respawn_delay(attempt) else {
                log::error!("daemon crash circuit breaker opened after {attempt} crashes");
                let last_fatal = app2.state::<Daemon>().last_fatal.lock_or_recover().clone();
                fail_daemon(&app2, crash_loop_message(last_fatal.as_deref()));
                return;
            };

            log::warn!(
                "daemon exited unexpectedly — respawn {attempt}/{DAEMON_MAX_RESPAWNS} in {}s",
                delay.as_secs()
            );
            std::thread::sleep(delay);
            if !app2.state::<AppExiting>().0.load(Ordering::SeqCst) {
                spawn_daemon(app2.clone(), true);
            }
        });
    }

    if let Some(stderr) = stderr {
        let app3 = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                log::error!("[daemon:stderr] {line}");
                // Not surfaced yet: the crash is respawned, and only a crash
                // loop that exhausts the budget reports this reason.
                if line.starts_with("GG_APP_FATAL") {
                    *app3.state::<Daemon>().last_fatal.lock_or_recover() = Some(line);
                }
            }
        });
    }
}

/// POST /session to the daemon for `cwd` (+ optional resume `session_path`);
/// returns the new session id or the daemon's concrete initialization error.
pub(crate) async fn daemon_create_session(
    app: &tauri::AppHandle,
    port: u16,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: &Path,
    session_path: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let client = app.state::<reqwest::Client>().inner().clone();
    let body = serde_json::json!({
        "mode": mode,
        "chatAgent": chat_agent,
        "cwd": cwd.to_string_lossy(),
        "sessionPath": session_path,
    });
    let res = client
        .post(format!("{}/session", sidecar_base(port)))
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = res.status();
    let value = res
        .json::<serde_json::Value>()
        .await
        .map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|error| error.as_str())
            .unwrap_or("failed to create agent session")
            .to_string());
    }
    let id = value
        .get("sessionId")
        .and_then(|session_id| session_id.as_str())
        .map(|session_id| session_id.to_string())
        .ok_or_else(|| "agent daemon returned no session id".to_string())?;
    Ok((id, json_session_path(&value)))
}

/// The conversation file a daemon response names, if any.
pub(crate) fn json_session_path(value: &serde_json::Value) -> Option<String> {
    value
        .get("sessionPath")
        .and_then(|path| path.as_str())
        .filter(|path| !path.is_empty())
        .map(str::to_string)
}

/// DELETE /session/:id on the daemon (best-effort, fire-and-forget).
pub(crate) async fn daemon_delete_session(app: &tauri::AppHandle, port: u16, id: &str) {
    let client = app.state::<reqwest::Client>().inner().clone();
    let _ = client
        .delete(format!(
            "{}/session/{}",
            sidecar_base(port),
            urlencoding(id)
        ))
        .send()
        .await;
}

pub(crate) fn publish_window_session(
    map: &mut HashMap<String, WindowSession>,
    label: &str,
    generation: u64,
    session_id: String,
    session_path: Option<String>,
) -> bool {
    let Some(entry) = map.get_mut(label) else {
        return false;
    };
    if entry.generation != generation {
        return false;
    }
    entry.session_id = Some(session_id);
    // Remember the conversation the daemon opened (a fresh one has no path
    // until now), so a daemon respawn reopens it instead of starting empty.
    if session_path.is_some() {
        entry.session_path = session_path;
    }
    true
}

/// Record why a session start failed, but only on the window's current
/// generation: a superseded start must not mask the newer attempt.
pub(crate) fn record_start_error(
    map: &mut HashMap<String, WindowSession>,
    label: &str,
    generation: u64,
    message: &str,
) -> bool {
    match map.get_mut(label) {
        Some(entry) if entry.generation == generation => {
            entry.start_error = Some(message.to_string());
            true
        }
        _ => false,
    }
}

fn fail_window_session(app: &tauri::AppHandle, label: &str, generation: u64, message: &str) {
    let current = record_start_error(
        &mut app.state::<Windows>().map.lock_or_recover(),
        label,
        generation,
        message,
    );
    if current {
        let _ = app.emit_to(
            EventTarget::webview_window(label.to_string()),
            "sidecar-error",
            message,
        );
    }
}

/// Record a pending window session synchronously. This invalidates older starts
/// before any daemon request is allowed to publish its response.
pub(crate) fn prepare_window_session(
    app: &tauri::AppHandle,
    label: &str,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: &Path,
    session_path: Option<&str>,
) -> u64 {
    let windows: State<Windows> = app.state();
    let generation = windows.next_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let mut map = windows.map.lock_or_recover();
    let entry = map.entry(label.to_string()).or_default();
    entry.generation = generation;
    entry.mode = mode;
    entry.chat_agent = chat_agent;
    entry.cwd = Some(cwd.to_path_buf());
    entry.session_path = session_path.map(str::to_string);
    entry.session_id = None;
    entry.start_error = None;
    log::info!(
        "window session starting label={label} generation={generation} mode={mode:?} cwd={} elapsed_ms=0",
        cwd.display()
    );
    generation
}

/// Finish a prepared session and publish it only if its generation is current.
/// Returning the daemon error lets picker commands remain on the session list
/// instead of entering a loading screen that can never hydrate.
pub(crate) async fn finish_window_session(
    app: tauri::AppHandle,
    label: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
    generation: u64,
) -> Result<(), String> {
    let started_at = std::time::Instant::now();
    let port = match await_daemon_port(&app).await {
        Ok(port) => port,
        Err(message) => {
            log::error!(
                "window session daemon unavailable label={label} generation={generation} mode={mode:?} cwd={} error={message} elapsed_ms={}",
                cwd.display(),
                started_at.elapsed().as_millis()
            );
            fail_window_session(&app, &label, generation, &message);
            return Err(message);
        }
    };

    let (id, opened_path) = match daemon_create_session(
        &app,
        port,
        mode,
        chat_agent,
        &cwd,
        session_path.as_deref(),
    )
    .await
    {
        Ok(id) => id,
        Err(message) => {
            log::error!(
                "daemon session creation failed label={label} generation={generation} mode={mode:?} cwd={} error={message} elapsed_ms={}",
                cwd.display(),
                started_at.elapsed().as_millis()
            );
            fail_window_session(&app, &label, generation, &message);
            return Err(message);
        }
    };

    let published = {
        let windows: State<Windows> = app.state();
        let mut map = windows.map.lock_or_recover();
        publish_window_session(&mut map, &label, generation, id.clone(), opened_path)
    };
    if !published {
        log::warn!(
            "stale window session discarded label={label} generation={generation} mode={mode:?} cwd={} daemon_session_id={id} elapsed_ms={}",
            cwd.display(),
            started_at.elapsed().as_millis()
        );
        daemon_delete_session(&app, port, &id).await;
        return Err("session selection was superseded".to_string());
    }

    log::info!(
        "window session ready label={label} generation={generation} mode={mode:?} cwd={} daemon_session_id={id} elapsed_ms={}",
        cwd.display(),
        started_at.elapsed().as_millis()
    );
    start_event_bridge(app.clone(), label.clone(), port, id);
    let _ = app.emit_to(EventTarget::webview_window(label), "sidecar-ready", port);
    Ok(())
}

/// Create (or re-point) one window's session in the background.
pub(crate) fn start_window_session(
    app: tauri::AppHandle,
    label: String,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: PathBuf,
    session_path: Option<String>,
) {
    let generation = prepare_window_session(
        &app,
        &label,
        mode,
        chat_agent,
        &cwd,
        session_path.as_deref(),
    );
    tauri::async_runtime::spawn(async move {
        let _ = finish_window_session(app, label, mode, chat_agent, cwd, session_path, generation)
            .await;
    });
}

/// After a daemon respawn, re-create a session for every live window from its
/// stored `{mode, cwd, session_path}` so each webview re-hydrates.
pub(crate) fn recreate_all_window_sessions(app: tauri::AppHandle) {
    let targets: Vec<(String, WorkspaceMode, ChatAgent, PathBuf, Option<String>)> = {
        let windows: State<Windows> = app.state();
        let map = windows.map.lock_or_recover();
        map.iter()
            .filter_map(|(label, window)| {
                window.cwd.clone().map(|cwd| {
                    (
                        label.clone(),
                        window.mode,
                        window.chat_agent,
                        cwd,
                        window.session_path.clone(),
                    )
                })
            })
            .collect()
    };
    for (label, mode, chat_agent, cwd, session_path) in targets {
        start_window_session(app.clone(), label, mode, chat_agent, cwd, session_path);
    }
}

/// Boot the app's windows. If a workspace snapshot has restorable windows (each
/// with a cwd that still exists on disk), reopen one window per entry — pointed
/// at its project + session, with saved geometry — and record a per-window
/// restore target so the webview skips the picker. Otherwise fall back to the
/// single default `main` window at the boot cwd (the picker then shows).
pub(crate) fn restore_or_default_windows(app: &tauri::AppHandle) -> Result<(), String> {
    let ws = read_workspace();
    let entries = filter_restorable(ws.windows, |c| Path::new(c).exists());
    if entries.is_empty() {
        // Fresh boot / nothing to restore: the usual single main window.
        build_app_window(app, "main")?;
        start_window_session(
            app.clone(),
            "main".into(),
            WorkspaceMode::Code,
            ChatAgent::General,
            default_cwd(),
            None,
        );
        broadcast_window_order(app);
        return Ok(());
    }

    let count = entries.len();
    let mut any_geometry = false;
    for (i, entry) in entries.into_iter().enumerate() {
        // First restored window reclaims `main`; the rest get project-N.
        let label = if i == 0 {
            "main".to_string()
        } else {
            format!("project-{i}")
        };
        // Register the target before constructing the webview: even a hidden
        // webview may execute immediately after build() returns.
        {
            let state: State<RestoreTargets> = app.state();
            register_restore_target(
                &mut state.map.lock_or_recover(),
                label.clone(),
                RestoreEntry {
                    mode: entry.mode,
                    chat_agent: entry.chat_agent,
                    cwd: entry.cwd.clone(),
                    session_path: entry.session_path.clone(),
                },
            );
        }
        let win = match build_app_window_with_visibility(app, &label, false) {
            Ok(win) => win,
            Err(error) => {
                remove_restore_target(
                    &mut app.state::<RestoreTargets>().map.lock_or_recover(),
                    &label,
                );
                return Err(error);
            }
        };
        start_window_session(
            app.clone(),
            label.clone(),
            entry.mode,
            entry.chat_agent,
            PathBuf::from(&entry.cwd),
            entry.session_path.clone(),
        );
        // Apply saved geometry when present; else we tile after the loop.
        if let (Some(x), Some(y)) = (entry.x, entry.y) {
            any_geometry = true;
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        if let (Some(w), Some(h)) = (entry.width, entry.height) {
            any_geometry = true;
            let _ = win.set_size(tauri::PhysicalSize::new(w, h));
        }
        let _ = win.show();
    }
    if !any_geometry {
        arrange_windows(app, count);
    }
    broadcast_window_order(app);
    Ok(())
}

/// How long the quit snapshot waits, in total, for the daemon to answer.
pub(crate) const QUIT_REFRESH_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(400);

/// What one window's re-read `/state` said: `(label, session_path, cwd)`.
type LiveSession = (String, Option<String>, Option<PathBuf>);

/// Re-read every window's `/state` on the daemon at `port`, all at once: the
/// whole round trip is bounded by one `deadline`, however many windows are
/// open. A window the daemon does not answer for in time is simply left out.
async fn read_live_sessions(
    client: reqwest::Client,
    port: u16,
    targets: Vec<(String, String)>,
    deadline: std::time::Duration,
) -> Vec<LiveSession> {
    let url = format!("{}/state", sidecar_base(port));
    futures_util::future::join_all(targets.into_iter().map(|(label, sid)| {
        let client = client.clone();
        let url = url.clone();
        async move {
            let res = client
                .get(&url)
                .header("x-gg-session", &sid)
                .timeout(deadline)
                .send()
                .await
                .ok()?;
            let body = res.json::<serde_json::Value>().await.ok()?;
            let session_path = body
                .get("sessionPath")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let cwd = body
                .get("cwd")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(PathBuf::from);
            Some((label, session_path, cwd))
        }
    }))
    .await
    .into_iter()
    .flatten()
    .collect()
}

/// Record what `read_live_sessions` learned. A window keeps its last-known
/// session wherever its `/state` had nothing to add, and one that closed
/// meanwhile is skipped.
fn record_live_sessions(
    map: &mut HashMap<String, WindowSession>,
    results: impl IntoIterator<Item = LiveSession>,
) {
    for (label, session_path, cwd) in results {
        if let Some(inst) = map.get_mut(&label) {
            if let Some(session_path) = session_path {
                inst.session_path = Some(session_path);
            }
            if let Some(cwd) = cwd {
                inst.cwd = Some(cwd);
            }
        }
    }
}

/// Before the final exit snapshot, re-read each live session's `/state` (via the
/// shared daemon, keyed by the window's `x-gg-session` header) so a window that
/// started a new session mid-run (changing its session file) is recorded at its
/// CURRENT session, not the one it was created with. Best-effort + time-boxed:
/// any window we can't reach keeps its last-known session_path.
pub(crate) fn refresh_live_sessions(app: &tauri::AppHandle) {
    let Some(port) = *app.state::<Daemon>().port.lock_or_recover() else {
        return;
    };
    let targets: Vec<(String, String)> = {
        let state: State<Windows> = app.state();
        let map = state.map.lock_or_recover();
        map.iter()
            .filter_map(|(label, w)| w.session_id.clone().map(|id| (label.clone(), id)))
            .collect()
    };
    if targets.is_empty() {
        return;
    }
    let client = app.state::<reqwest::Client>().inner().clone();
    // The exit callback runs on the main event-loop thread (outside the async
    // runtime), so block_on is safe here. Every window is asked at once, so a
    // hung daemon costs one deadline at quit, not one per open window.
    let results = tauri::async_runtime::block_on(read_live_sessions(
        client,
        port,
        targets,
        QUIT_REFRESH_TIMEOUT,
    ));
    let state: State<Windows> = app.state();
    let mut map = state.map.lock_or_recover();
    record_live_sessions(&mut map, results);
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Quit snapshot: every window's /state is re-read at once ──────────────

    #[test]
    fn an_unanswered_or_closed_window_keeps_its_last_known_session() {
        let mut map = HashMap::from([(
            "main".to_string(),
            WindowSession {
                session_path: Some("old.jsonl".into()),
                cwd: Some(PathBuf::from("/old")),
                ..Default::default()
            },
        )]);
        record_live_sessions(
            &mut map,
            [
                // Answered, but without a session path: the old one stays.
                ("main".to_string(), None, Some(PathBuf::from("/new"))),
                // A window that closed meanwhile is skipped.
                ("closed".to_string(), Some("x.jsonl".into()), None),
            ],
        );
        assert_eq!(map["main"].session_path.as_deref(), Some("old.jsonl"));
        assert_eq!(map["main"].cwd, Some(PathBuf::from("/new")));
        assert_eq!(map.len(), 1);
    }

    /// A stand-in daemon on loopback taking three sessions. `slow` is answered
    /// only once the other two have connected, so a caller that asks one window
    /// at a time never sees it answered in time; the rest answer at once.
    /// Returns the port, whether `slow` ever saw the others, and the server.
    fn spawn_daemon_with_a_slow_window(
    ) -> (u16, std::sync::Arc<AtomicBool>, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        use std::sync::atomic::AtomicUsize;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("address").port();
        let others = std::sync::Arc::new(AtomicUsize::new(0));
        let slow_saw_the_others = std::sync::Arc::new(AtomicBool::new(false));
        let mut handlers = Vec::new();
        let flag = slow_saw_the_others.clone();
        let server = std::thread::spawn(move || {
            for _ in 0..3 {
                let (mut conn, _) = listener.accept().expect("accept");
                conn.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .expect("read timeout");
                let others = others.clone();
                let slow_saw_the_others = flag.clone();
                handlers.push(std::thread::spawn(move || {
                    // Read the request head, then answer by session.
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        match conn.read(&mut byte) {
                            Ok(0) | Err(_) => break,
                            Ok(_) => head.push(byte[0]),
                        }
                    }
                    let head = String::from_utf8_lossy(&head).to_lowercase();
                    let sid = head
                        .lines()
                        .find_map(|line| line.strip_prefix("x-gg-session: "))
                        .unwrap_or_default()
                        .to_string();
                    if sid == "slow" {
                        let give_up = std::time::Instant::now() + std::time::Duration::from_secs(3);
                        while others.load(Ordering::SeqCst) < 2
                            && std::time::Instant::now() < give_up
                        {
                            std::thread::sleep(std::time::Duration::from_millis(2));
                        }
                        slow_saw_the_others
                            .store(others.load(Ordering::SeqCst) >= 2, Ordering::SeqCst);
                    } else {
                        others.fetch_add(1, Ordering::SeqCst);
                    }
                    let body =
                        format!(r#"{{"sessionPath":"{sid}.jsonl","cwd":"/projects/{sid}"}}"#);
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = conn.write_all(response.as_bytes());
                    let _ = conn.write_all(body.as_bytes());
                    let _ = conn.flush();
                }));
            }
            for handler in handlers {
                let _ = handler.join();
            }
        });
        (port, slow_saw_the_others, server)
    }

    #[test]
    fn quit_asks_every_window_for_its_session_at_once() {
        crate::install_rustls_provider();
        let (port, slow_saw_the_others, server) = spawn_daemon_with_a_slow_window();
        let results = tauri::async_runtime::block_on(read_live_sessions(
            sidecar_http_client("token", None),
            port,
            vec![
                ("main".to_string(), "slow".to_string()),
                ("project-1".to_string(), "fast-a".to_string()),
                ("project-2".to_string(), "fast-b".to_string()),
            ],
            std::time::Duration::from_secs(2),
        ));
        server.join().expect("server thread");
        let session = |name: &str| {
            Some((
                Some(format!("{name}.jsonl")),
                Some(PathBuf::from(format!("/projects/{name}"))),
            ))
        };
        let mut by_label: HashMap<String, _> = results
            .into_iter()
            .map(|(label, path, cwd)| (label, (path, cwd)))
            .collect();
        assert_eq!(by_label.remove("main"), session("slow"));
        assert_eq!(by_label.remove("project-1"), session("fast-a"));
        assert_eq!(by_label.remove("project-2"), session("fast-b"));
        assert!(by_label.is_empty());
        assert!(
            slow_saw_the_others.load(Ordering::SeqCst),
            "one window's request waited alone: windows are asked one at a time"
        );
    }

    #[test]
    fn daemon_respawns_with_bounded_exponential_backoff() {
        let delays: Vec<u64> = (1..=DAEMON_MAX_RESPAWNS)
            .map(|attempt| daemon_respawn_delay(attempt).unwrap().as_secs())
            .collect();
        assert_eq!(delays, vec![1, 2, 4, 8, 16]);
    }

    #[test]
    fn daemon_start_wait_outlasts_the_crash_loop_and_slow_first_launch() {
        // Live bug: a 30s wait gave up on a daemon still being scanned by
        // macOS on first launch, and that window never got a session.
        let backoff: u64 = (1..=DAEMON_MAX_RESPAWNS)
            .map(|attempt| daemon_respawn_delay(attempt).unwrap().as_secs())
            .sum();
        assert!(DAEMON_START_TIMEOUT.as_secs() >= backoff + 120);
    }

    #[test]
    fn window_readiness_reports_the_failed_start_reason() {
        let mut window = WindowSession {
            generation: 1,
            ..Default::default()
        };
        assert_eq!(window_readiness(None, Some(9)), Ok(None));
        assert_eq!(window_readiness(Some(&window), Some(9)), Ok(None));
        window.session_id = Some("sid".into());
        assert_eq!(window_readiness(Some(&window), None), Ok(None));
        assert_eq!(window_readiness(Some(&window), Some(9)), Ok(Some(9)));
        window.session_id = None;
        window.start_error = Some("boom".into());
        assert_eq!(window_readiness(Some(&window), Some(9)), Err("boom".into()));
    }

    #[test]
    fn stale_start_failure_does_not_mask_a_newer_attempt() {
        let mut map = HashMap::new();
        map.insert(
            "main".into(),
            WindowSession {
                generation: 2,
                ..Default::default()
            },
        );
        assert!(!record_start_error(&mut map, "main", 1, "old failure"));
        assert!(map.get("main").unwrap().start_error.is_none());
        assert!(record_start_error(&mut map, "main", 2, "new failure"));
        assert_eq!(
            map.get("main").unwrap().start_error.as_deref(),
            Some("new failure")
        );
        assert!(!record_start_error(&mut map, "gone", 2, "closed window"));
    }

    #[test]
    fn crash_loop_message_carries_the_fatal_reason() {
        assert_eq!(
            crash_loop_message(Some("GG_APP_FATAL EACCES: ~/.gg/settings.json")),
            "The agent daemon kept crashing on startup: EACCES: ~/.gg/settings.json"
        );
        assert_eq!(
            crash_loop_message(Some("GG_APP_FATAL ")),
            "The agent daemon stopped after repeated crashes."
        );
        assert_eq!(
            crash_loop_message(None),
            "The agent daemon stopped after repeated crashes."
        );
    }

    #[test]
    fn daemon_crash_loop_opens_circuit_breaker() {
        assert!(daemon_respawn_delay(0).is_none());
        assert!(daemon_respawn_delay(DAEMON_MAX_RESPAWNS + 1).is_none());
    }

    // ── Window↔session map (daemon model) ──────────────────────────────────
    // The `Windows` map replaces the old per-window `Sidecars` registry. These
    // lock in the three mutations the lifecycle relies on: a window gets a
    // session id once the daemon answers, `select_project` re-points it to a
    // fresh session (old id taken so its SSE bridge retires), and a window
    // close removes its entry entirely (peers untouched).

    #[test]
    fn window_session_records_project_before_daemon_answers() {
        // start_window_session records cwd/session_path up front, session_id None
        // until POST /session returns — so snapshot/restore can see the target.
        let mut map: HashMap<String, WindowSession> = HashMap::new();
        map.insert(
            "main".into(),
            WindowSession {
                session_id: None,
                mode: WorkspaceMode::Chat,
                chat_agent: ChatAgent::Research,
                cwd: Some(PathBuf::from("/p/a")),
                session_path: Some("/s/a.jsonl".into()),
                generation: 1,
                start_error: None,
            },
        );
        let w = map.get("main").unwrap();
        assert!(w.session_id.is_none());
        assert_eq!(w.mode, WorkspaceMode::Chat);
        assert_eq!(w.chat_agent, ChatAgent::Research);
        assert_eq!(w.cwd.as_deref(), Some(Path::new("/p/a")));
        assert_eq!(w.session_path.as_deref(), Some("/s/a.jsonl"));
    }

    #[test]
    fn select_project_repoints_to_a_fresh_session() {
        // Mirrors select_project: take the old id (retires its bridge), then the
        // new session id + cwd land on the SAME window entry.
        let mut map: HashMap<String, WindowSession> = HashMap::new();
        map.insert(
            "main".into(),
            WindowSession {
                session_id: Some("old-id".into()),
                mode: WorkspaceMode::Code,
                chat_agent: ChatAgent::General,
                cwd: Some(PathBuf::from("/p/a")),
                session_path: None,
                generation: 1,
                start_error: None,
            },
        );
        // select_project takes the old id so the old SSE bridge retires.
        let old = map.get_mut("main").and_then(|w| w.session_id.take());
        assert_eq!(old.as_deref(), Some("old-id"));
        assert!(map.get("main").unwrap().session_id.is_none());
        // start_window_session then records the new project + session id.
        let entry = map.get_mut("main").unwrap();
        entry.mode = WorkspaceMode::Chat;
        entry.chat_agent = ChatAgent::Therapist;
        entry.cwd = Some(PathBuf::from("/p/b"));
        entry.session_id = Some("new-id".into());
        let w = map.get("main").unwrap();
        assert_eq!(w.session_id.as_deref(), Some("new-id"));
        assert_eq!(w.mode, WorkspaceMode::Chat);
        assert_eq!(w.chat_agent, ChatAgent::Therapist);
        assert_eq!(w.cwd.as_deref(), Some(Path::new("/p/b")));
    }

    #[test]
    fn closing_one_window_leaves_peers_intact() {
        // Destroyed removes only the closed window's entry; other windows keep
        // their sessions (the shared daemon process is never touched here).
        let mut map: HashMap<String, WindowSession> = HashMap::new();
        map.insert(
            "main".into(),
            WindowSession {
                session_id: Some("id-1".into()),
                cwd: Some(PathBuf::from("/p/a")),
                session_path: None,
                ..Default::default()
            },
        );
        map.insert(
            "project-1".into(),
            WindowSession {
                session_id: Some("id-2".into()),
                cwd: Some(PathBuf::from("/p/b")),
                session_path: None,
                ..Default::default()
            },
        );
        let removed = map.remove("main").and_then(|w| w.session_id);
        assert_eq!(removed.as_deref(), Some("id-1"));
        assert!(!map.contains_key("main"));
        // Peer survives with its own session.
        assert_eq!(
            map.get("project-1").unwrap().session_id.as_deref(),
            Some("id-2")
        );
    }

    #[test]
    fn restore_target_survives_repeated_webview_mounts_until_cleanup() {
        let mut targets = HashMap::new();
        let entry = RestoreEntry {
            mode: WorkspaceMode::Code,
            chat_agent: ChatAgent::General,
            cwd: "/project".into(),
            session_path: Some("/sessions/one.jsonl".into()),
        };

        register_restore_target(&mut targets, "main".into(), entry);
        assert_eq!(
            restore_target(&targets, "main").map(|target| target.cwd),
            Some("/project".into())
        );
        assert_eq!(
            restore_target(&targets, "main").map(|target| target.cwd),
            Some("/project".into())
        );
        assert!(remove_restore_target(&mut targets, "main").is_some());
        assert!(restore_target(&targets, "main").is_none());
    }

    #[test]
    fn stale_window_session_generation_cannot_overwrite_newer_result() {
        let mut map = HashMap::new();
        map.insert(
            "main".into(),
            WindowSession {
                generation: 2,
                cwd: Some(PathBuf::from("/new-project")),
                ..Default::default()
            },
        );

        assert!(publish_window_session(
            &mut map,
            "main",
            2,
            "new-session".into(),
            Some("/sessions/new.jsonl".into())
        ));
        assert!(!publish_window_session(
            &mut map,
            "main",
            1,
            "stale-session".into(),
            Some("/sessions/stale.jsonl".into())
        ));
        assert_eq!(
            map.get("main").unwrap().session_id.as_deref(),
            Some("new-session")
        );
        assert_eq!(
            map.get("main").unwrap().session_path.as_deref(),
            Some("/sessions/new.jsonl")
        );
    }

    #[test]
    fn a_fresh_session_records_its_path_so_a_daemon_respawn_reopens_it() {
        // Live bug: a goal window opened without a path; after a daemon
        // respawn it was recreated with none and lost its conversation.
        let mut map = HashMap::new();
        map.insert(
            "main".into(),
            WindowSession {
                generation: 1,
                ..Default::default()
            },
        );
        assert!(publish_window_session(
            &mut map,
            "main",
            1,
            "sid".into(),
            Some("/sessions/fresh.jsonl".into())
        ));
        assert_eq!(
            map.get("main").unwrap().session_path.as_deref(),
            Some("/sessions/fresh.jsonl")
        );
        assert_eq!(
            json_session_path(&serde_json::json!({ "sessionId": "x", "sessionPath": "" })),
            None
        );
    }
}

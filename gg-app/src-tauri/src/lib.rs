use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt as WindowsCommandExt;

/// `CREATE_NO_WINDOW` — spawn a console program without allocating a console.
///
/// The packaged app is a GUI (`windows_subsystem = "windows"`) process, so it
/// owns no console: every console child (the Node daemon, `taskkill`, the
/// PowerShell process snapshot) would otherwise pop its own black window. On
/// launch and quit that reads as the app flashing command prompts at the user.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the console window for a spawned child. No-op off Windows.
fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

use base64::Engine as _;
use tauri::{
    Emitter, EventTarget, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

mod auth;
mod commands;
mod daemon;
mod events;
mod paths;
mod process;
mod settings;
mod state;
mod tray;
mod windows;

use commands::agent_admin::*;
use daemon::*;
use events::*;
use paths::*;
use process::*;
use settings::*;
use state::*;
use tray::*;
use windows::*;

/// Kleio remote-host support (all platforms). See `kleio/mod.rs`.
mod ask_notify;
mod keep_awake;
mod kleio;

/// Install the process-wide rustls crypto provider.
///
/// reqwest 0.13 is compiled with `rustls-no-provider` (tauri-plugin-updater
/// asks for it, and cargo unifies features across the one shared build), and in
/// that mode `ClientBuilder::build()` PANICS rather than returning an error if
/// no provider has been installed. `unwrap_or_else` cannot catch that, so a
/// missing provider takes the whole app down at startup.
///
/// The updater installs `ring` lazily, but only when it first checks for an
/// update — far too late for the client built below. `ring` here matches what
/// it would install, so whichever runs first the process agrees with itself.
pub(crate) fn install_rustls_provider() {
    // Fails only if a provider is already installed, which is the outcome we
    // want anyway — so the result is deliberately ignored.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Self-update and relaunch exist on computers only. kleio: the iPhone build
/// is installed from Xcode and cannot restart itself, so it has neither plugin
/// (see capabilities/desktop.json).
#[cfg(desktop)]
fn with_desktop_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
}

#[cfg(mobile)]
fn with_desktop_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
}

/// kleio (iPhone): the barcode scanner, for the pairing QR code of Kleio's
/// link. Its permission is granted in `kleio::link::setup`, which needs the
/// app first.
#[cfg(target_os = "ios")]
fn with_link_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.plugin(tauri_plugin_barcode_scanner::init())
}

#[cfg(not(target_os = "ios"))]
fn with_link_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
}

/// kleio: what a just-saved pairing needs before it is in use.
#[derive(serde::Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum PairingActivation {
    /// Switched on in place (iPhone, first pairing). The app can carry on.
    Active,
    /// Applies on the next launch (desktop relaunches; a phone already talking
    /// to a host must be closed and reopened).
    Restart,
}

/// kleio: switch a pairing that `kleio_pair` just saved on in place. A phone
/// app cannot relaunch itself, so on the iPhone a first pairing does here what
/// boot does when already paired: register the authenticated client, mark the
/// host as the engine, and start the main window's session. Desktop keeps its
/// "Restart Kleio" flow.
#[tauri::command]
async fn kleio_activate_pairing(app: tauri::AppHandle) -> Result<PairingActivation, String> {
    if !cfg!(mobile) || kleio::remote().is_some() {
        return Ok(PairingActivation::Restart);
    }
    #[cfg(mobile)]
    {
        if kleio::activate_paired().is_none() {
            return Err("Paired, but the saved pairing could not be read back.".into());
        }
        let token = app.state::<Daemon>().token.clone();
        app.manage(build_http_client(&token));
        // New session first, host port second: the boot-time attempt still
        // waiting for a host is then already superseded when the port lands,
        // so it discards its session instead of racing this one.
        start_default_window_session(app.clone(), "main".into());
        *app.state::<Daemon>().port.lock().unwrap() = Some(kleio::REMOTE_PORT_SENTINEL);
        log::info!("kleio: pairing switched on in place");
        #[cfg(target_os = "ios")]
        kleio::phone::enable_notifications(&app);
    }
    let _ = &app;
    Ok(PairingActivation::Active)
}

/// Register the shared HTTP client. kleio: an unpaired iPhone registers none —
/// the client must carry the device token, which only exists after pairing,
/// and a phone app cannot relaunch to rebuild it; `kleio_activate_pairing`
/// registers it then. Commands asking for it before that get a clean error.
fn with_http_client(
    builder: tauri::Builder<tauri::Wry>,
    client: reqwest::Client,
) -> tauri::Builder<tauri::Wry> {
    if cfg!(mobile) && kleio::remote().is_none() {
        builder
    } else {
        builder.manage(client)
    }
}

/// The shared reqwest client every proxy call uses, authenticated by default
/// headers so all ~60 call sites need no per-site changes.
fn build_http_client(daemon_token: &str) -> reqwest::Client {
    let mut default_headers = reqwest::header::HeaderMap::new();
    if let Ok(v) = reqwest::header::HeaderValue::from_str(daemon_token) {
        default_headers.insert("x-gg-token", v);
    }
    // kleio: registration point 2/3 — the host checks a device token instead,
    // and the client reaches it as its pairing says (over the link, or a URL).
    if let Some(r) = kleio::remote() {
        if let Ok(v) = reqwest::header::HeaderValue::from_str(&r.device_token) {
            default_headers.insert(kleio::DEVICE_TOKEN_HEADER, v);
        }
        if let Some(c) = r.control_credential.as_deref() {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(c) {
                default_headers.insert(kleio::CONTROL_HEADER, v);
            }
        }
    }
    kleio::client_builder()
        .default_headers(default_headers)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_rustls_provider();

    // Per-launch daemon auth token (see `Daemon::token`), sent by the shared
    // client as a default header.
    let daemon_token = uuid::Uuid::new_v4().to_string();
    let http_client = build_http_client(&daemon_token);

    let builder = with_link_plugins(with_desktop_plugins(tauri::Builder::default()));
    with_http_client(builder, http_client)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("gg-app".into()),
                    },
                ))
                .build(),
        )
        .manage(Daemon {
            token: daemon_token,
            ..Default::default()
        })
        .manage(Windows::default())
        .manage(RestoreTargets::default())
        .manage(AppExiting::default())
        .manage(FocusedWindow::default())
        .manage(MoveDebounce::default())
        .manage(TrayState::default())
        .manage(TrayIntents::default())
        .manage(kleio::biometric::BiometricGate::default()) // kleio
        .manage(kleio::radio::LocalRadio::default()) // kleio
        .manage(kleio::Presence::default()) // kleio
        .manage(kleio::push::PushToken::default()) // kleio
        .manage(kleio::push::PendingTap::default()) // kleio
        .manage(kleio::live::LiveTokens::default()) // kleio
        .manage(kleio::files::Downloads::default()) // kleio
        .manage(kleio::BridgeEpochs::default()) // kleio
        .manage(keep_awake::KeepAwake::default()) // kleio voice keep-awake
        .manage(kleio::parked::Parked::load(
            kleio::parked::path(&home_dir()),
        )) // kleio
        .invoke_handler(tauri::generate_handler![
            kleio::kleio_remote_status, // kleio
            kleio::commands::kleio_pair,
            kleio::commands::kleio_forget,
            kleio_activate_pairing,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            kleio::link::kleio_link_check_ticket,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            kleio::link::kleio_link_pair,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            kleio::link::kleio_link_pair_cancel,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            kleio::link::kleio_link_status,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            kleio::switch::kleio_switch_status,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            kleio::switch::kleio_switch_remove_old,
            daemon::kleio_chat_for_session,
            kleio::push::kleio_take_notification_tap,
            kleio::live::kleio_live_start,
            kleio::commands::kleio_devices,
            kleio::commands::kleio_revoke,
            kleio::commands::kleio_offer,
            kleio::commands::kleio_pair_state,
            kleio::commands::kleio_pair_decide,
            kleio::commands::kleio_pair_cancel,
            kleio::commands::kleio_recent_pairings,
            kleio::commands::kleio_admin_state,
            kleio::commands::kleio_admin_lock,
            kleio::commands::kleio_api,
            kleio::commands::kleio_voice_call,
            kleio::files::kleio_file_fetch,
            keep_awake::keep_awake_acquire,
            keep_awake::keep_awake_release,
            keep_awake::agent_keep_awake_get,
            keep_awake::agent_keep_awake_set,
            kleio::files::kleio_file_open,
            kleio::files::kleio_file_save,
            kleio::files::kleio_site_open,
            kleio::show::kleio_show_part,
            kleio::tailscale::kleio_tailscale_status,
            daemon::sidecar_port,
            daemon::retry_window_session,
            commands::files::dropped_path_info,
            paths::permissions_status,
            paths::open_permissions_settings,
            commands::files::read_dropped_file_attachment,
            commands::files::open_project_path,
            commands::files::open_image_data,
            commands::files::open_url,
            commands::agent::agent_state,
            commands::agent::agent_memories,
            commands::agent::agent_delete_memory,
            commands::agent::agent_jiwa,
            commands::agent::agent_delete_jiwa,
            commands::agent::agent_save_memory,
            commands::agent::agent_save_jiwa,
            commands::agent::agent_progress,
            commands::agent::agent_usage,
            commands::agent::agent_prompt,
            commands::agent::agent_cancel,
            commands::agent::agent_ken_prompt,
            commands::agent::agent_ken_cancel,
            commands::agent::agent_autopilot_set,
            commands::agent::agent_accept_plan,
            commands::agent::agent_new_session,
            commands::agent::agent_history,
            commands::agent::agent_history_images,
            commands::agent::agent_export_transcript,
            commands::agent::agent_auth_oauth_start,
            commands::agent::agent_auth_oauth_code,
            commands::agent::agent_mcp_elicit,
            commands::agent::agent_ask_user,
            ask_notify::desktop_notify_ask,
            commands::agent::agent_kill_task,
            commands::agent::agent_import_transcript,
            commands::agent::agent_cancel_queued,
            commands::agent::agent_radio_state,
            commands::agent::agent_radio_set,
            commands::agent::agent_radio_volume,
            commands::agent::agent_tasks,
            commands::agent::agent_checklist,
            commands::agent::agent_run_tasks,
            commands::agent::agent_delete_task,
            commands::agent::agent_cycle_thinking,
            commands::agent::agent_models,
            commands::agent::agent_switch_model,
            commands::agent::agent_switch_ken_model,
            commands::agent::agent_enhance_prompt,
            commands::agent::agent_prewarm,
            commands::agent::agent_transcribe,
            commands::agent::agent_commands,
            windows::setup_windows,
            windows::new_window,
            windows::open_whatsnew_window,
            windows::select_project,
            commands::agent_admin::agent_projects,
            commands::agent_admin::agent_project_folders,
            commands::agent_admin::routines_list,
            commands::agent_admin::routines_add,
            commands::agent_admin::routines_remove,
            commands::agent_admin::agent_goals,
            commands::agent_admin::agent_create_goal,
            commands::agent_admin::agent_goal_kickoff,
            commands::agent_admin::agent_update_goal,
            commands::agent_admin::agent_goal_pause,
            commands::agent_admin::agent_goal_resume,
            commands::agent_admin::agent_delete_goal,
            commands::agent_admin::agent_set_critter_model,
            commands::agent_admin::agent_sessions,
            commands::agent_admin::agent_delete_chat,
            commands::agent_admin::agent_files,
            commands::agent::agent_plugins,
            commands::agent::agent_install_plugin,
            commands::agent::agent_remove_plugin,
            commands::agent_admin::agent_set_project_hidden,
            settings::app_settings_get,
            settings::app_settings_save,
            settings::app_create_project,
            auth::app_auth_status,
            auth::app_auth_apikey,
            auth::app_auth_logout,
            commands::agent_admin::agent_telegram_get,
            commands::agent_admin::agent_telegram_save,
            commands::agent_admin::agent_local,
            commands::agent_admin::agent_local_scan,
            commands::agent_admin::agent_local_endpoint_add,
            commands::agent_admin::agent_local_endpoint_remove,
            commands::agent_admin::agent_hf_search,
            commands::agent_admin::agent_hf_pull,
            commands::agent_admin::agent_hf_pull_status,
            commands::agent_admin::agent_hf_pull_cancel,
            commands::agent_admin::agent_serve_status,
            commands::agent_admin::agent_serve_start,
            commands::agent_admin::agent_serve_stop,
            commands::agent_admin::agent_steroids_status,
            commands::agent_admin::agent_steroids_install,
            commands::agent_admin::agent_mcp_list,
            commands::agent_admin::agent_mcp_add,
            commands::agent_admin::agent_mcp_remove,
            commands::agent_admin::agent_mcp_login,
            windows::gaze_focus,
            windows::focus_window_by_offset,
            windows::arrange_all,
            settings::window_restore_target,
            tray::window_tray_intent,
            tray::set_update_available,
            tray::set_remote_active
        ])
        .setup(|app| {
            // Windows-only: track per-window minimized state so restoring one
            // window can restore its siblings (macOS does this natively).
            #[cfg(target_os = "windows")]
            app.manage(MinimizeState::default());
            // kleio (iPhone): close the event streams whenever the app goes to
            // the background, so the host sees nobody watching and notifies.
            #[cfg(target_os = "ios")]
            kleio::phone::watch_background(app.handle());
            // kleio (iPhone): a tapped notification opens what it is about.
            // Must be in place before launch finishes; this is that moment.
            #[cfg(target_os = "ios")]
            kleio::phone::handle_notification_taps(app.handle());
            // kleio (iPhone): Live Activities. Collect the push tokens iOS
            // issues for them, so the host can keep them current.
            #[cfg(target_os = "ios")]
            kleio::live::begin(app.handle());
            // Sweep orphaned sidecars from previous (crashed/force-quit) app
            // instances BEFORE spawning any new sidecars — they'd otherwise
            // accumulate forever across launches. Best-effort + logged.
            // Cross-platform: uses `ps` on Unix, PowerShell CIM on Windows.
            // kleio: Kleio runs no local sidecars, so there are none of its own
            // to sweep, and GG Coder's on this Mac are not ours to touch.
            if !kleio::REMOTE_ONLY {
                sweep_orphan_sidecars();
            }
            // macOS menu-bar / Windows notification-area presence. Built before
            // the windows so the status item is there even if window restore is
            // slow. Non-fatal: a tray failure must never stop the app launching.
            #[cfg(any(target_os = "macos", windows))]
            if let Err(e) = init_tray(&app.handle().clone()) {
                log::warn!("tray init failed: {e}");
            }
            // kleio (macOS and iPhone): the link's state and log and, when
            // this launch reaches the host over the link, its loopback
            // listener, up before the first request below.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            kleio::link::setup(app.handle());
            // Spawn the ONE shared Node daemon before any window asks for a
            // session. Window session creation (in restore/setup) awaits its
            // `GG_APP_LISTENING` port via `await_daemon_port`.
            // kleio: registration point 3/3 — remote host: nothing to spawn.
            // Not paired (Kleio): no engine at all; the webview shows the
            // connect-to-your-Mac-mini screen.
            if kleio::remote().is_some() {
                *app.state::<Daemon>().port.lock().unwrap() = Some(kleio::REMOTE_PORT_SENTINEL);
                // kleio (iPhone): replies an earlier launch left running in
                // the background — dispose each once it finishes.
                let parked = if cfg!(mobile) {
                    app.state::<kleio::parked::Parked>().snapshot()
                } else {
                    Vec::new()
                };
                for (path, id) in parked {
                    watch_parked_session(
                        app.handle().clone(),
                        kleio::REMOTE_PORT_SENTINEL,
                        path,
                        id,
                    );
                }
                // kleio (iPhone): "agent finished" notifications.
                #[cfg(target_os = "ios")]
                kleio::phone::enable_notifications(app.handle());
            } else if !kleio::REMOTE_ONLY {
                spawn_daemon(app.handle().clone(), false);
            }
            // Restore the previous session's windows (each at its project +
            // session) when a workspace snapshot exists; otherwise build the
            // single default `main` window. Windows are built in code (not from
            // config) so macOS gets `hidden_title(true)` via the builder.
            restore_or_default_windows(&app.handle().clone())?;
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // Backstop: a page that (re)loads holds nothing, so a reload in the
            // middle of a voice call can't keep the Mac awake.
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview
                    .app_handle()
                    .state::<keep_awake::KeepAwake>()
                    .release_window(webview.label());
            }
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                let app = window.app_handle();
                // Backstop: a closed window can't keep the Mac awake.
                app.state::<keep_awake::KeepAwake>()
                    .release_window(window.label());
                // A target can remain pending when a webview closes before mount.
                remove_restore_target(
                    &mut app.state::<RestoreTargets>().map.lock().unwrap(),
                    window.label(),
                );
                // A deliberate close (app NOT quitting) drops this window from the
                // workspace so it doesn't reopen next launch. During quit the
                // AppExiting flag is set, so the snapshot is preserved intact.
                let exiting = app.state::<AppExiting>().0.load(Ordering::SeqCst);
                if !exiting {
                    remove_window_from_workspace(app, window.label());
                }
                // Dispose only THIS window's session in the shared daemon so
                // other projects keep running. The daemon process itself is
                // never killed here (that happens only on app exit).
                let state: State<Windows> = window.state();
                let session_id = state
                    .map
                    .lock()
                    .unwrap()
                    .remove(window.label())
                    .and_then(|w| w.session_id);
                if let Some(id) = session_id {
                    if let Some(port) = *app.state::<Daemon>().port.lock().unwrap() {
                        let app2 = app.clone();
                        tauri::async_runtime::spawn(async move {
                            daemon_delete_session(&app2, port, &id).await;
                        });
                    }
                }
                // Update peers: the closed window is gone from the reading order.
                broadcast_window_order(app);
            }
            // Track which window holds keyboard focus and notify peers so each
            // can dim/brighten its position label + input border.
            tauri::WindowEvent::Focused(focused) if *focused => {
                let app = window.app_handle().clone();
                {
                    let state: State<FocusedWindow> = app.state();
                    *state.0.lock().unwrap() = Some(window.label().to_string());
                }
                broadcast_window_order(&app);
            }
            // Windows-only: a single taskbar click un-minimizes just the picked
            // window. Cascade the restore to its siblings so the whole workspace
            // reopens together, like macOS. Compiled out on macOS (falls to `_`).
            #[cfg(target_os = "windows")]
            tauri::WindowEvent::Resized(_) => {
                restore_sibling_windows(window);
            }
            // kleio: the iPhone app is back on screen. iOS froze its sockets
            // while it was away, so reconnect the event streams now; the host
            // replays what was missed from each stream's Last-Event-ID.
            #[cfg(mobile)]
            tauri::WindowEvent::Resumed => {
                log::info!("kleio: app resumed; reconnecting event streams");
                let app = window.app_handle().clone();
                // iOS may have taken the link's listener away while the app
                // was suspended: it listens again before anything is told.
                #[cfg(target_os = "ios")]
                kleio::link::listen_again(&app);
                app.state::<kleio::Presence>().foreground();
                // A push-token registration that failed earlier gets another go.
                tauri::async_runtime::spawn(async move {
                    kleio::push::register_due(&app.state::<kleio::push::PushToken>()).await;
                    #[cfg(target_os = "ios")]
                    kleio::live::register_due(&app.state::<kleio::live::LiveTokens>()).await;
                });
            }
            // Debounced: native drag fires Moved per pixel. Only the last move's
            // deferred task fires (its captured Instant still matches), so peers
            // learn the new reading order ~150ms after the drag settles.
            tauri::WindowEvent::Moved(_) => {
                let app = window.app_handle().clone();
                let now = std::time::Instant::now();
                {
                    let state: State<MoveDebounce> = app.state();
                    *state.0.lock().unwrap() = Some(now);
                }
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let fire = {
                        let state: State<MoveDebounce> = app.state();
                        let guard = state.0.lock().unwrap();
                        *guard == Some(now)
                    };
                    if fire {
                        broadcast_window_order(&app);
                    }
                });
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // kleio (iPhone): a tapped Live Activity opens its conversation.
            #[cfg(target_os = "ios")]
            if let RunEvent::Opened { urls } = &event {
                for url in urls {
                    kleio::live::open_url(app, url.as_str());
                }
            }
            if let RunEvent::ExitRequested { .. } = event {
                // Mark the quit BEFORE windows start tearing down, so the
                // Destroyed handlers preserve the snapshot, then write the final
                // snapshot (current geometry + each window's live cwd/session).
                app.state::<AppExiting>().0.store(true, Ordering::SeqCst);
                refresh_live_sessions(app);
                snapshot_workspace(app);
                // Terminate the daemon's process group once — reaps every
                // session's MCP/LSP children in one shot (no orphans).
                let child = app.state::<Daemon>().child.lock().unwrap().take();
                if let Some(child) = child {
                    terminate_child(child);
                }
                // kleio: remote mode's radio plays locally — silence it.
                app.state::<kleio::radio::LocalRadio>().stop();
            }
            if let RunEvent::Exit = event {
                // Backstop: never leave a power assertion behind on quit.
                app.state::<keep_awake::KeepAwake>().release_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the startup crash from the reqwest 0.13 bump: the shared client is
    /// built before anything else in `run()`, and without a rustls provider that
    /// build PANICS, so the packaged app died on launch with no error of its
    /// own. Asserting `build()` succeeds after `install_rustls_provider` catches
    /// a provider that stops covering the feature set reqwest is compiled with.
    ///
    /// It cannot see the CALL being dropped from `run()` — that ordering is only
    /// observable by launching the app, which is the Windows packaged smoke's job.
    #[test]
    fn shared_http_client_builds_after_provider_install() {
        install_rustls_provider();
        assert!(
            reqwest::Client::builder().build().is_ok(),
            "shared client must build once the rustls provider is installed",
        );
    }
}

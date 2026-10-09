use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

/// Lock a mutex, recovering the guard if a previous holder panicked. A
/// poisoned lock must not cascade into crashing the whole desktop app.
pub(crate) trait LockExt<T> {
    fn lock_or_recover(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

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
use futures_util::StreamExt;
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
fn install_rustls_provider() {
    // Fails only if a provider is already installed, which is the outcome we
    // want anyway — so the result is deliberately ignored.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_rustls_provider();

    // Per-launch daemon auth token (see `Daemon::token`). The shared reqwest
    // client attaches it as a default header so all ~60 proxy call sites are
    // authenticated without per-site changes.
    let daemon_token = uuid::Uuid::new_v4().to_string();
    let mut default_headers = reqwest::header::HeaderMap::new();
    default_headers.insert(
        "x-gg-token",
        reqwest::header::HeaderValue::from_str(&daemon_token)
            .expect("uuid v4 is valid header ASCII"),
    );
    let http_client = reqwest::Client::builder()
        .default_headers(default_headers)
        // The daemon is on loopback, so a connect that doesn't land quickly
        // never will. No overall timeout here: the SSE stream is long-lived.
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
        .manage(http_client)
        .invoke_handler(tauri::generate_handler![
            daemon::sidecar_port,
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
            commands::agent::agent_progress,
            commands::agent::agent_keep_awake_get,
            commands::agent::agent_keep_awake_set,
            commands::agent::agent_usage,
            commands::agent::agent_prompt,
            commands::agent::agent_cancel,
            commands::agent::agent_ken_prompt,
            commands::agent::agent_ken_cancel,
            commands::agent::agent_autopilot_set,
            commands::agent::agent_accept_plan,
            commands::agent::agent_new_session,
            commands::agent::agent_history,
            commands::agent::agent_export_transcript,
            commands::agent::agent_auth_apikey,
            commands::agent::agent_auth_oauth_start,
            commands::agent::agent_auth_oauth_code,
            commands::agent::agent_mcp_elicit,
            commands::agent::agent_ask_user,
            commands::agent::agent_auth_logout,
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
            commands::agent::agent_prewarm,
            commands::agent::agent_models,
            commands::agent::agent_switch_model,
            commands::agent::agent_switch_ken_model,
            commands::agent::agent_enhance_prompt,
            commands::agent::agent_commands,
            windows::setup_windows,
            windows::new_window,
            windows::open_whatsnew_window,
            windows::reveal_whatsnew_window,
            windows::select_project,
            commands::agent_admin::agent_projects,
            commands::agent_admin::agent_sessions,
            commands::agent_admin::agent_files,
            commands::agent::agent_settings,
            commands::agent::agent_save_settings,
            commands::agent::agent_plugins,
            commands::agent::agent_install_plugin,
            commands::agent::agent_remove_plugin,
            commands::agent_admin::agent_create_project,
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
            // Sweep orphaned sidecars from previous (crashed/force-quit) app
            // instances BEFORE spawning any new sidecars — they'd otherwise
            // accumulate forever across launches. Best-effort + logged.
            // Cross-platform: uses `ps` on Unix, PowerShell CIM on Windows.
            sweep_orphan_sidecars();
            // macOS menu-bar / Windows notification-area presence. Built before
            // the windows so the status item is there even if window restore is
            // slow. Non-fatal: a tray failure must never stop the app launching.
            #[cfg(any(target_os = "macos", windows))]
            if let Err(e) = init_tray(&app.handle().clone()) {
                log::warn!("tray init failed: {e}");
            }
            // Spawn the ONE shared Node daemon before any window asks for a
            // session. Window session creation (in restore/setup) awaits its
            // `GG_APP_LISTENING` port via `await_daemon_port`.
            spawn_daemon(app.handle().clone(), false);
            // Restore the previous session's windows (each at its project +
            // session) when a workspace snapshot exists; otherwise build the
            // single default `main` window. Windows are built in code (not from
            // config) so macOS gets `hidden_title(true)` via the builder.
            restore_or_default_windows(&app.handle().clone())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                let app = window.app_handle();
                // A target can remain pending when a webview closes before mount.
                remove_restore_target(
                    &mut app.state::<RestoreTargets>().map.lock_or_recover(),
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
                    .lock_or_recover()
                    .remove(window.label())
                    .and_then(|w| w.session_id);
                if let Some(id) = session_id {
                    if let Some(port) = *app.state::<Daemon>().port.lock_or_recover() {
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
                    *state.0.lock_or_recover() = Some(window.label().to_string());
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
            // Debounced: native drag fires Moved per pixel. Only the last move's
            // deferred task fires (its captured Instant still matches), so peers
            // learn the new reading order ~150ms after the drag settles.
            tauri::WindowEvent::Moved(_) => {
                let app = window.app_handle().clone();
                let now = std::time::Instant::now();
                {
                    let state: State<MoveDebounce> = app.state();
                    *state.0.lock_or_recover() = Some(now);
                }
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                    let fire = {
                        let state: State<MoveDebounce> = app.state();
                        let guard = state.0.lock_or_recover();
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
            if let RunEvent::ExitRequested { .. } = event {
                // Mark the quit BEFORE windows start tearing down, so the
                // Destroyed handlers preserve the snapshot, then write the final
                // snapshot (current geometry + each window's live cwd/session).
                app.state::<AppExiting>().0.store(true, Ordering::SeqCst);
                refresh_live_sessions(app);
                snapshot_workspace(app);
                // Terminate the daemon's process group once — reaps every
                // session's MCP/LSP children in one shot (no orphans).
                let child = app.state::<Daemon>().child.lock_or_recover().take();
                if let Some(child) = child {
                    terminate_child(child);
                }
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

//! System tray (macOS menu bar / Windows notification area).

use crate::*;

// ── System tray (macOS menu bar / Windows notification area) ──────────────
// One status item giving the app a presence while its windows are hidden behind
// a fullscreen editor.
//
// The icon is platform-split, and the split is NOT cosmetic:
//   macOS   — a black-on-transparent "G" flagged as a TEMPLATE image, which the
//             system re-tints for light/dark menu bars. Feeding the rounded app
//             tile here would render as a solid blob.
//   Windows — the full-colour app icon. Windows has no template concept, so a
//             monochrome mark would vanish on either the light or the dark
//             taskbar; the tile carries its own background and reads on both.
// (Same split, same reasoning, as openclaw's Tauri tray.)
//
// Linux is excluded: it needs libayatana-appindicator and we don't ship Linux
// (see the release workflow's matrix).
//
// The menu has no per-item visibility API in muda, so "Update now" is added and
// removed by REBUILDING the menu whenever the webview reports a change
// (`set_update_available` / `set_remote_active`).

/// Tray menu item ids. Kept as one list so the builder and the click handler
/// can never drift apart.
#[cfg(any(target_os = "macos", windows))]
pub(crate) mod tray_id {
    pub const UPDATE: &str = "tray:update";
    pub const NEW_CHAT: &str = "tray:new-chat";
    pub const NEW_CODE: &str = "tray:new-code";
    pub const REMOTE: &str = "tray:remote";
    pub const SETTINGS: &str = "tray:settings";
}

/// Everything the tray menu's labels depend on. Both fields are pushed down by
/// the webview (Rust owns neither the updater nor the Telegram serve loop), and
/// any change rebuilds the menu.
#[derive(Default, Clone, PartialEq, Eq)]
pub(crate) struct TrayStatus {
    /// Pending update version, or `None` when up to date. Drives whether the
    /// "Update now" item exists at all.
    pub(crate) update_version: Option<String>,
    /// True while the Telegram serve loop is running. Flips the Remote item
    /// between "Remote" and "Remote · Turn off".
    pub(crate) remote_active: bool,
}

#[derive(Default)]
pub(crate) struct TrayState(pub(crate) Mutex<TrayStatus>);

/// Tray actions handed to a window that does not exist yet. A freshly built
/// window's webview isn't listening when the menu is clicked, so the intent is
/// parked here and the webview claims it on mount via `window_tray_intent`.
#[derive(Default)]
pub(crate) struct TrayIntents(pub(crate) Mutex<HashMap<String, String>>);

/// True for the real app windows (`main`, `project-N`) — excludes transient
/// chrome like the borderless `whatsnew` dialog, which must never be treated as a place to route a tray action.
#[cfg(any(target_os = "macos", windows))]
pub(crate) fn is_app_window(label: &str) -> bool {
    is_workspace_window(label)
}

/// App-window labels in reading order (left-to-right, top-to-bottom).
#[cfg(any(target_os = "macos", windows))]
pub(crate) fn app_window_labels(app: &tauri::AppHandle) -> Vec<String> {
    compute_window_order(app)
        .into_iter()
        .filter(|l| is_app_window(l))
        .collect()
}

/// The window a tray action should target: the focused app window when there is
/// one, else the first in reading order. `None` when no app window is open.
#[cfg(any(target_os = "macos", windows))]
pub(crate) fn tray_target_window(app: &tauri::AppHandle) -> Option<String> {
    let labels = app_window_labels(app);
    let focused = app.state::<FocusedWindow>().0.lock_or_recover().clone();
    focused
        .filter(|l| labels.iter().any(|x| x == l))
        .or_else(|| labels.first().cloned())
}

/// Build the tray menu for a given status. "Update now" is present ONLY while
/// `update_version` is `Some` — muda has no per-item visibility API, so the menu
/// is rebuilt instead.
#[cfg(any(target_os = "macos", windows))]
pub(crate) fn build_tray_menu(
    app: &tauri::AppHandle,
    status: &TrayStatus,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let menu = Menu::new(app)?;
    if let Some(version) = status.update_version.as_deref() {
        menu.append(&MenuItem::with_id(
            app,
            tray_id::UPDATE,
            format!("Update now \u{2192} v{version}"),
            true,
            None::<&str>,
        )?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(
        app,
        tray_id::NEW_CHAT,
        "New chat session",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        tray_id::NEW_CODE,
        "New code session",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        tray_id::REMOTE,
        if status.remote_active {
            "Remote \u{b7} Turn off"
        } else {
            "Remote"
        },
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        tray_id::SETTINGS,
        "Settings",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

/// Install the status item. Called once from `setup`.
#[cfg(any(target_os = "macos", windows))]
pub(crate) fn init_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::image::Image;
    use tauri::tray::TrayIconBuilder;

    // Black-on-transparent 72x72 PNG, flagged as a template below so macOS
    // re-tints it per menu-bar appearance instead of us shipping two assets.
    #[cfg(target_os = "macos")]
    let icon = Image::from_bytes(include_bytes!("../icons/tray-mac.png"))?;
    // Windows: the full-colour app tile. `CreateIcon` uses the bitmap at its
    // native size, so this is the 32x32 asset (16pt at 200% DPI) rather than the
    // 72px mac one, which the shell would have to scale down.
    #[cfg(windows)]
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    TrayIconBuilder::with_id("gg")
        .icon(icon)
        // Template tinting is a macOS concept; on Windows it must stay off or the
        // colour tile would be flattened.
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("GG Coder")
        .menu(&build_tray_menu(app, &TrayStatus::default())?)
        // The icon has no action other than its menu, so a click that did nothing
        // would read as broken. Right-click opens it too (tray-icon defaults
        // `menu_on_right_click` to true and tracks the two independently), so
        // Windows still gets its expected right-click behaviour.
        //
        // Apps that ALSO open a window on left click must set this to `false` on
        // Windows or the click does two things at once (rustdesk #15215). That
        // does not apply here precisely because the menu is the only action — so
        // don't "fix" this by copying their `cfg(windows)` override.
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let action = match event.id().as_ref() {
                tray_id::UPDATE => "update",
                tray_id::NEW_CHAT => "new-chat",
                tray_id::NEW_CODE => "new-code",
                tray_id::REMOTE => "remote",
                tray_id::SETTINGS => "settings",
                _ => return,
            };
            dispatch_tray_action(app.clone(), action);
        })
        .build(app)?;
    Ok(())
}

/// Route a tray action to a window and tell that window's webview what to do.
///
/// `new-chat` / `new-code` reuse the single open window when there is exactly
/// one; with several windows open there is no unambiguous "current" one, so a
/// NEW window is opened for the session instead of hijacking someone's work.
/// `remote` / `settings` always act on the existing target window (they're
/// app-wide, not per-session) and only open a window when none exists.
#[cfg(any(target_os = "macos", windows))]
pub(crate) fn dispatch_tray_action(app: tauri::AppHandle, action: &'static str) {
    let labels = app_window_labels(&app);
    let wants_new_window = match action {
        "new-chat" | "new-code" => labels.len() != 1,
        _ => labels.is_empty(),
    };

    if !wants_new_window {
        let Some(label) = tray_target_window(&app) else {
            return;
        };
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
        let _ = app.emit_to(EventTarget::webview_window(&label), "tray-intent", action);
        return;
    }

    // Window building must not run on the caller's thread (see `new_window`).
    tauri::async_runtime::spawn(async move {
        let label = next_window_label(&app);
        // Park the intent BEFORE the webview can mount, so the claim on mount
        // never races the window build.
        app.state::<TrayIntents>()
            .0
            .lock_or_recover()
            .insert(label.clone(), action.to_string());
        let Ok(win) = build_app_window(&app, &label) else {
            app.state::<TrayIntents>()
                .0
                .lock_or_recover()
                .remove(&label);
            return;
        };
        start_window_session(
            app.clone(),
            label,
            WorkspaceMode::Code,
            ChatAgent::General,
            default_cwd(),
            None,
        );
        let _ = win.set_focus();
        broadcast_window_order(&app);
    });
}

/// Claim (once) the tray action this window was opened for. Returns `None` for
/// windows the user opened themselves.
#[tauri::command]
pub(crate) fn window_tray_intent(webview: WebviewWindow) -> Option<String> {
    let state: State<TrayIntents> = webview.state();
    let mut map = state.0.lock_or_recover();
    map.remove(webview.label())
}

/// Apply `edit` to the tray status and rebuild the menu IF anything changed.
/// The no-change guard matters: every window pushes status on a timer, so
/// without it the menu would be rebuilt constantly (and would collapse while
/// open).
pub(crate) fn update_tray_status(app: &tauri::AppHandle, edit: impl FnOnce(&mut TrayStatus)) {
    let next = {
        let state: State<TrayState> = app.state();
        let mut current = state.0.lock_or_recover();
        let mut next = current.clone();
        edit(&mut next);
        if next == *current {
            return;
        }
        *current = next.clone();
        next
    };
    let _ = &next;
    #[cfg(any(target_os = "macos", windows))]
    {
        use tauri::tray::TrayIconId;
        if let Some(tray) = app.tray_by_id(&TrayIconId::new("gg")) {
            match build_tray_menu(app, &next) {
                Ok(menu) => {
                    let _ = tray.set_menu(Some(menu));
                }
                Err(e) => log::warn!("tray menu rebuild failed: {e}"),
            }
        }
    }
}

/// Report update availability from the webview so the tray can show or hide
/// "Update now". `version` is `None` when up to date.
#[tauri::command]
pub(crate) fn set_update_available(app: tauri::AppHandle, version: Option<String>) {
    update_tray_status(&app, |s| s.update_version = version);
}

/// Report whether the Telegram serve loop is running, so the tray's Remote item
/// reads "Remote" or "Remote · Turn off".
#[tauri::command]
pub(crate) fn set_remote_active(app: tauri::AppHandle, active: bool) {
    update_tray_status(&app, |s| s.remote_active = active);
}

//! Window building, window commands, tiling/reading order, and Windows minimize cascade.

use crate::*;

/// Windows-only: per-window last-known minimized state. Used to detect the
/// minimized→restored edge in `Resized` events (on Windows, minimize fires
/// `Resized(0,0)` / `is_minimized()==true`, restore fires `Resized(real)` /
/// `is_minimized()==false`) so that restoring ONE window brings all its
/// siblings back too — matching the macOS dock-reopen behavior. On macOS the
/// OS already restores every window from a single dock click, so the whole
/// `Resized` arm is compiled out there and this state is never populated.
#[cfg(target_os = "windows")]
#[derive(Default)]
pub(crate) struct MinimizeState(pub(crate) Mutex<HashMap<String, bool>>);

/// Windows-only: on the minimized→restored edge of one window, un-minimize
/// every sibling so a single taskbar click brings the whole workspace back
/// (like macOS). Ordinary resizes/drags are ignored — only a true
/// minimized→restored transition triggers the cascade. We pre-mark every
/// window as restored before calling `unminimize()`, so the `Resized` events
/// those calls generate don't re-cascade. No `set_focus()` — un-minimizing
/// siblings must not steal focus from the window the user actually clicked.
#[cfg(target_os = "windows")]
pub(crate) fn restore_sibling_windows(window: &tauri::Window) {
    let app = window.app_handle();
    let label = window.label().to_string();
    let cur = window.is_minimized().unwrap_or(false);
    let state: State<MinimizeState> = app.state();
    // Act only on an actual minimized (prev) → restored (cur == false) edge.
    let cascade = {
        let mut map = state.0.lock_or_recover();
        let prev = map.get(&label).copied().unwrap_or(false);
        map.insert(label.clone(), cur);
        prev && !cur
    };
    if !cascade {
        return;
    }
    // Collect siblings AND pre-mark every window restored, holding the lock only
    // briefly — never across a window call. `unminimize()` on Windows can
    // synchronously re-enter this handler (ShowWindow dispatches WM_SIZE), so a
    // lock held across it would deadlock the (non-reentrant) mutex. Pre-marking
    // makes any such re-entrant call read prev == false and skip the cascade.
    let siblings: Vec<WebviewWindow> = {
        let mut map = state.0.lock_or_recover();
        let mut out = Vec::new();
        for (sib_label, win) in app.webview_windows() {
            map.insert(sib_label.clone(), false);
            if sib_label != label {
                out.push(win);
            }
        }
        out
    };
    for win in siblings {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
    }
}

/// App background (#111317) painted on the native window + webview BEFORE the
/// first frame, so opening a new window never flashes white.
pub(crate) const APP_BG: tauri::window::Color = tauri::window::Color(15, 17, 21, 255);

/// Per-OS window chrome decision. macOS uses the Overlay title bar (webview
/// draws under the traffic lights); every other OS keeps native decorations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowChrome {
    MacOverlay,
    Native,
}

/// Compile-time chrome selection: Overlay only on macOS, native elsewhere.
pub(crate) fn window_chrome() -> WindowChrome {
    if cfg!(target_os = "macos") {
        WindowChrome::MacOverlay
    } else {
        WindowChrome::Native
    }
}

/// Apply the macOS Overlay title bar + hidden title to a window builder. Kept
/// behind `#[cfg(target_os = "macos")]` because `TitleBarStyle::Overlay` and
/// `hidden_title` are macOS-only builder methods.
#[cfg(target_os = "macos")]
pub(crate) fn apply_mac_overlay<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
}

/// No-op on non-macOS: native chrome is the default, nothing to apply.
#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_mac_overlay<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
}

/// Build an app window with the standard chrome. On macOS this includes the
/// Overlay title bar + `hidden_title(true)` so the native title text never
/// shows — the in-app `chat-head-title` is the ONLY title. Building via the
/// builder (rather than the config + a runtime patch) is the only way to hide
/// the native title, since there's no runtime `set_hidden_title` setter.
pub(crate) fn build_app_window_with_visibility(
    app: &tauri::AppHandle,
    label: &str,
    visible: bool,
) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("GG Coder")
        .inner_size(1024.0, 720.0)
        .min_inner_size(480.0, 360.0)
        .background_color(APP_BG)
        .visible(visible);
    // Windows needs HTML5 drop enabled for the existing browser attachment path.
    // macOS keeps Tauri's native handler so folder drops include absolute paths.
    #[cfg(target_os = "windows")]
    {
        builder = builder.disable_drag_drop_handler();
    }
    if matches!(window_chrome(), WindowChrome::MacOverlay) {
        builder = apply_mac_overlay(builder);
    }
    builder.build().map_err(|e| e.to_string())
}

pub(crate) fn build_app_window(
    app: &tauri::AppHandle,
    label: &str,
) -> Result<WebviewWindow, String> {
    build_app_window_with_visibility(app, label, true)
}

/// Open enough new project windows to reach `count` total (each with its own
/// agent sidecar at the default cwd), then tile the first `count` windows across
/// the work area like macOS fill&arrange. Project selection per window happens
/// in-app via the picker; windows open immediately.
///
/// MUST be `async`: on Windows, `WebviewWindowBuilder::build()` deadlocks when
/// called from a SYNCHRONOUS command (WebView2 runs window creation on the
/// event loop the sync command is blocking). The symptom was a blank,
/// unresponsive, uncloseable window. An async command runs off that thread, so
/// creation completes normally. See the docs.rs WebviewWindowBuilder "Known
/// issues" note.
#[tauri::command]
pub(crate) async fn setup_windows(app: tauri::AppHandle, count: usize) -> Result<(), String> {
    let existing = app.webview_windows().len();
    let to_create = count.saturating_sub(existing);
    for _ in 0..to_create {
        let label = next_window_label(&app);
        // macOS-only chrome: the Overlay title bar + hidden title lets the
        // webview draw under the traffic lights. Windows/Linux keep native
        // chrome (Overlay is a no-op / unsupported there) and the webview CSS
        // drops the mac traffic-light insets via the `.platform-*` class.
        let win = build_app_window(&app, &label)?;
        start_window_session(
            app.clone(),
            label,
            WorkspaceMode::Code,
            ChatAgent::General,
            default_cwd(),
            None,
        );
        let _ = win.set_focus();
    }
    arrange_windows(&app, count);
    broadcast_window_order(&app);
    Ok(())
}

/// Open a single new project window with its own agent sidecar (default cwd) and
/// focus it. Unlike `setup_windows`, this never re-tiles existing windows — it's
/// the Cmd/Ctrl+N "new window" shortcut. Project selection happens per-window.
///
/// `async` for the same reason as `setup_windows`: a synchronous window-building
/// command deadlocks WebView2 on Windows.
#[tauri::command]
pub(crate) async fn new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = next_window_label(&app);
    let win = build_app_window(&app, &label)?;
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
    Ok(())
}

/// The "What's new" modal lives in its OWN dedicated window so it appears EXACTLY
/// once (the main webview decides; see WhatsNewTrigger) and centers on the user's
/// SCREEN rather than inside whichever tiled project window happens to be open.
/// Reuses `index.html` with a `?whatsnew=1` flag — main.tsx renders only the
/// modal for that flag, so no second Vite entry / build-config change is needed.
/// Borderless + centered + always-on-top + off the taskbar so it reads as a
/// transient OS dialog. The window closes itself from the webview
/// (`getCurrentWebviewWindow().close()`); re-invoking just refocuses an open one.
///
/// `mode` picks the mood: `"hype"` is the one-time show after an update
/// relaunch, anything else (the home screen's button) is the calm read.
///
/// `async` for the same WebView2 reason as `setup_windows`/`new_window`.
#[tauri::command]
pub(crate) async fn open_whatsnew_window(
    app: tauri::AppHandle,
    mode: Option<String>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(WHATSNEW_LABEL) {
        let _ = win.set_focus();
        return Ok(());
    }
    // Built hidden: the page reveals it once its first frame has painted, so
    // the user never sees an empty or half-styled window.
    WebviewWindowBuilder::new(
        &app,
        WHATSNEW_LABEL,
        WebviewUrl::App(whatsnew_url(mode.as_deref()).into()),
    )
    .title("What's new")
    .inner_size(600.0, 640.0)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    // Fail closed: a page that never loads must not leave a hidden window
    // around (it would swallow the next "What's new" click as a refocus).
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WHATSNEW_REVEAL_TIMEOUT).await;
        if let Some(win) = app2.get_webview_window(WHATSNEW_LABEL) {
            if !win.is_visible().unwrap_or(true) {
                log::warn!("What's new window never revealed itself; closing it");
                let _ = win.close();
            }
        }
    });
    Ok(())
}

const WHATSNEW_LABEL: &str = "whatsnew";
/// How long the page gets to paint and call `reveal_whatsnew_window`.
const WHATSNEW_REVEAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Called by the What's-new page once its first frame is painted: show the
/// (so far hidden) window and focus it. Only that window may reveal itself.
#[tauri::command]
pub(crate) fn reveal_whatsnew_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != WHATSNEW_LABEL {
        return Err("only the What's new window can reveal itself".into());
    }
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

/// The What's-new page URL. Only the two known moods reach the webview; an
/// unknown value falls back to calm rather than being passed through.
fn whatsnew_url(mode: Option<&str>) -> &'static str {
    match mode {
        Some("hype") => "index.html?whatsnew=1&mode=hype",
        _ => "index.html?whatsnew=1&mode=calm",
    }
}

/// Cycle keyboard focus by `offset` (±1) through windows in reading order,
/// wrapping around. No-op when ≤1 window is open. Forward = +1, backward = -1
/// (Shift held). Bound to Cmd/Ctrl + Backquote (±Shift).
#[tauri::command]
pub(crate) fn focus_window_by_offset(app: tauri::AppHandle, offset: i32) -> Result<(), String> {
    let order = compute_window_order(&app);
    if order.len() <= 1 {
        return Ok(());
    }
    let cur = app
        .state::<FocusedWindow>()
        .0
        .lock_or_recover()
        .clone()
        .and_then(|f| order.iter().position(|l| l == &f))
        .unwrap_or(0) as i32;
    let len = order.len() as i32;
    // Wrap-safe modulo for negative offsets (backward cycling).
    let next = ((cur + offset) % len + len) % len;
    if let Some(label) = order.get(next as usize) {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_focus();
        }
    }
    Ok(())
}

/// Re-tile EVERY currently open window into a clean grid (no create/destroy),
/// then broadcast the new order. Works for any count (3, 5, 7, 9, 12, …).
///
/// Applies the rects in a STAGGERED async loop (~30ms between windows). On macOS
/// `set_size`/`set_position` dispatch to the main thread asynchronously, and
/// firing all of them in a tight loop lets the window server coalesce the later
/// dispatches — so the trailing windows would move but keep their old size.
/// Staggering lets each window's size+position fully commit before the next's
/// hits the main-thread queue.
#[tauri::command]
pub(crate) async fn arrange_all(app: tauri::AppHandle) -> Result<(), String> {
    let count = app.webview_windows().len();
    let tiles = sorted_windows(&app, count);
    let rects = if tiles.is_empty() {
        Vec::new()
    } else {
        let Some(monitor) = tiles[0].primary_monitor().ok().flatten() else {
            broadcast_window_order(&app);
            return Ok(());
        };
        let area = monitor.work_area();
        tile_rects(
            count,
            area.position.x,
            area.position.y,
            area.size.width as i32,
            area.size.height as i32,
        )
    };
    for (win, rect) in tiles.iter().zip(rects.iter()) {
        apply_tile(win, *rect);
        // Let the main thread commit this window before queuing the next.
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    broadcast_window_order(&app);
    Ok(())
}

/// Re-point THIS window's agent at a chosen project: dispose its current daemon
/// session and create a fresh one at `cwd`, optionally resuming the session file
/// `session_path`. The command resolves only after the daemon session is ready,
/// so a failed resume stays in the picker instead of opening an endless skeleton.
#[tauri::command]
pub(crate) async fn select_project(
    webview: WebviewWindow,
    app: tauri::AppHandle,
    mode: WorkspaceMode,
    chat_agent: ChatAgent,
    cwd: String,
    session_path: Option<String>,
) -> Result<(), String> {
    let label = webview.label().to_string();
    // The existing daemon session is about to be retired. Remove its durable
    // target first so a failed switch or mid-switch webview reload cannot reopen
    // a workspace whose session has already been disposed.
    remove_restore_target(
        &mut app.state::<RestoreTargets>().map.lock_or_recover(),
        &label,
    );
    snapshot_workspace(&app);

    // Take the old session id (and clear it) so the old SSE bridge retires.
    let old_id = {
        let windows: State<Windows> = app.state();
        let mut map = windows.map.lock_or_recover();
        map.get_mut(&label)
            .and_then(|window| window.session_id.take())
    };
    // Dispose the old session on the daemon (best-effort, off-thread).
    if let Some(id) = old_id {
        if let Some(port) = port_for(&webview) {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                daemon_delete_session(&app2, port, &id).await;
            });
        }
    }

    let target = RestoreEntry {
        mode,
        chat_agent,
        cwd: cwd.clone(),
        session_path: session_path.clone(),
    };
    let cwd = PathBuf::from(cwd);
    let generation = prepare_window_session(
        &app,
        &label,
        mode,
        chat_agent,
        &cwd,
        session_path.as_deref(),
    );
    finish_window_session(
        app.clone(),
        label.clone(),
        mode,
        chat_agent,
        cwd,
        session_path,
        generation,
    )
    .await?;

    // Publish the target only after the daemon confirms the selection. Keeping
    // it for the window lifetime lets a reloaded webview recover in place.
    register_restore_target(
        &mut app.state::<RestoreTargets>().map.lock_or_recover(),
        label,
        target,
    );
    snapshot_workspace(&app);
    Ok(())
}

/// Allocate a unique `project-N` window label.
pub(crate) fn next_window_label(app: &tauri::AppHandle) -> String {
    let mut n = 1;
    loop {
        let label = format!("project-{n}");
        if app.get_webview_window(&label).is_none() {
            return label;
        }
        n += 1;
    }
}

/// Pure: the tile rects `(x, y, width, height)` for `count` windows arranged in
/// a generalized grid (`cols = ceil(sqrt(N))`) filling the work area `(ox, oy, w, h)`,
/// in order (row-major: left→right within a row, top→bottom across rows).
pub(crate) fn tile_rects(
    count: usize,
    ox: i32,
    oy: i32,
    w: i32,
    h: i32,
) -> Vec<(i32, i32, u32, u32)> {
    if count == 0 {
        return Vec::new();
    }
    let cols = grid_cols(count);
    let rows: i32 = ((count as i32) + cols - 1) / cols;
    let cell_w = w / cols;
    let cell_h = h / rows;
    (0..count as i32)
        .map(|i| {
            let col = i % cols;
            let row = i / cols;
            (
                ox + col * cell_w,
                oy + row * cell_h,
                cell_w as u32,
                cell_h as u32,
            )
        })
        .collect()
}

/// The first `count` open windows (main first, then project-N ascending). Returns
/// the live window handles in label order. `take`-limited by `count`.
pub(crate) fn sorted_windows(app: &tauri::AppHandle, count: usize) -> Vec<WebviewWindow> {
    let mut windows: Vec<WebviewWindow> = app.webview_windows().into_values().collect();
    // Deterministic order: main first, then project-N ascending.
    windows.sort_by_key(|w| label_rank(w.label()));
    windows.into_iter().take(count).collect()
}

/// Apply one tile rect to a window. Order matters on macOS: `set_size` and
/// `set_position` both dispatch to the main thread asynchronously (tao's
/// `set_content_size_async` / `set_frame_top_left_point_async`), and
/// `setFrameTopLeftPoint` anchors against the window's CURRENT frame size — so
/// resize FIRST (establish correct dimensions), then move to the cell origin.
pub(crate) fn apply_tile(win: &WebviewWindow, rect: (i32, i32, u32, u32)) {
    let (x, y, w, h) = rect;
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Tile the first `count` windows into a grid filling the primary work area.
/// Synchronous (applies all rects immediately) — used at window-creation time
/// (`setup_windows` / restore), where the OS commits each before the next shows.
pub(crate) fn arrange_windows(app: &tauri::AppHandle, count: usize) {
    let tiles = sorted_windows(app, count);
    if tiles.is_empty() {
        return;
    }
    let Some(monitor) = tiles[0].primary_monitor().ok().flatten() else {
        return;
    };
    let area = monitor.work_area();
    let rects = tile_rects(
        count,
        area.position.x,
        area.position.y,
        area.size.width as i32,
        area.size.height as i32,
    );
    for (win, rect) in tiles.iter().zip(rects.iter()) {
        apply_tile(win, *rect);
    }
}

pub(crate) fn label_rank(label: &str) -> (u8, u32) {
    if label == "main" {
        (0, 0)
    } else if let Some(n) = label.strip_prefix("project-").and_then(|s| s.parse().ok()) {
        (1, n)
    } else {
        (2, 0)
    }
}

/// Pure: labels in reading order — rows top→bottom, left→right within a row.
/// Windows whose y differs by < `row_tolerance` from the row's anchor (first
/// member) are treated as the same row. `positions` is `(label, x, y)`.
pub(crate) fn reading_order(positions: &[(String, i32, i32)], row_tolerance: i32) -> Vec<String> {
    if positions.is_empty() {
        return Vec::new();
    }
    // Sort by y so we can walk top→bottom and group into rows.
    let mut sorted: Vec<&(String, i32, i32)> = positions.iter().collect();
    sorted.sort_by_key(|p| p.2);

    let mut rows: Vec<Vec<&(String, i32, i32)>> = Vec::new();
    for &p in &sorted {
        let need_new_row = match rows.last() {
            // Same row when the y gap to the row's anchor is within tolerance.
            Some(row) => (p.2 - row[0].2).abs() > row_tolerance,
            None => true,
        };
        if need_new_row {
            rows.push(vec![p]);
        } else {
            rows.last_mut()
                .expect("need_new_row is false only when rows is non-empty")
                .push(p);
        }
    }

    // Within each row sort left→right by x, then collect labels in order.
    let mut out = Vec::with_capacity(positions.len());
    for mut row in rows {
        row.sort_by_key(|p| p.1);
        for p in row {
            out.push(p.0.clone());
        }
    }
    out
}

/// Pure: column count for a generalized grid tiling N windows.
/// cols = ceil(sqrt(N)) → 1→1, 2→2, 3→2, 4→2, 6→3, 9→3, 12→4.
pub(crate) fn grid_cols(count: usize) -> i32 {
    if count == 0 {
        return 1;
    }
    ((count as f64).sqrt().ceil() as i32).max(1)
}

/// Every open window's label, in reading order (rows top→bottom, left→right
/// within a row). Tolerance ≈ half the smallest window height so tiled same-row
/// windows group reliably while free-floating windows still get a stable order.
pub(crate) fn compute_window_order(app: &tauri::AppHandle) -> Vec<String> {
    let windows = app.webview_windows();
    let mut positions: Vec<(String, i32, i32)> = Vec::with_capacity(windows.len());
    let mut min_height: i32 = i32::MAX;
    for (label, win) in &windows {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            continue;
        };
        let h = size.height as i32;
        if h > 0 && h < min_height {
            min_height = h;
        }
        positions.push((label.clone(), pos.x, pos.y));
    }
    // Floor the tolerance so a single tiny window doesn't collapse rows together.
    let tolerance = (min_height / 2).max(40);
    reading_order(&positions, tolerance)
}

/// Broadcast the current reading order + focused label to every window so each
/// can derive its own position (e.g. "1/4") and whether it's the active window.
pub(crate) fn broadcast_window_order(app: &tauri::AppHandle) {
    let order = compute_window_order(app);
    let focused = app.state::<FocusedWindow>().0.lock_or_recover().clone();
    let payload = serde_json::json!({ "order": order, "focused": focused });
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "window-order",
            payload.clone(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whatsnew_url_only_passes_known_moods() {
        assert_eq!(
            whatsnew_url(Some("hype")),
            "index.html?whatsnew=1&mode=hype"
        );
        assert_eq!(
            whatsnew_url(Some("calm")),
            "index.html?whatsnew=1&mode=calm"
        );
        assert_eq!(
            whatsnew_url(Some("x&concept=1")),
            "index.html?whatsnew=1&mode=calm"
        );
        assert_eq!(whatsnew_url(None), "index.html?whatsnew=1&mode=calm");
    }

    #[test]
    fn window_chrome_matches_target_os() {
        let got = window_chrome();
        if cfg!(target_os = "macos") {
            assert_eq!(got, WindowChrome::MacOverlay);
        } else {
            assert_eq!(got, WindowChrome::Native);
        }
    }

    // ── reading_order + grid_cols tests ───────────────────────────────────────

    /// Helper: build a (label, x, y) position tuple.
    fn pos(label: &str, x: i32, y: i32) -> (String, i32, i32) {
        (label.to_string(), x, y)
    }

    #[test]
    fn reading_order_empty_is_empty() {
        assert!(reading_order(&[], 50).is_empty());
    }

    #[test]
    fn reading_order_2x2_grid_is_reading_order() {
        // Four quadrants given out of order → TL, TR, BL, BR.
        let positions = vec![
            pos("br", 500, 400),
            pos("tl", 0, 0),
            pos("tr", 500, 0),
            pos("bl", 0, 400),
        ];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["tl", "tr", "bl", "br"]);
    }

    #[test]
    fn reading_order_single_row_left_to_right() {
        // Three same-row windows given out of order → left, center, right.
        let positions = vec![pos("c", 500, 0), pos("a", 0, 0), pos("b", 250, 0)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "b", "c"]);
    }

    #[test]
    fn reading_order_tolerance_groups_nearby_rows() {
        // Two windows whose y differs by 30 (< tolerance 50) → same row, x order.
        let positions = vec![pos("b", 500, 30), pos("a", 0, 0)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "b"]);
    }

    #[test]
    fn reading_order_large_gap_splits_rows() {
        // y gap of 400 (> tolerance 50) → separate rows.
        let positions = vec![pos("top", 500, 0), pos("bot", 0, 400)];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["top", "bot"]);
    }

    #[test]
    fn reading_order_three_rows() {
        // 3×2 grid (6 windows) → row1 L→R, row2 L→R, row3 L→R.
        let positions = vec![
            pos("c", 500, 0),
            pos("f", 500, 800),
            pos("a", 0, 0),
            pos("e", 0, 800),
            pos("d", 0, 400),
            pos("b", 500, 400),
        ];
        let order = reading_order(&positions, 50);
        assert_eq!(order, vec!["a", "c", "d", "b", "e", "f"]);
    }

    #[test]
    fn grid_cols_generalizes_any_count() {
        assert_eq!(grid_cols(0), 1); // guard against division-by-zero
        assert_eq!(grid_cols(1), 1);
        assert_eq!(grid_cols(2), 2);
        assert_eq!(grid_cols(3), 2);
        assert_eq!(grid_cols(4), 2);
        assert_eq!(grid_cols(5), 3);
        assert_eq!(grid_cols(6), 3);
        assert_eq!(grid_cols(7), 3);
        assert_eq!(grid_cols(8), 3);
        assert_eq!(grid_cols(9), 3);
        assert_eq!(grid_cols(12), 4);
    }

    #[test]
    fn tile_rects_fills_work_area_row_major() {
        // 1920×1080 work area, origin (0,0). 4 windows → 2×2.
        let rects = tile_rects(4, 0, 0, 1920, 1080);
        assert_eq!(rects.len(), 4);
        // Row 0: left & right halves.
        assert_eq!(rects[0], (0, 0, 960, 540));
        assert_eq!(rects[1], (960, 0, 960, 540));
        // Row 1: left & right halves.
        assert_eq!(rects[2], (0, 540, 960, 540));
        assert_eq!(rects[3], (960, 540, 960, 540));
    }

    #[test]
    fn tile_rects_five_is_three_cols_two_rows() {
        // 5 windows → cols=3, rows=2. The last two land in row 1 (col 0 & 1).
        let rects = tile_rects(5, 0, 0, 3000, 1000);
        assert_eq!(rects.len(), 5);
        let cell_w = 3000 / 3; // 1000
        let cell_h = 1000 / 2; // 500
                               // Indices 3 & 4 are the bottom row — they must be sized to the cell.
        assert_eq!(rects[3], (0, cell_h, cell_w as u32, cell_h as u32));
        assert_eq!(rects[4], (cell_w, cell_h, cell_w as u32, cell_h as u32));
    }

    #[test]
    fn tile_rects_empty_is_empty() {
        assert!(tile_rects(0, 0, 0, 1920, 1080).is_empty());
    }
}

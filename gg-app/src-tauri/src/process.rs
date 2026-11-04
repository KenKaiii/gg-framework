//! Child process-tree termination and the startup orphan-sidecar sweep.

use crate::*;

/// Gracefully terminate a sidecar child AND its entire process tree so MCP/LSP
/// children (spawned without `detached`, so they share the sidecar's process
/// group) die with it — no orphans on window-close/project-switch/quit.
///
/// On Unix the daemon is spawned as a process-group leader (see
/// `spawn_daemon`), so sending signals to `-pid` (negative pid =
/// the whole group) reaps every descendant in one shot. We SIGTERM the group so
/// the sidecar's SIGTERM handler can run `session.dispose()`, poll `try_wait()`
/// for up to ~3s, then SIGKILL the group and `wait()` to reap the direct child
/// (std `Child` never auto-reaps).
///
/// On Windows there is no process-group kill, so we tree-kill via
/// `taskkill /T /F` (kills the descendant tree), then `wait()` to reap.
pub(crate) fn terminate_child(mut child: Child) {
    let pid = child.id() as i32;
    #[cfg(unix)]
    unsafe {
        // Negative pid = signal the entire process group. The sidecar is its
        // own group leader (pgid == sidecar pid), so this reaches every
        // non-detached descendant (MCP stdio children, LSP servers).
        libc::kill(-pid, libc::SIGTERM);
    }
    std::thread::spawn(move || {
        #[cfg(unix)]
        {
            for _ in 0..30 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            // Grace period expired — force-kill the whole group.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        {
            // Tree-kill on Windows: /T kills the descendant tree, /F forces it.
            let _ = hide_console(&mut std::process::Command::new("taskkill"))
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            // Fall back to direct kill if taskkill is unavailable.
            let _ = child.kill();
        }
        let _ = child.wait(); // reap the direct child (avoid zombie)
    });
}

// ── Startup orphan sweeper ─────────────────────────────────────────────────
// When the app is force-quit, crashes, or is killed during a dev run, the
// sidecar process tree (Node sidecar + MCP stdio children + LSP servers) is
// orphaned — reparented to init (pid 1) or an orphan-reaper. Rust only kills
// the direct sidecar PID, so children survive. Without a startup sweep these
// accumulate forever. We run once at the top of `.setup`, before new sidecars
// are spawned.
//
// Cross-platform: the pure classifier (`orphan_killset`) is OS-agnostic; only
// the process-table snapshot and the force-kill primitive differ between
// Unix (`ps` + `libc::kill`) and Windows (PowerShell CIM + `taskkill`).

/// One process row from the OS process table (pid, parent pid, process-group
/// id, full command). `pgid` is 0 on platforms without process groups
/// (Windows) — it's only consulted on Unix, where the sidecar is spawned as a
/// group leader (`process_group(0)`) so every non-detached descendant inherits
/// `pgid == sidecar_pid`. That inherited pgid survives the sidecar's death (the
/// children reparent to init but keep their group id), which is what lets the
/// sweep recognise a crashed sidecar's MCP/LSP children by lineage instead of
/// by a hardcoded name whitelist.
pub(crate) struct ProcInfo {
    pub(crate) pid: i32,
    pub(crate) ppid: i32,
    pub(crate) pgid: i32,
    pub(crate) command: String,
}

/// Command substrings that identify a GG Coder *sidecar* process itself.
/// `app-sidecar` matches both bundled `app-sidecar.mjs` and dev
/// `app-sidecar.js`. This is our OWN binary name (fully under our control, not
/// a third-party MCP name), so it's a safe, stable anchor. MCP children are NOT
/// matched by name — there are thousands of possible MCP servers and users can
/// add any of them — they're recognised structurally instead (descendant walk +
/// process-group lineage; see `orphan_killset`).
pub(crate) const SIDECAR_COMMAND_PATTERNS: &[&str] = &["app-sidecar"];

/// Pure (no I/O): given a process-table snapshot, the current app's pid, and the
/// set of process-group ids belonging to sidecars we have ever spawned (the
/// ledger — see `read_sidecar_ledger`), return the orphaned sidecar-tree PIDs to
/// SIGKILL.
///
/// A sidecar-tree member is killed when ANY of these hold and it isn't self:
///
/// 1. **Orphaned sidecar** — command matches `SIDECAR_COMMAND_PATTERNS` and its
///    parent is dead (`ppid == 1` or `ppid` absent from the snapshot).
/// 2. **Descendant of an orphaned sidecar** — transitively reachable via the
///    ppid tree from a (1) root. Catches MCP/LSP children still linked to a
///    freshly-dead sidecar that's still in this snapshot.
/// 3. **Process-group lineage (name-agnostic)** — the process's `pgid` is a
///    ledgered sidecar group whose *leader is dead* (no live process has
///    `pid == pgid`). This is the key case: after a crash/force-quit the sidecar
///    is long gone and its MCP children have reparented to init, but they keep
///    the sidecar's pgid. Any MCP server, of any name the user added, is caught
///    here — no whitelist. PID-recycle-safe: a group whose leader is alive is
///    skipped entirely (either a still-live sidecar, whose children we must NOT
///    kill, or an unrelated process that recycled the pid).
///
/// The current app pid and its live sidecars are never matched — a live
/// sidecar's parent is the still-running `gg-app`, so its `ppid` is alive, and
/// its group leader is alive so lineage skips it.
pub(crate) fn orphan_killset(
    snapshot: &[ProcInfo],
    self_pid: i32,
    ledger_pgids: &HashSet<i32>,
) -> Vec<i32> {
    let live_pids: HashSet<i32> = snapshot.iter().map(|p| p.pid).collect();
    let mut parent_children: HashMap<i32, Vec<i32>> = HashMap::new();
    for p in snapshot {
        parent_children.entry(p.ppid).or_default().push(p.pid);
    }

    let matches_sidecar = |cmd: &str| SIDECAR_COMMAND_PATTERNS.iter().any(|pat| cmd.contains(pat));
    let parent_dead = |ppid: i32| ppid == 1 || !live_pids.contains(&ppid);

    // The subset of ledgered sidecar groups whose LEADER is dead. A group whose
    // leader (pid == pgid) is still alive is skipped: it's either a live sidecar
    // (its children are in use) or an unrelated process that recycled the pid.
    let dead_leader_groups: HashSet<i32> = ledger_pgids
        .iter()
        .copied()
        .filter(|&g| g > 1 && !live_pids.contains(&g))
        .collect();

    let mut killset: HashSet<i32> = HashSet::new();

    // (1) Orphaned sidecars + (3) process-group lineage. Both are single-pass
    // over the snapshot.
    for p in snapshot {
        if p.pid == self_pid {
            continue;
        }
        let orphaned_sidecar = matches_sidecar(&p.command) && parent_dead(p.ppid);
        let orphaned_group_member = p.pgid > 1 && dead_leader_groups.contains(&p.pgid);
        if orphaned_sidecar || orphaned_group_member {
            killset.insert(p.pid);
        }
    }

    // (2) Descendants: transitively collect children of each root via the map.
    // Catches freshly-orphaned MCP/LSP trees still linked to a dead sidecar
    // that remains in this snapshot (its pgid leader still "alive").
    let mut stack: Vec<i32> = killset.iter().copied().collect();
    while let Some(parent) = stack.pop() {
        if let Some(children) = parent_children.get(&parent) {
            for &child in children {
                if child != self_pid && killset.insert(child) {
                    stack.push(child);
                }
            }
        }
    }

    let mut result: Vec<i32> = killset.into_iter().collect();
    result.sort_unstable();
    result
}

/// Pure parser for `ps -eo pid=,ppid=,pgid=,command=` output (one row per
/// line). Column padding (multiple spaces) is collapsed by `split_whitespace`.
/// Available on all platforms so the parsing can be unit-tested.
/// On Windows its only caller is `#[cfg(unix)]`, so outside tests it is dead
/// there; the allow is scoped to non-Unix so Unix builds still flag real rot.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn parse_ps_output(stdout: &str) -> Vec<ProcInfo> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid: i32 = parts.next()?.parse().ok()?;
            let ppid: i32 = parts.next()?.parse().ok()?;
            let pgid: i32 = parts.next()?.parse().ok()?;
            // The rest of the line is the full command (may contain spaces).
            // Pattern matching uses .contains(), so rejoining with single
            // spaces is fine.
            let command = parts.collect::<Vec<_>>().join(" ");
            Some(ProcInfo {
                pid,
                ppid,
                pgid,
                command,
            })
        })
        .collect()
}

/// Pure parser for PowerShell CIM output: one line per process as
/// `pid|ppid|command` (see `process_snapshot` on Windows). The command field
/// may contain `|` and spaces — `splitn(3, '|')` captures it verbatim.
/// Available on all platforms so the parsing can be unit-tested.
/// On Unix its only caller is `#[cfg(not(unix))]`, so outside tests it is dead
/// there; the allow is scoped to Unix so Windows builds still flag real rot.
#[cfg_attr(unix, allow(dead_code))]
pub(crate) fn parse_cim_output(stdout: &str) -> Vec<ProcInfo> {
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            // splitn(3, '|') — the command field may itself contain '|',
            // but only the first two fields matter and the third captures
            // everything else verbatim.
            let mut parts = line.splitn(3, '|');
            let pid: i32 = parts.next()?.trim().parse().ok()?;
            let ppid: i32 = parts.next()?.trim().parse().ok()?;
            let command = parts.next()?.trim().to_string();
            // Windows has no POSIX process groups; pgid is unused there (set to
            // 0 so the lineage rule in `orphan_killset`, which requires pgid > 1,
            // never fires — Windows relies on name + descendant matching).
            Some(ProcInfo {
                pid,
                ppid,
                pgid: 0,
                command,
            })
        })
        .collect()
}

/// Snapshot the OS process table into `ProcInfo` rows (pid, ppid, command).
/// Returns `None` if the process-listing command is unavailable — the sweep
/// then silently does nothing.
#[cfg(unix)]
pub(crate) fn process_snapshot() -> Option<Vec<ProcInfo>> {
    let output = Command::new("ps")
        .args(["-eo", "pid=,ppid=,pgid=,command="])
        .output()
        .ok()?;
    Some(parse_ps_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Windows snapshot via PowerShell CIM — the modern replacement for the
/// deprecated `wmic`. Emits one line per process: `pid|ppid|command`, using
/// `|` as a field delimiter. CommandLine may be empty for kernel processes;
/// those won't match any pattern so they're harmless.
#[cfg(not(unix))]
pub(crate) fn process_snapshot() -> Option<Vec<ProcInfo>> {
    // Single-quoted '|' inside the script is a literal separator, not a pipe.
    // The script string uses Rust line continuations (\) so it reads as one
    // logical line of PowerShell.
    let script = "Get-CimInstance Win32_Process | ForEach-Object { \
        [string]$_.ProcessId + '|' + [string]$_.ParentProcessId + '|' + [string]$_.CommandLine \
    }";
    let output = hide_console(&mut Command::new("powershell"))
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    Some(parse_cim_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Force-kill a single PID (best-effort, errors ignored).
#[cfg(unix)]
pub(crate) fn force_kill_pid(pid: i32) {
    unsafe {
        let _ = libc::kill(pid, libc::SIGKILL);
    }
}

/// Force-kill a single PID via `taskkill /F` (no descendant tree walk needed —
/// the sweeper kills every orphan-tree member individually from the snapshot).
#[cfg(not(unix))]
pub(crate) fn force_kill_pid(pid: i32) {
    let _ = hide_console(&mut Command::new("taskkill"))
        .args(["/PID", &pid.to_string(), "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Absolute path to the sidecar PID ledger (`~/.gg/gg-app-sidecars`).
///
/// Newline-delimited list of PIDs of every Node sidecar this app has spawned.
/// Because each sidecar is spawned as a process-group leader (`process_group(0)`
/// on Unix), its PID equals the pgid shared by all of its MCP/LSP children. So a
/// ledgered PID doubles as "a GG process-group id", which is how the sweep
/// recognises a crashed sidecar's children by lineage — no MCP-name whitelist.
pub(crate) fn sidecar_ledger_path() -> PathBuf {
    app_state_dir().join("gg-app-sidecars")
}

/// Read the ledgered sidecar PIDs (== process-group ids). Missing/garbage file
/// → empty set (the sweep then degrades to name + descendant matching, exactly
/// the pre-ledger behaviour). Best-effort, never panics.
pub(crate) fn read_sidecar_ledger() -> HashSet<i32> {
    let Ok(contents) = std::fs::read_to_string(sidecar_ledger_path()) else {
        return HashSet::new();
    };
    contents
        .lines()
        .filter_map(|l| l.trim().parse::<i32>().ok())
        .filter(|&p| p > 1)
        .collect()
}

/// Append a freshly-spawned sidecar's PID to the ledger. Called right after
/// `spawn_daemon` gets a live child. Creates `~/.gg` if needed. Best-effort:
/// a write failure only means that sidecar's orphans fall back to name matching.
pub(crate) fn record_sidecar_pid(pid: i32) {
    let path = sidecar_ledger_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{pid}");
    }
}

/// Rewrite the ledger to keep only PIDs whose process group is still live —
/// i.e. a process with `pid == pgid` exists in the snapshot (a still-running
/// sidecar, ours or a concurrent instance's). Drops dead groups (their members
/// were just swept) and pids recycled away, so the file can't grow without
/// bound. Best-effort.
pub(crate) fn prune_sidecar_ledger(ledger: &HashSet<i32>, snapshot: &[ProcInfo]) {
    let live_pids: HashSet<i32> = snapshot.iter().map(|p| p.pid).collect();
    let keep: Vec<i32> = ledger
        .iter()
        .copied()
        .filter(|g| live_pids.contains(g))
        .collect();
    let path = sidecar_ledger_path();
    if keep.is_empty() {
        // Nothing worth keeping — remove the file so a stale set can't linger.
        let _ = std::fs::remove_file(&path);
        return;
    }
    let body = keep
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let _ = std::fs::write(&path, format!("{body}\n"));
}

/// Snapshot the process table, classify orphaned sidecar trees, and force-kill
/// each. Best-effort + logged; never panics. Runs once at startup before any
/// sidecar is spawned.
pub(crate) fn sweep_orphan_sidecars() {
    let Some(snapshot) = process_snapshot() else {
        log::warn!("orphan sweep: process listing unavailable, skipping");
        return;
    };
    let self_pid = std::process::id() as i32;
    let ledger = read_sidecar_ledger();

    let killset = orphan_killset(&snapshot, self_pid, &ledger);
    if killset.is_empty() {
        log::info!("orphan sweep: no stale sidecars found");
        prune_sidecar_ledger(&ledger, &snapshot);
        return;
    }

    log::info!("orphan sweep: killing {} stale process(es)", killset.len());
    for pid in &killset {
        let cmd = snapshot
            .iter()
            .find(|p| &p.pid == pid)
            .map(|p| p.command.as_str())
            .unwrap_or("?");
        log::info!("orphan sweep: killing pid {pid}: {cmd}");
        force_kill_pid(*pid);
    }
    prune_sidecar_ledger(&ledger, &snapshot);
}

// ── Opening URLs/paths in the user's default app ────────────────────────────
//
// tauri-plugin-opener (via the `open` crate's `that_detached`) double-forks on
// Unix: the child it spawns exits at once and is never `wait()`ed, so every
// link the app opened left a `<defunct>` process under the app until quit.
// Here the launcher (`open` on macOS, `xdg-open` & co. elsewhere) is spawned
// in its own process group and reaped on a background thread instead.
// The iPhone keeps the plugin: there `open::commands` builds a `uiopen`
// command the phone can't run.

/// Spawn `cmd` with no stdio in its own process group and reap it in the
/// background, so it never lingers as a zombie. Returns the child's pid.
#[cfg(all(unix, not(target_os = "ios")))]
pub(crate) fn spawn_reaped(mut cmd: Command) -> std::io::Result<u32> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own group: a Ctrl-C/SIGHUP aimed at the app (dev terminal) must
        // not take down a browser that `xdg-open` runs in the foreground.
        .process_group(0);
    let mut child = cmd.spawn()?;
    let pid = child.id();
    std::thread::Builder::new()
        .name("reap-launcher".into())
        .spawn(move || {
            let _ = child.wait();
        })?;
    Ok(pid)
}

/// Schemes `open_url` hands to the OS, matching the opener plugin's default
/// scope. Anything else (`file:`, `javascript:`, custom app schemes) is refused
/// so the webview can't turn this into a local-file or app launcher.
pub(crate) fn is_openable_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["https://", "http://", "mailto:", "tel:"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

/// Open a URL or an existing path with the OS default handler.
#[cfg(not(target_os = "ios"))]
pub(crate) fn open_with_default(target: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        // The `open` crate's launcher list, tried in order — the same ones
        // the opener plugin uses, minus its zombie-leaving detach.
        let mut last_error = None;
        for cmd in open::commands(target) {
            match spawn_reaped(cmd) {
                Ok(_) => return Ok(()),
                Err(e) => last_error = Some(e),
            }
        }
        Err(last_error
            .map(|e| e.to_string())
            .unwrap_or_else(|| "no launcher available".into()))
    }
    #[cfg(not(unix))]
    {
        // Windows opens through ShellExecuteW: no child process, no zombie.
        tauri_plugin_opener::open_url(target, None::<&str>).map_err(|e| e.to_string())
    }
}

// A child mid-spawn holds all our fds (macOS: close-on-exec ones too), so a
// listener closed meanwhile still takes connections. Tests that spawn and the
// link test that expects a closed listener refused take turns on this.
#[cfg(test)]
pub(crate) static SPAWN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_url_accepts_only_web_mail_and_phone_schemes() {
        assert!(is_openable_url("https://github.com/o/r/pulls"));
        assert!(is_openable_url("HTTP://example.com"));
        assert!(is_openable_url("mailto:someone@example.com"));
        assert!(is_openable_url("tel:+15550100"));
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("/Applications/Calculator.app"));
        assert!(!is_openable_url("vscode://file/x"));
    }

    /// Regression: opening a link must not leave a `<defunct>` child behind.
    /// Checked through `ps`, which lists a zombie (state `Z`) until it is
    /// reaped; `kill(pid, 0)` can't tell (macOS answers ESRCH for zombies).
    #[cfg(all(unix, not(target_os = "ios")))]
    #[test]
    fn spawn_reaped_leaves_no_zombie() {
        let _spawning = SPAWN_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let pid = spawn_reaped(Command::new("true")).expect("spawn `true`");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let out = Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .expect("run ps");
            if String::from_utf8_lossy(&out.stdout).trim().is_empty() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "launcher pid {pid} was never reaped (zombie)"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    // ── orphan_killset classifier tests ──────────────────────────────────────

    /// Helper: build a ProcInfo row whose process group is itself (a group
    /// leader / a process not tracked by lineage). Good enough for the
    /// name+descendant cases; use `proc_g` to set an explicit pgid.
    fn proc(pid: i32, ppid: i32, command: &str) -> ProcInfo {
        proc_g(pid, ppid, pid, command)
    }

    /// Helper: build a ProcInfo row with an explicit process-group id — used to
    /// model MCP/LSP children that inherited a (now-dead) sidecar's pgid.
    fn proc_g(pid: i32, ppid: i32, pgid: i32, command: &str) -> ProcInfo {
        ProcInfo {
            pid,
            ppid,
            pgid,
            command: command.to_string(),
        }
    }

    /// The empty ledger — for tests that exercise only name + descendant rules.
    fn no_ledger() -> HashSet<i32> {
        HashSet::new()
    }

    /// A ledger containing the given sidecar pgids.
    fn ledger(pgids: &[i32]) -> HashSet<i32> {
        pgids.iter().copied().collect()
    }

    #[test]
    fn orphan_sidecar_with_ppid_1_is_killed() {
        // A sidecar reparented to init is an orphan (matched by our own name).
        let snap = vec![proc(500, 1, "node /app/sidecar/app-sidecar.mjs")];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert_eq!(ks, vec![500]);
    }

    #[test]
    fn live_sidecar_with_alive_parent_is_excluded() {
        // The current gg-app (pid 100) is the parent of a live sidecar (pid 200).
        let snap = vec![
            proc(100, 1, "/Applications/GG Coder.app/Contents/MacOS/gg-app"),
            proc(200, 100, "ggnode app-sidecar.mjs"),
        ];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.is_empty(), "live sidecar must not be killed: {ks:?}");
    }

    #[test]
    fn orphan_sidecar_with_dead_parent_not_in_snapshot() {
        // Parent pid 999 is absent from the snapshot and ≠ 1 → dead → orphan.
        let snap = vec![proc(300, 999, "node app-sidecar.js")];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.contains(&300));
    }

    #[test]
    fn reparented_mcp_child_killed_by_group_lineage() {
        // THE crash case: the sidecar (pgid 500) is long gone; its MCP child
        // reparented to init (ppid 1) but kept pgid 500. The command is an
        // arbitrary user-added MCP name we've never heard of. With 500 in the
        // ledger and no live pid==500, lineage kills it — no name whitelist.
        let snap = vec![proc_g(701, 1, 500, "node some-random-user-mcp-server")];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert_eq!(ks, vec![701]);
    }

    #[test]
    fn reparented_mcp_child_spared_when_group_leader_alive() {
        // Same shape, but a process with pid==500 is still alive (a live sidecar,
        // or a recycled pid). The group is NOT dead → its members are left alone.
        // The live app (pid 100, self) is in the snapshot so the sidecar's parent
        // reads as alive too.
        let snap = vec![
            proc(100, 1, "gg-app"),
            proc(500, 100, "ggnode app-sidecar.mjs"),
            proc_g(701, 500, 500, "node some-user-mcp-server"),
        ];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert!(ks.is_empty(), "live-group members must be spared: {ks:?}");
    }

    #[test]
    fn unledgered_group_is_not_killed_by_lineage() {
        // A reparented process whose pgid is NOT in the ledger is none of our
        // business — lineage only fires for groups we recorded spawning.
        let snap = vec![proc_g(701, 1, 900, "node some-user-mcp-server")];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert!(ks.is_empty(), "unledgered group must be spared: {ks:?}");
    }

    #[test]
    fn orphan_descendant_tree_is_collected() {
        // sidecar(500, orphaned) → npm exec(501) → node some-mcp-server(502).
        // Children still linked to the in-snapshot dead sidecar are caught by
        // the descendant walk regardless of their names.
        let snap = vec![
            proc(500, 1, "node app-sidecar.js"),
            proc(501, 500, "npm exec @scope/some-mcp-server"),
            proc(502, 501, "node some-mcp-server"),
        ];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.contains(&500));
        assert!(ks.contains(&501));
        assert!(ks.contains(&502));
        assert_eq!(ks.len(), 3);
    }

    #[test]
    fn current_app_pid_never_killed() {
        // Even if self somehow matches a pattern and has a dead parent, exclude it.
        let snap = vec![proc(100, 1, "node app-sidecar.js")];
        let ks = orphan_killset(&snap, 100, &no_ledger());
        assert!(ks.is_empty(), "self pid must never be in killset: {ks:?}");
    }

    #[test]
    fn unrelated_node_with_dead_parent_excluded() {
        // A vite process with a dead parent, no matching name, no ledgered group
        // → excluded.
        let snap = vec![proc(800, 1, "node vite")];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        assert!(
            ks.is_empty(),
            "non-matching process must not be killed: {ks:?}"
        );
    }

    #[test]
    fn dedup_when_descendant_also_matches_lineage() {
        // sidecar(500, orphaned) → MCP child(501) sharing pgid 500. 501 is both a
        // descendant AND a lineage member. It must appear exactly once.
        let snap = vec![
            proc_g(500, 1, 500, "node app-sidecar.js"),
            proc_g(501, 500, 500, "node some-user-mcp-server"),
        ];
        let ks = orphan_killset(&snap, 100, &ledger(&[500]));
        let count_501 = ks.iter().filter(|&&p| p == 501).count();
        assert_eq!(count_501, 1, "pid 501 must appear exactly once: {ks:?}");
        assert_eq!(ks.len(), 2);
    }

    #[test]
    fn multi_instance_concurrent_dev_runs_safe() {
        // Two gg-app instances each with their own live sidecar. Both sidecar
        // pgids are ledgered, but both leaders are alive → neither is swept.
        let snap = vec![
            proc(100, 1, "gg-app"),
            proc_g(200, 100, 200, "node app-sidecar.js"),
            proc(300, 1, "gg-app"),
            proc_g(400, 300, 400, "node app-sidecar.js"),
        ];
        let led = ledger(&[200, 400]);
        // Instance 1 sweeps.
        assert!(orphan_killset(&snap, 100, &led).is_empty());
        // Instance 2 sweeps.
        assert!(orphan_killset(&snap, 300, &led).is_empty());
    }

    // ── Output parser tests (cross-platform) ────────────────────────────────
    // These verify the parsing of real OS process-listing output so the Windows
    // CIM path is exercised on macOS (where the Windows snapshot command can't
    // run, but the parser can).

    #[test]
    fn parse_ps_handles_column_padding_and_spaces_in_command() {
        // Real `ps -eo pid=,ppid=,pgid=,command=` output: multiple spaces
        // between fields. Columns are pid, ppid, pgid, then the command.
        let raw = "    1     0     1 /sbin/launchd\n\
                   11541     1 11541 /Applications/GG Coder.app/Contents/MacOS/gg-app\n\
                   11553 11541 11553 /Applications/GG Coder.app/Contents/MacOS/ggnode app-sidecar.mjs";
        let rows = parse_ps_output(raw);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].pid, 1);
        assert_eq!(rows[0].ppid, 0);
        assert_eq!(rows[0].pgid, 1);
        assert_eq!(rows[0].command, "/sbin/launchd");
        // The sidecar is its own group leader (pgid == pid).
        assert_eq!(rows[2].pgid, 11553);
        // Command with spaces is rejoined correctly.
        assert!(rows[2].command.contains("app-sidecar.mjs"));
        assert!(rows[2].command.contains("ggnode"));
    }

    #[test]
    fn parse_ps_skips_unparseable_lines() {
        let raw = "pid ppid pgid command\n\
                   abc def ghi not-a-number\n\
                   42 1 42 node";
        let rows = parse_ps_output(raw);
        // Header + garbage lines are skipped; only the valid row survives.
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 42);
        assert_eq!(rows[0].pgid, 42);
    }

    #[test]
    fn parse_cim_handles_pipe_delimited_output() {
        // Real PowerShell CIM output: pid|ppid|CommandLine.
        let raw = "4|0|\n\
                   5204|5200|C:\\Program Files\\nodejs\\node.exe app-sidecar.mjs\n\
                   5300|5204|C:\\Program Files\\nodejs\\node.exe some-mcp-server";
        let rows = parse_cim_output(raw);
        assert_eq!(rows.len(), 3);
        // Kernel process with empty CommandLine.
        assert_eq!(rows[0].pid, 4);
        assert_eq!(rows[0].ppid, 0);
        assert_eq!(rows[0].command, "");
        // Sidecar with full path.
        assert!(rows[1].command.contains("app-sidecar.mjs"));
        // MCP grandchild.
        assert_eq!(rows[2].ppid, 5204);
        assert!(rows[2].command.contains("some-mcp-server"));
    }

    #[test]
    fn parse_cim_command_with_pipe_is_preserved() {
        // A command line containing a pipe character must not be split further.
        let raw = "100|1|cmd /c echo hi | findstr foo";
        let rows = parse_cim_output(raw);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 100);
        assert_eq!(rows[0].ppid, 1);
        // The third field captures everything after the second '|'.
        assert_eq!(rows[0].command, "cmd /c echo hi | findstr foo");
    }

    #[test]
    fn parse_cim_skips_blank_and_garbage_lines() {
        let raw = "\n\
                   \r\n\
                   abc|def|garbage\n\
                   42|1|node app-sidecar.mjs";
        let rows = parse_cim_output(raw);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pid, 42);
    }

    #[test]
    fn full_windows_sweep_pipeline() {
        // End-to-end: CIM output → parse → classify → killset. Simulates a
        // Windows machine where a previous gg-app instance was force-quit,
        // orphaning its sidecar tree (parent PIDs absent from the snapshot).
        let raw = "4|0|\n\
                   1000|4|C:\\Windows\\System32\\cmd.exe\n\
                   5000|9999|C:\\nodejs\\node.exe app-sidecar.mjs\n\
                   5001|5000|C:\\nodejs\\node.exe some-mcp-server\n\
                   6000|4|C:\\Program Files\\GG Coder\\gg-app.exe\n\
                   6001|6000|C:\\nodejs\\node.exe app-sidecar.mjs";
        let snapshot = parse_cim_output(raw);
        assert_eq!(snapshot.len(), 6);
        // Self = the new gg-app (pid 6000). Its sidecar (6001) has a live parent.
        // Windows has no pgid (all 0), so classification relies on the sidecar
        // name (5000) + descendant walk (5001) — ledger is irrelevant here.
        let killset = orphan_killset(&snapshot, 6000, &no_ledger());
        // Orphaned sidecar (5000, parent 9999 dead) + its MCP child (5001).
        assert!(killset.contains(&5000));
        assert!(killset.contains(&5001));
        // Live sidecar (6001) must NOT be killed.
        assert!(!killset.contains(&6001));
        assert_eq!(killset.len(), 2);
    }
}

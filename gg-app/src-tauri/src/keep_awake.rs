//! Keep the display/system awake during Kleio voice conversations.
//!
//! macOS: IOKit user-idle power assertions (`PreventUserIdleDisplaySleep` +
//! `PreventUserIdleSystemSleep`). These only block *idle* sleep — the user can
//! still sleep or lock the Mac manually. Every other target is a no-op.
//!
//! Holds are keyed by (window label, hold id) and ref-counted: the OS assertion
//! exists while at least one hold exists, across all windows.
//!
//! Separately, `agent_keep_awake_get`/`agent_keep_awake_set` proxy the setting
//! for keeping the computer awake while the agent works. The sidecar holds that
//! assertion itself, because runs (routines included) outlive any window.

use std::collections::BTreeSet;
use std::sync::Mutex;

/// Max holds a single window may keep (stops a misbehaving page growing it).
pub const MAX_HOLDS_PER_WINDOW: usize = 8;

/// The OS-level "stay awake" switch. Abstracted so counting is testable.
pub trait Backend: Send {
    fn acquire(&mut self) -> Result<(), String>;
    fn release(&mut self);
}

#[derive(Default)]
struct Inner<B> {
    holds: BTreeSet<(String, String)>,
    backend: B,
}

pub struct KeepAwake<B: Backend = OsBackend> {
    inner: Mutex<Inner<B>>,
}

impl Default for KeepAwake<OsBackend> {
    fn default() -> Self {
        // `OsBackend` is a unit struct off macOS, so `default()` is the
        // portable way to build it on every target.
        #[allow(clippy::default_constructed_unit_structs)]
        Self::with_backend(OsBackend::default())
    }
}

fn valid_hold(hold: &str) -> bool {
    (1..=64).contains(&hold.len())
        && hold
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl<B: Backend> KeepAwake<B> {
    pub fn with_backend(backend: B) -> Self {
        Self {
            inner: Mutex::new(Inner {
                holds: BTreeSet::new(),
                backend,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner<B>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn acquire(&self, window: &str, hold: &str) -> Result<(), String> {
        if !valid_hold(hold) {
            return Err("invalid hold id".into());
        }
        let mut g = self.lock();
        let key = (window.to_string(), hold.to_string());
        if g.holds.contains(&key) {
            return Ok(());
        }
        let per_window = g.holds.iter().filter(|(w, _)| w == window).count();
        if per_window >= MAX_HOLDS_PER_WINDOW {
            return Err("too many keep-awake holds for this window".into());
        }
        if g.holds.is_empty() {
            if let Err(e) = g.backend.acquire() {
                log::warn!("keep_awake: failed to create power assertion: {e}");
                return Err(e);
            }
        }
        g.holds.insert(key);
        Ok(())
    }

    pub fn release(&self, window: &str, hold: &str) -> Result<(), String> {
        if !valid_hold(hold) {
            return Err("invalid hold id".into());
        }
        let mut g = self.lock();
        if g.holds.remove(&(window.to_string(), hold.to_string())) && g.holds.is_empty() {
            g.backend.release();
        }
        Ok(())
    }

    /// Backstop: a window was destroyed — drop all of its holds.
    pub fn release_window(&self, window: &str) {
        let mut g = self.lock();
        let had = !g.holds.is_empty();
        g.holds.retain(|(w, _)| w != window);
        if had && g.holds.is_empty() {
            g.backend.release();
        }
    }

    /// Backstop: app exit — drop everything.
    pub fn release_all(&self) {
        let mut g = self.lock();
        if !g.holds.is_empty() {
            g.holds.clear();
            g.backend.release();
        }
    }

    #[cfg(test)]
    fn count(&self) -> usize {
        self.lock().holds.len()
    }
}

#[tauri::command]
pub fn keep_awake_acquire(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, KeepAwake>,
    hold: String,
) -> Result<(), String> {
    state.acquire(window.label(), &hold)
}

#[tauri::command]
pub fn keep_awake_release(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, KeepAwake>,
    hold: String,
) -> Result<(), String> {
    state.release(window.label(), &hold)
}

/// Proxy: the app-wide "keep computer awake while the agent works" setting.
/// Daemon-level (one OS assertion for every window), so no session header.
#[tauri::command]
pub async fn agent_keep_awake_get(
    webview: tauri::WebviewWindow,
    client: tauri::State<'_, reqwest::Client>,
) -> Result<serde_json::Value, String> {
    let port = crate::port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .get(format!("{}/keep-awake", crate::sidecar_base(port)))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

/// Proxy: turn keep-awake on/off; applies live to in-flight runs.
#[tauri::command]
pub async fn agent_keep_awake_set(
    webview: tauri::WebviewWindow,
    client: tauri::State<'_, reqwest::Client>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let port = crate::port_for(&webview).ok_or("daemon not ready")?;
    let res = client
        .post(format!("{}/keep-awake", crate::sidecar_base(port)))
        .json(&serde_json::json!({ "enabled": enabled }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    res.json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())
}

pub use os::OsBackend;

#[cfg(target_os = "macos")]
mod os {
    use std::ffi::{c_char, c_void};

    type CFStringRef = *const c_void;
    type IOPMAssertionID = u32;
    const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8
    const LEVEL_ON: u32 = 255; // kIOPMAssertionLevelOn

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            s: *const c_char,
            enc: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            kind: CFStringRef,
            level: u32,
            name: CFStringRef,
            id: *mut IOPMAssertionID,
        ) -> i32;
        fn IOPMAssertionRelease(id: IOPMAssertionID) -> i32;
    }

    fn create(kind: &std::ffi::CStr, name: &std::ffi::CStr) -> Result<IOPMAssertionID, String> {
        // SAFETY: valid NUL-terminated C strings; CF objects released below.
        unsafe {
            let k = CFStringCreateWithCString(std::ptr::null(), kind.as_ptr(), UTF8);
            let n = CFStringCreateWithCString(std::ptr::null(), name.as_ptr(), UTF8);
            let mut id: IOPMAssertionID = 0;
            let rc = if k.is_null() || n.is_null() {
                -1
            } else {
                IOPMAssertionCreateWithName(k, LEVEL_ON, n, &mut id)
            };
            if !k.is_null() {
                CFRelease(k);
            }
            if !n.is_null() {
                CFRelease(n);
            }
            if rc == 0 {
                Ok(id)
            } else {
                Err(format!(
                    "IOPMAssertionCreateWithName({kind:?}) failed: {rc:#x}"
                ))
            }
        }
    }

    fn drop_id(id: IOPMAssertionID) {
        // SAFETY: id came from a successful IOPMAssertionCreateWithName.
        let rc = unsafe { IOPMAssertionRelease(id) };
        if rc != 0 {
            log::warn!("keep_awake: IOPMAssertionRelease failed: {rc:#x}");
        }
    }

    #[derive(Default)]
    pub struct OsBackend {
        ids: Vec<IOPMAssertionID>,
    }

    impl super::Backend for OsBackend {
        fn acquire(&mut self) -> Result<(), String> {
            self.release();
            let name = c"Kleio voice conversation";
            for kind in [
                c"PreventUserIdleDisplaySleep",
                c"PreventUserIdleSystemSleep",
            ] {
                match create(kind, name) {
                    Ok(id) => self.ids.push(id),
                    Err(e) => {
                        self.release();
                        return Err(e);
                    }
                }
            }
            Ok(())
        }
        fn release(&mut self) {
            for id in self.ids.drain(..) {
                drop_id(id);
            }
        }
    }

    impl Drop for OsBackend {
        fn drop(&mut self) {
            super::Backend::release(self);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod os {
    /// No-op on non-macOS targets.
    #[derive(Default)]
    pub struct OsBackend;

    impl super::Backend for OsBackend {
        fn acquire(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn release(&mut self) {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
    use std::sync::Arc;

    #[derive(Clone, Default)]
    struct Fake {
        active: Arc<AtomicI32>,
        acquires: Arc<AtomicI32>,
        fail: Arc<AtomicBool>,
    }
    impl Backend for Fake {
        fn acquire(&mut self) -> Result<(), String> {
            if self.fail.load(Ordering::SeqCst) {
                return Err("boom".into());
            }
            self.acquires.fetch_add(1, Ordering::SeqCst);
            self.active.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn release(&mut self) {
            self.active.fetch_sub(1, Ordering::SeqCst);
        }
    }

    fn setup() -> (KeepAwake<Fake>, Fake) {
        let f = Fake::default();
        (KeepAwake::with_backend(f.clone()), f)
    }
    fn active(f: &Fake) -> i32 {
        f.active.load(Ordering::SeqCst)
    }

    #[test]
    fn double_acquire_is_one_hold() {
        let (k, f) = setup();
        k.acquire("main", "a").unwrap();
        k.acquire("main", "a").unwrap();
        assert_eq!(k.count(), 1);
        assert_eq!(f.acquires.load(Ordering::SeqCst), 1);
        k.release("main", "a").unwrap();
        assert_eq!(active(&f), 0);
    }

    #[test]
    fn double_release_and_unknown_are_noops() {
        let (k, f) = setup();
        k.release("main", "nope").unwrap();
        assert_eq!(active(&f), 0);
        k.acquire("main", "a").unwrap();
        k.release("main", "a").unwrap();
        k.release("main", "a").unwrap();
        assert_eq!(active(&f), 0);
        assert_eq!(k.count(), 0);
    }

    #[test]
    fn two_windows_share_one_assertion() {
        let (k, f) = setup();
        k.acquire("w1", "a").unwrap();
        k.acquire("w2", "a").unwrap();
        assert_eq!(active(&f), 1);
        k.release("w1", "a").unwrap();
        assert_eq!(active(&f), 1);
        k.release("w2", "a").unwrap();
        assert_eq!(active(&f), 0);
    }

    #[test]
    fn window_destroyed_drops_only_its_holds() {
        let (k, f) = setup();
        k.acquire("w1", "a").unwrap();
        k.acquire("w1", "b").unwrap();
        k.acquire("w2", "a").unwrap();
        k.release_window("w1");
        assert_eq!(k.count(), 1);
        assert_eq!(active(&f), 1);
        k.release_window("w2");
        assert_eq!(active(&f), 0);
        k.release_window("w2");
        assert_eq!(active(&f), 0);
    }

    #[test]
    fn exit_drops_all() {
        let (k, f) = setup();
        k.acquire("w1", "a").unwrap();
        k.acquire("w2", "b").unwrap();
        k.release_all();
        assert_eq!(k.count(), 0);
        assert_eq!(active(&f), 0);
        k.release_all();
        assert_eq!(active(&f), 0);
    }

    #[test]
    fn invalid_ids_rejected() {
        let (k, f) = setup();
        for bad in ["", "a b", "x/y", "é", &"a".repeat(65)] {
            assert!(k.acquire("main", bad).is_err(), "{bad:?}");
            assert!(k.release("main", bad).is_err(), "{bad:?}");
        }
        assert!(k.acquire("main", &"a".repeat(64)).is_ok());
        assert!(k.acquire("main", "A-z_09").is_ok());
        assert_eq!(active(&f), 1);
    }

    #[test]
    fn per_window_cap() {
        let (k, _f) = setup();
        for i in 0..MAX_HOLDS_PER_WINDOW {
            k.acquire("w1", &format!("h{i}")).unwrap();
        }
        assert!(k.acquire("w1", "extra").is_err());
        k.acquire("w1", "h0").unwrap(); // re-acquire existing still Ok
        k.acquire("w2", "extra").unwrap();
        assert_eq!(k.count(), MAX_HOLDS_PER_WINDOW + 1);
    }

    #[test]
    fn backend_failure_leaves_no_hold() {
        let (k, f) = setup();
        f.fail.store(true, Ordering::SeqCst);
        assert!(k.acquire("main", "a").is_err());
        assert_eq!(k.count(), 0);
        f.fail.store(false, Ordering::SeqCst);
        k.acquire("main", "a").unwrap();
        assert_eq!(active(&f), 1);
    }

    #[test]
    fn os_backend_compiles_and_is_constructible() {
        let _k = KeepAwake::default();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "touches real macOS power assertions; run with --ignored"]
    fn keep_awake_macos_real_assertion() {
        fn pmset() -> String {
            let out = std::process::Command::new("pmset")
                .args(["-g", "assertions"])
                .output()
                .expect("pmset");
            String::from_utf8_lossy(&out.stdout).into_owned()
        }
        fn ours(s: &str) -> Vec<String> {
            s.lines()
                .filter(|l| l.contains("Kleio voice conversation"))
                .map(str::to_string)
                .collect()
        }
        let k = KeepAwake::default();
        k.acquire("test", "real").unwrap();
        let held = ours(&pmset());
        println!("pmset while held:\n{}", held.join("\n"));
        assert!(held
            .iter()
            .any(|l| l.contains("PreventUserIdleDisplaySleep")));
        assert!(held
            .iter()
            .any(|l| l.contains("PreventUserIdleSystemSleep")));
        k.release("test", "real").unwrap();
        let after = ours(&pmset());
        println!("pmset after release: {after:?}");
        assert!(after.is_empty());
    }
}

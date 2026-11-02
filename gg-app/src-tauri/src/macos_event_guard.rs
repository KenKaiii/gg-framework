// tao 0.35 overrides -[NSApplication sendEvent:] / -[NSWindow sendEvent:] with
// `extern "C"` Rust functions. An Objective-C exception raised by AppKit under
// them (macOS 27's Siri/Writing Tools assertion in NSCampoLightweightUIController)
// cannot unwind through those frames, so the app aborts with
// `panic_cannot_unwind` (tao::platform_impl::platform::app::send_event).
// We wrap AppKit's own implementations — the frames directly beneath tao's —
// in @try/@catch, log the exception and drop that one event, as stock
// -[NSApplication run] does. Redundant once tao ships tauri-apps/tao#1354.

use std::ffi::CStr;
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use objc2::exception;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::sel;

type SendEventFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject);

// The runtime hands back the replaced IMP exactly once; the C callbacks below
// have no other way to reach it.
static APP_SEND_EVENT: OnceLock<SendEventFn> = OnceLock::new();
static WINDOW_SEND_EVENT: OnceLock<SendEventFn> = OnceLock::new();
static SWALLOWED: AtomicU64 = AtomicU64::new(0);

const MAX_LOGGED_REASON: usize = 500;

pub(crate) fn install() {
    for (class, slot, wrapper) in [
        (
            c"NSApplication",
            &APP_SEND_EVENT,
            guarded_app_send_event as SendEventFn,
        ),
        (
            c"NSWindow",
            &WINDOW_SEND_EVENT,
            guarded_window_send_event as SendEventFn,
        ),
    ] {
        if let Err(e) = install_on(class, slot, wrapper) {
            log::warn!("[event-guard] not installed: {e}");
        }
    }
}

unsafe extern "C-unwind" fn guarded_app_send_event(
    this: *mut AnyObject,
    sel: Sel,
    event: *mut AnyObject,
) {
    dispatch_guarded(&APP_SEND_EVENT, "NSApplication", this, sel, event);
}

unsafe extern "C-unwind" fn guarded_window_send_event(
    this: *mut AnyObject,
    sel: Sel,
    event: *mut AnyObject,
) {
    dispatch_guarded(&WINDOW_SEND_EVENT, "NSWindow", this, sel, event);
}

fn install_on(
    class: &CStr,
    slot: &'static OnceLock<SendEventFn>,
    wrapper: SendEventFn,
) -> Result<(), String> {
    let name = class.to_string_lossy();
    let cls = AnyClass::get(class).ok_or_else(|| format!("class {name} not found"))?;
    let method = cls
        .instance_method(sel!(sendEvent:))
        .ok_or_else(|| format!("-[{name} sendEvent:] not found"))?;
    if slot.get().is_some() {
        return Ok(());
    }
    // SAFETY: `sendEvent:` has the C signature `void (id, SEL, NSEvent *)`,
    // which is exactly `SendEventFn`; Imp is just the erased form of it.
    let original = unsafe { std::mem::transmute::<Imp, SendEventFn>(method.implementation()) };
    // Store before swapping so the wrapper never runs with an empty slot.
    slot.set(original)
        .map_err(|_| format!("-[{name} sendEvent:] already guarded"))?;
    // SAFETY: same signature as above; the wrapper forwards every call to the
    // original and only adds exception handling.
    unsafe {
        method.set_implementation(std::mem::transmute::<SendEventFn, Imp>(wrapper));
    }
    Ok(())
}

/// Returns true when an Objective-C exception was caught and swallowed.
fn dispatch_guarded(
    slot: &OnceLock<SendEventFn>,
    owner: &str,
    this: *mut AnyObject,
    sel: Sel,
    event: *mut AnyObject,
) -> bool {
    let Some(original) = slot.get().copied() else {
        return false;
    };
    // SAFETY: forwarding the runtime's own arguments to the original IMP.
    let result = exception::catch(AssertUnwindSafe(|| unsafe { original(this, sel, event) }));
    let Err(exc) = result else {
        return false;
    };
    let n = SWALLOWED.fetch_add(1, Ordering::Relaxed) + 1;
    // A repeating exception must not flood the log: first 20, then every 1000th.
    if n <= 20 || n.is_multiple_of(1000) {
        let detail = match exc {
            Some(exc) => format!("{exc:?}"),
            None => "nil exception".to_string(),
        };
        let detail: String = detail.chars().take(MAX_LOGGED_REASON).collect();
        log::error!(
            "[event-guard] swallowed Objective-C exception #{n} in -[{owner} sendEvent:]: {detail}"
        );
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::runtime::{ClassBuilder, NSObject};
    use objc2::{class, msg_send, ClassType};
    use std::os::unix::process::ExitStatusExt;
    use std::sync::atomic::AtomicBool;

    const CHILD_ENV: &str = "GG_EVENT_GUARD_ABORT_CHILD";

    // Stand-in for AppKit: an ObjC method that raises NSRangeException.
    unsafe extern "C-unwind" fn raising_send_event(
        _this: &AnyObject,
        _sel: Sel,
        _event: *mut AnyObject,
    ) {
        let empty: *mut AnyObject = unsafe { msg_send![class!(NSArray), array] };
        let _: *mut AnyObject = unsafe { msg_send![empty, objectAtIndex: 5usize] };
    }

    // Stand-in for tao's `extern "C" fn send_event` that calls `[super sendEvent:]`.
    extern "C" fn tao_like_send_event(this: &AnyObject, _sel: Sel, event: *mut AnyObject) {
        let base = this
            .class()
            .superclass()
            .expect("tao-like class has a superclass");
        let _: () = unsafe { msg_send![super(this, base), sendEvent: event] };
    }

    /// Registers `<prefix>Base` (raises in sendEvent:) and `<prefix>Tao`
    /// (extern "C" override calling super); returns a `<prefix>Tao` instance.
    fn tao_like_instance(prefix: &str) -> *mut AnyObject {
        let base_name = std::ffi::CString::new(format!("{prefix}Base")).expect("cstr");
        let tao_name = std::ffi::CString::new(format!("{prefix}Tao")).expect("cstr");
        let mut base = ClassBuilder::new(&base_name, NSObject::class()).expect("new base class");
        unsafe {
            base.add_method(
                sel!(sendEvent:),
                raising_send_event as unsafe extern "C-unwind" fn(_, _, _),
            );
        }
        let base = base.register();
        let mut tao = ClassBuilder::new(&tao_name, base).expect("new tao class");
        unsafe {
            tao.add_method(
                sel!(sendEvent:),
                tao_like_send_event as extern "C" fn(_, _, _),
            );
        }
        let tao = tao.register();
        unsafe { msg_send![tao, new] }
    }

    static GUARDED_SLOT: OnceLock<SendEventFn> = OnceLock::new();
    static GUARDED_CAUGHT: AtomicBool = AtomicBool::new(false);

    unsafe extern "C-unwind" fn guarded_test_send_event(
        this: *mut AnyObject,
        sel: Sel,
        event: *mut AnyObject,
    ) {
        if dispatch_guarded(&GUARDED_SLOT, "GGGuardCaughtBase", this, sel, event) {
            GUARDED_CAUGHT.store(true, Ordering::SeqCst);
        }
    }

    // Regression for the macOS 27 crash: an exception beneath tao's extern "C"
    // sendEvent: must be caught instead of aborting the process.
    #[test]
    fn exception_under_tao_like_frame_is_swallowed() {
        let obj = tao_like_instance("GGGuardCaught");
        install_on(c"GGGuardCaughtBase", &GUARDED_SLOT, guarded_test_send_event)
            .expect("guard installs");
        let _: () = unsafe { msg_send![obj, sendEvent: std::ptr::null_mut::<AnyObject>()] };
        assert!(GUARDED_CAUGHT.load(Ordering::SeqCst));
        // A second dispatch also survives (the guard is not one-shot).
        GUARDED_CAUGHT.store(false, Ordering::SeqCst);
        let _: () = unsafe { msg_send![obj, sendEvent: std::ptr::null_mut::<AnyObject>()] };
        assert!(GUARDED_CAUGHT.load(Ordering::SeqCst));
    }

    // Child half of the control test below; a no-op unless re-executed by it.
    #[test]
    #[ignore = "run only as a child of unguarded_exception_aborts_like_the_crash_report"]
    fn unguarded_child() {
        if std::env::var_os(CHILD_ENV).is_none() {
            return;
        }
        let obj = tao_like_instance("GGGuardUnguarded");
        let _: () = unsafe { msg_send![obj, sendEvent: std::ptr::null_mut::<AnyObject>()] };
    }

    // Control: without the guard, the same setup reproduces the crash report's
    // SIGABRT + panic_cannot_unwind, so the test above is exercising the bug.
    #[test]
    fn unguarded_exception_aborts_like_the_crash_report() {
        let out = std::process::Command::new(std::env::current_exe().expect("test exe"))
            .args([
                "--exact",
                "macos_event_guard::tests::unguarded_child",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_ENV, "1")
            .output()
            .expect("spawn child test");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.signal(), Some(libc::SIGABRT), "stderr: {stderr}");
        assert!(
            stderr.contains("panic in a function that cannot unwind"),
            "stderr: {stderr}"
        );
    }

    #[test]
    fn install_wraps_appkit_send_event() {
        install();
        install(); // idempotent
        for (class, wrapper) in [
            (c"NSApplication", guarded_app_send_event as SendEventFn),
            (c"NSWindow", guarded_window_send_event as SendEventFn),
        ] {
            let imp = AnyClass::get(class)
                .and_then(|c| c.instance_method(sel!(sendEvent:)))
                .expect("sendEvent: exists")
                .implementation();
            assert_eq!(imp as usize, wrapper as usize, "{class:?}");
        }
    }
}

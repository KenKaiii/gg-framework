//! Agent-event broadcasting and the SSE bridge from the daemon to windows.

use crate::*;

/// Emit one `agent-event` frame to EVERY window, matching the shape the SSE
/// bridge produces. For global state changed natively, outside any session.
pub(crate) fn broadcast_agent_event(
    app: &tauri::AppHandle,
    event_type: &str,
    data: serde_json::Value,
) {
    for label in app.webview_windows().keys() {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "agent-event",
            serde_json::json!({ "type": event_type, "data": data }),
        );
    }
}

/// Current unix time in milliseconds (wall clock; fine for an expiry stamp).
pub(crate) fn current_unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Drain every complete SSE frame (frames are separated by a blank line) from a
/// rolling BYTE buffer, returning each frame's decoded text and leaving any
/// trailing partial frame in `buf`.
///
/// Why a byte buffer instead of decoding each network chunk: `bytes_stream()`
/// splits on arbitrary TCP boundaries, so a multibyte UTF-8 codepoint (emoji,
/// ✓, box-drawing, CJK, accented chars — all common in agent output) can
/// straddle two chunks. Decoding a chunk that ends mid-codepoint replaces the
/// partial bytes with U+FFFD and corrupts the stream for good. A complete frame
/// always ends at an ASCII `\n`, so its bytes never split a codepoint — decoding
/// per-frame is lossless, and any partial tail stays buffered until its rest
/// arrives.
pub(crate) fn drain_sse_frames(buf: &mut Vec<u8>) -> Vec<String> {
    let mut frames = Vec::new();
    while let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
        let drained: Vec<u8> = buf.drain(..pos + 2).collect();
        // Bytes before the `\n\n` are the complete frame (whole codepoints).
        frames.push(String::from_utf8_lossy(&drained[..pos]).into_owned());
    }
    frames
}

/// Run `emit` only while `label` still shows `session_id`; says whether it ran.
/// The registry is unlocked BEFORE `emit`: handing a frame to the webview is
/// not instant, and holding the registry across it made every proxy command's
/// `session_for` wait on stream traffic.
pub(crate) fn emit_to_current_session(
    map: &Mutex<HashMap<String, WindowSession>>,
    label: &str,
    session_id: &str,
    emit: impl FnOnce(),
) -> bool {
    let current = map
        .lock_or_recover()
        .get(label)
        .and_then(|w| w.session_id.as_deref())
        == Some(session_id);
    if !current {
        return false;
    }
    emit();
    true
}

/// Connect to a window's sidecar SSE stream and re-emit each frame ONLY to that
/// window (`emit_to` the window label) as `agent-event`, so windows never see
/// each other's agent activity. Rust has no mixed-content restriction, so the
/// webview never touches plain HTTP directly. Reconnects on stream end, backing
/// off while the daemon stays unreachable.
pub(crate) fn start_event_bridge(
    app: tauri::AppHandle,
    label: String,
    port: u16,
    session_id: String,
) {
    // Its own client, not the shared proxy one: that bounds every request
    // (`SIDECAR_REQUEST_TIMEOUT`), and this stream is long-lived by design.
    let client = app.state::<EventStreamClient>().inner().0.clone();
    tauri::async_runtime::spawn(async move {
        let mut retry_delay = SSE_RETRY_MIN;
        loop {
            // Stop once this window's active session has moved on (project switch
            // created a new session) or the window is gone — otherwise the old
            // bridge would reconnect to a stale session forever. Session routing
            // is by id now (the daemon port is shared across all windows).
            {
                let state: State<Windows> = app.state();
                let map = state.map.lock_or_recover();
                if map.get(&label).and_then(|w| w.session_id.clone()) != Some(session_id.clone()) {
                    log::debug!("event bridge for {label} session {session_id} retired");
                    return;
                }
            }
            // The daemon adds this response to the target session's SSE clients.
            let url = format!(
                "{}/events?session={}",
                sidecar_base(port),
                urlencoding(&session_id)
            );
            match client.get(&url).send().await {
                Ok(res) if !res.status().is_success() => {
                    log::warn!("agent event stream refused: {}", res.status());
                }
                Ok(res) => {
                    // Connected: the next drop is a fresh outage, retried fast.
                    retry_delay = SSE_RETRY_MIN;
                    let mut stream = res.bytes_stream();
                    // Raw byte buffer — decode only at frame boundaries so a
                    // codepoint split across TCP chunks is never corrupted.
                    let mut buf: Vec<u8> = Vec::new();
                    while let Some(chunk) = stream.next().await {
                        let Ok(bytes) = chunk else { break };
                        buf.extend_from_slice(&bytes);
                        for frame in drain_sse_frames(&mut buf) {
                            for line in frame.lines() {
                                if let Some(payload) = line.strip_prefix("data: ") {
                                    if let Ok(value) =
                                        serde_json::from_str::<serde_json::Value>(payload)
                                    {
                                        let state: State<Windows> = app.state();
                                        let emitted = emit_to_current_session(
                                            &state.map,
                                            &label,
                                            &session_id,
                                            || {
                                                let _ = app.emit_to(
                                                    EventTarget::webview_window(label.clone()),
                                                    "agent-event",
                                                    value,
                                                );
                                            },
                                        );
                                        if !emitted {
                                            return;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    log::warn!("agent event stream ended, reconnecting");
                }
                Err(e) => {
                    log::error!("failed to connect to event stream: {e}");
                }
            }
            // Do not leave a stale working/success label while the stream is down,
            // and never deliver an old session's disconnect to its replacement.
            {
                let state: State<Windows> = app.state();
                if !emit_to_current_session(&state.map, &label, &session_id, || {
                    let _ = app.emit_to(
                        EventTarget::webview_window(label.clone()),
                        "agent-event",
                        serde_json::json!({ "type": "connection_lost", "data": {} }),
                    );
                }) {
                    return;
                }
            }
            tokio::time::sleep(retry_delay).await;
            retry_delay = next_sse_retry_delay(retry_delay);
        }
    });
}

/// First reconnect after a dropped event stream: quick, so a blip is invisible.
pub(crate) const SSE_RETRY_MIN: std::time::Duration = std::time::Duration::from_secs(1);
/// Ceiling while the daemon stays down. If it never returns (the crash circuit
/// breaker opened), every window would otherwise wake, log and re-render a
/// "Reconnecting" event once a second until the app quits.
pub(crate) const SSE_RETRY_MAX: std::time::Duration = std::time::Duration::from_secs(30);

pub(crate) fn next_sse_retry_delay(current: std::time::Duration) -> std::time::Duration {
    (current * 2).min(SSE_RETRY_MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_retry_backs_off_to_a_ceiling() {
        let mut delay = SSE_RETRY_MIN;
        let mut seen = vec![delay.as_secs()];
        for _ in 0..8 {
            delay = next_sse_retry_delay(delay);
            seen.push(delay.as_secs());
        }
        assert_eq!(seen, [1, 2, 4, 8, 16, 30, 30, 30, 30]);
    }

    // ── Frame delivery (emit_to_current_session) ─────────────────────────────

    fn registry(session_id: Option<&str>) -> Mutex<HashMap<String, WindowSession>> {
        Mutex::new(HashMap::from([(
            "main".to_string(),
            WindowSession {
                session_id: session_id.map(str::to_string),
                ..Default::default()
            },
        )]))
    }

    #[test]
    fn a_frame_is_emitted_with_the_registry_unlocked() {
        let map = registry(Some("sid-1"));
        let mut emitted = false;
        assert!(emit_to_current_session(&map, "main", "sid-1", || {
            assert!(
                map.try_lock().is_ok(),
                "the window registry is locked while a frame is handed to the webview"
            );
            emitted = true;
        }));
        assert!(emitted);
    }

    #[test]
    fn a_frame_for_a_window_that_changed_session_is_dropped() {
        let map = registry(Some("sid-2"));
        // The window moved to another session mid-run: the old stream's frames
        // must not land in the new one.
        assert!(!emit_to_current_session(&map, "main", "sid-1", || {
            panic!("a frame for a retired session was emitted")
        }));
        // A window with no session yet, or one that is gone, is no target either.
        assert!(!emit_to_current_session(
            &registry(None),
            "main",
            "sid-1",
            || { panic!("a frame was emitted for a window without a session") }
        ));
        assert!(!emit_to_current_session(&map, "closed", "sid-2", || {
            panic!("a frame was emitted for a window that is gone")
        }));
    }

    // ── SSE frame decoding (drain_sse_frames) ────────────────────────────────

    #[test]
    fn drains_complete_frames_and_keeps_partial() {
        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(b"data: one\n\ndata: two\n\ndata: par");
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(
            frames,
            vec!["data: one".to_string(), "data: two".to_string()]
        );
        // The unterminated "data: par" stays buffered for the next chunk.
        assert_eq!(buf, b"data: par");
    }

    #[test]
    fn no_complete_frame_leaves_buffer_intact() {
        let mut buf: Vec<u8> = b"data: incomplete\n".to_vec();
        assert!(drain_sse_frames(&mut buf).is_empty());
        assert_eq!(buf, b"data: incomplete\n");
    }

    #[test]
    fn multibyte_codepoint_split_across_chunks_is_not_corrupted() {
        // "✓ 🚀 café" — ✓ (3 bytes), 🚀 (4 bytes), é (2 bytes). Feed the
        // frame one byte at a time so every codepoint straddles a chunk
        // boundary. The old per-chunk from_utf8_lossy would emit U+FFFD; the
        // byte-buffered drainer must reconstruct the exact text.
        let payload = "data: ✓ 🚀 café";
        let wire = format!("{payload}\n\n");
        let mut buf: Vec<u8> = Vec::new();
        let mut frames: Vec<String> = Vec::new();
        for &byte in wire.as_bytes() {
            buf.push(byte);
            frames.extend(drain_sse_frames(&mut buf));
        }
        assert_eq!(frames, vec![payload.to_string()]);
        assert!(
            !frames[0].contains('\u{FFFD}'),
            "no replacement chars: {:?}",
            frames[0]
        );
        assert!(buf.is_empty());
    }

    #[test]
    fn multiple_frames_in_one_chunk() {
        let mut buf: Vec<u8> = b"data: a\n\ndata: b\n\ndata: c\n\n".to_vec();
        let frames = drain_sse_frames(&mut buf);
        assert_eq!(frames, vec!["data: a", "data: b", "data: c"]);
        assert!(buf.is_empty());
    }
}

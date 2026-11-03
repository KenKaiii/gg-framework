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

/// Connect to a window's sidecar SSE stream and re-emit each frame ONLY to that
/// window (`emit_to` the window label) as `agent-event`, so windows never see
/// each other's agent activity. Rust has no mixed-content restriction, so the
/// webview never touches plain HTTP directly. Reconnects on stream end.
pub(crate) fn start_event_bridge(
    app: tauri::AppHandle,
    label: String,
    port: u16,
    session_id: String,
) {
    // Reuse the app's shared HTTP client (cheap Arc clone) so the SSE connect
    // shares the connection pool with the proxy commands.
    let client = app.state::<reqwest::Client>().inner().clone();
    // kleio: the host pings every 15 s, so silence means a dead connection.
    // On the iPhone the stream closes while the app is in the background (so
    // the host can notify) and reopens the moment it is back (kleio::Presence).
    let mut presence = app.state::<kleio::Presence>().subscribe();
    let idle = kleio::remote().map(|_| kleio::STREAM_IDLE);
    // kleio: only the newest bridge for a window delivers (kleio::BridgeEpochs).
    let epoch = app.state::<kleio::BridgeEpochs>().begin(&label);
    tauri::async_runtime::spawn(async move {
        let mut last_event_id: Option<u64> = None;
        // Still this window's bridge, for this window's active session?
        let speaks_for_window = |app: &tauri::AppHandle| -> bool {
            let state: State<Windows> = app.state();
            let map = state.map.lock().unwrap();
            map.get(&label).and_then(|w| w.session_id.as_deref()) == Some(session_id.as_str())
                && app.state::<kleio::BridgeEpochs>().is_current(&label, epoch)
        };
        loop {
            let mut resumed = false;
            // Stop once this window's active session has moved on (project switch
            // created a new session) or the window is gone — otherwise the old
            // bridge would reconnect to a stale session forever. Session routing
            // is by id now (the daemon port is shared across all windows).
            if !speaks_for_window(&app) {
                log::debug!("event bridge for {label} session {session_id} retired");
                return;
            }
            // kleio: never hold a connection open from the background.
            kleio::until_visible(&mut presence).await;
            if !speaks_for_window(&app) {
                return;
            }
            // kleio: the host's sidecar restarts (an update, a crash) and
            // forgets every session. The host still accepts this stream and
            // only pings it, and every request for the window fails (the home
            // screen read that as "no model"). So ask before connecting: a
            // forgotten session is started again from its conversation, as
            // after a local daemon respawn. A live one notes where its
            // conversation is now, for exactly that.
            if kleio::remote().is_some() {
                match fetch_session_state(&client, port, &session_id).await {
                    SessionState::Gone => {
                        if speaks_for_window(&app) {
                            log::warn!(
                                "kleio: the host forgot session {session_id} of {label}; starting it again"
                            );
                            recreate_window_session(&app, &label);
                        }
                        return;
                    }
                    SessionState::Found(state) => {
                        let windows: State<Windows> = app.state();
                        let mut map = windows.map.lock().unwrap();
                        remember_session_path(&mut map, &label, &session_id, &state);
                    }
                    SessionState::Unknown => {}
                }
            }
            // The daemon adds this response to the target session's SSE clients.
            let url = format!(
                "{}/events?session={}",
                sidecar_base(port),
                urlencoding(&session_id)
            );
            // kleio: resume from the last frame id the host gave us (the local
            // sidecar sends no id: lines, so this stays None locally).
            let mut req = client.get(&url);
            if let Some(id) = last_event_id {
                req = req.header("Last-Event-ID", id.to_string());
            }
            match req.send().await {
                Ok(res) => {
                    let mut stream = res.bytes_stream();
                    // Raw byte buffer — decode only at frame boundaries so a
                    // codepoint split across TCP chunks is never corrupted.
                    let mut buf: Vec<u8> = Vec::new();
                    loop {
                        let bytes = match kleio::next_chunk(&mut stream, &mut presence, idle).await
                        {
                            kleio::Wake::Chunk(Some(Ok(bytes))) => bytes,
                            kleio::Wake::Chunk(_) => break,
                            kleio::Wake::Idle => {
                                log::warn!("agent event stream silent for {idle:?}, reconnecting");
                                break;
                            }
                            kleio::Wake::OnScreenChanged => {
                                resumed = true;
                                break;
                            }
                        };
                        buf.extend_from_slice(&bytes);
                        for frame in drain_sse_frames(&mut buf) {
                            if let Some(id) = kleio::sse_frame_id(&frame) {
                                last_event_id = Some(id);
                            }
                            for line in frame.lines() {
                                if let Some(payload) = line.strip_prefix("data: ") {
                                    if let Ok(value) =
                                        serde_json::from_str::<serde_json::Value>(payload)
                                    {
                                        if !speaks_for_window(&app) {
                                            return;
                                        }
                                        let _ = app.emit_to(
                                            EventTarget::webview_window(label.clone()),
                                            "agent-event",
                                            value,
                                        );
                                    }
                                }
                            }
                        }
                    }
                    if !resumed {
                        log::warn!("agent event stream ended, reconnecting");
                    }
                }
                Err(e) => {
                    log::error!("failed to connect to event stream: {e}");
                }
            }
            // kleio: the app left the screen or came back. Reconnect from
            // Last-Event-ID as soon as it is on screen (the top of the loop
            // waits); the host replays what was missed, so nothing was "lost".
            if resumed {
                continue;
            }
            // Do not leave a stale working/success label while the stream is down,
            // and never deliver an old session's disconnect to its replacement.
            if !speaks_for_window(&app) {
                return;
            }
            let _ = app.emit_to(
                EventTarget::webview_window(label.clone()),
                "agent-event",
                serde_json::json!({ "type": "connection_lost", "data": {} }),
            );
            tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

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

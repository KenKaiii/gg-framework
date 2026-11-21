//! Linux RPM self-update. The updater plugin installs with a bare `rpm -U`,
//! which RPM 6 (Fedora 45+) refuses for any package without a GPG signature
//! the machine trusts ("does not verify: no signature"), and it takes no extra
//! flags. Here the payload is downloaded and checked against our updater key
//! by the plugin, then installed with `--nosignature`: rpm's own signature
//! check is the only one skipped, after ours has passed.

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Runtime};

/// Download progress, in the same shape as the updater plugin's JS
/// `DownloadEvent`, so the webview handles both routes the same way.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "event", content = "data")]
// Only the Linux installer sends these.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) enum UpdateDownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

/// True when this build was installed from the .rpm, so updates must go
/// through [`install_rpm_update`] rather than the plugin's own install.
#[tauri::command]
pub(crate) fn update_installs_rpm() -> bool {
    cfg!(target_os = "linux")
        && matches!(
            tauri::utils::platform::bundle_type(),
            Some(tauri::utils::config::BundleType::Rpm)
        )
}

/// Download the pending update (verified against the updater key) and
/// install it with `pkexec rpm -U --nosignature`. The caller relaunches.
#[tauri::command]
pub(crate) async fn install_rpm_update<R: Runtime>(
    app: AppHandle<R>,
    on_event: Channel<UpdateDownloadEvent>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use tauri_plugin_updater::UpdaterExt;
        let update = app
            .updater()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No update is available any more.".to_string())?;
        let mut started = false;
        // `download` checks the updater signature before returning the bytes.
        let bytes = update
            .download(
                |chunk_length, content_length| {
                    if !started {
                        started = true;
                        let _ = on_event.send(UpdateDownloadEvent::Started { content_length });
                    }
                    let _ = on_event.send(UpdateDownloadEvent::Progress { chunk_length });
                },
                || {
                    let _ = on_event.send(UpdateDownloadEvent::Finished);
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        install_rpm_bytes(&bytes)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, on_event);
        Err("RPM updates are only installed on Linux.".to_string())
    }
}

#[cfg(target_os = "linux")]
fn install_rpm_bytes(bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

    // A fresh owner-only directory, so nothing else can swap the package
    // between the write and the install.
    let dir = std::env::temp_dir().join(format!("gg-coder-update-{}", uuid::Uuid::new_v4()));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&dir)
        .map_err(|e| format!("Couldn't prepare the update: {e}"))?;
    let package = dir.join("gg-coder-update.rpm");
    let written = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&package)
        .and_then(|mut file| file.write_all(bytes));
    let status = written
        .map_err(|e| format!("Couldn't save the update: {e}"))
        .and_then(|()| {
            crate::hide_console(&mut std::process::Command::new("pkexec"))
                .args(["rpm", "-U", "--nosignature"])
                .arg(&package)
                .status()
                .map_err(|e| {
                    format!(
                        "Couldn't ask for permission to install the update ({e}). Install the latest .rpm from the GitHub releases page instead."
                    )
                })
        });
    let _ = std::fs::remove_dir_all(&dir);
    let status = status?;
    match status.code() {
        Some(0) => Ok(()),
        // pkexec: 126 = the password prompt was dismissed, 127 = not authorised.
        Some(126) | Some(127) => Err(
            "The update needs your password to install. Try again and approve the prompt."
                .to_string(),
        ),
        _ => Err(format!("The update couldn't be installed (rpm {status}).")),
    }
}

#[cfg(test)]
mod tests {
    use super::UpdateDownloadEvent;

    #[test]
    fn download_events_match_the_plugin_js_shape() {
        let json = |e: UpdateDownloadEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            json(UpdateDownloadEvent::Started {
                content_length: Some(10)
            }),
            serde_json::json!({ "event": "Started", "data": { "contentLength": 10 } })
        );
        assert_eq!(
            json(UpdateDownloadEvent::Progress { chunk_length: 4 }),
            serde_json::json!({ "event": "Progress", "data": { "chunkLength": 4 } })
        );
        assert_eq!(
            json(UpdateDownloadEvent::Finished),
            serde_json::json!({ "event": "Finished" })
        );
    }
}

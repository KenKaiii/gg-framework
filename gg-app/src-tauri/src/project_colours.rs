//! Personal project colours: separate from gg-app.json so the sidecar/settings
//! writer cannot erase them. All native windows share this serialized writer.
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

const EVENT: &str = "project-colours-changed";
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Default)]
pub(crate) struct ProjectColours(Arc<Mutex<u64>>);

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    overrides: BTreeMap<String, String>,
    stripe: bool,
    revision: u64,
    project_key: Option<String>,
}

fn valid_choice(choice: &str) -> bool {
    matches!(
        choice,
        "None"
            | "Blue"
            | "Violet"
            | "Green"
            | "Amber"
            | "Coral"
            | "Teal"
            | "Pink"
            | "Lime"
            | "Cyan"
            | "Orchid"
    )
}

fn project_key(cwd: &str) -> Result<String, String> {
    let path = PathBuf::from(cwd);
    if cwd.is_empty() || cwd.contains('\0') || !path.is_absolute() {
        return Err("A project folder is required".into());
    }
    let canonical =
        std::fs::canonicalize(&path).map_err(|_| "Cannot resolve the project folder")?;
    if !canonical.is_dir() {
        return Err("A project folder is required".into());
    }
    let path = crate::strip_extended_prefix(canonical);
    let key = path
        .to_str()
        .ok_or("Cannot identify the project folder")?
        .to_string();
    #[cfg(windows)]
    let key = key.to_lowercase();
    if key.len() > 4096 {
        return Err("Project folder path is too long".into());
    }
    Ok(key)
}

fn preferences_path() -> PathBuf {
    crate::home_dir()
        .join(".gg")
        .join("gg-app-project-colours.json")
}

fn read_preferences(path: &Path) -> Result<serde_json::Value, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(serde_json::json!({})),
        Err(_) => return Err("Cannot read project colour preferences".into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read project colour preferences")?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("Project colour preferences are too large".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Project colour preferences are malformed; the file was left unchanged")?;
    if !value.is_object() {
        return Err("Project colour preferences are malformed; the file was left unchanged".into());
    }
    Ok(value)
}

fn snapshot(value: &serde_json::Value, revision: u64, key: Option<String>) -> Snapshot {
    let overrides = value
        .get("overrides")
        .and_then(|v| v.as_object())
        .into_iter()
        .flat_map(|map| map.iter())
        .filter_map(|(key, value)| {
            let choice = value.as_str()?;
            (key.len() <= 4096 && !key.is_empty() && valid_choice(choice))
                .then(|| (key.clone(), choice.to_string()))
        })
        .collect();
    Snapshot {
        overrides,
        stripe: value
            .get("stripe")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        revision,
        project_key: key,
    }
}

// Same-directory temp + rename: a failed write leaves the previous file intact.
fn write_preferences(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "Cannot encode project colours")?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("Project colour preferences are too large".into());
    }
    let parent = path
        .parent()
        .ok_or("Cannot locate project colour preferences")?;
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create project colour preferences")?;
    let temp = parent.join(format!(".project-colours-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
        return Err("Cannot save project colour preferences; the previous choice was kept".into());
    }
    Ok(())
}

fn update_preferences(
    path: &Path,
    key: Option<&str>,
    choice: Option<&str>,
    stripe: Option<bool>,
) -> Result<serde_json::Value, String> {
    if choice.is_none() == stripe.is_none() {
        return Err("Change either a project colour or stripe visibility".into());
    }
    if let Some(choice) = choice {
        if choice != "Automatic" && !valid_choice(choice) {
            return Err("Unknown project colour".into());
        }
        if key.is_none() {
            return Err("A project folder is required".into());
        }
    }
    // Re-read under the shared lock; never write a stale window's whole map.
    let mut value = read_preferences(path)?;
    if let Some(choice) = choice {
        let overrides = value
            .as_object_mut()
            .unwrap()
            .entry("overrides")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or("Project colour preferences are malformed; the file was left unchanged")?;
        let key = key.unwrap();
        if choice == "Automatic" {
            overrides.remove(key);
        } else {
            overrides.insert(key.to_string(), serde_json::json!(choice));
        }
    }
    if let Some(stripe) = stripe {
        value["stripe"] = serde_json::json!(stripe);
    }
    write_preferences(path, &value)?;
    Ok(value)
}

#[tauri::command]
pub(crate) async fn project_colours_get(
    state: State<'_, ProjectColours>,
    cwd: Option<String>,
) -> Result<Snapshot, String> {
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let key = cwd.as_deref().map(project_key).transpose()?;
        let revision = lock
            .lock()
            .map_err(|_| "Project colour preferences are unavailable")?;
        Ok(snapshot(
            &read_preferences(&preferences_path())?,
            *revision,
            key,
        ))
    })
    .await
    .map_err(|_| "Cannot load project colours".to_string())?
}

#[tauri::command]
pub(crate) async fn project_colours_save(
    app: tauri::AppHandle,
    state: State<'_, ProjectColours>,
    cwd: Option<String>,
    choice: Option<String>,
    stripe: Option<bool>,
) -> Result<Snapshot, String> {
    let lock = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let key = cwd.as_deref().map(project_key).transpose()?;
        let mut revision = lock
            .lock()
            .map_err(|_| "Project colour preferences are unavailable")?;
        let value = update_preferences(
            &preferences_path(),
            key.as_deref(),
            choice.as_deref(),
            stripe,
        )?;
        *revision += 1;
        let saved = snapshot(&value, *revision, key);
        // Emit while serialized, so every webview sees the same write order.
        if app.emit(EVENT, &saved).is_err() {
            log::warn!("Could not broadcast project colour preferences");
        }
        Ok(saved)
    })
    .await
    .map_err(|_| "Cannot save project colours".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("gg-project-colours-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> PathBuf {
            self.0.join("colours.json")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn choices_restart_reset_and_none_preserve_other_preferences() {
        let fixture = Fixture::new();
        let path = fixture.file();
        assert!(!snapshot(&read_preferences(&path).unwrap(), 0, None).stripe);
        for choice in [
            "Blue", "Violet", "Green", "Amber", "Coral", "Teal", "Pink", "Lime", "Cyan", "Orchid",
            "None",
        ] {
            update_preferences(&path, Some("/a/project"), Some(choice), None).unwrap();
            let restarted = snapshot(&read_preferences(&path).unwrap(), 0, None);
            assert_eq!(restarted.overrides["/a/project"], choice);
        }
        update_preferences(&path, Some("/b/project"), Some("Green"), None).unwrap();
        update_preferences(&path, None, None, Some(true)).unwrap();
        update_preferences(&path, Some("/a/project"), Some("Automatic"), None).unwrap();
        let saved = snapshot(&read_preferences(&path).unwrap(), 0, None);
        assert!(!saved.overrides.contains_key("/a/project"));
        assert_eq!(saved.overrides["/b/project"], "Green");
        assert!(saved.stripe);
        update_preferences(&path, None, None, Some(false)).unwrap();
        assert!(!snapshot(&read_preferences(&path).unwrap(), 0, None).stripe);
    }

    #[test]
    fn concurrent_windows_merge_instead_of_replacing_other_projects() {
        let fixture = Fixture::new();
        let lock = Arc::new(Mutex::new(0));
        let handles: Vec<_> = (0..20)
            .map(|index| {
                let lock = lock.clone();
                let path = fixture.file();
                std::thread::spawn(move || {
                    let mut revision = lock.lock().unwrap();
                    update_preferences(
                        &path,
                        Some(&format!("/work/{index}/project")),
                        Some("Blue"),
                        None,
                    )
                    .unwrap();
                    *revision += 1;
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(
            snapshot(
                &read_preferences(&fixture.file()).unwrap(),
                *lock.lock().unwrap(),
                None
            )
            .overrides
            .len(),
            20
        );
    }

    #[test]
    fn rejects_invalid_choices_folderless_updates_and_malformed_files() {
        let fixture = Fixture::new();
        let path = fixture.file();
        assert!(update_preferences(&path, None, Some("Blue"), None).is_err());
        assert!(update_preferences(&path, Some("/a"), Some("red; display:none"), None).is_err());
        assert!(!path.exists());
        std::fs::write(&path, "{broken").unwrap();
        assert!(update_preferences(&path, Some("/a"), Some("Blue"), None).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{broken");
        let parsed = snapshot(
            &serde_json::json!({"overrides":{"/a":"url(secret)","/b":"Green"},"stripe":"yes"}),
            0,
            None,
        );
        assert_eq!(parsed.overrides.len(), 1);
        assert!(!parsed.stripe);
    }

    #[test]
    fn failed_save_keeps_previous_file_and_unknown_fields_survive() {
        let fixture = Fixture::new();
        let path = fixture.file();
        std::fs::write(&path, r#"{"futureSetting":42,"overrides":{"/a":"Blue"}}"#).unwrap();
        let value = update_preferences(&path, Some("/b"), Some("Green"), None).unwrap();
        assert_eq!(value["futureSetting"], 42);
        let before = std::fs::read(&path).unwrap();
        let too_large = serde_json::json!({"extra":"x".repeat(MAX_FILE_BYTES as usize)});
        assert!(write_preferences(&path, &too_large).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(write_preferences(&fixture.0, &value).is_err());
    }

    #[test]
    fn project_identity_uses_the_whole_canonical_path() {
        let fixture = Fixture::new();
        for dir in ["a/project", "b/project"] {
            std::fs::create_dir_all(fixture.0.join(dir)).unwrap();
        }
        let a = project_key(fixture.0.join("a/project").to_str().unwrap()).unwrap();
        let b = project_key(fixture.0.join("b/project").to_str().unwrap()).unwrap();
        assert_ne!(a, b);
        assert_eq!(
            a,
            project_key(fixture.0.join("a/../a/project/.").to_str().unwrap()).unwrap()
        );
        assert!(project_key("").is_err());
        assert!(project_key("relative/project").is_err());
    }
}

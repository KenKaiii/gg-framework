use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{Emitter, EventTarget, Manager};

use super::{AzureConnectionError, SecureAzureConfig};
use crate::{sidecar_base, Daemon, WindowSession, Windows};

const RELOAD_WAIT_ATTEMPTS: usize = 600;
const RELOAD_WAIT_INTERVAL: Duration = Duration::from_millis(50);

pub(crate) fn configure_daemon_azure_environment(
    command: &mut Command,
    config: Option<&SecureAzureConfig>,
) {
    let Some(config) = config else {
        // No complete OS-vault connection: inherit the process environment unchanged.
        return;
    };
    command
        .env("AZURE_OPENAI_API_KEY", &config.api_key)
        .env("AZURE_OPENAI_BASE_URL", &config.base_url)
        .env("AZURE_OPENAI_DEPLOYMENT", &config.deployment);
    match &config.model_identity {
        Some(model_identity) => {
            command.env("AZURE_OPENAI_MODEL_ID", model_identity);
        }
        None => {
            command.env_remove("AZURE_OPENAI_MODEL_ID");
        }
    }
}

pub(crate) type ReloadFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), AzureConnectionError>> + Send + 'a>>;

pub(crate) trait DaemonReloadClient {
    fn prepare<'a>(&'a self) -> ReloadFuture<'a>;
    fn cancel<'a>(&'a self) -> ReloadFuture<'a>;
    fn reload<'a>(&'a self) -> ReloadFuture<'a>;
}

pub(crate) async fn run_mutation_with_reload<R, F, T>(
    reloader: &R,
    mutation: F,
) -> Result<T, AzureConnectionError>
where
    R: DaemonReloadClient,
    F: Future<Output = Result<T, AzureConnectionError>>,
{
    reloader.prepare().await?;
    let result = match mutation.await {
        Ok(result) => result,
        Err(error) => {
            let _ = reloader.cancel().await;
            return Err(error);
        }
    };
    if reloader.reload().await.is_err() {
        let _ = reloader.cancel().await;
        return Err(AzureConnectionError::general(
            "models_refresh_failed",
            "The Azure connection changed securely, but models did not refresh. Restart gg-app to apply the change.",
        ));
    }
    Ok(result)
}

pub(crate) struct NativeDaemonReloadClient {
    app: tauri::AppHandle,
}

impl NativeDaemonReloadClient {
    pub(crate) fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }

    fn port(&self) -> Result<u16, AzureConnectionError> {
        (*self.app.state::<Daemon>().port.lock().unwrap()).ok_or_else(refresh_unavailable)
    }

    async fn post(&self, path: &str) -> Result<reqwest::StatusCode, AzureConnectionError> {
        let port = self.port()?;
        self.app
            .state::<reqwest::Client>()
            .post(format!("{}{path}", sidecar_base(port)))
            .send()
            .await
            .map(|response| response.status())
            .map_err(|_| refresh_unavailable())
    }
}

impl DaemonReloadClient for NativeDaemonReloadClient {
    fn prepare<'a>(&'a self) -> ReloadFuture<'a> {
        Box::pin(async move {
            match self.post("/admin/reload/prepare").await?.as_u16() {
                200 => Ok(()),
                409 => Err(AzureConnectionError::general(
                    "active_runs",
                    "Finish or cancel every active run before changing the Azure connection.",
                )),
                _ => Err(refresh_unavailable()),
            }
        })
    }

    fn cancel<'a>(&'a self) -> ReloadFuture<'a> {
        Box::pin(async move {
            let status = self.post("/admin/reload/cancel").await?;
            if status.is_success() {
                Ok(())
            } else {
                Err(refresh_unavailable())
            }
        })
    }

    fn reload<'a>(&'a self) -> ReloadFuture<'a> {
        Box::pin(async move {
            self.port()?;
            let old_generation = self.app.state::<Daemon>().generation.load(Ordering::SeqCst);
            prepare_planned_reload(&self.app);
            let status = match self.post("/admin/reload").await {
                Ok(status) => status,
                Err(error) => {
                    cancel_planned_reload(&self.app);
                    return Err(error);
                }
            };
            if status.as_u16() != 202 {
                cancel_planned_reload(&self.app);
                return Err(if status.as_u16() == 409 {
                    AzureConnectionError::general(
                        "active_runs",
                        "Finish or cancel every active run before refreshing Azure models.",
                    )
                } else {
                    refresh_unavailable()
                });
            }

            for _ in 0..RELOAD_WAIT_ATTEMPTS {
                let daemon = self.app.state::<Daemon>();
                let generation = daemon.generation.load(Ordering::SeqCst);
                let ready = daemon.port.lock().unwrap().is_some();
                if ready && generation > old_generation {
                    return Ok(());
                }
                tokio::time::sleep(RELOAD_WAIT_INTERVAL).await;
            }
            cancel_planned_reload(&self.app);
            Err(AzureConnectionError::general(
                "models_refresh_failed",
                "The Azure connection changed securely, but models did not refresh. Restart gg-app to apply the change.",
            ))
        })
    }
}

fn refresh_unavailable() -> AzureConnectionError {
    AzureConnectionError::general(
        "models_refresh_unavailable",
        "The Azure connection could not refresh models. Try again after the agent is ready.",
    )
}

fn prepare_planned_reload(app: &tauri::AppHandle) {
    let labels = {
        let windows = app.state::<Windows>();
        let registry = windows.map.lock().unwrap();
        registry.keys().cloned().collect::<HashSet<_>>()
    };
    let daemon = app.state::<Daemon>();
    daemon.planned_reload.store(true, Ordering::SeqCst);
    *daemon.model_refresh_windows.lock().unwrap() = labels;
}

fn cancel_planned_reload(app: &tauri::AppHandle) {
    let daemon = app.state::<Daemon>();
    daemon.planned_reload.store(false, Ordering::SeqCst);
    daemon.model_refresh_windows.lock().unwrap().clear();
}

pub(crate) fn take_ready_model_refresh_windows(app: &tauri::AppHandle) -> Vec<String> {
    let ready = {
        let windows = app.state::<Windows>();
        let registry = windows.map.lock().unwrap();
        let daemon = app.state::<Daemon>();
        let pending = daemon.model_refresh_windows.lock().unwrap();
        ready_refresh_labels(&pending, &registry)
    };
    if ready.is_empty() {
        return ready;
    }
    {
        let daemon = app.state::<Daemon>();
        let mut pending = daemon.model_refresh_windows.lock().unwrap();
        for label in &ready {
            pending.remove(label);
        }
    }
    for label in &ready {
        let _ = app.emit_to(
            EventTarget::webview_window(label.clone()),
            "agent-models-changed",
            serde_json::json!({}),
        );
    }
    ready
}

fn ready_refresh_labels(
    pending: &HashSet<String>,
    registry: &std::collections::HashMap<String, WindowSession>,
) -> Vec<String> {
    let mut labels = pending
        .iter()
        .filter(|label| {
            registry
                .get(*label)
                .is_some_and(|session| session.session_id.is_some())
        })
        .cloned()
        .collect::<Vec<_>>();
    labels.sort();
    labels
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ChatAgent, WindowSession, WorkspaceMode};
    use std::ffi::OsStr;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    fn canary() -> String {
        std::env::var("GG_AZURE_TEST_CANARY").unwrap_or_else(|_| {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            format!("azure-lifecycle-test-key-{}-{nonce}", std::process::id())
        })
    }

    #[test]
    fn sidecar_env_injection_overrides_only_with_complete_secure_config() {
        let canary = canary();
        let config = SecureAzureConfig {
            api_key: canary.clone(),
            base_url: "https://secure.openai.azure.com/openai/v1/responses".into(),
            deployment: "customer-production-chat".into(),
            model_identity: Some("gpt-5.6-sol".into()),
        };
        let mut command = Command::new("node");
        configure_daemon_azure_environment(&mut command, Some(&config));
        let env = command
            .get_envs()
            .map(|(key, value)| (key.to_owned(), value.map(OsStr::to_owned)))
            .collect::<std::collections::HashMap<_, _>>();
        assert!(
            env.get(OsStr::new("AZURE_OPENAI_API_KEY"))
                .and_then(|value| value.as_deref())
                == Some(OsStr::new(&canary)),
            "injected API key did not match"
        );
        assert_eq!(
            env.get(OsStr::new("AZURE_OPENAI_DEPLOYMENT"))
                .and_then(|value| value.as_deref()),
            Some(OsStr::new("customer-production-chat"))
        );
        assert_eq!(
            env.get(OsStr::new("AZURE_OPENAI_MODEL_ID"))
                .and_then(|value| value.as_deref()),
            Some(OsStr::new("gpt-5.6-sol"))
        );

        let mut identity_absent = Command::new("node");
        let mut legacy_config = config.clone();
        legacy_config.model_identity = None;
        configure_daemon_azure_environment(&mut identity_absent, Some(&legacy_config));
        assert!(identity_absent
            .get_envs()
            .any(|(key, value)| key == OsStr::new("AZURE_OPENAI_MODEL_ID") && value.is_none()));

        let mut inherited = Command::new("node");
        configure_daemon_azure_environment(&mut inherited, None);
        assert!(inherited.get_envs().next().is_none());
    }

    struct MockReloader {
        calls: Arc<Mutex<Vec<&'static str>>>,
        fail_reload: bool,
    }

    impl DaemonReloadClient for MockReloader {
        fn prepare<'a>(&'a self) -> ReloadFuture<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("prepare");
                Ok(())
            })
        }

        fn cancel<'a>(&'a self) -> ReloadFuture<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("cancel");
                Ok(())
            })
        }

        fn reload<'a>(&'a self) -> ReloadFuture<'a> {
            Box::pin(async move {
                self.calls.lock().unwrap().push("reload");
                if self.fail_reload {
                    Err(AzureConnectionError::general(
                        "models_refresh_unavailable",
                        "Models could not refresh before the mutation result was classified.",
                    ))
                } else {
                    Ok(())
                }
            })
        }
    }

    #[test]
    fn restart_failure_is_sanitized_after_successful_mutation() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let reloader = MockReloader {
            calls: calls.clone(),
            fail_reload: true,
        };
        let mutated = Arc::new(Mutex::new(false));
        let mutation_flag = mutated.clone();
        let error =
            tauri::async_runtime::block_on(run_mutation_with_reload(&reloader, async move {
                *mutation_flag.lock().unwrap() = true;
                Ok(())
            }))
            .unwrap_err();
        assert!(*mutated.lock().unwrap());
        assert_eq!(*calls.lock().unwrap(), vec!["prepare", "reload", "cancel"]);
        assert_eq!(error.code, "models_refresh_failed");
        assert!(!serde_json::to_string(&error).unwrap().contains(&canary()));
    }

    fn window(session_id: Option<&str>) -> WindowSession {
        WindowSession {
            session_id: session_id.map(str::to_owned),
            mode: WorkspaceMode::Code,
            chat_agent: ChatAgent::General,
            cwd: Some(PathBuf::from("C:/project")),
            session_path: None,
            generation: 1,
        }
    }

    #[test]
    fn model_refresh_labels_are_isolated_until_each_window_is_ready() {
        let mut registry = std::collections::HashMap::from([
            ("main".into(), window(Some("main-session"))),
            ("project-1".into(), window(None)),
        ]);
        let pending = HashSet::from(["main".into(), "project-1".into()]);
        assert_eq!(ready_refresh_labels(&pending, &registry), vec!["main"]);

        registry.get_mut("project-1").unwrap().session_id = Some("project-session".into());
        assert_eq!(
            ready_refresh_labels(&pending, &registry),
            vec!["main", "project-1"]
        );
    }
}

mod storage;
mod validation;

pub(crate) mod commands;
pub(crate) mod lifecycle;

use serde::{Deserialize, Serialize};

use storage::{
    FileMetadataStore, KeyringSecretStore, MetadataStore, SecretStore, SecretStoreError,
};
use validation::{
    mask_endpoint, mask_value, resolve_environment, responses_url, status_for, validate_metadata,
    validate_optional_key, RemoteValidator, ReqwestRemoteValidator,
};

#[derive(Clone)]
pub(crate) struct SecureAzureConfig {
    pub(crate) base_url: String,
    pub(crate) deployment: String,
    pub(crate) model_identity: Option<String>,
    pub(crate) api_key: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AzureConnectionSource {
    Secure,
    Environment,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AzureConnectionStatus {
    pub(crate) configured: bool,
    pub(crate) source: AzureConnectionSource,
    pub(crate) endpoint: Option<String>,
    pub(crate) deployment: Option<String>,
    pub(crate) endpoint_summary: Option<String>,
    pub(crate) deployment_summary: Option<String>,
    pub(crate) has_stored_key: bool,
}

#[derive(Clone, Default)]
pub(crate) struct AzureEnvironment {
    pub(crate) api_key: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) deployment: Option<String>,
    pub(crate) model_identity: Option<String>,
}

impl AzureEnvironment {
    pub(crate) fn inherited() -> Self {
        Self {
            api_key: std::env::var("AZURE_OPENAI_API_KEY").ok(),
            base_url: std::env::var("AZURE_OPENAI_BASE_URL").ok(),
            deployment: std::env::var("AZURE_OPENAI_DEPLOYMENT").ok(),
            model_identity: std::env::var("AZURE_OPENAI_MODEL_ID").ok(),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAzureConnection {
    pub(crate) endpoint: String,
    pub(crate) deployment: String,
    /// Missing or blank preserves the existing vault entry.
    pub(crate) api_key: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AzureErrorField {
    Endpoint,
    Deployment,
    ApiKey,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AzureConnectionError {
    pub(crate) code: &'static str,
    pub(crate) field: Option<AzureErrorField>,
    pub(crate) message: &'static str,
}

impl AzureConnectionError {
    pub(super) fn field(field: AzureErrorField, code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            field: Some(field),
            message,
        }
    }

    pub(super) fn general(code: &'static str, message: &'static str) -> Self {
        Self {
            code,
            field: None,
            message,
        }
    }

    fn storage_read() -> Self {
        Self::general(
            "secure_storage_unavailable",
            "The Azure connection could not be read from secure storage. Try again after unlocking your operating-system credential vault.",
        )
    }

    fn metadata_read() -> Self {
        Self::general(
            "metadata_unavailable",
            "The saved Azure connection metadata could not be read. Re-enter the connection details and try again.",
        )
    }

    fn metadata_write() -> Self {
        Self::general(
            "metadata_save_failed",
            "The Azure connection could not be saved. The previous connection is still active.",
        )
    }
}

impl std::fmt::Display for AzureConnectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for AzureConnectionError {}

struct AzureConnectionManager<S, M, V> {
    secrets: S,
    metadata: M,
    validator: V,
}

impl<S, M, V> AzureConnectionManager<S, M, V>
where
    S: SecretStore,
    M: MetadataStore,
    V: RemoteValidator,
{
    fn new(secrets: S, metadata: M, validator: V) -> Self {
        Self {
            secrets,
            metadata,
            validator,
        }
    }

    fn status(
        &self,
        environment: &AzureEnvironment,
    ) -> Result<AzureConnectionStatus, AzureConnectionError> {
        let saved_metadata = self
            .metadata
            .load()
            .map_err(|_| AzureConnectionError::metadata_read())?;
        let stored_key = self
            .secrets
            .get()
            .map_err(|_| AzureConnectionError::storage_read())?;

        if let (Some(metadata), Some(_)) = (&saved_metadata, &stored_key) {
            return Ok(status_for(
                AzureConnectionSource::Secure,
                &metadata.endpoint,
                &metadata.deployment,
                true,
                true,
            ));
        }

        if let Some(config) = resolve_environment(environment) {
            return Ok(status_for(
                AzureConnectionSource::Environment,
                &config.base_url,
                &config.deployment,
                false,
                false,
            ));
        }

        Ok(AzureConnectionStatus {
            configured: false,
            source: AzureConnectionSource::None,
            endpoint: saved_metadata.as_ref().map(|value| value.endpoint.clone()),
            deployment: saved_metadata
                .as_ref()
                .map(|value| value.deployment.clone()),
            endpoint_summary: saved_metadata
                .as_ref()
                .map(|value| mask_endpoint(&value.endpoint)),
            deployment_summary: saved_metadata
                .as_ref()
                .map(|value| mask_value(&value.deployment)),
            has_stored_key: stored_key.is_some(),
        })
    }

    fn secure_config(&self) -> Result<Option<SecureAzureConfig>, AzureConnectionError> {
        let Some(metadata) = self
            .metadata
            .load()
            .map_err(|_| AzureConnectionError::metadata_read())?
        else {
            return Ok(None);
        };
        let Some(api_key) = self
            .secrets
            .get()
            .map_err(|_| AzureConnectionError::storage_read())?
        else {
            return Ok(None);
        };
        Ok(Some(SecureAzureConfig {
            base_url: responses_url(&metadata.endpoint),
            deployment: metadata.deployment,
            model_identity: metadata.model_identity,
            api_key,
        }))
    }

    async fn save(
        &self,
        input: SaveAzureConnection,
    ) -> Result<AzureConnectionStatus, AzureConnectionError> {
        let metadata = validate_metadata(&input.endpoint, &input.deployment)?;
        self.metadata
            .load()
            .map_err(|_| AzureConnectionError::metadata_read())?;
        let prior_secret = self
            .secrets
            .get()
            .map_err(|_| AzureConnectionError::storage_read())?;
        let replacement_key = validate_optional_key(input.api_key.as_deref())?;
        let api_key = replacement_key
            .as_deref()
            .or(prior_secret.as_deref())
            .ok_or_else(|| {
                AzureConnectionError::field(
                    AzureErrorField::ApiKey,
                    "api_key_required",
                    "An Azure OpenAI API key is required.",
                )
            })?;

        let candidate = SecureAzureConfig {
            base_url: responses_url(&metadata.endpoint),
            deployment: metadata.deployment.clone(),
            model_identity: metadata.model_identity.clone(),
            api_key: api_key.to_owned(),
        };
        self.validator.validate(&candidate).await?;

        if let Some(ref key) = replacement_key {
            self.secrets.set(key).map_err(|_| AzureConnectionError::general(
                "secure_storage_save_failed",
                "The API key could not be saved in the operating-system credential vault. The previous connection is still active.",
            ))?;
        }

        if self.metadata.write(&metadata).is_err() {
            if replacement_key.is_some()
                && restore_secret(&self.secrets, prior_secret.as_deref()).is_err()
            {
                return Err(AzureConnectionError::general(
                    "connection_rollback_failed",
                    "The connection metadata could not be saved, and the previous credential could not be restored. Reconnect Azure before using it.",
                ));
            }
            return Err(AzureConnectionError::metadata_write());
        }

        Ok(status_for(
            AzureConnectionSource::Secure,
            &metadata.endpoint,
            &metadata.deployment,
            true,
            true,
        ))
    }

    fn remove(&self) -> Result<(), AzureConnectionError> {
        let prior_metadata = self
            .metadata
            .load()
            .map_err(|_| AzureConnectionError::metadata_read())?;
        self.metadata.remove().map_err(|_| {
            AzureConnectionError::general(
                "metadata_remove_failed",
                "The Azure connection could not be removed. The existing connection is still active.",
            )
        })?;

        if self.secrets.delete().is_err() {
            if let Some(metadata) = prior_metadata {
                if self.metadata.write(&metadata).is_err() {
                    return Err(AzureConnectionError::general(
                        "connection_remove_recovery_failed",
                        "The credential vault rejected removal, and the connection metadata could not be restored. Reconnect Azure before using it.",
                    ));
                }
            }
            return Err(AzureConnectionError::general(
                "secure_storage_remove_failed",
                "The operating-system credential vault rejected removal. The Azure connection remains active.",
            ));
        }
        Ok(())
    }
}

type ProductionAzureConnectionManager =
    AzureConnectionManager<KeyringSecretStore, FileMetadataStore, ReqwestRemoteValidator>;

fn production_manager() -> Result<ProductionAzureConnectionManager, AzureConnectionError> {
    Ok(AzureConnectionManager::new(
        KeyringSecretStore,
        FileMetadataStore::new(FileMetadataStore::default_path()),
        ReqwestRemoteValidator::new()?,
    ))
}

pub(crate) fn secure_config() -> Result<Option<SecureAzureConfig>, AzureConnectionError> {
    production_manager()?.secure_config()
}

fn status_after_secure_removal(environment: &AzureEnvironment) -> AzureConnectionStatus {
    if let Some(config) = resolve_environment(environment) {
        return status_for(
            AzureConnectionSource::Environment,
            &config.base_url,
            &config.deployment,
            false,
            false,
        );
    }
    AzureConnectionStatus {
        configured: false,
        source: AzureConnectionSource::None,
        endpoint: None,
        deployment: None,
        endpoint_summary: None,
        deployment_summary: None,
        has_stored_key: false,
    }
}

fn restore_secret<S: SecretStore>(
    store: &S,
    previous: Option<&str>,
) -> Result<(), SecretStoreError> {
    match previous {
        Some(value) => store.set(value),
        None => store.delete(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::sync::{Arc, Mutex};
    use storage::AzureMetadata;
    use validation::ValidationFuture;

    fn canary() -> String {
        std::env::var("GG_AZURE_TEST_CANARY").unwrap_or_else(|_| {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            format!("azure-manager-test-key-{}-{nonce}", std::process::id())
        })
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    #[derive(Clone, Default)]
    struct MockSecretStore {
        value: Arc<Mutex<Option<String>>>,
        fail_delete: Arc<Mutex<bool>>,
    }

    impl MockSecretStore {
        fn with(value: Option<&str>) -> Self {
            Self {
                value: Arc::new(Mutex::new(value.map(str::to_owned))),
                fail_delete: Arc::new(Mutex::new(false)),
            }
        }
    }

    impl SecretStore for MockSecretStore {
        fn get(&self) -> Result<Option<String>, SecretStoreError> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn set(&self, value: &str) -> Result<(), SecretStoreError> {
            *self.value.lock().unwrap() = Some(value.to_owned());
            Ok(())
        }

        fn delete(&self) -> Result<(), SecretStoreError> {
            if *self.fail_delete.lock().unwrap() {
                return Err(SecretStoreError::Unavailable);
            }
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct MockMetadataStore {
        value: Arc<Mutex<Option<AzureMetadata>>>,
        serialized: Arc<Mutex<Vec<String>>>,
        fail_write: Arc<Mutex<bool>>,
    }

    impl MockMetadataStore {
        fn with(value: Option<AzureMetadata>) -> Self {
            Self {
                value: Arc::new(Mutex::new(value)),
                serialized: Arc::new(Mutex::new(Vec::new())),
                fail_write: Arc::new(Mutex::new(false)),
            }
        }
    }

    impl MetadataStore for MockMetadataStore {
        fn load(&self) -> Result<Option<AzureMetadata>, storage::MetadataStoreError> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn write(&self, metadata: &AzureMetadata) -> Result<(), storage::MetadataStoreError> {
            if *self.fail_write.lock().unwrap() {
                return Err(storage::MetadataStoreError::Unavailable);
            }
            self.serialized
                .lock()
                .unwrap()
                .push(serde_json::to_string(metadata).unwrap());
            *self.value.lock().unwrap() = Some(metadata.clone());
            Ok(())
        }

        fn remove(&self) -> Result<(), storage::MetadataStoreError> {
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    struct AcceptValidator;

    impl RemoteValidator for AcceptValidator {
        fn validate<'a>(&'a self, _config: &'a SecureAzureConfig) -> ValidationFuture<'a> {
            Box::pin(async { Ok(()) })
        }
    }

    fn metadata(endpoint: &str, deployment: &str) -> AzureMetadata {
        AzureMetadata {
            endpoint: endpoint.to_owned(),
            deployment: deployment.to_owned(),
            model_identity: Some("gpt-5.6-sol".to_owned()),
        }
    }

    fn input(key: Option<&str>) -> SaveAzureConnection {
        SaveAzureConnection {
            endpoint: "https://secure.openai.azure.com".into(),
            deployment: "gpt-secure".into(),
            api_key: key.map(str::to_owned),
        }
    }

    #[test]
    fn secure_connection_precedes_environment_and_ipc_is_redacted() {
        let canary = canary();
        let manager = AzureConnectionManager::new(
            MockSecretStore::with(Some(&canary)),
            MockMetadataStore::with(Some(metadata(
                "https://secure.openai.azure.com",
                "gpt-secure",
            ))),
            AcceptValidator,
        );
        let environment = AzureEnvironment {
            api_key: Some("environment-secret".into()),
            base_url: Some("https://env.openai.azure.com/openai/v1/responses".into()),
            deployment: Some("gpt-env".into()),
            model_identity: None,
        };
        let status = manager.status(&environment).unwrap();
        let ipc = serde_json::to_string(&status).unwrap();
        assert_eq!(status.source, AzureConnectionSource::Secure);
        assert!(!ipc.contains(&canary));
        assert!(!ipc.contains("environment-secret"));
    }

    #[test]
    fn partial_secure_state_uses_complete_environment_without_combining_values() {
        let manager = AzureConnectionManager::new(
            MockSecretStore::default(),
            MockMetadataStore::with(Some(metadata(
                "https://partial.openai.azure.com",
                "gpt-partial",
            ))),
            AcceptValidator,
        );
        let environment = AzureEnvironment {
            api_key: Some("environment-secret".into()),
            base_url: Some("https://env.openai.azure.com/openai/v1/responses".into()),
            deployment: Some("gpt-env".into()),
            model_identity: None,
        };
        let status = manager.status(&environment).unwrap();
        assert_eq!(status.source, AzureConnectionSource::Environment);
        assert_eq!(status.deployment, None);
        assert_eq!(status.deployment_summary.as_deref(), Some("g•••••v"));
    }

    #[test]
    fn save_serializes_only_metadata_and_blank_key_preserves_secret() {
        let canary = canary();
        let secrets = MockSecretStore::with(Some(&canary));
        let metadata = MockMetadataStore::default();
        let manager =
            AzureConnectionManager::new(secrets.clone(), metadata.clone(), AcceptValidator);
        let status = block_on(manager.save(input(Some("   ")))).unwrap();
        assert!(
            secrets.get().unwrap().as_deref() == Some(canary.as_str()),
            "stored secret did not match"
        );
        let serialized = metadata.serialized.lock().unwrap();
        assert_eq!(serialized.len(), 1);
        assert!(serialized[0].contains("\"modelIdentity\":\"gpt-5.6-sol\""));
        assert!(!serialized[0].contains(&canary));
        assert!(!serde_json::to_string(&status).unwrap().contains(&canary));
    }

    #[test]
    fn metadata_failure_rolls_back_replaced_secret() {
        let canary = canary();
        let secrets = MockSecretStore::with(Some("previous-secret"));
        let metadata = MockMetadataStore::with(Some(metadata(
            "https://old.openai.azure.com",
            "old-deployment",
        )));
        *metadata.fail_write.lock().unwrap() = true;
        let manager =
            AzureConnectionManager::new(secrets.clone(), metadata.clone(), AcceptValidator);
        let error = block_on(manager.save(input(Some(&canary)))).unwrap_err();
        assert_eq!(error.code, "metadata_save_failed");
        assert_eq!(secrets.get().unwrap().as_deref(), Some("previous-secret"));
        assert_eq!(
            metadata.load().unwrap().unwrap().deployment,
            "old-deployment"
        );
        assert!(!serde_json::to_string(&error).unwrap().contains(&canary));
    }

    #[test]
    fn failed_vault_delete_restores_metadata() {
        let canary = canary();
        let secrets = MockSecretStore::with(Some(&canary));
        *secrets.fail_delete.lock().unwrap() = true;
        let saved = metadata("https://old.openai.azure.com", "old-deployment");
        let metadata = MockMetadataStore::with(Some(saved.clone()));
        let manager = AzureConnectionManager::new(secrets, metadata.clone(), AcceptValidator);
        let error = manager.remove().unwrap_err();
        assert_eq!(error.code, "secure_storage_remove_failed");
        assert_eq!(metadata.load().unwrap(), Some(saved));
        assert!(!serde_json::to_string(&error).unwrap().contains(&canary));
    }

    #[test]
    fn successful_removal_status_uses_environment_without_secure_store_reads() {
        let canary = canary();
        let environment = AzureEnvironment {
            api_key: Some(canary.clone()),
            base_url: Some("https://environment.openai.azure.com/openai/v1/responses".into()),
            deployment: Some("environment-deployment".into()),
            model_identity: None,
        };

        let status = status_after_secure_removal(&environment);

        assert_eq!(status.source, AzureConnectionSource::Environment);
        assert_eq!(status.endpoint, None);
        let deployment_summary = status.deployment_summary.as_deref().unwrap();
        assert!(deployment_summary.starts_with('e'));
        assert!(deployment_summary.ends_with('t'));
        assert!(!deployment_summary.contains("environment-deployment"));
        assert!(!status.has_stored_key);
    }
}

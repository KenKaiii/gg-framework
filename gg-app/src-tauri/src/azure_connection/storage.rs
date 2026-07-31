use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "com.ggcoder.app.azure-openai";
const KEYRING_ACCOUNT: &str = "api-key";
const METADATA_FILE: &str = "gg-app-azure.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct AzureMetadata {
    pub(super) endpoint: String,
    pub(super) deployment: String,
    #[serde(default)]
    pub(super) model_identity: Option<String>,
}

#[derive(Debug)]
pub(super) enum SecretStoreError {
    Unavailable,
}

pub(super) trait SecretStore {
    fn get(&self) -> Result<Option<String>, SecretStoreError>;
    fn set(&self, value: &str) -> Result<(), SecretStoreError>;
    fn delete(&self) -> Result<(), SecretStoreError>;
}

#[derive(Default)]
pub(super) struct KeyringSecretStore;

impl KeyringSecretStore {
    fn entry(&self) -> Result<keyring::v1::Entry, SecretStoreError> {
        keyring::v1::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|_| SecretStoreError::Unavailable)
    }
}

impl SecretStore for KeyringSecretStore {
    fn get(&self) -> Result<Option<String>, SecretStoreError> {
        match self.entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::v1::Error::NoEntry) => Ok(None),
            Err(_) => Err(SecretStoreError::Unavailable),
        }
    }

    fn set(&self, value: &str) -> Result<(), SecretStoreError> {
        self.entry()?
            .set_password(value)
            .map_err(|_| SecretStoreError::Unavailable)
    }

    fn delete(&self) -> Result<(), SecretStoreError> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
            Err(_) => Err(SecretStoreError::Unavailable),
        }
    }
}

#[derive(Debug)]
pub(super) enum MetadataStoreError {
    Unavailable,
    Invalid,
}

pub(super) trait MetadataStore {
    fn load(&self) -> Result<Option<AzureMetadata>, MetadataStoreError>;
    fn write(&self, metadata: &AzureMetadata) -> Result<(), MetadataStoreError>;
    fn remove(&self) -> Result<(), MetadataStoreError>;
}

pub(super) struct FileMetadataStore {
    path: PathBuf,
}

impl FileMetadataStore {
    pub(super) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub(super) fn default_path() -> PathBuf {
        home_dir().join(".gg").join(METADATA_FILE)
    }
}

impl MetadataStore for FileMetadataStore {
    fn load(&self) -> Result<Option<AzureMetadata>, MetadataStoreError> {
        let contents = match std::fs::read_to_string(&self.path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(MetadataStoreError::Unavailable),
        };
        serde_json::from_str(&contents)
            .map(Some)
            .map_err(|_| MetadataStoreError::Invalid)
    }

    fn write(&self, metadata: &AzureMetadata) -> Result<(), MetadataStoreError> {
        let parent = self.path.parent().ok_or(MetadataStoreError::Unavailable)?;
        std::fs::create_dir_all(parent).map_err(|_| MetadataStoreError::Unavailable)?;
        let serialized =
            serde_json::to_vec_pretty(metadata).map_err(|_| MetadataStoreError::Invalid)?;
        // atomic-write-file creates its temporary file beside the destination.
        // On Windows that preserves the containing ~/.gg directory's inherited ACL;
        // on Unix we override the mode below so replacement never preserves 0644.
        #[allow(unused_mut)] // Mutated only on Unix to enforce private permissions.
        let mut options = atomic_write_file::OpenOptions::new();
        #[cfg(unix)]
        {
            use atomic_write_file::unix::OpenOptionsExt as AtomicOpenOptionsExt;
            use std::os::unix::fs::OpenOptionsExt as StdOpenOptionsExt;
            options.preserve_mode(false).mode(0o600);
        }
        let mut file = options
            .open(&self.path)
            .map_err(|_| MetadataStoreError::Unavailable)?;
        file.write_all(&serialized)
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|_| MetadataStoreError::Unavailable)?;
        file.commit().map_err(|_| MetadataStoreError::Unavailable)
    }

    fn remove(&self) -> Result<(), MetadataStoreError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(MetadataStoreError::Unavailable),
        }
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn metadata(endpoint: &str, deployment: &str) -> AzureMetadata {
        AzureMetadata {
            endpoint: endpoint.to_owned(),
            deployment: deployment.to_owned(),
            model_identity: Some("gpt-5.6-sol".to_owned()),
        }
    }

    #[test]
    fn legacy_metadata_without_model_identity_remains_conservative() {
        let metadata: AzureMetadata = serde_json::from_str(
            r#"{"endpoint":"https://legacy.openai.azure.com","deployment":"customer-chat"}"#,
        )
        .unwrap();
        assert_eq!(metadata.model_identity, None);
    }

    #[test]
    fn file_store_atomically_overwrites_non_secret_metadata() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "gg-app-azure-storage-{}-{nonce}",
            std::process::id()
        ));
        let path = root.join(METADATA_FILE);
        let store = FileMetadataStore::new(path.clone());
        store
            .write(&metadata("https://one.openai.azure.com", "first"))
            .unwrap();
        store
            .write(&metadata("https://two.openai.azure.com", "second"))
            .unwrap();
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("second"));
        assert!(!contents.contains("first"));
        assert!(contents.contains("\"modelIdentity\": \"gpt-5.6-sol\""));
        assert!(!contents.contains("apiKey"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_path_is_dedicated_and_parent_is_required() {
        let path = FileMetadataStore::default_path();
        assert_eq!(
            path.file_name().and_then(|name| name.to_str()),
            Some(METADATA_FILE)
        );
        assert_ne!(
            path.file_name().and_then(|name| name.to_str()),
            Some("auth.json")
        );
        assert_ne!(
            path.file_name().and_then(|name| name.to_str()),
            Some("gg-app.json")
        );

        let invalid = FileMetadataStore::new(Path::new("").to_path_buf());
        assert!(invalid
            .write(&metadata("https://x.openai.azure.com", "x"))
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn metadata_write_replaces_permissive_mode_with_private_mode() {
        use std::os::unix::fs::PermissionsExt;

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "gg-app-azure-private-mode-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join(METADATA_FILE);
        std::fs::write(&path, b"legacy metadata").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        FileMetadataStore::new(path.clone())
            .write(&metadata("https://private.openai.azure.com", "private"))
            .unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        std::fs::remove_dir_all(root).unwrap();
    }
}

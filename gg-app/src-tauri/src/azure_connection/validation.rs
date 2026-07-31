use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use super::storage::AzureMetadata;
use super::{
    AzureConnectionError, AzureConnectionSource, AzureConnectionStatus, AzureEnvironment,
    AzureErrorField, SecureAzureConfig,
};

const MAX_ENDPOINT_LENGTH: usize = 2_048;
const MAX_DEPLOYMENT_LENGTH: usize = 256;
const MAX_API_KEY_LENGTH: usize = 8_192;
const AZURE_SETUP_MODEL_ID: &str = "gpt-5.6-sol";
const AZURE_HOST_SUFFIXES: [&str; 2] = [".openai.azure.com", ".cognitiveservices.azure.com"];
const VALIDATION_OUTPUT_TOKENS: u8 = 16;
const VALIDATION_TIMEOUT: Duration = Duration::from_secs(12);

pub(super) type ValidationFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), AzureConnectionError>> + Send + 'a>>;

pub(super) trait RemoteValidator {
    fn validate<'a>(&'a self, config: &'a SecureAzureConfig) -> ValidationFuture<'a>;
}

pub(super) struct ReqwestRemoteValidator {
    client: reqwest::Client,
}

impl ReqwestRemoteValidator {
    pub(super) fn new() -> Result<Self, AzureConnectionError> {
        let client = reqwest::Client::builder()
            .timeout(VALIDATION_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| {
                AzureConnectionError::general(
                    "validation_unavailable",
                    "Azure validation could not start. Check your network settings and try again.",
                )
            })?;
        Ok(Self { client })
    }
}

impl RemoteValidator for ReqwestRemoteValidator {
    fn validate<'a>(&'a self, config: &'a SecureAzureConfig) -> ValidationFuture<'a> {
        Box::pin(async move {
            let api_key = sensitive_api_key_header(&config.api_key)?;
            let response = self
                .client
                .post(&config.base_url)
                .header("api-key", api_key)
                .json(&serde_json::json!({
                    "model": config.deployment,
                    "input": "Reply with OK.",
                    "max_output_tokens": VALIDATION_OUTPUT_TOKENS,
                    "stream": false
                }))
                .send()
                .await
                .map_err(map_network_error)?;

            match response.status().as_u16() {
                200..=299 => Ok(()),
                401 => Err(AzureConnectionError::field(
                    AzureErrorField::ApiKey,
                    "invalid_api_key",
                    "Azure rejected this API key. Check the key and try again.",
                )),
                403 => Err(AzureConnectionError::general(
                    "access_forbidden",
                    "This key cannot access the Azure deployment. Check its role and resource access.",
                )),
                404 => Err(AzureConnectionError::general(
                    "deployment_not_found",
                    "Azure could not find this resource endpoint or deployment. Check both values.",
                )),
                429 => Err(AzureConnectionError::general(
                    "throttled",
                    "Azure is throttling requests. Wait a moment, then validate again.",
                )),
                500..=599 => Err(AzureConnectionError::general(
                    "azure_unavailable",
                    "Azure is temporarily unavailable. Try again shortly.",
                )),
                _ => Err(AzureConnectionError::general(
                    "validation_failed",
                    "Azure could not validate this connection. Check the details and try again.",
                )),
            }
        })
    }
}

fn sensitive_api_key_header(
    value: &str,
) -> Result<reqwest::header::HeaderValue, AzureConnectionError> {
    let mut header = reqwest::header::HeaderValue::from_str(value).map_err(|_| {
        AzureConnectionError::field(
            AzureErrorField::ApiKey,
            "invalid_api_key",
            "Enter a valid Azure OpenAI API key.",
        )
    })?;
    header.set_sensitive(true);
    Ok(header)
}

fn map_network_error(error: reqwest::Error) -> AzureConnectionError {
    if error.is_timeout() {
        AzureConnectionError::general(
            "validation_timeout",
            "Azure validation timed out. Check the endpoint and network, then try again.",
        )
    } else {
        AzureConnectionError::general(
            "validation_network_error",
            "Azure validation could not reach the endpoint. Check DNS, TLS, and network access.",
        )
    }
}

pub(super) fn validate_metadata(
    endpoint: &str,
    deployment: &str,
) -> Result<AzureMetadata, AzureConnectionError> {
    Ok(AzureMetadata {
        endpoint: normalize_resource_endpoint(endpoint)?,
        deployment: normalize_deployment(deployment)?,
        model_identity: Some(AZURE_SETUP_MODEL_ID.to_owned()),
    })
}

fn normalize_resource_endpoint(value: &str) -> Result<String, AzureConnectionError> {
    let value = value.trim();
    let invalid = || {
        AzureConnectionError::field(
            AzureErrorField::Endpoint,
            "invalid_endpoint",
            "Enter an HTTPS Azure resource endpoint like https://resource.openai.azure.com.",
        )
    };
    if value.is_empty() || value.len() > MAX_ENDPOINT_LENGTH || value.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| invalid())?;
    let host = parsed.host_str().ok_or_else(invalid)?;
    let resource = AZURE_HOST_SUFFIXES
        .iter()
        .find_map(|suffix| host.strip_suffix(suffix))
        .ok_or_else(invalid)?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.port().is_some()
        || (parsed.path() != "/" && !parsed.path().is_empty())
        || resource.is_empty()
        || resource.contains('.')
    {
        return Err(invalid());
    }
    Ok(format!("https://{host}"))
}

fn normalize_deployment(value: &str) -> Result<String, AzureConnectionError> {
    let deployment = value.trim();
    if deployment.is_empty()
        || deployment.len() > MAX_DEPLOYMENT_LENGTH
        || deployment.chars().any(char::is_control)
    {
        return Err(AzureConnectionError::field(
            AzureErrorField::Deployment,
            "invalid_deployment",
            "Enter an Azure deployment name containing 1 to 256 characters.",
        ));
    }
    Ok(deployment.to_owned())
}

pub(super) fn validate_optional_key(
    value: Option<&str>,
) -> Result<Option<String>, AzureConnectionError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > MAX_API_KEY_LENGTH || value.chars().any(char::is_control) {
        return Err(AzureConnectionError::field(
            AzureErrorField::ApiKey,
            "invalid_api_key",
            "Enter a valid Azure OpenAI API key.",
        ));
    }
    Ok(Some(value.to_owned()))
}

pub(super) fn responses_url(endpoint: &str) -> String {
    format!("{endpoint}/openai/v1/responses")
}

pub(super) fn resolve_environment(environment: &AzureEnvironment) -> Option<SecureAzureConfig> {
    let api_key = environment.api_key.as_deref()?.trim();
    let base_url = environment.base_url.as_deref()?.trim();
    let deployment = environment.deployment.as_deref()?.trim();
    if api_key.is_empty()
        || deployment.is_empty()
        || !is_strict_responses_url(base_url)
        || deployment.len() > MAX_DEPLOYMENT_LENGTH
        || deployment.chars().any(char::is_control)
    {
        return None;
    }
    let model_identity = environment
        .model_identity
        .as_deref()
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= MAX_DEPLOYMENT_LENGTH
                && !value.chars().any(char::is_control)
        })
        .map(str::to_owned);
    Some(SecureAzureConfig {
        api_key: api_key.to_owned(),
        base_url: base_url.to_owned(),
        deployment: deployment.to_owned(),
        model_identity,
    })
}

fn is_strict_responses_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.path().ends_with("/responses")
}

pub(super) fn status_for(
    source: AzureConnectionSource,
    endpoint: &str,
    deployment: &str,
    editable: bool,
    has_stored_key: bool,
) -> AzureConnectionStatus {
    AzureConnectionStatus {
        configured: true,
        source,
        endpoint: editable.then(|| endpoint.to_owned()),
        deployment: editable.then(|| deployment.to_owned()),
        endpoint_summary: Some(mask_endpoint(endpoint)),
        deployment_summary: Some(mask_value(deployment)),
        has_stored_key,
    }
}

pub(super) fn mask_endpoint(value: &str) -> String {
    let host = reqwest::Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_else(|| value.to_owned());
    let resource = host.split('.').next().unwrap_or(&host);
    format!("{}…azure.com", mask_value(resource))
}

pub(super) fn mask_value(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    match chars.len() {
        0 => String::new(),
        1..=4 => "•".repeat(chars.len()),
        _ => format!(
            "{}{}{}",
            chars[0],
            "•".repeat(chars.len() - 2),
            chars[chars.len() - 1]
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    fn canary() -> String {
        std::env::var("GG_AZURE_TEST_CANARY").unwrap_or_else(|_| {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            format!("azure-validation-test-key-{}-{nonce}", std::process::id())
        })
    }

    fn block_on<F: Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn accepts_official_resource_origins_and_builds_responses_urls() {
        for (endpoint, normalized) in [
            (
                " HTTPS://My-Resource.OPENAI.AZURE.COM/ ",
                "https://my-resource.openai.azure.com",
            ),
            (
                "https://example-francecentral.cognitiveservices.azure.com",
                "https://example-francecentral.cognitiveservices.azure.com",
            ),
            (
                "https://my-resource.openai.azure.com:443",
                "https://my-resource.openai.azure.com",
            ),
        ] {
            let origin = normalize_resource_endpoint(endpoint).unwrap();
            assert_eq!(origin, normalized);
            assert_eq!(
                responses_url(&origin),
                format!("{normalized}/openai/v1/responses")
            );
        }
    }

    #[test]
    fn rejects_non_resource_origins() {
        for malformed in [
            "http://resource.openai.azure.com",
            "https://user:password@resource.openai.azure.com",
            "https://resource.openai.azure.com/openai/v1/responses",
            "https://resource.openai.azure.com?api-version=preview",
            "https://resource.openai.azure.com#fragment",
            "https://resource.openai.azure.com:8443",
            "https://nested.resource.openai.azure.com",
            "https://nested.resource.cognitiveservices.azure.com",
            "https://example.com",
            "https://resource.openai.azure.com.example.com",
            "https://resource.cognitiveservices.azure.com.example.com",
            "https://127.0.0.1",
            "https://localhost",
            "https://resource.openai.azure.com/\nheader",
        ] {
            let error = normalize_resource_endpoint(malformed).unwrap_err();
            assert_eq!(error.field, Some(AzureErrorField::Endpoint), "{malformed}");
        }
    }

    #[test]
    fn validation_errors_and_sensitive_header_are_redacted() {
        let canary = canary();
        let header = sensitive_api_key_header(&canary).unwrap();
        assert!(!format!("{header:?}").contains(&canary));
        let key_value = format!("{canary}\ninvalid");
        let error = validate_optional_key(Some(&key_value)).unwrap_err();
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(!serialized.contains(&canary));
    }

    #[test]
    fn resolves_only_complete_environment_fallback() {
        let canary = canary();
        let complete = AzureEnvironment {
            api_key: Some(canary.clone()),
            base_url: Some(
                "https://example.openai.azure.com/openai/v1/responses?api-version=preview".into(),
            ),
            deployment: Some("gpt-env".into()),
            model_identity: Some("gpt-5.6-sol".into()),
        };
        assert!(
            resolve_environment(&complete).unwrap().api_key == canary,
            "resolved environment key did not match"
        );
        let mut partial = complete.clone();
        partial.deployment = None;
        assert!(resolve_environment(&partial).is_none());
        partial = complete;
        partial.base_url = Some("https://example.openai.azure.com/openai/v1".into());
        assert!(resolve_environment(&partial).is_none());
    }

    fn read_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = vec![0_u8; 16_384];
        let count = stream.read(&mut bytes).unwrap();
        String::from_utf8_lossy(&bytes[..count]).into_owned()
    }

    fn send_response(mut stream: TcpStream, status: &str, headers: &[(&str, String)]) -> String {
        let request = read_request(&mut stream);
        let mut response =
            format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n");
        for (name, value) in headers {
            response.push_str(&format!("{name}: {value}\r\n"));
        }
        response.push_str("\r\n");
        stream.write_all(response.as_bytes()).unwrap();
        request
    }

    #[test]
    fn remote_validation_uses_supported_token_budget_and_disables_redirects() {
        let canary = canary();
        let redirect_target = TcpListener::bind("127.0.0.1:0").unwrap();
        redirect_target.set_nonblocking(true).unwrap();
        let target_url = format!("http://{}/stolen", redirect_target.local_addr().unwrap());
        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_url = format!("http://{}/responses", source.local_addr().unwrap());
        let source_thread = thread::spawn(move || {
            let (stream, _) = source.accept().unwrap();
            send_response(stream, "302 Found", &[("Location", target_url)])
        });
        let validator = ReqwestRemoteValidator::new().unwrap();
        let config = SecureAzureConfig {
            base_url: source_url,
            deployment: "gpt-test".into(),
            model_identity: None,
            api_key: canary.clone(),
        };
        let error = block_on(validator.validate(&config)).unwrap_err();
        let request = source_thread.join().unwrap();
        assert!(request.contains(&canary));
        assert!(request.contains("\"max_output_tokens\":16"));
        assert_eq!(error.code, "validation_failed");
        thread::sleep(Duration::from_millis(100));
        assert!(redirect_target.accept().is_err());
        assert!(!serde_json::to_string(&error).unwrap().contains(&canary));
    }

    #[test]
    fn provider_body_never_enters_validation_error() {
        let canary = canary();
        let server_canary = canary.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/responses", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            let body = format!("raw provider body containing {server_canary}");
            let response = format!(
                "HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let validator = ReqwestRemoteValidator::new().unwrap();
        let config = SecureAzureConfig {
            base_url: url,
            deployment: "gpt-test".into(),
            model_identity: None,
            api_key: canary.clone(),
        };
        let error = block_on(validator.validate(&config)).unwrap_err();
        server.join().unwrap();
        let serialized = serde_json::to_string(&error).unwrap();
        assert_eq!(error.code, "invalid_api_key");
        assert!(!serialized.contains(&canary));
        assert!(!serialized.contains("raw provider body"));
    }
}

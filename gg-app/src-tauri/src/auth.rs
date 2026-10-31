//! Native provider auth status and API-key writes (~/.gg/auth.json).

use crate::*;

// ── Native provider auth status (~/.gg/auth.json) ─────────────────────────
// The AI-providers list is STATIC metadata and the "connected" badge only needs
// to read which provider keys exist in ~/.gg/auth.json — neither needs the Node
// agent. Reading it natively means the login hub always renders even when the
// sidecar is slow/crashed (it used to show a blank list, identical in spirit to
// the project-folder bug). The login ACTIONS (OAuth flow, key storage, logout)
// still go through the sidecar — those genuinely need the agent.
//
// This list mirrors packages/ggcoder/src/core/auth-providers.ts (AUTH_PROVIDERS).
// Keep the two in sync when adding a provider.

/// Absolute path to ~/.gg/auth.json.
pub(crate) fn auth_file_path() -> PathBuf {
    home_dir().join(".gg").join("auth.json")
}

/// One API-key option for a provider that splits auth across multiple
/// distinct endpoints/credentials (currently only Xiaomi: Token Plan vs.
/// API Credits). Mirrors `ApiKeyVariant` in
/// packages/ggcoder/src/core/auth-providers.ts.
#[derive(PartialEq, Debug)]
pub(crate) struct ApiKeyVariant {
    /// Storage key in auth.json (distinct from the provider `value`).
    pub(crate) key: &'static str,
    /// Display label, e.g. "Token Plan" or "API Credits".
    pub(crate) label: &'static str,
    /// Base URL stored alongside this variant's credential.
    pub(crate) base_url: Option<&'static str>,
}

/// Guidance for one auth method — what it bills against and when to pick it.
/// Only providers offering a real choice (the dual-auth ones) carry these.
/// Mirrors `AuthMethodMeta` in packages/ggcoder/src/core/auth-providers.ts.
pub(crate) struct MethodDetail {
    /// "oauth" or "apikey".
    pub(crate) method: &'static str,
    /// Button/row label, e.g. "Sign in with Grok".
    pub(crate) label: &'static str,
    /// What the user spends on this method.
    pub(crate) billing: &'static str,
    /// When to choose it.
    pub(crate) when: &'static str,
    /// Prerequisite the user must already have, if any.
    pub(crate) requires: Option<&'static str>,
}

/// Static metadata for one AI provider in the login hub. Mirrors
/// packages/ggcoder/src/core/auth-providers.ts (AUTH_PROVIDERS) — keep in sync.
pub(crate) struct ProviderMeta {
    /// Storage key in auth.json + the value the webview passes back.
    pub(crate) value: &'static str,
    pub(crate) label: &'static str,
    pub(crate) description: &'static str,
    /// Supported auth methods, e.g. `["oauth"]`, `["apikey"]`, or both.
    pub(crate) methods: &'static [&'static str],
    /// Distinct auth.json key holding subscription OAuth credentials, for the
    /// providers that can hold OAuth *and* an API key at once. Mirrors gg-core's
    /// DUAL_AUTH_PROVIDERS — OAuth-only providers store under `value` itself and
    /// leave this `None`.
    pub(crate) oauth_key: Option<&'static str>,
    /// Display name of the OAuth credential ("Grok OAuth"), for the
    /// priority note. Only meaningful alongside `oauth_key`.
    pub(crate) oauth_label: Option<&'static str>,
    /// Per-method guidance; empty when the provider offers no choice.
    pub(crate) method_details: &'static [MethodDetail],
    pub(crate) api_key_label: Option<&'static str>,
    /// Custom API base URL stored alongside an API-key credential. Used as the
    /// default when `api_key_variants` is empty.
    pub(crate) api_key_base_url: Option<&'static str>,
    /// When a provider's API-key auth splits across multiple endpoints, the
    /// choices to present (first = default). Empty for every single-credential
    /// provider.
    pub(crate) api_key_variants: &'static [ApiKeyVariant],
}

/// The provider catalog (single source of truth for app_auth_status +
/// app_auth_apikey). Order is the display order in the login hub.
/// Providers left out of the app's provider list (and so its login and
/// settings screens). Their rows stay below so logout and stored keys still
/// resolve. Mirrors gg-core's `HIDDEN_PROVIDERS` (hidden-providers.ts) — keep
/// in sync. Gemini: Google no longer serves personal accounts over sign-in.
pub(crate) const HIDDEN_PROVIDERS: &[&str] = &["gemini"];

/// Providers whose API-key form offers an optional base-URL override. The
/// webview reads this as `allowCustomBaseUrl`; without it the login modal has
/// no field to type into, which is exactly how the OpenRouter override shipped
/// invisible. Mirrors gg-core's `AuthProviderMeta.allowCustomBaseUrl` — keep in
/// sync.
pub(crate) const CUSTOM_BASE_URL_PROVIDERS: &[&str] = &["openrouter"];

pub(crate) const AUTH_PROVIDERS: &[ProviderMeta] = &[
    ProviderMeta {
        value: "anthropic",
        label: "Anthropic",
        description: "Claude Fable 5.1, Opus 5.5, Opus 5.5 Fast, Sonnet 5.5, Haiku 5.5",
        methods: &["oauth"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[],
        api_key_label: None,
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "openai",
        label: "OpenAI",
        description:
            "GPT-6 Astra, GPT-6 Astra Fast, GPT-6.1 Sol, GPT-6.1 Sol Fast, GPT-6 Luna, GPT-6 Luna Fast",
        methods: &["oauth"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[],
        api_key_label: None,
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "gemini",
        label: "Gemini",
        description:
            "Gemini 3.8 Flash, 3.5 Flash Lite, 3.1 Flash Lite, 3.5 Flash, 3.1 Pro (Preview)",
        // Google sign-in (Code Assist, stored under `gemini`) or an AI Studio
        // key stored under its own `gemini-api` key — mirrors gg-core's
        // AUTH_PROVIDERS. Not a dual-auth provider: the API key is used first.
        methods: &["oauth", "apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[
            MethodDetail {
                method: "oauth",
                label: "Sign in with Google",
                billing: "Gemini Code Assist Standard or Enterprise licence.",
                when: "Personal Google accounts are no longer served here (Google ended it on June 18, 2026).",
                requires: None,
            },
            MethodDetail {
                method: "apikey",
                label: "Gemini API key",
                billing: "Pay-per-token from a Google AI Studio key.",
                when: "Used first whenever it is set.",
                requires: None,
            },
        ],
        api_key_label: Some("Gemini"),
        api_key_base_url: Some("https://generativelanguage.googleapis.com/v1beta"),
        api_key_variants: &[ApiKeyVariant {
            key: "gemini-api",
            label: "Google AI Studio",
            base_url: Some("https://generativelanguage.googleapis.com/v1beta"),
        }],
    },
    ProviderMeta {
        value: "xai",
        label: "xAI (Grok)",
        description: "Grok 4.7 · OAuth or API key",
        methods: &["oauth", "apikey"],
        oauth_key: Some("xai-oauth"),
        oauth_label: Some("Grok OAuth"),
        method_details: &[
            MethodDetail {
                method: "oauth",
                label: "Sign in with Grok",
                billing: "Included with SuperGrok or X Premium.",
                when: "",
                requires: None,
            },
            MethodDetail {
                method: "apikey",
                label: "xAI API key",
                billing: "Pay-per-token on console.x.ai credits.",
                when: "",
                requires: None,
            },
        ],
        api_key_label: Some("xAI"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "moonshot",
        label: "Moonshot",
        description: "Kimi K3, K2.8 Preview (Kimi sign-in), K2.7 Code · OAuth or API key",
        methods: &["oauth", "apikey"],
        oauth_key: Some("moonshot-oauth"),
        oauth_label: Some("Kimi OAuth"),
        method_details: &[
            MethodDetail {
                method: "oauth",
                label: "Sign in with Kimi",
                billing: "Included with a Kimi For Coding plan.",
                when: "",
                requires: None,
            },
            MethodDetail {
                method: "apikey",
                label: "Moonshot API key",
                billing: "Pay-per-token on Moonshot credits.",
                when: "",
                requires: None,
            },
        ],
        api_key_label: Some("Moonshot"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "glm",
        label: "Z.AI (GLM)",
        description: "GLM-5.3, GLM-5.3-Flash",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[],
        api_key_label: Some("Z.AI"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "minimax",
        label: "MiniMax",
        description: "MiniMax M3",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[],
        api_key_label: Some("MiniMax"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "xiaomi",
        label: "Xiaomi (MiMo)",
        description:
            "MiMo-V2.6-Pro, MiMo-V2.6-Flash, MiMo-V2.6-Pro-UltraSpeed · Token Plan or API Credits",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[],
        api_key_label: Some("Xiaomi MiMo"),
        api_key_base_url: Some("https://token-plan-sgp.xiaomimimo.com/v1"),
        api_key_variants: &[
            ApiKeyVariant {
                key: "xiaomi",
                label: "Token Plan",
                base_url: Some("https://token-plan-sgp.xiaomimimo.com/v1"),
            },
            ApiKeyVariant {
                key: "xiaomi-credits",
                label: "API Credits (required for UltraSpeed)",
                base_url: Some("https://api.xiaomimimo.com/v1"),
            },
        ],
    },
    ProviderMeta {
        value: "deepseek",
        label: "DeepSeek",
        description: "DeepSeek V4 Pro, V4.1 Flash",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[],
        api_key_label: Some("DeepSeek"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "sakana",
        label: "Sakana (Fugu)",
        description: "Fugu, Fugu Max, Fugu Ultra",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[],
        api_key_label: Some("Sakana"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "openrouter",
        label: "OpenRouter",
        description: "Qwen3.8 Max · multi-provider gateway",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[],
        api_key_label: Some("OpenRouter"),
        // Mirrors gg-ai's OPENROUTER_BASE_URL. Stored with the key so the app's
        // optional base-URL override has a default to fall back to, and the
        // login form has a placeholder to show.
        api_key_base_url: Some("https://openrouter.ai/api/v1"),
        api_key_variants: &[],
    },
];

/// Pure: normalize a user-supplied base-URL override. Empty/whitespace input
/// means "use the provider default" and yields `None`. Anything else must be a
/// usable http(s) URL: the refusal keeps a pasted garbage string out of
/// auth.json, where it would silently break every request for that provider.
/// Trailing slashes are stripped so `…/v1/` and `…/v1` behave identically.
pub(crate) fn normalize_base_url(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 2048 {
        return Err("Base URL is too long".to_string());
    }
    let lower = value.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Base URL must start with http:// or https://".to_string());
    }
    Ok(Some(value.trim_end_matches('/').to_string()))
}

/// Pure: resolve `(storage_key, base_url)` for an API-key submission to
/// `provider`, given an optional variant key. Providers with multiple
/// `api_key_variants` (currently only Xiaomi: Token Plan vs. API Credits)
/// select the matching variant, defaulting to the first/primary one when
/// `variant` is absent or unknown. Single-variant providers ignore `variant`
/// and use the flat `api_key_base_url`. Returns `None` if `provider` is
/// unknown or doesn't support API-key auth.
pub(crate) fn resolve_apikey_target(
    provider: &str,
    variant: Option<&str>,
) -> Option<(String, Option<&'static str>)> {
    let meta = AUTH_PROVIDERS
        .iter()
        .find(|p| p.value == provider && p.methods.contains(&"apikey"))?;
    if meta.api_key_variants.is_empty() {
        return Some((meta.value.to_string(), meta.api_key_base_url));
    }
    let chosen = variant
        .and_then(|v| meta.api_key_variants.iter().find(|x| x.key == v))
        .unwrap_or(&meta.api_key_variants[0]);
    Some((chosen.key.to_string(), chosen.base_url))
}

/// Native: provider list + live connection status, read directly from
/// ~/.gg/auth.json. `connected` is true when a credential key is present
/// (a dual-auth provider like Moonshot/xAI is satisfied by either its OAuth key
/// or its API key; a multi-variant provider like Xiaomi is satisfied by ANY of
/// its variant keys — mirrors AuthStorage.hasProviderAuth). Never needs the
/// sidecar.
///
/// Also reports WHICH methods are connected and which one a request would
/// actually use, mirroring AuthStorage's resolution order: subscription OAuth
/// wins, and the API key only takes over while OAuth's usage window is
/// exhausted. A single `connected` bit cannot express "signed in with OAuth,
/// key on file as backup", and the UI needs that to explain itself and to offer
/// a per-method disconnect.
#[tauri::command]
pub(crate) fn app_auth_status() -> serde_json::Value {
    // Parse the auth file into a JSON object; missing/invalid → empty (no creds).
    let creds = std::fs::read_to_string(auth_file_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let has_key = |key: &str| -> bool {
        creds
            .as_ref()
            .and_then(|v| v.get(key))
            .map(|v| !v.is_null())
            .unwrap_or(false)
    };
    // `usageExhaustedUntil` on an OAuth credential: set by the agent loop when the
    // subscription endpoint reported its plan usage was spent (0 when absent).
    let exhausted_until = |key: &str| -> i64 {
        creds
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(|v| v.get("usageExhaustedUntil"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
    };
    // API-key credential present under any of the provider's key(s).
    let has_api_key = |p: &ProviderMeta| -> bool {
        if !p.methods.contains(&"apikey") {
            return false;
        }
        // With variants, the variant keys are the API-key keys: the provider id
        // may hold something else (Gemini keeps its OAuth login there).
        if p.api_key_variants.is_empty() {
            has_key(p.value)
        } else {
            p.api_key_variants.iter().any(|v| has_key(v.key))
        }
    };
    // OAuth credential present. Dual-auth providers keep it under a distinct key;
    // OAuth-only providers store it under the provider id itself.
    let has_oauth = |p: &ProviderMeta| -> bool {
        if !p.methods.contains(&"oauth") {
            return false;
        }
        match p.oauth_key {
            Some(key) => has_key(key),
            None => has_key(p.value),
        }
    };
    let connected = |p: &ProviderMeta| -> bool { has_oauth(p) || has_api_key(p) };

    let now_ms = current_unix_millis();
    let list: Vec<serde_json::Value> = AUTH_PROVIDERS
        .iter()
        .filter(|p| !HIDDEN_PROVIDERS.contains(&p.value))
        .map(|p| {
            let oauth = has_oauth(p);
            let api_key = has_api_key(p);
            let mut connected_methods: Vec<&str> = Vec::new();
            if oauth {
                connected_methods.push("oauth");
            }
            if api_key {
                connected_methods.push("apikey");
            }
            // OAuth is sidelined only while its usage window is spent AND a key
            // exists to cover it — with no key, OAuth stays active so the real
            // usage-limit error surfaces instead of a silent billing switch.
            let sidelined_until = match p.oauth_key {
                Some(key) if oauth && api_key => {
                    let until = exhausted_until(key);
                    if until > now_ms {
                        Some(until)
                    } else {
                        None
                    }
                }
                _ => None,
            };
            // Gemini resolves its API key first (gg-core model registry
            // authStorageKeys); every other provider prefers OAuth.
            let active_method = if p.value == "gemini" && api_key {
                Some("apikey")
            } else if oauth {
                if sidelined_until.is_some() {
                    Some("apikey")
                } else {
                    Some("oauth")
                }
            } else if api_key {
                Some("apikey")
            } else {
                None
            };

            let mut obj = serde_json::json!({
                "value": p.value,
                "label": p.label,
                "description": p.description,
                "methods": p.methods,
                "connected": connected(p),
                "connectedMethods": connected_methods,
            });
            if let Some(m) = active_method {
                obj["activeMethod"] = serde_json::json!(m);
            }
            if let Some(until) = sidelined_until {
                obj["oauthExhaustedUntil"] = serde_json::json!(until);
            }
            if !p.method_details.is_empty() {
                let guidance: Vec<serde_json::Value> = p
                    .method_details
                    .iter()
                    .map(|d| {
                        let mut g = serde_json::json!({
                            "method": d.method,
                            "label": d.label,
                            "billing": d.billing,
                            "when": d.when,
                        });
                        if let Some(r) = d.requires {
                            g["requires"] = serde_json::json!(r);
                        }
                        g
                    })
                    .collect();
                obj["methodGuidance"] = serde_json::json!(guidance);
            }
            // Only a provider with two methods has a priority to explain. Keep the
            // wording in sync with gg-core's DUAL_AUTH_PROVIDERS resolution order
            // (and authPriorityNote, which words Gemini's key-first order).
            if p.value == "gemini" {
                obj["priorityNote"] = serde_json::json!(
                    "Uses the Gemini API key first when one is set; otherwise the Google sign-in."
                );
            } else if let (Some(oauth_label), Some(key_label)) = (p.oauth_label, p.api_key_label) {
                obj["priorityNote"] = serde_json::json!(format!(
                    "Uses {oauth_label} first; the {key_label} API key takes over when it runs out, then switches back."
                ));
            }
            if let Some(l) = p.api_key_label {
                obj["apiKeyLabel"] = serde_json::json!(l);
            }
            if let Some(u) = p.api_key_base_url {
                obj["apiKeyBaseUrl"] = serde_json::json!(u);
            }
            // Gates the login modal's "API base URL (optional)" input.
            if CUSTOM_BASE_URL_PROVIDERS.contains(&p.value) {
                obj["allowCustomBaseUrl"] = serde_json::json!(true);
            }
            // The URL currently in effect, so the form can prefill it and the
            // user can edit it later without re-pasting the key.
            if !p.api_key_variants.is_empty() {
                for variant in p.api_key_variants {
                    if let Some(url) = creds
                        .as_ref()
                        .and_then(|v| v.get(variant.key))
                        .and_then(|c| c.get("baseUrl"))
                        .and_then(|u| u.as_str())
                    {
                        obj["currentBaseUrl"] = serde_json::json!(url);
                        break;
                    }
                }
            } else if let Some(url) = creds
                .as_ref()
                .and_then(|v| v.get(p.value))
                .and_then(|c| c.get("baseUrl"))
                .and_then(|u| u.as_str())
            {
                obj["currentBaseUrl"] = serde_json::json!(url);
            }
            if !p.api_key_variants.is_empty() {
                let variants: Vec<serde_json::Value> = p
                    .api_key_variants
                    .iter()
                    .map(|v| {
                        serde_json::json!({
                            "key": v.key,
                            "label": v.label,
                            "baseUrl": v.base_url,
                        })
                    })
                    .collect();
                obj["apiKeyVariants"] = serde_json::json!(variants);
            }
            obj
        })
        .collect();

    serde_json::json!({ "providers": list })
}

// ── Native API-key auth writes (~/.gg/auth.json) ──────────────────────────
// Storing/removing an API key is a pure mutation of auth.json — the SAME file
// app_auth_status reads. Doing it natively (not via the sidecar) means a fresh
// user can log in even though their not-yet-configured sidecar may not be up:
// the sidecar used to crash on boot when no provider was configured, so a
// sidecar-routed key write would hang forever. Mirrors AuthStorage on the Node
// side (the credential shape + moonshot's dual-key logout).

/// API-key credentials never expire in practice; mirror the sidecar's ~100-year
/// horizon (365d * 100) so refresh logic never treats them as stale.
pub(crate) const API_KEY_TTL_MS: i64 = 365 * 24 * 60 * 60 * 1000 * 100;

/// Pure: build the OAuthCredentials JSON object for an API key (matches
/// AuthStorage's shape: accessToken + empty refreshToken + far-future expiry +
/// optional baseUrl). `now_ms` is injected for testability.
pub(crate) fn apikey_credential_json(
    key: &str,
    base_url: Option<&str>,
    now_ms: i64,
) -> serde_json::Value {
    let mut obj = serde_json::json!({
        "accessToken": key,
        "refreshToken": "",
        "expiresAt": now_ms + API_KEY_TTL_MS,
    });
    if let Some(url) = base_url {
        obj["baseUrl"] = serde_json::json!(url);
    }
    obj
}

/// Pure: upsert an API-key credential into the existing auth.json text
/// (read-modify-write), preserving every other provider's entry. Returns the
/// new pretty-printed JSON. `existing` is the current file contents (None when
/// the file is missing). Errors only on a malformed (non-object) existing file.
pub(crate) fn apply_apikey(
    existing: Option<&str>,
    provider: &str,
    base_url: Option<&str>,
    now_ms: i64,
    key: &str,
) -> Result<String, String> {
    let mut root = parse_auth_object(existing)?;
    if let Some(map) = root.as_object_mut() {
        map.insert(
            provider.to_string(),
            apikey_credential_json(key, base_url, now_ms),
        );
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Pure: remove a provider's credential(s) from the existing auth.json text.
///
/// `method` scopes the removal for dual-auth providers (Moonshot, xAI), which
/// hold two independent credentials: `Some("oauth")` drops only the subscription
/// login, `Some("apikey")` drops only the key(s), and `None` disconnects the
/// provider entirely. Dropping a spent API key must not sign the user out of
/// their subscription, and vice versa.
///
/// Returns the new pretty-printed JSON (an empty object `{}` when nothing
/// remains / no file).
pub(crate) fn apply_logout(
    existing: Option<&str>,
    provider: &str,
    method: Option<&str>,
) -> Result<String, String> {
    let mut root = parse_auth_object(existing)?;
    let meta = AUTH_PROVIDERS.iter().find(|p| p.value == provider);
    if let Some(map) = root.as_object_mut() {
        if method != Some("apikey") {
            // A dual-auth provider's OAuth credential lives under its own key;
            // every other provider's lives under the provider id.
            match meta.and_then(|m| m.oauth_key) {
                Some(key) => {
                    map.remove(key);
                }
                None => {
                    map.remove(provider);
                }
            }
        }
        if method != Some("oauth") {
            // Covers single-credential providers and a dual provider's API key,
            // plus every variant key (Xiaomi's two, Gemini's one). A provider
            // that also signs in with OAuth under its own id (Gemini) keeps
            // that key when only the API key is removed.
            let oauth_under_provider_id = meta
                .map(|m| m.methods.contains(&"oauth") && m.oauth_key.is_none())
                .unwrap_or(false);
            if !(oauth_under_provider_id && method == Some("apikey")) {
                map.remove(provider);
            }
            if let Some(meta) = meta {
                for v in meta.api_key_variants {
                    map.remove(v.key);
                }
            }
        }
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Parse auth.json text into a JSON object value. Missing file → empty object.
/// A present-but-malformed/non-object file is an error (refuse to clobber it).
pub(crate) fn parse_auth_object(existing: Option<&str>) -> Result<serde_json::Value, String> {
    match existing {
        None => Ok(serde_json::json!({})),
        Some(s) if s.trim().is_empty() => Ok(serde_json::json!({})),
        Some(s) => {
            let v: serde_json::Value =
                serde_json::from_str(s).map_err(|e| format!("auth.json is not valid JSON: {e}"))?;
            if v.is_object() {
                Ok(v)
            } else {
                Err("auth.json is not a JSON object".to_string())
            }
        }
    }
}

/// Atomically write auth.json (temp file + rename), creating ~/.gg if needed.
/// On unix the file is mode 0600 (credentials). Mirrors gg-core's atomicWriteFile.
pub(crate) fn write_auth_file(contents: &str) -> Result<(), String> {
    let path = auth_file_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(())
}

/// Native: store an API key for a provider directly in ~/.gg/auth.json. Never
/// touches the sidecar, so it can't hang on a not-yet-booted agent. Validates
/// that the provider exists and supports API-key auth, and that the key is
/// non-empty. `variant` selects which storage key/base URL to use for
/// providers with multiple API-key options (currently only Xiaomi); omitted or
/// unknown defaults to the first/primary variant. `base_url` is an optional
/// override (OpenRouter and anything else flagged `allowCustomBaseUrl`) so the
/// provider can point at a compatible gateway; empty means "use the default".
/// Returns `{ ok: true }`.
#[tauri::command]
pub(crate) fn app_auth_apikey(
    provider: String,
    key: String,
    variant: Option<String>,
    base_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API key is required".to_string());
    }
    let (storage_key, default_base_url) = resolve_apikey_target(&provider, variant.as_deref())
        .ok_or_else(|| "provider does not support API key auth".to_string())?;
    let override_base_url = normalize_base_url(base_url.as_deref())?;
    let effective_base_url = override_base_url.as_deref().or(default_base_url);
    let existing = std::fs::read_to_string(auth_file_path()).ok();
    let now_ms = current_unix_millis();
    let next = apply_apikey(
        existing.as_deref(),
        &storage_key,
        effective_base_url,
        now_ms,
        key,
    )?;
    write_auth_file(&next)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Pure: set (or clear) the `baseUrl` on an EXISTING provider credential,
/// returning the new auth.json text. Errors when the provider has no
/// credential: a base URL with no key is meaningless, and quietly creating a
/// keyless entry would make the provider look connected.
pub(crate) fn apply_baseurl(
    existing: Option<&str>,
    provider: &str,
    base_url: Option<&str>,
) -> Result<String, String> {
    let mut root = parse_auth_object(existing)?;
    let map = root
        .as_object_mut()
        .ok_or_else(|| "auth.json is not an object".to_string())?;
    let entry = map
        .get_mut(provider)
        .ok_or_else(|| "Connect an API key for this provider first.".to_string())?;
    let obj = entry
        .as_object_mut()
        .ok_or_else(|| "Stored credential is not an object.".to_string())?;
    match base_url {
        Some(url) => {
            obj.insert("baseUrl".to_string(), serde_json::json!(url));
        }
        None => {
            obj.remove("baseUrl");
        }
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Native: change just the base URL of a connected provider, without asking for
/// the key again. Empty input clears it back to the provider default. Never
/// touches the sidecar — auth.json is the same file the daemon reads.
#[tauri::command]
pub(crate) fn app_auth_baseurl(
    provider: String,
    base_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let normalized = normalize_base_url(base_url.as_deref())?;
    let existing = std::fs::read_to_string(auth_file_path()).ok();
    let next = apply_baseurl(existing.as_deref(), &provider, normalized.as_deref())?;
    write_auth_file(&next)?;
    Ok(serde_json::json!({ "ok": true, "baseUrl": normalized }))
}

/// Native: disconnect a provider (remove its credential from ~/.gg/auth.json).
/// `method` ("oauth" | "apikey") disconnects just one of a dual-auth provider's
/// two credentials; omitted, it removes all of them — including the OAuth key
/// and every API-key variant (currently only Xiaomi's). Never touches the
/// sidecar. Returns `{ ok: true }`.
#[tauri::command]
pub(crate) fn app_auth_logout(
    app: tauri::AppHandle,
    provider: String,
    method: Option<String>,
) -> Result<serde_json::Value, String> {
    if let Some(m) = method.as_deref() {
        if m != "oauth" && m != "apikey" {
            return Err(format!("unknown auth method: {m}"));
        }
    }
    let existing = std::fs::read_to_string(auth_file_path()).ok();
    // Nothing to remove and no file → succeed silently (idempotent).
    if existing.is_none() {
        return Ok(serde_json::json!({ "ok": true }));
    }
    let next = apply_logout(existing.as_deref(), &provider, method.as_deref())?;
    write_auth_file(&next)?;
    // Disconnecting removes that provider's models from `/models` and clears
    // its connection dot. Logout is deliberately native (it must work even with
    // no daemon), so the sidecar never learns about it — tell every window
    // directly, or their pickers keep offering models the user can no longer
    // authenticate against and the login screen still shows them connected.
    broadcast_agent_event(&app, "models_change", serde_json::json!({}));
    broadcast_agent_event(
        &app,
        "auth_change",
        serde_json::json!({ "provider": provider }),
    );
    Ok(serde_json::json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_providers_keep_regional_groups_and_openrouter_last() {
        let values: Vec<&str> = AUTH_PROVIDERS
            .iter()
            .map(|provider| provider.value)
            .collect();
        assert_eq!(
            values,
            vec![
                "anthropic",
                "openai",
                "gemini",
                "xai",
                "moonshot",
                "glm",
                "minimax",
                "xiaomi",
                "deepseek",
                "sakana",
                "openrouter",
            ]
        );
    }

    #[test]
    fn auth_status_omits_hidden_providers() {
        let status = app_auth_status();
        let values: Vec<&str> = status["providers"]
            .as_array()
            .expect("providers array")
            .iter()
            .filter_map(|p| p["value"].as_str())
            .collect();
        assert!(values.contains(&"anthropic"));
        for hidden in HIDDEN_PROVIDERS {
            assert!(!values.contains(hidden), "{hidden} is still listed");
        }
    }

    #[test]
    fn auth_status_offers_the_base_url_override_only_where_allowed() {
        let status = app_auth_status();
        let providers = status["providers"].as_array().expect("providers array");
        let find = |value: &str| {
            providers
                .iter()
                .find(|p| p["value"].as_str() == Some(value))
                .unwrap_or_else(|| panic!("{value} not listed"))
        };

        // The webview only renders the override input when this flag is present.
        let openrouter = find("openrouter");
        assert_eq!(openrouter["allowCustomBaseUrl"], serde_json::json!(true));
        assert_eq!(
            openrouter["apiKeyBaseUrl"],
            serde_json::json!("https://openrouter.ai/api/v1"),
            "the form needs a default to show as its placeholder"
        );

        // A provider with no override stays without the field.
        assert!(find("sakana").get("allowCustomBaseUrl").is_none());
    }

    #[test]
    fn resolve_apikey_target_gates_on_apikey_support() {
        // OAuth-only provider → not an API-key provider.
        assert!(resolve_apikey_target("anthropic", None).is_none());
        // Unknown provider → None.
        assert!(resolve_apikey_target("nope", None).is_none());
        // API-key provider with no custom base URL, no variants.
        assert_eq!(
            resolve_apikey_target("glm", None),
            Some(("glm".to_string(), None)),
        );
        // Moonshot supports both oauth + apikey, no variants.
        assert_eq!(
            resolve_apikey_target("moonshot", None),
            Some(("moonshot".to_string(), None)),
        );
        // xAI uses the public OpenAI-compatible API with a console.x.ai key.
        assert_eq!(
            resolve_apikey_target("xai", None),
            Some(("xai".to_string(), None)),
        );
    }

    #[test]
    fn resolve_apikey_target_xiaomi_defaults_to_token_plan() {
        // No variant requested → first/primary variant (Token Plan), storage
        // key unchanged from the provider id for backward compat.
        assert_eq!(
            resolve_apikey_target("xiaomi", None),
            Some((
                "xiaomi".to_string(),
                Some("https://token-plan-sgp.xiaomimimo.com/v1")
            )),
        );
    }

    #[test]
    fn resolve_apikey_target_xiaomi_credits_variant() {
        assert_eq!(
            resolve_apikey_target("xiaomi", Some("xiaomi-credits")),
            Some((
                "xiaomi-credits".to_string(),
                Some("https://api.xiaomimimo.com/v1")
            )),
        );
    }

    #[test]
    fn resolve_apikey_target_unknown_variant_falls_back_to_first() {
        assert_eq!(
            resolve_apikey_target("xiaomi", Some("bogus")),
            Some((
                "xiaomi".to_string(),
                Some("https://token-plan-sgp.xiaomimimo.com/v1")
            )),
        );
    }

    #[test]
    fn apply_logout_xiaomi_drops_both_variant_keys() {
        let existing = r#"{ "xiaomi": { "accessToken": "tp", "refreshToken": "", "expiresAt": 1 }, "xiaomi-credits": { "accessToken": "cr", "refreshToken": "", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "xiaomi", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("xiaomi").is_none());
        assert!(v.get("xiaomi-credits").is_none());
    }

    #[test]
    fn apikey_credential_has_far_future_expiry_and_optional_base_url() {
        let now = 1_000_000_000_000i64;
        let cred = apikey_credential_json("sk-test", None, now);
        assert_eq!(cred["accessToken"], "sk-test");
        assert_eq!(cred["refreshToken"], "");
        assert_eq!(cred["expiresAt"].as_i64().unwrap(), now + API_KEY_TTL_MS);
        assert!(cred.get("baseUrl").is_none());

        let with_url = apikey_credential_json("k", Some("https://x/v1"), now);
        assert_eq!(with_url["baseUrl"], "https://x/v1");
    }

    #[test]
    fn apply_apikey_creates_file_when_missing() {
        let out = apply_apikey(None, "glm", None, 0, "sk-1").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["glm"]["accessToken"], "sk-1");
    }

    #[test]
    fn apply_apikey_preserves_other_providers() {
        let existing = r#"{ "anthropic": { "accessToken": "oauth-tok", "refreshToken": "r", "expiresAt": 5 } }"#;
        let out = apply_apikey(Some(existing), "glm", None, 0, "sk-1").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        // New provider added.
        assert_eq!(v["glm"]["accessToken"], "sk-1");
        // Existing provider untouched.
        assert_eq!(v["anthropic"]["accessToken"], "oauth-tok");
        assert_eq!(v["anthropic"]["refreshToken"], "r");
    }

    #[test]
    fn apply_apikey_carries_base_url() {
        let out = apply_apikey(None, "xiaomi", Some("https://x/v1"), 0, "sk-2").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["xiaomi"]["baseUrl"], "https://x/v1");
    }

    #[test]
    fn apply_apikey_rejects_malformed_file() {
        assert!(apply_apikey(Some("not json"), "glm", None, 0, "k").is_err());
        assert!(apply_apikey(Some("[1,2,3]"), "glm", None, 0, "k").is_err());
    }

    #[test]
    fn normalize_base_url_treats_empty_as_default() {
        assert_eq!(normalize_base_url(None).unwrap(), None);
        assert_eq!(normalize_base_url(Some("")).unwrap(), None);
        assert_eq!(normalize_base_url(Some("   ")).unwrap(), None);
    }

    #[test]
    fn normalize_base_url_strips_trailing_slashes() {
        assert_eq!(
            normalize_base_url(Some(" https://gw.example.com/v1/ ")).unwrap(),
            Some("https://gw.example.com/v1".to_string())
        );
        assert_eq!(
            normalize_base_url(Some("http://127.0.0.1:8080/v1///")).unwrap(),
            Some("http://127.0.0.1:8080/v1".to_string())
        );
    }

    #[test]
    fn normalize_base_url_rejects_non_http_schemes() {
        assert!(normalize_base_url(Some("ftp://gw.example.com")).is_err());
        assert!(normalize_base_url(Some("gw.example.com/v1")).is_err());
        assert!(normalize_base_url(Some("javascript:alert(1)")).is_err());
    }

    #[test]
    fn openrouter_has_a_default_base_url() {
        let (key, base) = resolve_apikey_target("openrouter", None).unwrap();
        assert_eq!(key, "openrouter");
        assert_eq!(base, Some("https://openrouter.ai/api/v1"));
    }

    #[test]
    fn apply_baseurl_sets_and_clears_without_touching_the_key() {
        let existing = r#"{ "openrouter": { "accessToken": "secret", "refreshToken": "", "expiresAt": 1 } }"#;
        let with = apply_baseurl(Some(existing), "openrouter", Some("https://gw.example.com/v1"))
            .expect("set");
        let v: serde_json::Value = serde_json::from_str(&with).unwrap();
        assert_eq!(v["openrouter"]["baseUrl"], "https://gw.example.com/v1");
        assert_eq!(v["openrouter"]["accessToken"], "secret");

        // Clearing restores the provider default and keeps the credential.
        let cleared = apply_baseurl(Some(&with), "openrouter", None).expect("clear");
        let v2: serde_json::Value = serde_json::from_str(&cleared).unwrap();
        assert!(v2["openrouter"].get("baseUrl").is_none());
        assert_eq!(v2["openrouter"]["accessToken"], "secret");
    }

    #[test]
    fn apply_baseurl_requires_an_existing_credential() {
        let existing = r#"{ "glm": { "accessToken": "k", "refreshToken": "", "expiresAt": 1 } }"#;
        // No key stored → refuse, rather than creating a keyless entry that
        // would make the provider look connected.
        assert!(apply_baseurl(Some(existing), "openrouter", Some("https://gw.example.com/v1")).is_err());
        assert!(apply_baseurl(None, "openrouter", Some("https://gw.example.com/v1")).is_err());
    }

    #[test]
    fn apply_logout_removes_provider() {
        let existing = r#"{ "glm": { "accessToken": "k", "refreshToken": "", "expiresAt": 1 }, "openai": { "accessToken": "o", "refreshToken": "", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "glm", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("glm").is_none());
        assert_eq!(v["openai"]["accessToken"], "o");
    }

    #[test]
    fn apply_logout_moonshot_drops_both_keys() {
        let existing = r#"{ "moonshot": { "accessToken": "key", "refreshToken": "", "expiresAt": 1 }, "moonshot-oauth": { "accessToken": "oauth", "refreshToken": "r", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "moonshot", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("moonshot").is_none());
        assert!(v.get("moonshot-oauth").is_none());
    }

    #[test]
    fn apply_logout_xai_drops_both_keys() {
        let existing = r#"{ "xai": { "accessToken": "key", "refreshToken": "", "expiresAt": 1 }, "xai-oauth": { "accessToken": "oauth", "refreshToken": "r", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "xai", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("xai").is_none());
        assert!(v.get("xai-oauth").is_none());
    }

    #[test]
    fn apply_logout_scoped_to_one_method_keeps_the_other() {
        // Disconnecting Grok OAuth must leave a configured API key usable, and
        // dropping a spent API key must not sign the user out of the subscription.
        let existing = r#"{ "xai": { "accessToken": "key", "refreshToken": "", "expiresAt": 1 }, "xai-oauth": { "accessToken": "oauth", "refreshToken": "r", "expiresAt": 1 } }"#;

        let out = apply_logout(Some(existing), "xai", Some("oauth")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("xai-oauth").is_none());
        assert_eq!(v["xai"]["accessToken"], "key");

        let out = apply_logout(Some(existing), "xai", Some("apikey")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("xai").is_none());
        assert_eq!(v["xai-oauth"]["accessToken"], "oauth");
    }

    #[test]
    fn apply_logout_oauth_only_provider_uses_provider_id_key() {
        // Anthropic has no distinct OAuth key — its credential IS `anthropic`.
        let existing =
            r#"{ "anthropic": { "accessToken": "t", "refreshToken": "r", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "anthropic", Some("oauth")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("anthropic").is_none());
    }

    #[test]
    fn apply_logout_gemini_methods_are_separate() {
        // Gemini's Google sign-in lives under `gemini`, its AI Studio key under
        // `gemini-api`: removing one must keep the other.
        let existing = r#"{ "gemini": { "accessToken": "o", "refreshToken": "r", "expiresAt": 1 }, "gemini-api": { "accessToken": "k", "refreshToken": "", "expiresAt": 1 } }"#;
        let key_only = apply_logout(Some(existing), "gemini", Some("apikey")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&key_only).unwrap();
        assert!(v.get("gemini").is_some());
        assert!(v.get("gemini-api").is_none());

        let oauth_only = apply_logout(Some(existing), "gemini", Some("oauth")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&oauth_only).unwrap();
        assert!(v.get("gemini").is_none());
        assert!(v.get("gemini-api").is_some());

        let both = apply_logout(Some(existing), "gemini", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&both).unwrap();
        assert!(v.get("gemini").is_none());
        assert!(v.get("gemini-api").is_none());
    }

    #[test]
    fn resolve_apikey_target_gemini_never_overwrites_the_oauth_login() {
        assert_eq!(
            resolve_apikey_target("gemini", None),
            Some((
                "gemini-api".to_string(),
                Some("https://generativelanguage.googleapis.com/v1beta")
            )),
        );
    }

    #[test]
    fn apply_logout_missing_file_is_empty_object() {
        let out = apply_logout(None, "glm", None).unwrap();
        assert_eq!(out.trim(), "{}");
    }
}

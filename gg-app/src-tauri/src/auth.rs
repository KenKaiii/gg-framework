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

/// One API-key option for a provider that takes both a plan key and a
/// pay-per-token key (Kimi, Xiaomi), or whose key lives apart from the provider
/// id (Gemini). Mirrors `ApiKeyVariant` in packages/gg-core/src/auth-providers.ts.
#[derive(PartialEq, Debug)]
pub(crate) struct ApiKeyVariant {
    /// Storage key in auth.json (distinct from the provider `value`).
    pub(crate) key: &'static str,
    /// Display label, e.g. "Token Plan" or "API Credits".
    pub(crate) label: &'static str,
    /// "plan" bills the user's subscription; "payg" bills per token.
    pub(crate) kind: &'static str,
    /// What the user spends with this key.
    pub(crate) billing: &'static str,
    /// Base URL stored alongside this variant's credential.
    pub(crate) base_url: Option<&'static str>,
}

/// Guidance for one auth method — what it bills against and when to pick it.
/// Every provider carries these. Mirrors `AuthMethodMeta` in
/// packages/gg-core/src/auth-providers.ts.
pub(crate) struct MethodDetail {
    /// "oauth" or "apikey".
    pub(crate) method: &'static str,
    /// Button/row label, e.g. "Continue with ChatGPT".
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
    /// Distinct auth.json key holding the sign-in, for the providers that can
    /// hold a sign-in *and* an API key at once. Mirrors gg-core's
    /// DUAL_AUTH_PROVIDERS (plus Anthropic's Claude Code marker).
    pub(crate) oauth_key: Option<&'static str>,
    /// Display name of the sign-in ("ChatGPT plan"), for the priority note.
    /// Only meaningful alongside `oauth_key`.
    pub(crate) oauth_label: Option<&'static str>,
    /// Per-method guidance.
    pub(crate) method_details: &'static [MethodDetail],
    pub(crate) api_key_label: Option<&'static str>,
    /// Custom API base URL stored alongside an API-key credential. Used as the
    /// default when `api_key_variants` is empty.
    pub(crate) api_key_base_url: Option<&'static str>,
    /// When a provider takes a plan key and a pay-per-token key, the choices to
    /// present (first = default). Empty for every single-key provider.
    pub(crate) api_key_variants: &'static [ApiKeyVariant],
}

/// Providers left out of the app's provider list (and so its login and
/// settings screens). Their rows stay below so logout and stored keys still
/// resolve. Mirrors gg-core's `HIDDEN_PROVIDERS` (hidden-providers.ts) — keep
/// in sync. None today.
pub(crate) const HIDDEN_PROVIDERS: &[&str] = &[];

/// Providers whose API key may point at a compatible gateway instead of the
/// vendor endpoint, with the default the transport uses (gg-ai's
/// OPENROUTER_BASE_URL) for the form's placeholder.
pub(crate) const CUSTOM_BASE_URL_PROVIDERS: &[(&str, &str)] =
    &[("openrouter", "https://openrouter.ai/api/v1")];

fn allows_custom_base_url(provider: &str) -> bool {
    CUSTOM_BASE_URL_PROVIDERS
        .iter()
        .any(|(p, _)| *p == provider)
}

/// Pure: validate a user-typed base URL. Empty means "use the default" (None).
/// Anything else must be an absolute http(s) URL with a host and no embedded
/// credentials; trailing slashes are dropped so `/v1/` and `/v1` match.
pub(crate) fn normalize_base_url(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = raw.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let invalid = || "Base URL must be a full http:// or https:// address.".to_string();
    if value.len() > 2048 {
        return Err("Base URL is too long.".to_string());
    }
    let parsed = reqwest::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(invalid());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Put the API key in the key field, not in the base URL.".to_string());
    }
    Ok(Some(value.trim_end_matches('/').to_string()))
}

/// auth.json key of the "signed in with Claude through Claude Code" marker
/// (`{"via":"claude-code"}`). Mirrors gg-core's CLAUDE_CODE_AUTH_KEY.
pub(crate) const CLAUDE_CODE_AUTH_KEY: &str = "anthropic-claude-code";

/// auth.json key of the ChatGPT plan sign-in. Mirrors gg-core's OPENAI_CHATGPT_KEY.
pub(crate) const OPENAI_CHATGPT_KEY: &str = "openai-chatgpt";

/// A sign-in GG Coder no longer uses (it posed as another vendor's app, or its
/// token stopped working): `(provider, storage key, message)`. Never counted as
/// connected; the user is asked once to reconnect. Mirrors gg-core's
/// RETIRED_SIGN_INS — keep the messages identical.
pub(crate) const RETIRED_SIGN_INS: &[(&str, &str, &str)] = &[
    (
        "anthropic",
        "anthropic",
        "Your old Claude sign-in no longer works. Sign in with Claude again to keep using your subscription.",
    ),
    (
        "openai",
        "openai",
        "Your old ChatGPT sign-in no longer works. Continue with ChatGPT again, or add an OpenAI API key.",
    ),
    (
        "moonshot",
        "moonshot-oauth",
        "Kimi sign-in was removed. Paste a Kimi Code plan key from the Kimi Code Console, or a Moonshot API key.",
    ),
    (
        "xai",
        "xai-oauth",
        "Grok sign-in was removed: xAI offers SuperGrok and X Premium usage only in apps it partners with. Add an xAI API key instead.",
    ),
    (
        "gemini",
        "gemini",
        "Google sign-in was removed. Add a Gemini API key from Google AI Studio instead.",
    ),
];

/// True when `entry`, stored under `storage_key`, is a retired sign-in rather
/// than a usable credential. Mirrors gg-core's `isRetiredEntry`.
pub(crate) fn is_retired_entry(storage_key: &str, entry: Option<&serde_json::Value>) -> bool {
    let Some(entry) = entry.filter(|e| !e.is_null()) else {
        return false;
    };
    let non_empty = |field: &str| {
        entry
            .get(field)
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.is_empty())
    };
    match storage_key {
        // An old GG Claude sign-in token (`sk-ant-oat…`), not an API key.
        "anthropic" => entry
            .get("accessToken")
            .and_then(|t| t.as_str())
            .is_some_and(|t| t.starts_with("sk-ant-oat")),
        // These slots now hold API keys; only a refreshable sign-in is retired.
        "openai" | "gemini" => {
            non_empty("refreshToken") || non_empty("accountId") || non_empty("projectId")
        }
        _ => RETIRED_SIGN_INS
            .iter()
            .any(|(_, key, _)| *key == storage_key),
    }
}

/// The retired sign-in still on disk for `provider`, if any: `(storage key, message)`.
fn retired_sign_in(
    creds: Option<&serde_json::Value>,
    provider: &str,
) -> Option<(&'static str, &'static str)> {
    RETIRED_SIGN_INS
        .iter()
        .find(|(p, key, _)| {
            *p == provider && is_retired_entry(key, creds.and_then(|v| v.get(*key)))
        })
        .map(|(_, key, message)| (*key, *message))
}

pub(crate) const AUTH_PROVIDERS: &[ProviderMeta] = &[
    ProviderMeta {
        value: "anthropic",
        label: "Anthropic",
        description: "Claude Fable 5.1, Opus 5.5, Opus 5.5 Fast, Sonnet 5.5, Haiku 5.5",
        // Sign in with Claude runs through Claude Code, which holds the token;
        // auth.json keeps only a marker under its own key. The API key lives
        // under `anthropic`.
        methods: &["oauth", "apikey"],
        oauth_key: Some(CLAUDE_CODE_AUTH_KEY),
        oauth_label: None,
        method_details: &[
            MethodDetail {
                method: "oauth",
                label: "Sign in with Claude",
                billing: "Uses your Claude Pro or Max plan.",
                when: "Runs through Anthropic's Claude Code, which GG Coder downloads once (about 140 MB) the first time you pick this.",
                requires: Some("A Claude Pro or Max subscription."),
            },
            MethodDetail {
                method: "apikey",
                label: "Anthropic API key",
                billing: "Pay-per-token from an Anthropic Console key.",
                when: "No subscription needed. Used only while you are not signed in with Claude.",
                requires: None,
            },
        ],
        api_key_label: Some("Anthropic"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "openai",
        label: "OpenAI",
        description: "GPT-6 Astra, GPT-6 Astra Fast, GPT-6.1 Sol, GPT-6.1 Sol Fast, GPT-6.1 Terra, GPT-6.1 Terra Fast, GPT-6 Luna, GPT-6 Luna Fast",
        // The ChatGPT plan sign-in lives under `openai-chatgpt`, the API key
        // under `openai` — a dual-auth provider (gg-core DUAL_AUTH_PROVIDERS).
        methods: &["oauth", "apikey"],
        oauth_key: Some(OPENAI_CHATGPT_KEY),
        oauth_label: Some("ChatGPT plan"),
        method_details: &[
            MethodDetail {
                method: "oauth",
                label: "Continue with ChatGPT",
                billing: "Uses your ChatGPT plan.",
                when: "Signs in through OpenAI. Manage what GG Coder may use at chatgpt.com/settings/usage.",
                requires: Some("A ChatGPT plan."),
            },
            MethodDetail {
                method: "apikey",
                label: "OpenAI API key",
                billing: "Pay-per-token from an OpenAI Platform key.",
                when: "No subscription needed. Covers you while your ChatGPT plan's usage is out.",
                requires: None,
            },
        ],
        api_key_label: Some("OpenAI"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "gemini",
        label: "Gemini",
        description: "Gemini 3.8 Flash, 3.5 Flash Lite, 3.1 Flash Lite, 3.5 Flash, 3.1 Pro (Preview)",
        // Stored under `gemini-api`: `gemini` held the retired Google sign-in.
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[
            MethodDetail {
                method: "apikey",
                label: "Gemini API key",
                billing: "Pay-per-token from a Google AI Studio key.",
                when: "",
                requires: None,
            },
        ],
        api_key_label: Some("Gemini"),
        api_key_base_url: Some("https://generativelanguage.googleapis.com/v1beta"),
        api_key_variants: &[
            ApiKeyVariant {
                key: "gemini-api",
                label: "Google AI Studio",
                kind: "payg",
                billing: "Pay-per-token from a Google AI Studio key.",
                base_url: Some("https://generativelanguage.googleapis.com/v1beta"),
            },
        ],
    },
    ProviderMeta {
        value: "xai",
        label: "xAI (Grok)",
        description: "Grok 4.7",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[
            MethodDetail {
                method: "apikey",
                label: "xAI API key",
                billing: "Pay-per-token from console.x.ai credits.",
                when: "SuperGrok and X Premium usage is only offered in apps xAI partners with.",
                requires: None,
            },
        ],
        api_key_label: Some("xAI"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "moonshot",
        label: "Kimi (Moonshot)",
        description: "Kimi K3, K2.8 Preview (Kimi Code plan), K2.7 Code, K2.7 Code HighSpeed",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[
            MethodDetail {
                method: "apikey",
                label: "Kimi API key",
                billing: "A Kimi Code plan key uses your plan; a Moonshot key is pay-per-token.",
                when: "",
                requires: None,
            },
        ],
        api_key_label: Some("Kimi"),
        api_key_base_url: None,
        api_key_variants: &[
            ApiKeyVariant {
                key: "kimi-code",
                label: "Kimi Code plan",
                kind: "plan",
                billing: "Uses your Kimi Code plan. Create the key in the Kimi Code Console.",
                base_url: None,
            },
            ApiKeyVariant {
                key: "moonshot",
                label: "Moonshot API",
                kind: "payg",
                billing: "Pay-per-token from platform.moonshot.ai.",
                base_url: None,
            },
        ],
    },
    ProviderMeta {
        value: "glm",
        label: "Z.AI (GLM)",
        description: "GLM-5.3, GLM-5.3-Flash",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[
            MethodDetail {
                method: "apikey",
                label: "Z.AI API key",
                billing: "Pay-per-token from your Z.AI account balance.",
                when: "GLM Coding Plan quota can't be used here: Z.AI limits the plan to the tools it lists.",
                requires: None,
            },
        ],
        api_key_label: Some("Z.AI"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "minimax",
        label: "MiniMax",
        description: "MiniMax M3.1 Flash, M3",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[
            MethodDetail {
                method: "apikey",
                label: "MiniMax API key",
                billing: "An M Plan key uses your plan; a pay-as-you-go key is pay-per-token.",
                when: "The key you paste decides which one is billed.",
                requires: None,
            },
        ],
        api_key_label: Some("MiniMax"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
    ProviderMeta {
        value: "xiaomi",
        label: "Xiaomi (MiMo)",
        description: "MiMo-V2.6-Pro, MiMo-V2.6-Flash, MiMo-V2.6-Pro-UltraSpeed · Token Plan or API Credits",
        methods: &["apikey"],
        oauth_key: None,
        oauth_label: None,
        method_details: &[
            MethodDetail {
                method: "apikey",
                label: "Xiaomi MiMo API key",
                billing: "A Token Plan key uses your plan; an API Credits key is pay-per-token.",
                when: "",
                requires: None,
            },
        ],
        api_key_label: Some("Xiaomi MiMo"),
        api_key_base_url: Some("https://token-plan-sgp.xiaomimimo.com/v1"),
        api_key_variants: &[
            ApiKeyVariant {
                key: "xiaomi",
                label: "Token Plan",
                kind: "plan",
                billing: "Uses your MiMo Token Plan.",
                base_url: Some("https://token-plan-sgp.xiaomimimo.com/v1"),
            },
            ApiKeyVariant {
                key: "xiaomi-credits",
                label: "API Credits",
                kind: "payg",
                billing: "Pay-per-token from MiMo API Credits. Required for UltraSpeed.",
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
        method_details: &[
            MethodDetail {
                method: "apikey",
                label: "DeepSeek API key",
                billing: "Pay-per-token from platform.deepseek.com.",
                when: "",
                requires: None,
            },
        ],
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
        method_details: &[
            MethodDetail {
                method: "apikey",
                label: "Sakana API key",
                billing: "Pay-per-token from your Sakana API account.",
                when: "",
                requires: None,
            },
        ],
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
        method_details: &[
            MethodDetail {
                method: "apikey",
                label: "OpenRouter API key",
                billing: "Pay-per-token from OpenRouter credits.",
                when: "",
                requires: None,
            },
        ],
        api_key_label: Some("OpenRouter"),
        api_key_base_url: None,
        api_key_variants: &[],
    },
];

/// Pure: resolve `(storage_key, base_url)` for an API-key submission to
/// `provider`, given an optional variant key. Providers with
/// `api_key_variants` (Kimi and Xiaomi: plan key vs. pay-per-token key; Gemini)
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
/// ~/.gg/auth.json. `connected` is true when a usable credential is present
/// (OpenAI is satisfied by its plan sign-in or its API key; a provider with key
/// variants like Kimi or Xiaomi by ANY of them; a retired sign-in never counts —
/// mirrors AuthStorage.hasProviderAuth). Never needs the sidecar.
///
/// Also reports WHICH methods are connected and which one a request would
/// actually use, mirroring AuthStorage's resolution order: subscription OAuth
/// wins, and the API key only takes over while OAuth's usage window is
/// exhausted. A single `connected` bit cannot express "signed in with OAuth,
/// key on file as backup", and the UI needs that to explain itself and to offer
/// a per-method disconnect.
#[tauri::command]
pub(crate) async fn app_auth_status() -> serde_json::Value {
    let creds = read_auth_file();
    let mut status = auth_status_snapshot(creds.as_ref());
    status["localConnected"] = serde_json::json!(local_model_source(creds.as_ref()).await);
    status
}

/// Parse the auth file into a JSON object; missing/invalid → None (no creds).
fn read_auth_file() -> Option<serde_json::Value> {
    std::fs::read_to_string(auth_file_path())
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
}

/// Provider tiles from the auth file; `localConnected` is added by the command.
pub(crate) fn auth_status_snapshot(creds: Option<&serde_json::Value>) -> serde_json::Value {
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
    // A usable credential under `key`: present and not a retired sign-in (an
    // old Codex token in the `openai` slot must never read as an API key).
    let has_usable = |key: &str| -> bool {
        has_key(key) && !is_retired_entry(key, creds.and_then(|v| v.get(key)))
    };
    // API-key credential present under any of the provider's key(s).
    let has_api_key = |p: &ProviderMeta| -> bool {
        if !p.methods.contains(&"apikey") {
            return false;
        }
        if p.api_key_variants.is_empty() {
            has_usable(p.value)
        } else {
            p.api_key_variants.iter().any(|v| has_usable(v.key))
        }
    };
    // Sign-in present, under its own key (the ChatGPT plan, the Claude Code marker).
    let has_oauth = |p: &ProviderMeta| -> bool {
        p.methods.contains(&"oauth") && p.oauth_key.is_some_and(has_key)
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
            let active_method = if oauth {
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
            // A retired sign-in is still on disk: ask the user once to
            // reconnect. Connecting again or dismissing removes the entry.
            if let Some((_, message)) = retired_sign_in(creds, p.value) {
                obj["reauthRequired"] = serde_json::json!(true);
                obj["reauthMessage"] = serde_json::json!(message);
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
            // Only a provider with two credentials has a priority to explain.
            // Keep the wording identical to gg-core's authPriorityNote.
            let plan = p.api_key_variants.iter().find(|v| v.kind == "plan");
            let payg = p.api_key_variants.iter().find(|v| v.kind == "payg");
            if p.value == "anthropic" {
                obj["priorityNote"] = serde_json::json!(
                    "Uses Sign in with Claude while you are signed in; otherwise the Anthropic API key."
                );
            } else if let (Some(oauth_label), Some(key_label)) = (p.oauth_label, p.api_key_label) {
                obj["priorityNote"] = serde_json::json!(format!(
                    "Uses your {oauth_label} first; the {key_label} API key takes over while its usage is out, then switches back."
                ));
            } else if let (Some(plan), Some(payg)) = (plan, payg) {
                obj["priorityNote"] = serde_json::json!(format!(
                    "Uses the {} key first when both are set; the {} key covers models the plan doesn't include.",
                    plan.label, payg.label
                ));
            }
            if let Some(l) = p.api_key_label {
                obj["apiKeyLabel"] = serde_json::json!(l);
            }
            if let Some(u) = p.api_key_base_url {
                obj["apiKeyBaseUrl"] = serde_json::json!(u);
            }
            if let Some((_, default_url)) =
                CUSTOM_BASE_URL_PROVIDERS.iter().find(|(v, _)| *v == p.value)
            {
                obj["allowCustomBaseUrl"] = serde_json::json!(true);
                obj["defaultBaseUrl"] = serde_json::json!(default_url);
                if let Some(url) = creds
                    .as_ref()
                    .and_then(|v| v.get(p.value))
                    .and_then(|c| c.get("baseUrl"))
                    .and_then(|u| u.as_str())
                {
                    obj["currentBaseUrl"] = serde_json::json!(url);
                }
            }
            if !p.api_key_variants.is_empty() {
                let variants: Vec<serde_json::Value> = p
                    .api_key_variants
                    .iter()
                    .map(|v| {
                        serde_json::json!({
                            "key": v.key,
                            "label": v.label,
                            "kind": v.kind,
                            "billing": v.billing,
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

/// Local endpoints in auth.json, split the way the sidecar's `localConnected`
/// splits them: user-added ones (`local:custom-<host>`, see `endpointIdFor`)
/// count as configured; an auto-detected one (Ollama) keeps its credential after
/// the server stops, so it's returned by base URL to be checked live.
fn local_endpoints(creds: Option<&serde_json::Value>) -> (bool, Vec<String>) {
    let mut custom = false;
    let mut detected = Vec::new();
    for (key, value) in creds.and_then(|v| v.as_object()).into_iter().flatten() {
        let Some(id) = key.strip_prefix("local:") else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        if id.starts_with("custom-") {
            custom = true;
        } else if let Some(url) = value.get("baseUrl").and_then(|u| u.as_str()) {
            detected.push(url.to_string());
        }
    }
    (custom, detected)
}

/// Whether a local endpoint can serve a model right now.
async fn local_model_source(creds: Option<&serde_json::Value>) -> bool {
    let (custom, detected) = local_endpoints(creds);
    if custom {
        return true;
    }
    for base_url in detected {
        if serves_a_model(&base_url).await {
            return true;
        }
    }
    false
}

/// GET `<base>/models` and check it lists something. Its own client: the shared
/// one carries the daemon token, which must never reach another local server.
async fn serves_a_model(base_url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
    else {
        return false;
    };
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let Ok(res) = client.get(&url).send().await else {
        return false;
    };
    if !res.status().is_success() {
        return false;
    }
    res.json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| {
            v.get("data")
                .and_then(|d| d.as_array())
                .map(|a| !a.is_empty())
        })
        .unwrap_or(false)
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
    storage_key: &str,
    base_url: Option<&str>,
    now_ms: i64,
    key: &str,
) -> Result<String, String> {
    let mut root = parse_auth_object(existing)?;
    let provider = storage_key_provider(storage_key);
    if let Some(map) = root.as_object_mut() {
        // Connecting again also removes that provider's retired sign-in —
        // what the reconnect notice asked for (mirrors AuthStorage.setCredentials).
        for (p, retired_key, _) in RETIRED_SIGN_INS {
            if *p == provider
                && *retired_key != storage_key
                && is_retired_entry(retired_key, map.get(*retired_key))
            {
                map.remove(*retired_key);
            }
        }
        map.insert(
            storage_key.to_string(),
            apikey_credential_json(key, base_url, now_ms),
        );
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Logical provider for a storage key (`kimi-code` → `moonshot`). Mirrors
/// gg-core's `storageKeyProvider`.
fn storage_key_provider(storage_key: &str) -> &str {
    if storage_key == OPENAI_CHATGPT_KEY {
        return "openai";
    }
    AUTH_PROVIDERS
        .iter()
        .find(|p| p.api_key_variants.iter().any(|v| v.key == storage_key))
        .map(|p| p.value)
        .unwrap_or(storage_key)
}

/// Pure: remove a provider's credential(s) from the existing auth.json text.
///
/// `method` scopes the removal: `Some("oauth")` drops only the sign-in (the
/// ChatGPT plan, the Claude Code marker), `Some("apikey")` drops only the
/// key(s), `Some("legacy")` drops only a retired sign-in, and `None`
/// disconnects the provider entirely. Dropping a spent API key must not sign
/// the user out of their plan, and vice versa.
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
        let retired = retired_sign_in(Some(&serde_json::Value::Object(map.clone())), provider);
        if method == Some("legacy") {
            if let Some((key, _)) = retired {
                map.remove(key);
            }
            return serde_json::to_string_pretty(&root).map_err(|e| e.to_string());
        }
        if method != Some("apikey") {
            if let Some(key) = meta.and_then(|m| m.oauth_key) {
                map.remove(key);
            }
        }
        if method != Some("oauth") {
            // The provider id plus every variant key (Kimi's two, Xiaomi's two,
            // Gemini's one), and any retired sign-in left behind.
            map.remove(provider);
            if let Some(meta) = meta {
                for v in meta.api_key_variants {
                    map.remove(v.key);
                }
            }
            if let Some((key, _)) = retired {
                map.remove(key);
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
/// providers with key variants (Kimi, Xiaomi); omitted or unknown defaults to
/// the first/primary variant. `base_url` overrides the
/// endpoint for providers in `CUSTOM_BASE_URL_PROVIDERS`. Returns `{ ok: true }`.
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
    let override_url = normalize_base_url(base_url.as_deref())?;
    if override_url.is_some() && !allows_custom_base_url(&provider) {
        return Err("This provider doesn't take a custom base URL.".to_string());
    }
    let effective = override_url.as_deref().or(default_base_url);
    let existing = std::fs::read_to_string(auth_file_path()).ok();
    let now_ms = current_unix_millis();
    let next = apply_apikey(existing.as_deref(), &storage_key, effective, now_ms, key)?;
    write_auth_file(&next)?;
    Ok(serde_json::json!({ "ok": true }))
}

/// Pure: set (Some) or clear (None) the `baseUrl` on a provider's EXISTING
/// credential. Refuses when no key is stored: a keyless entry would make the
/// provider look connected.
pub(crate) fn apply_baseurl(
    existing: Option<&str>,
    provider: &str,
    base_url: Option<&str>,
) -> Result<String, String> {
    let mut root = parse_auth_object(existing)?;
    let entry = root
        .as_object_mut()
        .and_then(|m| m.get_mut(provider))
        .and_then(|e| e.as_object_mut())
        .ok_or_else(|| "Connect an API key for this provider first.".to_string())?;
    match base_url {
        Some(url) => {
            entry.insert("baseUrl".to_string(), serde_json::json!(url));
        }
        None => {
            entry.remove("baseUrl");
        }
    }
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

/// Native: change only the base URL of a connected provider, keeping its key.
/// Empty input goes back to the provider default. Returns `{ ok, baseUrl }`.
#[tauri::command]
pub(crate) fn app_auth_baseurl(
    provider: String,
    base_url: Option<String>,
) -> Result<serde_json::Value, String> {
    if !allows_custom_base_url(&provider) {
        return Err("This provider doesn't take a custom base URL.".to_string());
    }
    let normalized = normalize_base_url(base_url.as_deref())?;
    let existing = std::fs::read_to_string(auth_file_path()).ok();
    let next = apply_baseurl(existing.as_deref(), &provider, normalized.as_deref())?;
    write_auth_file(&next)?;
    Ok(serde_json::json!({ "ok": true, "baseUrl": normalized }))
}

/// Native: disconnect a provider (remove its credential from ~/.gg/auth.json).
/// `method` ("oauth" | "apikey" | "legacy") disconnects just one credential;
/// omitted, it removes all of them — the sign-in, every API-key variant and any
/// retired sign-in. Signing out of Claude or ChatGPT asks the sidecar first
/// (best effort) so it can sign Claude Code out or revoke the ChatGPT session.
/// Returns `{ ok: true }`.
#[tauri::command]
pub(crate) async fn app_auth_logout(
    webview: tauri::WebviewWindow,
    client: tauri::State<'_, reqwest::Client>,
    provider: String,
    method: Option<String>,
) -> Result<serde_json::Value, String> {
    if let Some(m) = method.as_deref() {
        if m != "oauth" && m != "apikey" && m != "legacy" {
            return Err(format!("unknown auth method: {m}"));
        }
    }
    let app = webview.app_handle().clone();
    // Claude Code holds the Claude login itself, and a ChatGPT sign-out must
    // revoke the session at OpenAI; only the sidecar does those. Best effort:
    // with no daemon the local credential still goes.
    let signs_out = method.is_none() || method.as_deref() == Some("oauth");
    if (provider == "anthropic" || provider == "openai") && signs_out {
        if let (Some(port), Some(sid)) = (
            crate::daemon::port_for(&webview),
            crate::daemon::session_for(&webview),
        ) {
            let _ = client
                .post(format!("{}/auth/logout", crate::daemon::sidecar_base(port)))
                .header("x-gg-session", &sid)
                .json(&serde_json::json!({ "provider": provider, "method": "oauth" }))
                .timeout(std::time::Duration::from_secs(20))
                .send()
                .await;
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
        let status = auth_status_snapshot(None);
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
    fn local_endpoints_splits_user_added_from_auto_detected() {
        let creds = serde_json::json!({
            "anthropic": { "accessToken": "t" },
            "local:ollama": { "accessToken": "local", "baseUrl": "http://127.0.0.1:11434/v1" },
            "local:gone": null,
        });
        assert_eq!(
            local_endpoints(Some(&creds)),
            (false, vec!["http://127.0.0.1:11434/v1".to_string()])
        );
        let custom = serde_json::json!({ "local:custom-gw": { "accessToken": "k" } });
        assert_eq!(local_endpoints(Some(&custom)), (true, vec![]));
        assert_eq!(local_endpoints(None), (false, vec![]));
    }

    #[test]
    fn a_stopped_ollama_is_not_a_model_source() {
        // Port 9 (discard) on loopback is closed on CI and dev machines.
        install_rustls_provider();
        let creds = serde_json::json!({
            "local:ollama": { "accessToken": "local", "baseUrl": "http://127.0.0.1:9/v1" },
        });
        assert!(!tauri::async_runtime::block_on(local_model_source(Some(
            &creds
        ))));
    }

    #[test]
    fn resolve_apikey_target_gates_on_apikey_support() {
        // OpenAI takes an API key beside the ChatGPT plan sign-in.
        assert_eq!(
            resolve_apikey_target("openai", None),
            Some(("openai".to_string(), None)),
        );
        // Anthropic's API key lives under the provider id, apart from the sign-in marker.
        assert_eq!(
            resolve_apikey_target("anthropic", None),
            Some(("anthropic".to_string(), None)),
        );
        // Unknown provider → None.
        assert!(resolve_apikey_target("nope", None).is_none());
        // API-key provider with no custom base URL, no variants.
        assert_eq!(
            resolve_apikey_target("glm", None),
            Some(("glm".to_string(), None)),
        );
        // Kimi defaults to the Kimi Code plan key; the Moonshot key is the other variant.
        assert_eq!(
            resolve_apikey_target("moonshot", None),
            Some(("kimi-code".to_string(), None)),
        );
        assert_eq!(
            resolve_apikey_target("moonshot", Some("moonshot")),
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
    fn normalize_base_url_accepts_gateways_and_strips_trailing_slashes() {
        assert_eq!(normalize_base_url(None).unwrap(), None);
        assert_eq!(normalize_base_url(Some("   ")).unwrap(), None);
        assert_eq!(
            normalize_base_url(Some(" https://gw.example.com/v1/ ")).unwrap(),
            Some("https://gw.example.com/v1".to_string())
        );
        assert_eq!(
            normalize_base_url(Some("http://127.0.0.1:8080/api/v1//")).unwrap(),
            Some("http://127.0.0.1:8080/api/v1".to_string())
        );
    }

    #[test]
    fn normalize_base_url_rejects_non_http_and_embedded_credentials() {
        for bad in [
            "ftp://gw.example.com",
            "gw.example.com/v1",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://user:pass@gw.example.com/v1",
        ] {
            assert!(
                normalize_base_url(Some(bad)).is_err(),
                "{bad} should be rejected"
            );
        }
    }

    #[test]
    fn apply_baseurl_sets_and_clears_without_touching_the_key() {
        let existing =
            r#"{ "openrouter": { "accessToken": "secret", "refreshToken": "", "expiresAt": 1 } }"#;
        let with = apply_baseurl(
            Some(existing),
            "openrouter",
            Some("https://gw.example.com/v1"),
        )
        .expect("set");
        let v: serde_json::Value = serde_json::from_str(&with).unwrap();
        assert_eq!(v["openrouter"]["baseUrl"], "https://gw.example.com/v1");
        assert_eq!(v["openrouter"]["accessToken"], "secret");

        let cleared = apply_baseurl(Some(&with), "openrouter", None).expect("clear");
        let v2: serde_json::Value = serde_json::from_str(&cleared).unwrap();
        assert!(v2["openrouter"].get("baseUrl").is_none());
        assert_eq!(v2["openrouter"]["accessToken"], "secret");
    }

    #[test]
    fn apply_baseurl_requires_an_existing_credential() {
        let existing = r#"{ "glm": { "accessToken": "k", "refreshToken": "", "expiresAt": 1 } }"#;
        assert!(apply_baseurl(
            Some(existing),
            "openrouter",
            Some("https://gw.example.com/v1")
        )
        .is_err());
        assert!(apply_baseurl(None, "openrouter", Some("https://gw.example.com/v1")).is_err());
    }

    #[test]
    fn auth_status_offers_a_base_url_only_where_allowed() {
        let creds = serde_json::json!({
            "openrouter": { "accessToken": "k", "refreshToken": "", "expiresAt": 1, "baseUrl": "https://gw.example.com/v1" },
        });
        let status = auth_status_snapshot(Some(&creds));
        let providers = status["providers"].as_array().unwrap();
        let find = |value: &str| providers.iter().find(|p| p["value"] == value).unwrap();

        let openrouter = find("openrouter");
        assert_eq!(openrouter["allowCustomBaseUrl"], serde_json::json!(true));
        assert_eq!(openrouter["defaultBaseUrl"], "https://openrouter.ai/api/v1");
        assert_eq!(openrouter["currentBaseUrl"], "https://gw.example.com/v1");
        assert!(find("anthropic").get("allowCustomBaseUrl").is_none());
    }

    #[test]
    fn apply_apikey_rejects_malformed_file() {
        assert!(apply_apikey(Some("not json"), "glm", None, 0, "k").is_err());
        assert!(apply_apikey(Some("[1,2,3]"), "glm", None, 0, "k").is_err());
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
    fn apply_logout_moonshot_drops_both_keys_and_the_retired_sign_in() {
        let existing = r#"{ "moonshot": { "accessToken": "key", "refreshToken": "", "expiresAt": 1 }, "kimi-code": { "accessToken": "plan", "refreshToken": "", "expiresAt": 1 }, "moonshot-oauth": { "accessToken": "oauth", "refreshToken": "r", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "moonshot", Some("apikey")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("moonshot").is_none());
        assert!(v.get("kimi-code").is_none());
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
        // Signing out of ChatGPT must leave a configured API key usable, and
        // dropping a spent API key must not sign the user out of the plan.
        let existing = r#"{ "openai": { "accessToken": "key", "refreshToken": "", "expiresAt": 1 }, "openai-chatgpt": { "accessToken": "plan", "refreshToken": "r", "expiresAt": 1 } }"#;

        let out = apply_logout(Some(existing), "openai", Some("oauth")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("openai-chatgpt").is_none());
        assert_eq!(v["openai"]["accessToken"], "key");

        let out = apply_logout(Some(existing), "openai", Some("apikey")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("openai").is_none());
        assert_eq!(v["openai-chatgpt"]["accessToken"], "plan");
    }

    #[test]
    fn apply_logout_legacy_removes_only_the_retired_sign_in() {
        // An old Codex token in the `openai` slot, plus a real key elsewhere.
        let existing = r#"{ "openai": { "accessToken": "codex", "refreshToken": "r", "expiresAt": 1, "accountId": "a" }, "openai-chatgpt": { "accessToken": "plan", "refreshToken": "r", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "openai", Some("legacy")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("openai").is_none());
        assert_eq!(v["openai-chatgpt"]["accessToken"], "plan");

        // A real OpenAI API key is not retired: dismissing leaves it.
        let key =
            r#"{ "openai": { "accessToken": "sk-key", "refreshToken": "", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(key), "openai", Some("legacy")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["openai"]["accessToken"], "sk-key");
    }

    #[test]
    fn apply_apikey_replaces_a_retired_sign_in_of_the_same_provider() {
        let existing = r#"{ "moonshot-oauth": { "accessToken": "o", "refreshToken": "r", "expiresAt": 1 }, "glm": { "accessToken": "g", "refreshToken": "", "expiresAt": 1 } }"#;
        let out = apply_apikey(Some(existing), "kimi-code", None, 0, "kc").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("moonshot-oauth").is_none());
        assert_eq!(v["kimi-code"]["accessToken"], "kc");
        assert_eq!(v["glm"]["accessToken"], "g");
    }

    #[test]
    fn openai_status_never_reads_an_old_codex_token_as_a_key() {
        let find = |creds: serde_json::Value| -> serde_json::Value {
            auth_status_snapshot(Some(&creds))["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["value"] == "openai")
                .unwrap()
                .clone()
        };
        let codex = find(serde_json::json!({
            "openai": { "accessToken": "codex", "refreshToken": "r", "accountId": "a" },
        }));
        assert_eq!(codex["connected"], false);
        assert_eq!(codex["connectedMethods"], serde_json::json!([]));
        assert_eq!(codex["reauthRequired"], true);
        assert!(codex["reauthMessage"]
            .as_str()
            .unwrap()
            .contains("Continue with ChatGPT"));

        let both = find(serde_json::json!({
            "openai": { "accessToken": "sk-key", "refreshToken": "" },
            "openai-chatgpt": { "accessToken": "plan", "refreshToken": "r" },
        }));
        assert_eq!(
            both["connectedMethods"],
            serde_json::json!(["oauth", "apikey"])
        );
        assert_eq!(both["activeMethod"], "oauth");
        assert!(both.get("reauthRequired").is_none());
        assert_eq!(
            both["priorityNote"],
            "Uses your ChatGPT plan first; the OpenAI API key takes over while its usage is out, then switches back."
        );
        assert_eq!(both["methodGuidance"][0]["label"], "Continue with ChatGPT");
    }

    #[test]
    fn only_claude_and_chatgpt_offer_a_sign_in_and_every_provider_takes_a_key() {
        let with_oauth: Vec<&str> = AUTH_PROVIDERS
            .iter()
            .filter(|p| p.methods.contains(&"oauth"))
            .map(|p| p.value)
            .collect();
        assert_eq!(with_oauth, vec!["anthropic", "openai"]);
        for p in AUTH_PROVIDERS {
            assert!(p.methods.contains(&"apikey"), "{} has no API key", p.value);
            assert!(
                p.method_details.iter().any(|d| d.method == "apikey"),
                "{} has no API-key guidance",
                p.value
            );
            for v in p.api_key_variants {
                assert!(
                    v.kind == "plan" || v.kind == "payg",
                    "{}/{}",
                    p.value,
                    v.key
                );
                assert!(!v.billing.is_empty(), "{}/{}", p.value, v.key);
            }
        }
    }

    #[test]
    fn kimi_status_lists_both_variants_with_billing() {
        let status = auth_status_snapshot(Some(&serde_json::json!({
            "kimi-code": { "accessToken": "kc", "refreshToken": "" },
        })));
        let kimi = status["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["value"] == "moonshot")
            .unwrap()
            .clone();
        assert_eq!(kimi["connected"], true);
        assert_eq!(kimi["methods"], serde_json::json!(["apikey"]));
        assert_eq!(kimi["apiKeyVariants"][0]["key"], "kimi-code");
        assert_eq!(kimi["apiKeyVariants"][0]["kind"], "plan");
        assert_eq!(kimi["apiKeyVariants"][1]["kind"], "payg");
        assert!(kimi["priorityNote"]
            .as_str()
            .unwrap()
            .contains("Kimi Code plan"));
    }

    #[test]
    fn anthropic_sign_in_marker_and_api_key_are_separate() {
        let existing = r#"{ "anthropic-claude-code": { "via": "claude-code" }, "anthropic": { "accessToken": "sk-ant-api03-x", "refreshToken": "", "expiresAt": 1 } }"#;
        let out = apply_logout(Some(existing), "anthropic", Some("oauth")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("anthropic-claude-code").is_none());
        assert_eq!(v["anthropic"]["accessToken"], "sk-ant-api03-x");

        let out = apply_logout(Some(existing), "anthropic", Some("apikey")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("anthropic").is_none());
        assert_eq!(v["anthropic-claude-code"]["via"], "claude-code");
    }

    #[test]
    fn anthropic_status_counts_the_marker_and_ignores_the_retired_oauth_token() {
        let find = |creds: serde_json::Value| -> serde_json::Value {
            auth_status_snapshot(Some(&creds))["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["value"] == "anthropic")
                .unwrap()
                .clone()
        };
        let marker = find(serde_json::json!({ "anthropic-claude-code": { "via": "claude-code" } }));
        assert_eq!(marker["connected"], true);
        assert_eq!(marker["activeMethod"], "oauth");
        assert_eq!(marker["methods"], serde_json::json!(["oauth", "apikey"]));

        let both = find(serde_json::json!({
            "anthropic-claude-code": { "via": "claude-code" },
            "anthropic": { "accessToken": "sk-ant-api03-x" },
        }));
        assert_eq!(
            both["connectedMethods"],
            serde_json::json!(["oauth", "apikey"])
        );
        assert_eq!(both["activeMethod"], "oauth");

        let legacy = find(serde_json::json!({
            "anthropic": { "accessToken": "sk-ant-oat01-x", "refreshToken": "r" },
        }));
        assert_eq!(legacy["connected"], false);
        assert_eq!(legacy["reauthRequired"], true);
        assert!(marker.get("reauthRequired").is_none());
        assert!(both.get("reauthRequired").is_none());
    }

    #[test]
    fn gemini_is_listed_on_its_key_and_flags_the_retired_google_sign_in() {
        let existing = r#"{ "gemini": { "accessToken": "o", "refreshToken": "r", "expiresAt": 1, "projectId": "p" }, "gemini-api": { "accessToken": "k", "refreshToken": "", "expiresAt": 1 } }"#;
        let creds: serde_json::Value = serde_json::from_str(existing).unwrap();
        let status = auth_status_snapshot(Some(&creds));
        let gemini = status["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["value"] == "gemini")
            .unwrap()
            .clone();
        assert_eq!(gemini["connectedMethods"], serde_json::json!(["apikey"]));
        assert_eq!(gemini["reauthRequired"], true);

        // Dismissing drops the sign-in and keeps the key.
        let dismissed = apply_logout(Some(existing), "gemini", Some("legacy")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&dismissed).unwrap();
        assert!(v.get("gemini").is_none());
        assert!(v.get("gemini-api").is_some());

        // A full disconnect removes both.
        let both = apply_logout(Some(existing), "gemini", None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&both).unwrap();
        assert!(v.get("gemini").is_none());
        assert!(v.get("gemini-api").is_none());
    }

    #[test]
    fn resolve_apikey_target_gemini_stores_under_its_own_key() {
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

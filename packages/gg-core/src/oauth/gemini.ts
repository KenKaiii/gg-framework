import http from "node:http";
import crypto from "node:crypto";
import { generatePKCE } from "./pkce.js";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types.js";

const CLIENT_ID_ENV = "GGCODER_GEMINI_OAUTH_CLIENT_ID";
const CLIENT_SECRET_ENV = "GGCODER_GEMINI_OAUTH_CLIENT_SECRET";
// Public "installed application" OAuth client shipped with the official Gemini CLI.
// Unlike the OpenAI/Anthropic flows (pure PKCE, no secret), Google's token endpoint
// requires a client_secret for the installed-app authorization_code / refresh_token
// grants — so it must be embedded to support local login like the other providers.
// This is the published gemini-cli installed-app secret (non-confidential by design);
// the env vars above override it for users who bring their own Google Cloud client.
const DEFAULT_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET = "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";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_BASE_URL = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = "v1internal";
const CODE_ASSIST_POST_RETRIES = 3;
const CODE_ASSIST_POST_RETRY_DELAY_MS = 100;
const SCOPE = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface GeminiOAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

interface CodeAssistLoadResponse {
  currentTier?: GeminiUserTier | null;
  allowedTiers?: GeminiUserTier[] | null;
  ineligibleTiers?: IneligibleTier[] | null;
  cloudaicompanionProject?: string | null;
  paidTier?: GeminiUserTier | null;
}

interface GeminiUserTier {
  id?: string;
  name?: string;
  isDefault?: boolean;
}

interface IneligibleTier {
  reasonCode?: string;
  reasonMessage?: string;
  tierName?: string;
  validationUrl?: string;
}

interface LongRunningOperationResponse {
  name?: string;
  done?: boolean;
  response?: {
    cloudaicompanionProject?: {
      id?: string;
      name?: string;
    };
  };
}

const USER_TIER_FREE = "free-tier";
const USER_TIER_LEGACY = "legacy-tier";
const USER_TIER_STANDARD = "standard-tier";
const VALIDATION_REQUIRED_REASON = "VALIDATION_REQUIRED";
const VPC_SC_REASON = "SECURITY_POLICY_VIOLATED";

class CodeAssistHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(label: string, status: number, body: string) {
    super(`Gemini Code Assist ${label} failed (${status}): ${body}`);
    this.name = "CodeAssistHttpError";
    this.status = status;
    this.body = body;
  }
}

export async function loginGemini(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { clientId, clientSecret } = getGeminiOAuthClientCredentials();
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomBytes(32).toString("hex");
  const redirectUri = await getLoopbackRedirectUri();

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  let code: string;
  try {
    code = await loginWithServer(url.toString(), redirectUri, state, callbacks);
  } catch {
    callbacks.onOpenUrl(url.toString());
    const raw = await callbacks.onPromptCode(
      "Could not start local server. Paste the callback URL or code from the browser:",
    );
    const parsed = parseAuthorizationInput(raw);
    if (!parsed.code) {
      throw new Error("No authorization code found in input.");
    }
    if (parsed.state && parsed.state !== state) {
      throw new Error("Invalid state. Please try again.");
    }
    code = parsed.code;
  }

  const creds = await exchangeGeminiCode(code, verifier, redirectUri, clientId, clientSecret);
  callbacks.onStatus("Setting up Gemini Code Assist access...");
  const projectId = await setupCodeAssistProject(creds.accessToken, callbacks);

  return {
    ...creds,
    projectId,
  };
}

export async function refreshGeminiToken(refreshToken: string): Promise<OAuthCredentials> {
  const { clientId, clientSecret } = getGeminiOAuthClientCredentials();
  const data = await postTokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

function getGeminiOAuthClientCredentials(): GeminiOAuthClientCredentials {
  const clientId = process.env[CLIENT_ID_ENV]?.trim() || DEFAULT_CLIENT_ID;
  const clientSecret = process.env[CLIENT_SECRET_ENV]?.trim() || DEFAULT_CLIENT_SECRET;
  return { clientId, clientSecret };
}

async function getLoopbackRedirectUri(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") {
          resolve(`http://127.0.0.1:${addr.port}/oauth2callback`);
        } else {
          reject(new Error("Failed to allocate OAuth callback port."));
        }
      });
    });
    server.on("error", reject);
  });
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }

  return { code: value };
}

async function loginWithServer(
  authUrl: string,
  redirectUri: string,
  expectedState: string,
  callbacks: OAuthLoginCallbacks,
): Promise<string> {
  const redirect = new URL(redirectUri);
  const port = Number(redirect.port);

  return new Promise<string>((resolve, reject) => {
    let receivedCode: string | null = null;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "", redirect.origin);

      if (url.pathname !== redirect.pathname) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      if (url.searchParams.get("state") !== expectedState) {
        res.statusCode = 400;
        res.end("State mismatch");
        return;
      }

      receivedCode = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
      res.end("<html><body><h1>Login successful!</h1><p>You can close this tab.</p></body></html>");
      server.close();
    });

    server.on("error", (err) => reject(err));
    server.listen(port, "127.0.0.1", () => {
      callbacks.onOpenUrl(authUrl);
      callbacks.onStatus("Waiting for browser callback...");
    });

    const timeout = setTimeout(() => {
      if (!receivedCode) server.close();
    }, 120_000);
    timeout.unref();

    server.on("close", () => {
      clearTimeout(timeout);
      if (receivedCode) {
        resolve(receivedCode);
      } else {
        reject(new Error("Server closed without receiving code."));
      }
    });
  });
}

async function exchangeGeminiCode(
  code: string,
  verifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
): Promise<OAuthCredentials> {
  const data = await postTokenRequest({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  if (!data.refresh_token) {
    throw new Error("Gemini OAuth did not return a refresh token. Please try login again.");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  };
}

async function postTokenRequest(body: Record<string, string>): Promise<GoogleTokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini token request failed (${response.status}): ${text}`);
  }

  return (await response.json()) as GoogleTokenResponse;
}

async function setupCodeAssistProject(
  accessToken: string,
  callbacks: OAuthLoginCallbacks,
): Promise<string> {
  const envProject = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (envProject && /^\d+$/.test(envProject)) {
    throw new Error("GOOGLE_CLOUD_PROJECT must be a project ID, not a numeric project number.");
  }

  const coreMetadata = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };
  const projectMetadata = {
    ...coreMetadata,
    ...(envProject ? { duetProject: envProject } : {}),
  };

  let loadRes: CodeAssistLoadResponse;
  while (true) {
    loadRes = await loadCodeAssist(accessToken, envProject, projectMetadata);
    const validation = getValidationRequiredTier(loadRes);
    if (!validation) break;

    callbacks.onStatus(
      `Gemini Code Assist requires account validation${
        validation.reasonMessage ? `: ${validation.reasonMessage}` : ""
      }`,
    );
    callbacks.onOpenUrl(validation.validationUrl);
    const answer = await callbacks.onPromptCode(
      "Complete validation in the browser, then press Enter to retry (or type cancel):",
    );
    if (answer.trim().toLowerCase() === "cancel") {
      throw new Error("Gemini Code Assist account validation was cancelled.");
    }
  }

  if (loadRes.currentTier) {
    const project = loadRes.cloudaicompanionProject ?? envProject;
    if (!project) throwProjectError(loadRes);
    return project;
  }

  const tier = getOnboardTier(loadRes);
  const onboardReq =
    tier.id === USER_TIER_FREE
      ? {
          tierId: tier.id,
          cloudaicompanionProject: undefined,
          metadata: coreMetadata,
        }
      : {
          tierId: tier.id,
          cloudaicompanionProject: envProject,
          metadata: projectMetadata,
        };

  let operation = await codeAssistPost<LongRunningOperationResponse>(
    accessToken,
    "onboardUser",
    onboardReq,
  );

  while (!operation.done && operation.name) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    operation = await codeAssistGet<LongRunningOperationResponse>(accessToken, operation.name);
  }

  const project = operation.response?.cloudaicompanionProject?.id ?? envProject;
  if (!project) throwProjectError(loadRes);
  return project;
}

async function loadCodeAssist(
  accessToken: string,
  envProject: string | undefined,
  metadata: Record<string, string>,
): Promise<CodeAssistLoadResponse> {
  try {
    return await codeAssistPost<CodeAssistLoadResponse>(accessToken, "loadCodeAssist", {
      ...(envProject ? { cloudaicompanionProject: envProject } : {}),
      metadata,
    });
  } catch (err) {
    if (err instanceof CodeAssistHttpError && isVpcScAffectedError(err)) {
      return { currentTier: { id: USER_TIER_STANDARD } };
    }
    if (
      err instanceof CodeAssistHttpError &&
      err.status === 403 &&
      envProject === "cloudshell-gca"
    ) {
      throw new Error(
        "Access to the default Cloud Shell Gemini project was denied.\n" +
          "Please set your own Google Cloud project by running:\n" +
          "gcloud config set project [PROJECT_ID]\n" +
          "or setting export GOOGLE_CLOUD_PROJECT=...",
        { cause: err },
      );
    }
    throw err;
  }
}

function getValidationRequiredTier(
  response: CodeAssistLoadResponse,
): (IneligibleTier & { validationUrl: string }) | undefined {
  return response.ineligibleTiers?.find(
    (tier): tier is IneligibleTier & { validationUrl: string } =>
      tier.reasonCode === VALIDATION_REQUIRED_REASON && typeof tier.validationUrl === "string",
  );
}

function getOnboardTier(response: CodeAssistLoadResponse): GeminiUserTier {
  const defaultTier = response.allowedTiers?.find((tier) => tier.isDefault);
  return defaultTier ?? { id: USER_TIER_LEGACY, name: "" };
}

function throwProjectError(response: CodeAssistLoadResponse): never {
  const reasons = response.ineligibleTiers
    ?.map((tier) => tier.reasonMessage ?? tier.tierName)
    .filter((reason): reason is string => Boolean(reason));
  if (reasons && reasons.length > 0) {
    throw new Error(`Gemini Code Assist setup failed: ${reasons.join(", ")}`);
  }
  throw new Error(
    "Gemini requires a Google Cloud project for this account. Set GOOGLE_CLOUD_PROJECT and try again.",
  );
}

async function codeAssistPost<T>(
  accessToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= CODE_ASSIST_POST_RETRIES; attempt++) {
    try {
      return await codeAssistRequest<T>(getCodeAssistMethodUrl(method), accessToken, method, {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (
        !(err instanceof CodeAssistHttpError) ||
        attempt === CODE_ASSIST_POST_RETRIES ||
        !shouldRetryCodeAssistStatus(err.status)
      ) {
        throw err;
      }
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, CODE_ASSIST_POST_RETRY_DELAY_MS));
  }

  throw lastError ?? new Error(`Gemini Code Assist ${method} failed.`);
}

async function codeAssistGet<T>(accessToken: string, operationName: string): Promise<T> {
  return codeAssistRequest<T>(getCodeAssistOperationUrl(operationName), accessToken, "operation", {
    method: "GET",
  });
}

async function codeAssistRequest<T>(
  url: string,
  accessToken: string,
  label: string,
  init: Pick<RequestInit, "method" | "body">,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: codeAssistHeaders(accessToken),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new CodeAssistHttpError(label, response.status, text);
  }

  return (await response.json()) as T;
}

function getCodeAssistBaseUrl(): string {
  const endpoint = process.env.CODE_ASSIST_ENDPOINT ?? CODE_ASSIST_BASE_URL;
  const version = process.env.CODE_ASSIST_API_VERSION || CODE_ASSIST_API_VERSION;
  return `${endpoint}/${version}`;
}

function getCodeAssistMethodUrl(method: string): string {
  return `${getCodeAssistBaseUrl()}:${method}`;
}

function getCodeAssistOperationUrl(operationName: string): string {
  return `${getCodeAssistBaseUrl()}/${operationName}`;
}

function shouldRetryCodeAssistStatus(status: number): boolean {
  return status === 429 || status === 499 || (status >= 500 && status <= 599);
}

function isVpcScAffectedError(error: CodeAssistHttpError): boolean {
  try {
    const parsed = JSON.parse(error.body) as unknown;
    if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return false;
    const details = (parsed as { error?: { details?: unknown[] } }).error?.details;
    return Array.isArray(details)
      ? details.some(
          (detail) =>
            detail != null &&
            typeof detail === "object" &&
            "reason" in detail &&
            detail.reason === VPC_SC_REASON,
        )
      : false;
  } catch {
    return false;
  }
}

function codeAssistHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-gemini-cli",
    "X-Goog-Api-Client": "gemini-cli/0.0.0",
  };
}

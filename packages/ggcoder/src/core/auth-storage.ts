import type { OAuthCredentials } from "@kenkaiiii/gg-core";
import { AuthStorage as CoreAuthStorage, NotLoggedInError } from "@kenkaiiii/gg-core";

export { NotLoggedInError, readStoredBaseUrlSync } from "@kenkaiiii/gg-core";

export const AZURE_OPENAI_PROVIDER = "azure";

export interface AzureOpenAIEnvironment {
  AZURE_OPENAI_API_KEY?: string;
  AZURE_OPENAI_BASE_URL?: string;
  AZURE_OPENAI_DEPLOYMENT?: string;
  AZURE_OPENAI_MODEL_ID?: string;
}

export interface AzureOpenAIConfig {
  apiKey: string;
  baseUrl: string;
  deployment: string;
  modelIdentity?: string;
}

const MAX_AZURE_DEPLOYMENT_BYTES = 256;
const UNICODE_CONTROL_CHARACTER = /\p{Cc}/u;

/** Azure configuration is usable only with a strict full Responses endpoint URL. */
export function resolveAzureOpenAIConfig(
  environment: AzureOpenAIEnvironment = process.env,
): AzureOpenAIConfig | undefined {
  const apiKey = environment.AZURE_OPENAI_API_KEY?.trim();
  const baseUrl = environment.AZURE_OPENAI_BASE_URL?.trim();
  const deployment = environment.AZURE_OPENAI_DEPLOYMENT?.trim();
  if (
    !apiKey ||
    !baseUrl ||
    !deployment ||
    !isAzureResponsesUrl(baseUrl) ||
    new TextEncoder().encode(deployment).byteLength > MAX_AZURE_DEPLOYMENT_BYTES ||
    UNICODE_CONTROL_CHARACTER.test(deployment)
  ) {
    return undefined;
  }
  const candidateIdentity = environment.AZURE_OPENAI_MODEL_ID?.trim();
  const modelIdentity =
    candidateIdentity &&
    new TextEncoder().encode(candidateIdentity).byteLength <= MAX_AZURE_DEPLOYMENT_BYTES &&
    !UNICODE_CONTROL_CHARACTER.test(candidateIdentity)
      ? candidateIdentity
      : undefined;
  return { apiKey, baseUrl, deployment, ...(modelIdentity ? { modelIdentity } : {}) };
}

function isAzureResponsesUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.pathname.endsWith("/responses")
    );
  } catch {
    return false;
  }
}

/**
 * App-layer auth boundary. Azure credentials remain ephemeral while every
 * persisted provider keeps the shared gg-core implementation unchanged.
 */
export class AuthStorage extends CoreAuthStorage {
  constructor(
    filePath?: string,
    private readonly environment: AzureOpenAIEnvironment = process.env,
  ) {
    super(filePath);
  }

  override async hasProviderAuth(provider: string): Promise<boolean> {
    if (provider === AZURE_OPENAI_PROVIDER) {
      return resolveAzureOpenAIConfig(this.environment) !== undefined;
    }
    return super.hasProviderAuth(provider);
  }

  override async isStaticApiKey(provider: string): Promise<boolean> {
    if (provider === AZURE_OPENAI_PROVIDER) return true;
    return super.isStaticApiKey(provider);
  }

  override async clearCredentials(provider: string): Promise<void> {
    if (provider === AZURE_OPENAI_PROVIDER) return;
    await super.clearCredentials(provider);
  }

  override async resolveCredentials(
    provider: string,
    options?: { forceRefresh?: boolean; storageKeys?: string[] },
  ): Promise<OAuthCredentials> {
    if (provider !== AZURE_OPENAI_PROVIDER) {
      return super.resolveCredentials(provider, options);
    }

    const config = resolveAzureOpenAIConfig(this.environment);
    if (!config) throw new NotLoggedInError(provider);
    return {
      accessToken: config.apiKey,
      refreshToken: "",
      expiresAt: Number.POSITIVE_INFINITY,
      baseUrl: config.baseUrl,
    };
  }
}

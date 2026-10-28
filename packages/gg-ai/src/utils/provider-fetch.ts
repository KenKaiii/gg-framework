import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

/**
 * Transport-level timeout for every LLM provider request.
 *
 * Node's built-in fetch runs on undici's default dispatcher, which aborts a
 * request after 300s without response headers (`UND_ERR_HEADERS_TIMEOUT`,
 * surfaced by the SDKs as "Request timed out.") and after 300s of silence
 * mid-body (`UND_ERR_BODY_TIMEOUT`, surfaced as "terminated"). Those caps sit
 * *below* the agent loop's own watchdogs (10min silent-thinking idle, 30min
 * thinking hard cap, 15min non-streaming thinking fallback), so they silently
 * become the real limit: a non-streaming reply that takes >5min to generate,
 * or a reasoning stream that stays quiet >5min, dies at exactly 300s on every
 * retry.
 *
 * Timeout policy belongs to the caller's AbortSignal (the agent loop's
 * watchdogs). This value is only a backstop for callers that pass no signal,
 * so it must stay above the longest agent-loop cap (30min).
 */
export const PROVIDER_TRANSPORT_TIMEOUT_MS = 45 * 60_000;

/**
 * Whether Node routes its own fetch through HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
 * Node turns that on for `--use-env-proxy` (command line or NODE_OPTIONS) or
 * `NODE_USE_ENV_PROXY=1`. A Node that doesn't know the flag refuses to start,
 * so a present flag is a supported one; the variable is silently ignored
 * before fetch support landed in 24.0.0 and 22.21.0. Node 22.12, which the
 * desktop app ships, therefore keeps provider requests direct like the rest
 * of its traffic.
 */
export function nodeUsesEnvProxy({
  env = process.env,
  execArgv = process.execArgv,
  nodeVersion = process.versions.node,
}: {
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  nodeVersion?: string;
} = {}): boolean {
  const flags = [...execArgv, ...(env.NODE_OPTIONS ?? "").split(/\s+/)];
  if (flags.includes("--use-env-proxy")) return true;
  if (env.NODE_USE_ENV_PROXY !== "1") return false;
  const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 21);
}

export interface ProviderFetchOptions {
  /**
   * Send requests through the HTTP(S)_PROXY / NO_PROXY environment variables.
   * Defaults to {@link nodeUsesEnvProxy}, so provider requests take the same
   * route as Node's built-in fetch.
   */
  useEnvProxy?: boolean;
}

/**
 * Build a fetch whose transport timeouts are `timeoutMs` instead of undici's
 * 300s defaults. Uses undici's own `fetch` together with its own dispatcher —
 * mixing an undici-package dispatcher with Node's bundled fetch is not
 * supported across undici majors.
 *
 * That dispatcher replaces Node's global one, so it must also replace Node's
 * env proxy: a plain `Agent` here sent every provider request direct, past a
 * proxy the user had turned on with NODE_USE_ENV_PROXY.
 */
export function createProviderFetch(
  timeoutMs: number,
  { useEnvProxy = nodeUsesEnvProxy() }: ProviderFetchOptions = {},
): typeof globalThis.fetch {
  const timeouts = { headersTimeout: timeoutMs, bodyTimeout: timeoutMs };
  const dispatcher = useEnvProxy ? new EnvHttpProxyAgent(timeouts) : new Agent(timeouts);
  const builtinFetch = globalThis.fetch;
  const providerFetch: typeof globalThis.fetch = async (input, init) => {
    // A host that replaced the global fetch (instrumentation, polyfills, test
    // doubles) keeps control of the transport, as it did before this existed.
    //
    // Global `Request` and `FormData` objects belong to Node's bundled undici,
    // and the package's fetch only recognises its own classes: a global
    // FormData is sent as the literal text "[object FormData]", which silently
    // broke multipart uploads (Moonshot video). Uploads are quick to answer,
    // so the 300s default timeouts are harmless for them.
    if (
      globalThis.fetch !== builtinFetch ||
      input instanceof Request ||
      init?.body instanceof FormData
    ) {
      return globalThis.fetch(input, init);
    }
    const response = await undiciFetch(input, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    });
    // undici's Response implements the same WHATWG interface as the global one.
    return response as unknown as Response;
  };
  // The OpenAI SDK refuses multipart uploads unless `fetch.Response` (else the
  // class of a probe response) encodes the global FormData. This fetch sends
  // global FormData through the built-in fetch above, so the global Response
  // class is the accurate answer; without it, Moonshot video uploads throw.
  return Object.assign(providerFetch, { Response: globalThis.Response });
}

/**
 * Wrap a fetch so `onActivity` fires for every body chunk of an SSE response.
 * Anthropic's SDK drops `ping` events before they reach us, so without this a
 * long silent-thinking stream (pings only, every 30s) looks dead to the watchdog.
 */
export function withBodyActivity(
  fetchImpl: typeof globalThis.fetch,
  onActivity: () => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      return response;
    }
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onActivity();
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(tap), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/** Default fetch for provider transports when the caller supplies none. */
export const providerFetch: typeof globalThis.fetch = createProviderFetch(
  PROVIDER_TRANSPORT_TIMEOUT_MS,
);

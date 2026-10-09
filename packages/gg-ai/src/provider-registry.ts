import type { StreamOptions } from "./types.js";
import type { StreamResult } from "./utils/event-stream.js";
import type { ProviderEmbedFn, ProviderRerankFn } from "./embed-types.js";

/**
 * A provider stream function. Takes StreamOptions and returns a StreamResult.
 * Each provider implements this to handle its specific API format.
 */
export type ProviderStreamFn = (options: StreamOptions) => StreamResult;

/** Capabilities a registered provider can offer. */
export type ProviderCapability = "stream" | "embed" | "rerank";

/**
 * Registry entry for a provider. A provider can have a simple stream function
 * or a more complex setup with custom routing logic. `embed` and `rerank` are
 * optional: leave them out when the provider has no such API, and `embed()` /
 * `rerank()` fail with a capability error instead.
 */
export interface ProviderEntry {
  /** Main stream function for this provider */
  stream: ProviderStreamFn;
  /** Embed one batch of texts. Batching, ordering checks and normalization are done by `embed()`. */
  embed?: ProviderEmbedFn;
  /** Default inputs per embedding request (the provider's documented maximum).
   *  Omit to send every input in one request. Callers can override with `batchSize`. */
  embedBatchSize?: number;
  /** Rerank documents against a query. Sorting and `topN` are applied by `rerank()`. */
  rerank?: ProviderRerankFn;
}

/**
 * Map-based provider registry. Built-in providers are registered at module load,
 * and extensions can register custom providers at runtime.
 */
class ProviderRegistryImpl {
  private providers = new Map<string, ProviderEntry>();

  /**
   * Register a provider. Overwrites any existing provider with the same name.
   *
   * ```ts
   * import { providerRegistry } from "@kenkaiiii/gg-ai";
   *
   * providerRegistry.register("deepseek", {
   *   stream: (options) => streamOpenAI({ ...options, baseUrl: "https://api.deepseek.com/v1" }),
   * });
   * ```
   */
  register(name: string, entry: ProviderEntry): void {
    this.providers.set(name, entry);
  }

  /** Remove a registered provider. */
  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  /** Get a provider entry by name. */
  get(name: string): ProviderEntry | undefined {
    return this.providers.get(name);
  }

  /** Check if a provider is registered. */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /** Whether a registered provider offers a capability (`false` for unknown providers). */
  supports(name: string, capability: ProviderCapability): boolean {
    const entry = this.providers.get(name);
    return typeof entry?.[capability] === "function";
  }

  /** List all registered provider names. */
  list(): string[] {
    return [...this.providers.keys()];
  }
}

/** Global provider registry. Import this to register custom providers. */
export const providerRegistry = new ProviderRegistryImpl();

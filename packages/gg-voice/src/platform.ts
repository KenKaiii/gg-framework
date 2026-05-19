import type { AudioInputChunk, AudioOutputChunk, JsonObject } from "./types.js";

export interface PlatformSecureTokenStore {
  getToken(key: string, signal?: AbortSignal): Promise<string | null>;
  setToken(key: string, value: string, signal?: AbortSignal): Promise<void>;
  deleteToken(key: string, signal?: AbortSignal): Promise<void>;
}

export interface OpenUrlRequest {
  readonly url: string;
  readonly fallbackUrl?: string;
}

export interface PlatformUrlOpener {
  canOpenUrl(url: string, signal?: AbortSignal): Promise<boolean>;
  openUrl(request: OpenUrlRequest, signal?: AbortSignal): Promise<void>;
}

export interface PlatformNotification {
  readonly title: string;
  readonly body?: string;
  readonly data?: JsonObject;
}

export interface PlatformAudioAdapter {
  startCapture(signal?: AbortSignal): Promise<AsyncIterable<AudioInputChunk>>;
  play(chunk: AudioOutputChunk, signal?: AbortSignal): Promise<void>;
  stop(reason?: string): Promise<void>;
}

export interface RelayRequest {
  readonly path: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface RelayResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface RelayHttpClient {
  send(request: RelayRequest, signal?: AbortSignal): Promise<RelayResponse>;
}

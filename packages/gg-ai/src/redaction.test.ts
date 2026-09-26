import { describe, expect, it } from "vitest";
import { REDACTION_MARKER, environmentSecrets, redactText, redactValue } from "./redaction.js";

const CANARY = "canary-super-secret-123456";

describe("redactText", () => {
  it.each([
    ["Bearer abcdefghijklmnop", "Bearer [REDACTED]"],
    ["Bearer abcDEF123ghiJKL456", "Bearer [REDACTED]"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", "Authorization: [REDACTED]"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", REDACTION_MARKER],
    ["token=abcdefghijklmnop", "token=[REDACTED]"],
    ["Cookie: session=abcdefghijklmnop; theme=dark", "Cookie: [REDACTED]"],
    ["https://alice:password123@example.com/path", "https://[REDACTED]@example.com/path"],
    ["sk-ant-api03-abcdefghijklmnop", REDACTION_MARKER],
  ])("redacts %s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("redacts private-key blocks", () => {
    const input = "before\n-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\nafter";
    expect(redactText(input)).toBe("before\n[REDACTED]\nafter");
  });

  it("redacts exact secrets and leaves short/common values alone", () => {
    expect(redactText(`secret=${CANARY} regular=hello`, { secrets: [CANARY, "hello"] })).toBe(
      "secret=[REDACTED] regular=hello",
    );
    expect(redactText("typescript tokenization monkey keyframe")).toBe(
      "typescript tokenization monkey keyframe",
    );
  });

  it.each([
    ["OPENAI_API_KEY=abcdefgh12345678", "OPENAI_API_KEY=[REDACTED]"],
    ['export GITHUB_TOKEN="ghx1234567890abcd"', 'export GITHUB_TOKEN="[REDACTED]"'],
    ["DB_PASSWORD: hunter2hunter2", "DB_PASSWORD: [REDACTED]"],
    [
      'const STRIPE_SECRET_KEY = "rk_live_abcdefgh1234";',
      'const STRIPE_SECRET_KEY = "[REDACTED]";',
    ],
    ["GET /cb?code=1&access_token=abcdefgh1234&x=1", "GET /cb?code=1&access_token=[REDACTED]&x=1"],
    ["client_secret=abcdefgh1234", "client_secret=[REDACTED]"],
    ["Bearer abc123def456ghi789", "Bearer [REDACTED]"],
    ["set-cookie: sid=abcdefgh1234; Path=/", "set-cookie: [REDACTED]"],
  ])("redacts credential form %s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  // Tool output is mostly source code: the model must see it verbatim or its
  // edits stop matching the file on disk.
  it.each([
    "const key = line.slice(0, colonIndex).trim().toLowerCase();",
    'if (key === "description") description = value;',
    "const token = await getToken(request);",
    "password: hashPassword(input.password),",
    "secret: process.env.JWT_SECRET,",
    "OPENAI_API_KEY: process.env.OPENAI_API_KEY,",
    "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "const API_KEY = import.meta.env.VITE_API_KEY;",
    "auth: { user: username, pass: password },",
    "headers: { cookie: req.headers.cookie },",
    "const cookie = parseCookie(header);",
    "This covers basic functionality and bearer authentication.",
    "PRUNE_PROTECT_TOKENS = 40_000",
    "MAX_KEY_LENGTH = 64",
    'const STORAGE_KEY = "gg-app:whatsNewVersion";',
    'const TOKEN_URL = "https://oauth2.googleapis.com/token";',
    "export const AUTH_PROVIDERS: readonly AuthProvider[] = [",
    "const AUTH_PATTERNS: RegExp[] = [",
    "--- PASS: TestParseConfig (0.00s)",
    "else process.env.GG_SESSION_TEST_SECRET = savedSecret;",
    "self.api_key = api_key",
  ])("leaves ordinary code untouched: %s", (input) => {
    expect(redactText(input)).toBe(input);
  });

  it("is idempotent", () => {
    const once = redactText(`Authorization: Bearer ${CANARY}`, { secrets: [CANARY] });
    expect(redactText(once, { secrets: [CANARY] })).toBe(once);
  });
});

describe("environmentSecrets", () => {
  it("collects only long values under sensitive names", () => {
    expect(
      environmentSecrets({
        OPENAI_API_KEY: CANARY,
        GITHUB_TOKEN: "github-token-1234",
        PASSWORD: "short",
        HOME: "/Users/example",
        EMPTY_SECRET: undefined,
      }),
    ).toEqual([CANARY, "github-token-1234"]);
  });
});

describe("redactValue", () => {
  it("immutably sanitizes nested values and sensitive keys", () => {
    const source = {
      ok: "ordinary",
      nested: { password: "tiny", note: `contains ${CANARY}` },
      count: 3,
      enabled: true,
    };
    const result = redactValue(source, { secrets: [CANARY] });

    expect(result).toEqual({
      ok: "ordinary",
      nested: { password: REDACTION_MARKER, note: "contains [REDACTED]" },
      count: 3,
      enabled: true,
    });
    expect(source.nested.password).toBe("tiny");
    expect(result).not.toBe(source);
    expect(result.nested).not.toBe(source.nested);
  });

  it("guards cycles, depth, and collection size", () => {
    const cyclic: Record<string, unknown> = { value: "safe" };
    cyclic.self = cyclic;
    expect(redactValue(cyclic)).toEqual({ value: "safe", self: "[CIRCULAR]" });
    expect(redactValue({ a: { b: "value" } }, { maxDepth: 1 })).toEqual({ a: "[TRUNCATED]" });
    expect(redactValue([1, 2, 3], { maxEntries: 2 })).toEqual([1, 2, "[TRUNCATED]"]);
  });

  it("clones an object shared by siblings instead of marking it circular", () => {
    // ask_user gives every option-less confirm question the same Yes/No array;
    // the second copy used to become "[CIRCULAR]" and crash the app's band.
    const shared = [{ label: "Yes" }, { label: "No" }];
    const result = redactValue({ a: { options: shared }, b: { options: shared } });
    expect(result).toEqual({ a: { options: shared }, b: { options: shared } });
  });

  it("preserves binary/media payload data while cloning media containers", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const media = { type: "image", data: "base64-image-data", mimeType: "image/png" };
    const result = redactValue({ bytes, media });
    expect(result.bytes).toBe(bytes);
    expect(result.media).toEqual(media);
    expect(result.media).not.toBe(media);
  });
});

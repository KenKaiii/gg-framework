import { stream, type Message, type Provider, type TextContent } from "@kenkaiiii/gg-ai";

const TITLE_PROMPT = `Generate an extremely short title (3-7 words) summarizing what the user is asking for. Just the title, nothing else. No quotes, no punctuation at the end.`;

/**
 * Makes a lightweight LLM call to generate a short session title
 * from the conversation so far. Uses the cheapest/fastest model
 * available for the given provider.
 */
export async function generateSessionTitle(opts: {
  provider: Provider;
  userMessage: string;
  assistantPreview: string;
  apiKey?: string;
  baseUrl?: string;
  accountId?: string;
  resolveCredentials?: () => Promise<{ apiKey: string; accountId?: string }>;
}): Promise<string> {
  // Resolve fresh credentials if available
  let apiKey = opts.apiKey;
  let accountId = opts.accountId;
  if (opts.resolveCredentials) {
    const creds = await opts.resolveCredentials();
    apiKey = creds.apiKey;
    accountId = creds.accountId;
  }

  // Use the cheapest model for title generation
  const model =
    opts.provider === "anthropic"
      ? "claude-haiku-4-5-20251001"
      : opts.provider === "openai"
        ? "gpt-5.1-codex-mini"
        : opts.provider === "glm"
          ? "glm-4.7-flash"
          : opts.provider === "moonshot"
            ? "kimi-k2.5"
            : "claude-haiku-4-5-20251001";

  const messages: Message[] = [
    { role: "system", content: TITLE_PROMPT },
    {
      role: "user",
      content: `User asked: "${truncate(opts.userMessage, 300)}"\n\nAssistant began: "${truncate(opts.assistantPreview, 200)}"`,
    },
  ];

  try {
    const result = stream({
      provider: opts.provider,
      model,
      messages,
      maxTokens: 30,
      temperature: 0,
      apiKey,
      baseUrl: opts.baseUrl,
      accountId,
    });

    // Attach a no-op catch immediately to prevent Node's unhandled rejection
    // detection from firing in the microtask gap before our await hooks up.
    result.response.catch(() => {});

    const response = await result;
    const msg = response.message;
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join("");

    return text.trim().replace(/[."]+$/, "") || "New conversation";
  } catch {
    // Silently fall back — title generation is best-effort
    return fallbackTitle(opts.userMessage);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function fallbackTitle(userMessage: string): string {
  if (!userMessage) return "New conversation";
  const cleaned = userMessage
    .replace(/^\/\S+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  const first = cleaned.split(/[.\n]/)[0]?.trim() ?? cleaned;
  if (first.length <= 50) return first;
  const t = first.slice(0, 50);
  const sp = t.lastIndexOf(" ");
  return (sp > 20 ? t.slice(0, sp) : t) + "…";
}

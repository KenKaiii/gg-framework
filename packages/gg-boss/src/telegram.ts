/**
 * Minimal Telegram Bot API client using raw fetch().
 * Supports long polling, markdown messages, inline keyboards, and message splitting.
 */

const TELEGRAM_API = "https://api.telegram.org";
const MAX_MESSAGE_LENGTH = 4096;

export interface TelegramConfig {
  botToken: string;
  /** Only accept messages from this Telegram user ID. */
  allowedUserId: number;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number; type: string; title?: string };
    text?: string;
    voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number } };
    data: string;
  };
  my_chat_member?: {
    chat: { id: number; type: string; title?: string };
    from: { id: number };
    new_chat_member: { status: string };
  };
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** Incoming message with chat context. */
export interface TelegramMessage {
  text: string;
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  chatTitle?: string;
}

/** Incoming voice note with chat context. */
export interface TelegramVoiceMessage {
  fileId: string;
  duration: number;
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  chatTitle?: string;
}

export class TelegramBot {
  private token: string;
  private allowedUserId: number;
  private offset = 0;
  private running = false;

  private onMessage: ((msg: TelegramMessage) => void) | null = null;
  private onVoiceMessage: ((msg: TelegramVoiceMessage) => void) | null = null;
  private onCallback: ((data: string, chatId: number) => void) | null = null;
  private onBotAdded: ((chatId: number, chatTitle?: string) => void) | null = null;
  private onBotRemoved: ((chatId: number) => void) | null = null;

  constructor(config: TelegramConfig) {
    this.token = config.botToken;
    this.allowedUserId = config.allowedUserId;
  }

  /** Register handler for incoming text messages. */
  onText(handler: (msg: TelegramMessage) => void): void {
    this.onMessage = handler;
  }

  /** Register handler for incoming voice notes. */
  onVoice(handler: (msg: TelegramVoiceMessage) => void): void {
    this.onVoiceMessage = handler;
  }

  /** Register handler for inline keyboard button presses. */
  onCallbackQuery(handler: (data: string, chatId: number) => void): void {
    this.onCallback = handler;
  }

  /** Register handler for when the bot is added to a group. */
  onAddedToGroup(handler: (chatId: number, chatTitle?: string) => void): void {
    this.onBotAdded = handler;
  }

  /** Register handler for when the bot is removed from a group. */
  onRemovedFromGroup(handler: (chatId: number) => void): void {
    this.onBotRemoved = handler;
  }

  /** Start long polling. Blocks until stop() is called. */
  async start(): Promise<void> {
    this.running = true;

    // Verify bot token works
    const me = await this.apiCall("getMe");
    if (!me.ok) {
      throw new Error(`Invalid bot token: ${JSON.stringify(me)}`);
    }

    let attempt = 0;
    while (this.running) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          await this.handleUpdate(update);
          // Advance offset only after successfully handling this update.
          // If handleUpdate throws, do NOT advance — so it will be retried.
          this.offset = update.update_id + 1;
        }
        attempt = 0;
      } catch (err) {
        if (!this.running) break;
        console.error(`[telegram] Poll error: ${err instanceof Error ? err.message : err}`);
        const delay = Math.min(3000 * 2 ** attempt, 30_000);
        const jitter = delay * (0.8 + Math.random() * 0.4);
        await sleep(jitter);
        attempt++;
      }
    }
  }

  /** Stop long polling. */
  stop(): void {
    this.running = false;
  }

  /** Send a text message to a specific chat. Converts markdown and splits long messages. */
  async send(chatId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
    const converted = toTelegramMarkdown(text);
    const chunks = splitMessage(converted);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const replyMarkup =
        isLast && buttons
          ? {
              inline_keyboard: buttons.map((row) =>
                row.map((b) => ({ text: b.text, callback_data: b.callback_data })),
              ),
            }
          : undefined;

      await this.apiCall("sendMessage", {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: "HTML",
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }
  }

  /** Send a plain text message (no markdown parsing) to a specific chat. */
  async sendPlain(chatId: number, text: string): Promise<void> {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await this.apiCall("sendMessage", {
        chat_id: chatId,
        text: chunk,
      });
    }
  }

  /** Send a typing indicator to a specific chat. */
  async sendTyping(chatId: number): Promise<void> {
    await this.apiCall("sendChatAction", {
      chat_id: chatId,
      action: "typing",
    });
  }

  /** Get a direct download URL for a Telegram file. */
  async getFileUrl(fileId: string): Promise<string> {
    const result = await this.apiCall("getFile", { file_id: fileId });
    if (!result.ok) throw new Error(`Failed to get file: ${JSON.stringify(result)}`);
    const filePath = (result.result as { file_path: string }).file_path;
    return `${TELEGRAM_API}/file/bot${this.token}/${filePath}`;
  }

  // ── Private ───────────────────────────────────────────

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.apiCall(
      "getUpdates",
      {
        offset: this.offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query", "my_chat_member"],
      },
      { signal: AbortSignal.timeout(35_000) },
    );

    if (!result.ok || !Array.isArray(result.result)) return [];
    return result.result as TelegramUpdate[];
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      const msg = update.message;

      // Auth check
      if (msg.from.id !== this.allowedUserId) {
        return;
      }

      if (msg.text && this.onMessage) {
        this.onMessage({
          text: msg.text,
          chatId: msg.chat.id,
          chatType: msg.chat.type as TelegramMessage["chatType"],
          chatTitle: msg.chat.title,
        });
      } else if (msg.voice && this.onVoiceMessage) {
        this.onVoiceMessage({
          fileId: msg.voice.file_id,
          duration: msg.voice.duration,
          chatId: msg.chat.id,
          chatType: msg.chat.type as TelegramMessage["chatType"],
          chatTitle: msg.chat.title,
        });
      }
    }

    // Bot membership changed in a group
    if (update.my_chat_member) {
      const member = update.my_chat_member;
      const status = member.new_chat_member.status;
      if ((status === "member" || status === "administrator") && this.onBotAdded) {
        this.onBotAdded(member.chat.id, member.chat.title);
      } else if ((status === "left" || status === "kicked") && this.onBotRemoved) {
        this.onBotRemoved(member.chat.id);
      }
    }

    if (update.callback_query) {
      const cb = update.callback_query;

      if (cb.from.id !== this.allowedUserId) return;

      await this.apiCall("answerCallbackQuery", { callback_query_id: cb.id });

      if (cb.data && this.onCallback) {
        this.onCallback(cb.data, cb.message.chat.id);
      }
    }
  }

  private async apiCall(
    method: string,
    body?: Record<string, unknown>,
    fetchInit?: RequestInit,
  ): Promise<{ ok: boolean; result?: unknown }> {
    const url = `${TELEGRAM_API}/bot${this.token}/${method}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      ...fetchInit,
    });

    if (!response.ok) {
      return { ok: false };
    }

    return response.json() as Promise<{ ok: boolean; result?: unknown }>;
  }
}

// ── Markdown Conversion ──────────────────────────────────

/**
 * Convert GitHub-flavored markdown to Telegram-compatible HTML.
 *
 * Telegram supports HTML: <b>, <i>, <code>, <pre>, <a href>
 * Does NOT support: headings, horizontal rules, tables, images
 */
function toTelegramMarkdown(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    let transformed = line;

    // Headings → bold text
    const headingMatch = transformed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      transformed = `<b>${headingMatch[2]}</b>`;
      result.push(transformed);
      continue;
    }

    // Horizontal rules → empty line
    if (/^(-{3,}|_{3,}|\*{3,})$/.test(transformed.trim())) {
      result.push("");
      continue;
    }

    // **bold** → <b>…</b>
    transformed = transformed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

    // _italic_ → <i>…</i>
    transformed = transformed.replace(/(?<!\*)_(.+?)_(?!\*)/g, "<i>$1</i>");

    // `code` → <code>…</code>
    transformed = transformed.replace(/`([^`]+)`/g, "<code>$1</code>");

    // [text](url) GFM links → just the link text (no raw link syntax)
    transformed = transformed.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

    result.push(transformed);
  }

  return result.join("\n");
}

// ── Helpers ───────────────────────────────────────────────

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH * 0.5) {
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

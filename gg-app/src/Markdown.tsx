import { memo, useCallback, useContext, useMemo, useRef, useState, createContext } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, CornerDownLeft } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openProjectPath, sendPrompt } from "./agent";
import { codeLanguage, codeNodeText } from "./markdown-prompt";
import { marked } from "marked";
import "highlight.js/styles/github-dark.css";

interface Props {
  children: string;
}

function isExternalHref(href: string): boolean {
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  return Boolean(scheme && scheme !== "file" && scheme.length > 1);
}

/**
 * Anchor that opens outside the webview. Browser links go to the OS browser;
 * file-ish links from the agent (`src/App.tsx`, `/abs/file.ts`, `file://…`) open
 * against the current project window's cwd. Shift/Cmd(Ctrl)+click reveals the
 * file in the system file manager (Finder / Explorer) instead of opening it.
 */
function ExternalLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (!href || href.startsWith("#")) return;
        e.preventDefault();
        if (isExternalHref(href)) {
          void openUrl(href);
        } else {
          void openProjectPath(href, e.shiftKey || e.metaKey || e.ctrlKey);
        }
      }}
    >
      {children}
    </a>
  );
}

/**
 * Select the word under a point, bypassing the host webview's selection
 * granularity. macOS WKWebView (what Tauri renders in) double-clicks a
 * preformatted block by *paragraph*, selecting the entire code block instead
 * of one word. We override that: resolve the caret at the click, expand to the
 * surrounding word, and set the selection ourselves. Returns false if we can't
 * resolve a caret (then the native behavior stands).
 */
function selectWordAtPoint(x: number, y: number): boolean {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) {
      node = p.offsetNode;
      offset = p.offset;
    }
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const text = node.textContent ?? "";
  if (!text) return false;
  // A "word" for code is a run of identifier characters; if the caret sits on a
  // non-word, non-space character, select the run of such symbols instead.
  const isWord = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  const isSpace = (c: string): boolean => /\s/.test(c);
  let start = Math.min(offset, text.length);
  const cls = (c: string): 0 | 1 | 2 => (isSpace(c) ? 0 : isWord(c) ? 1 : 2);
  // Anchor on the character to the right of the caret, else the one to the left.
  const here = start < text.length ? text[start] : (text[start - 1] ?? "");
  const kind = cls(here);
  if (kind === 0) return false; // whitespace — let the default (collapse) stand
  if (start >= text.length) start = text.length - 1;
  let end = start;
  while (start > 0 && cls(text[start - 1]) === kind) start--;
  while (end < text.length && cls(text[end]) === kind) end++;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const sel = window.getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/**
 * True once the surrounding Ken bubble has FINISHED streaming. While Ken is
 * still typing the prompt, this is false and the "Send to GG Coder" button is
 * withheld so the user can't fire a half-written prompt by accident. Defaults to
 * true so ordinary (non-streaming) renders — resumed history, GG Coder text —
 * always show the button. Provided by Markdown; consumed by PromptBlock.
 */
const PromptReadyContext = createContext(true);

/**
 * Handler the "Send to GG Coder" button calls when clicked. App provides one
 * that pushes a shimmering "Sent to GG Coder" user bubble into the transcript
 * (like a slash command renders) and then sends the prompt. Defaults to null, in
 * which case the button falls back to sending directly with no transcript row
 * (safe for any render outside App). */
const PromptSendContext = createContext<((text: string) => void) | null>(null);

/**
 * A Ken-recommended GG Coder prompt. Ken wraps every runnable prompt in a
 * ```prompt fence; we render the body in a styled block with a "Send to GG
 * Coder" button that fires it into the build session exactly as if the user
 * typed it. The button only appears once Ken's reply has finished streaming
 * (PromptReadyContext), and once sent it stays "Sent" so it's clear it landed.
 */
function PromptBlock({ body }: { body: string }): React.ReactElement {
  const ready = useContext(PromptReadyContext);
  const onSend = useContext(PromptSendContext);
  const [sent, setSent] = useState(false);
  const send = useCallback(() => {
    const text = body.replace(/\n$/, "").trim();
    if (!text) return;
    // Route through App so it can render the shimmering "Sent to GG Coder" user
    // bubble; fall back to a direct send if no handler is provided. Stays "Sent"
    // (disabled) afterward so the user can see it landed and can't double-fire.
    if (onSend) onSend(text);
    else void sendPrompt(text).catch(() => {});
    setSent(true);
  }, [body, onSend]);
  return (
    <div className="ken-prompt-block">
      <pre className="ken-prompt-body">{body.replace(/\n$/, "")}</pre>
      {ready && (
        <button
          type="button"
          className={`ken-prompt-send${sent ? " sent" : ""}`}
          onClick={send}
          disabled={sent}
          title={sent ? "Sent to GG Coder" : "Send this prompt to GG Coder"}
        >
          {sent ? <Check size={12} /> : <CornerDownLeft size={12} />}
          {sent ? "Sent" : "Send to GG Coder"}
        </button>
      )}
    </div>
  );
}

/**
 * Dispatch for ReactMarkdown's `pre` override. Hook-free so the branch is safe:
 * a ```prompt fence (Ken's runnable-prompt contract) renders as a PromptBlock
 * with a "Send to GG Coder" button; everything else is a normal CodeBlock.
 */
function PreBlock({ children }: { children?: React.ReactNode }): React.ReactElement {
  if (codeLanguage(children) === "prompt") {
    return <PromptBlock body={codeNodeText(children)} />;
  }
  return <CodeBlock>{children}</CodeBlock>;
}

/**
 * A fenced code block wrapped with a hover-revealed copy button. The raw text
 * is read from the rendered `<pre>` (so it includes the exact code, minus the
 * syntax-highlight markup). Double-click is handled manually (see
 * `selectWordAtPoint`) so it grabs one word, not the whole block.
 */
function CodeBlock({ children }: { children?: React.ReactNode }): React.ReactElement {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    const text = preRef.current?.innerText ?? "";
    if (!text) return;
    void navigator.clipboard
      .writeText(text.replace(/\n$/, ""))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="code-block">
      <button
        type="button"
        className="code-copy"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre
        ref={preRef}
        onDoubleClick={(e) => {
          if (selectWordAtPoint(e.clientX, e.clientY)) e.preventDefault();
        }}
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * Split markdown into top-level blocks (headings, paragraphs, code blocks,
 * lists, etc.) using marked's lexer. Each block becomes a separately memoized
 * component so that during streaming, only the last (active) block re-parses
 * — earlier completed blocks hit React.memo and skip re-rendering entirely.
 *
 * This is the technique used by Vercel Streamdown, Cline, and the Vercel AI
 * SDK cookbook. It reduces per-token cost from O(message_length) to O(block_length).
 */
function parseMarkdownIntoBlocks(markdown: string): string[] {
  try {
    const tokens = marked.lexer(markdown);
    return tokens.map((token) => token.raw);
  } catch {
    return [markdown];
  }
}

/**
 * Whether a marked block's raw text is a COMPLETE ```prompt fence (closing ```
 * present), as opposed to one still being streamed. marked auto-closes an open
 * fence into a code token at EOF, so a closed block's raw ends with ``` while a
 * still-streaming one ends with the body. This is what reveals Ken's "Send to GG
 * Coder" button the instant the prompt finishes, not when his whole reply ends.
 */
function isPromptBlockComplete(raw: string): boolean {
  const t = raw.trim();
  if (!/^`{3,}[ \t]*prompt\b/i.test(t)) return false;
  const firstNewline = t.indexOf("\n");
  if (firstNewline === -1) return false; // only the opening line so far
  const body = t.slice(firstNewline + 1).trimEnd();
  return /`{3,}\s*$/.test(body);
}

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    promptReady,
  }: {
    content: string;
    promptReady: boolean;
  }): React.ReactElement {
    const normalized = content.replace(/\\n/g, "\n").replace(/^\n+|\n+$/g, "");
    return (
      <PromptReadyContext.Provider value={promptReady}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{ a: ExternalLink, pre: PreBlock }}
        >
          {normalized}
        </ReactMarkdown>
      </PromptReadyContext.Provider>
    );
  },
  (prev, next) => prev.content === next.content && prev.promptReady === next.promptReady,
);

/**
 * Renders assistant text as GitHub-flavored markdown with syntax-highlighted
 * fenced code blocks. Mirrors the TUI's Markdown.tsx role in the web build.
 *
 * Splits the text into top-level blocks via marked.lexer() and memoizes each
 * block individually. During streaming, when text_delta grows the last
 * paragraph, only that paragraph re-parses — all earlier blocks (finished
 * code blocks, completed paragraphs) hit memo() and bail out.
 */
export const Markdown = memo(function Markdown({ children }: Props): React.ReactElement {
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);
  return (
    <div className="markdown">
      {blocks.map((block, index) => (
        // A ```prompt block reveals its "Send to GG Coder" button as soon as ITS
        // own closing fence arrives (per-block), not when the whole reply ends —
        // so the button shows right after Ken finishes the prompt even if he
        // keeps talking after it.
        <MemoizedMarkdownBlock
          key={index}
          content={block}
          promptReady={isPromptBlockComplete(block)}
        />
      ))}
    </div>
  );
});

/** Provider for the "Send to GG Coder" click handler. App wraps the transcript
 *  with this so prompt-block buttons push a transcript row + send. */
export const PromptSendProvider = PromptSendContext.Provider;

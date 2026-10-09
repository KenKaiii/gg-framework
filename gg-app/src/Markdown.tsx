import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  createContext,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CheckIcon, CopyIcon, ArrowElbowDownLeftIcon } from "@phosphor-icons/react";
import { openProjectPath, openUrl, sendPrompt } from "./agent";
import { toast } from "./toast";
import { codeLanguage, codeNodeText } from "./markdown-prompt";
import { collapsedCode, shouldCollapseCode, visibleBlockCount } from "./collapse";
import { marked } from "marked";
import { rehypeAnimateWords } from "./rehype-animate-words";
import { useAnimatedHeight } from "./animated-height";
import "highlight.js/styles/github-dark.css";

interface Props {
  children: string;
  /**
   * True while this text is actively streaming in: the trailing block wraps
   * its words in spans that fade in on mount. Off by default, and dropped
   * again once the stream settles, so finished prose carries no extra DOM.
   */
  animate?: boolean;
  /** Lets streaming content settle existing word effects on Activity return. */
  contentRef?: React.RefObject<HTMLDivElement | null>;
}

function isExternalHref(href: string): boolean {
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1].toLowerCase();
  return Boolean(scheme && scheme !== "file" && scheme.length > 1);
}

/**
 * Anchor that opens outside the webview. Browser links go to the OS browser;
 * file-ish links from the agent (`src/App.tsx`, `/abs/file.ts`, `file://…`) open
 * against the current project window's cwd.
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
        // No usable address: a link still streaming in (its placeholder is
        // blanked by react-markdown's URL filter), an unsafe one the filter
        // removed, or `[x]()`. Following an empty href would reload the app.
        if (!href) {
          e.preventDefault();
          return;
        }
        if (href.startsWith("#")) return;
        e.preventDefault();
        if (isExternalHref(href)) {
          void openUrl(href);
        } else {
          void openProjectPath(href);
        }
      }}
    >
      {children}
    </a>
  );
}

/**
 * A markdown table inside its own sideways-scrolling frame. Cells wrap only
 * between words (see `.md-table-scroll` in App.css), so when the columns'
 * narrowest readable widths add up to more than the chat is wide, the frame
 * scrolls instead of squeezing columns down to a letter each. The table keeps
 * `display: table` (a block-display table loses its table semantics for
 * VoiceOver), and the frame is focusable so a keyboard can scroll it.
 */
function ScrollTable({ children }: { children?: React.ReactNode }): React.ReactElement {
  return (
    <div className="md-table-scroll" tabIndex={0} role="region" aria-label="Table">
      <table>{children}</table>
    </div>
  );
}

/** Cells with at least this much text are sentences, not labels. */
const PROSE_CELL_CHARS = 24;

/**
 * A body cell. Sentence-length cells get a readable minimum width
 * (`.md-cell-prose`), so a wide table scrolls instead of squeezing them into a
 * word per line; short labels ("Low", "Done") keep their natural width. Only
 * `style` (GFM column alignment) is carried over from the parser.
 */
function TableCell({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  const prose = codeNodeText(children).length >= PROSE_CELL_CHARS;
  return (
    <td className={prose ? "md-cell-prose" : undefined} style={style}>
      {children}
    </td>
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
 * (like a slash command renders) and then sends the prompt. Resolves false when
 * the prompt never reached the agent, so the button can offer it again. Defaults
 * to null, in which case the button falls back to sending directly with no
 * transcript row (safe for any render outside App). */
const PromptSendContext = createContext<((text: string) => Promise<boolean>) | null>(null);

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
    // A send that failed re-enables the button so the prompt isn't lost.
    setSent(true);
    const delivered = onSend
      ? onSend(text)
      : sendPrompt(text).then(
          () => true,
          () => {
            toast("Couldn't send the prompt to GG Coder. Try again.", "error");
            return false;
          },
        );
    void delivered.then((ok) => {
      if (!ok) setSent(false);
    });
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
          {sent ? <CheckIcon size={12} /> : <ArrowElbowDownLeftIcon size={12} />}
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
  const [expanded, setExpanded] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);

  // Raw text drives both the copy fallback and the fold decision. The rendered
  // `children` is the highlighted tree; while folded we deliberately do NOT
  // mount it, so a thousand-line dump costs seven lines of DOM instead of a
  // thousand highlighted spans. That withheld markup is the memory win.
  const text = codeNodeText(children);
  const captureHeight = useAnimatedHeight(blockRef, expanded, expanded ? text : undefined);
  const collapsible = shouldCollapseCode(text);
  const folded = collapsible && !expanded;
  const { preview, hiddenLines } = collapsedCode(text);

  const copy = useCallback(() => {
    // Read the full source, not the folded preview, so copying a collapsed
    // block still yields the whole thing.
    const rendered = preRef.current?.innerText ?? "";
    const value = text || rendered;
    if (!value) return;
    void navigator.clipboard
      .writeText(value.replace(/\n$/, ""))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast("Couldn't copy to the clipboard.", "error"));
  }, [text]);

  return (
    <div ref={blockRef} className={`code-block${folded ? " folded" : ""}`}>
      <button
        type="button"
        className="code-copy"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
      >
        {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre
        ref={preRef}
        onDoubleClick={(e) => {
          if (selectWordAtPoint(e.clientX, e.clientY)) e.preventDefault();
        }}
      >
        {folded ? preview : children}
      </pre>
      {collapsible && (
        <button
          type="button"
          className="code-expand"
          onClick={() => {
            captureHeight();
            setExpanded(!expanded);
          }}
        >
          {folded ? `Show full output (${hiddenLines} more lines)` : "Show less"}
        </button>
      )}
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

const ANIMATED_PLUGINS = [rehypeHighlight, rehypeAnimateWords];
/**
 * How long a block keeps its word spans after a newer block starts below it.
 * Covers the reveal catching up plus the word fade (`--dur-row`, 220ms), so the
 * last words of a finished paragraph finish fading instead of snapping solid.
 */
const WORD_FADE_HOLD_MS = 450;
const PLUGINS = [rehypeHighlight];
const COMPONENTS = { a: ExternalLink, pre: PreBlock, table: ScrollTable, td: TableCell };

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    promptReady,
    animate,
  }: {
    content: string;
    promptReady: boolean;
    animate: boolean;
  }): React.ReactElement {
    const normalized = content.replace(/\\n/g, "\n").replace(/^\n+|\n+$/g, "");
    return (
      <PromptReadyContext.Provider value={promptReady}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={animate ? ANIMATED_PLUGINS : PLUGINS}
          components={COMPONENTS}
        >
          {normalized}
        </ReactMarkdown>
      </PromptReadyContext.Provider>
    );
  },
  (prev, next) =>
    prev.content === next.content &&
    prev.promptReady === next.promptReady &&
    prev.animate === next.animate,
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
export const Markdown = memo(function Markdown({
  children,
  animate = false,
  contentRef,
}: Props): React.ReactElement {
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children]);
  const [rowExpanded, setRowExpanded] = useState(false);
  const ownRootRef = useRef<HTMLDivElement>(null);
  const rootRef = contentRef ?? ownRootRef;
  const captureHeight = useAnimatedHeight(rootRef, rowExpanded, rowExpanded ? children : undefined);
  // Oversized content mounts only its leading blocks. Fenced-code folding above
  // handles one huge block; this handles the other shape, hundreds of ordinary
  // blocks in a single row, which no per-block rule would catch.
  const visibleCount = useMemo(() => visibleBlockCount(blocks), [blocks]);
  const rowFolded = !rowExpanded && visibleCount < blocks.length;
  const visible = rowFolded ? blocks.slice(0, visibleCount) : blocks;
  const lastIndex = visible.length - 1;
  // Blocks from `spanFrom` on carry word spans while the row animates. A block
  // that stops being the last one keeps them for WORD_FADE_HOLD_MS, so its
  // final words finish fading; dropping them at once cut those fades short and
  // the words snapped solid at the end of every paragraph. Blocks already on
  // screen at mount (history) never get spans.
  const [spanFrom, setSpanFrom] = useState(() => Math.max(0, lastIndex));
  const holdTimers = useRef(new Set<number>());
  useEffect(() => {
    if (!animate || lastIndex <= spanFrom) return;
    const timer = window.setTimeout(() => {
      holdTimers.current.delete(timer);
      setSpanFrom((prev) => Math.max(prev, lastIndex));
    }, WORD_FADE_HOLD_MS);
    holdTimers.current.add(timer);
    // Not cleared on the next block: each finished block gets its full hold.
  }, [animate, lastIndex, spanFrom]);
  useEffect(() => {
    const timers = holdTimers.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);
  return (
    <div ref={rootRef} className="markdown">
      {visible.map((block, index) => (
        // A ```prompt block reveals its "Send to GG Coder" button as soon as ITS
        // own closing fence arrives (per-block), not when the whole reply ends —
        // so the button shows right after Ken finishes the prompt even if he
        // keeps talking after it.
        <MemoizedMarkdownBlock
          key={index}
          content={block}
          promptReady={isPromptBlockComplete(block)}
          // Only the trailing block is still growing; the ones just above it
          // keep their spans briefly so their last words finish fading. Older
          // blocks stay memoized and span-free.
          animate={animate && index >= spanFrom}
        />
      ))}
      {rowFolded && (
        <button
          type="button"
          className="code-expand"
          onClick={() => {
            captureHeight();
            setRowExpanded(true);
          }}
        >
          {`Show full output (${blocks.length - visibleCount} more blocks)`}
        </button>
      )}
    </div>
  );
});

/** Provider for the "Send to GG Coder" click handler. App wraps the transcript
 *  with this so prompt-block buttons push a transcript row + send. */
export const PromptSendProvider = PromptSendContext.Provider;

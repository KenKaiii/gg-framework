// In-app preview of generated documents (Markdown, images, PDF, video).
//
// A tiny module-level store, like toast.ts: any component can ask for a preview
// without threading a context, and the single <FilePreviewHost/> mounted at the
// app root shows it. The file itself is read by Rust (`read_preview_file`).
import { openProjectPath } from "./agent";

export type PreviewKind = "markdown" | "image" | "pdf" | "video";

const KIND_BY_EXTENSION: Record<string, PreviewKind> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  svg: "image",
  pdf: "pdf",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
};

/** Kinds that are binary output rather than text someone may merely have mentioned. */
const MEDIA_KINDS: ReadonlySet<PreviewKind> = new Set(["image", "pdf", "video"]);

/**
 * What the preview can show for this path, from its extension. `null` for
 * anything else, and for a `file.md:12` style reference: that is a pointer into
 * source code, which belongs in the editor, not a rendered preview.
 */
export function previewKindOf(path: string): PreviewKind | null {
  const bare = path.trim().replace(/^file:\/\//, "");
  if (/:\d+(:\d+)?$/.test(bare.replace(/[?#].*$/, "")) || /#L\d+/.test(bare)) return null;
  const name = bare
    .replace(/[?#].*$/, "")
    .split(/[\\/]/)
    .pop();
  const ext = name?.includes(".") ? name.split(".").pop()?.toLowerCase() : undefined;
  return (ext && KIND_BY_EXTENSION[ext]) || null;
}

// ── Store ─────────────────────────────────────────────────

type Listener = (path: string | null) => void;
let current: string | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l(current);
}

export function subscribeFilePreview(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

export function openFilePreview(path: string): void {
  current = path;
  emit();
}

export function closeFilePreview(): void {
  if (current === null) return;
  current = null;
  emit();
}

/** Show the in-app preview when there is one for this path, else hand it to the OS. */
export function previewOrOpenPath(path: string): void {
  if (previewKindOf(path)) openFilePreview(path);
  else void openProjectPath(path);
}

// ── Auto-open setting ─────────────────────────────────────

const AUTO_KEY = "gg-preview-auto";

/** Whether a document the agent just generated opens by itself (default on). */
export function autoPreviewEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setAutoPreview(on: boolean): void {
  try {
    localStorage.setItem(AUTO_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// ── Spotting generated files ──────────────────────────────

const OUTPUT_PATH =
  /(?:^|[\s"'`(=:])((?:\/|~\/|[A-Za-z]:[\\/])[^\s"'`()<>|]+\.(?:pdf|mp4|m4v|mov|webm))(?=$|[\s"'`)>.,;:])/gi;

/** A file written inside a hidden folder (`.gg/plans`, `.git`) is bookkeeping, not a document to show. */
function inHiddenFolder(path: string): boolean {
  return /(^|[\\/])\.[^\\/.][^\\/]*[\\/]/.test(path.replace(/^~/, ""));
}

/**
 * Files a finished tool call produced that are worth opening: the `write` tool's
 * target, and a PDF or video named in a command's output (a render or an export).
 * Text mentioned in output (`cat README.md`) never counts, and neither does
 * anything in a hidden folder.
 */
export function generatedPreviewPaths(
  tool: string,
  args: Record<string, unknown>,
  result: string | undefined,
): string[] {
  const found: string[] = [];
  if (tool === "write" && typeof args.file_path === "string") {
    const target = args.file_path;
    if (previewKindOf(target) && !inHiddenFolder(target)) found.push(target);
  } else if (tool === "bash" && result) {
    for (const m of result.matchAll(OUTPUT_PATH)) {
      const kind = previewKindOf(m[1]);
      if (kind && MEDIA_KINDS.has(kind) && !inHiddenFolder(m[1])) found.push(m[1]);
    }
  }
  return [...new Set(found)];
}

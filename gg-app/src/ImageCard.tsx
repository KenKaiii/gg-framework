import { useState } from "react";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { saveChatImage } from "./agent";
import { toast } from "./toast";

const LAST_DIR_KEY = "gg-image-dir";

function lastDirectory(): string | null {
  try {
    return localStorage.getItem(LAST_DIR_KEY);
  } catch {
    return null;
  }
}

function rememberDirectory(savedPath: string): void {
  const dir = savedPath.replace(/[/\\][^/\\]*$/, "");
  try {
    if (dir) localStorage.setItem(LAST_DIR_KEY, dir);
  } catch {
    /* ignore */
  }
}

/**
 * Save this image wherever the user picks: the original file when it has one
 * (full size, never the smaller chat preview), else the in-memory image.
 */
function SaveImageButton({
  src,
  path,
  name,
}: {
  src: string;
  path?: string;
  name: string;
}): React.ReactElement {
  const [saving, setSaving] = useState(false);
  const saveImage = async (): Promise<void> => {
    setSaving(true);
    try {
      const saved = await saveChatImage({ path, src, directory: lastDirectory() });
      if (!saved) return; // cancelled: not an error, say nothing
      rememberDirectory(saved);
      toast(`Saved ${saved.split(/[/\\]/).pop() ?? name}`, "success");
    } catch (e) {
      toast(`Could not save image: ${String(e)}`, "error");
    } finally {
      setSaving(false);
    }
  };
  return (
    <button
      type="button"
      className="img-save"
      aria-label={`Save ${name}`}
      title="Save image"
      disabled={saving}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void saveImage();
      }}
    >
      <DownloadSimpleIcon size={14} weight="bold" aria-hidden />
    </button>
  );
}

/**
 * An image in the chat (tool output or a reply's markdown image): opens in the
 * default viewer when it has a file, and saves through the button at its
 * bottom-right corner. `inline` renders span-only markup, for use inside a <p>.
 */
export function ImageCard({
  src,
  alt,
  path,
  caption,
  title,
  inline = false,
  className,
  onOpen,
  onLoad,
  onError,
}: {
  src: string;
  alt: string;
  /** The image's file, when it has one: opens on click and is what gets saved. */
  path?: string;
  /** Text under the image; omitted for images without a file. */
  caption?: string;
  title?: string;
  inline?: boolean;
  className?: string;
  onOpen?: () => void;
  onLoad?: () => void;
  onError?: () => void;
}): React.ReactElement {
  const Root = inline ? "span" : "figure";
  const name = caption ?? path?.split(/[/\\]/).pop() ?? "image";
  const image = (
    <>
      <img className="img-thumb" src={src} alt={alt} onLoad={onLoad} onError={onError} />
      {caption && <span className="img-cap">{caption}</span>}
    </>
  );
  return (
    <Root
      className={`img-card${onOpen ? " img-card-clickable" : ""}${caption ? " has-cap" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      {onOpen ? (
        <button
          type="button"
          className="img-open"
          aria-label={`Open ${name}`}
          title={title}
          onClick={(e) => {
            // A markdown image can sit inside a link; opening the image must not follow it too.
            e.preventDefault();
            e.stopPropagation();
            onOpen();
          }}
        >
          {image}
        </button>
      ) : (
        image
      )}
      <SaveImageButton src={src} path={path} name={name} />
    </Root>
  );
}

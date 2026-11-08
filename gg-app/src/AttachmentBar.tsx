import { FileTextIcon, FilmStripIcon, XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import type { PendingAttachment } from "./attachments";

/**
 * Staged attachment chips shown above the chat input. Images show a thumbnail;
 * videos/files show an icon + name. Each has a remove button.
 */
export function AttachmentBar({
  attachments,
  onRemove,
  onOpenImage,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: number) => void;
  /** Open an image chip's preview (a data URL) in the default image viewer. */
  onOpenImage: (previewUrl: string) => void;
}): React.ReactElement | null {
  if (attachments.length === 0) return null;
  return (
    <div className="attach-bar">
      {attachments.map((a) => (
        <div key={a.id} className="attach-chip" title={a.name}>
          {a.previewUrl ? (
            <button
              type="button"
              className="attach-thumb-open"
              aria-label={`Open ${a.name}`}
              onClick={() => a.previewUrl && onOpenImage(a.previewUrl)}
            >
              <img className="attach-thumb" src={a.previewUrl} alt="" />
            </button>
          ) : (
            <span className="attach-icon" style={{ color: theme.textMuted }}>
              {a.kind === "video" ? <FilmStripIcon size={16} /> : <FileTextIcon size={16} />}
            </span>
          )}
          <span className="attach-name">{a.name}</span>
          <button
            className="attach-remove"
            aria-label={`Remove ${a.name}`}
            onClick={() => onRemove(a.id)}
          >
            <XIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

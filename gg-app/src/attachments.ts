import type { Attachment, AttachmentChip } from "./agent";

/** Raw bytes one message may attach. Matches MAX_DROPPED_FILE_BYTES (files.rs)
 *  and the sidecar's MAX_PROMPT_ATTACHMENT_BYTES, which sizes the /prompt body cap. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Decoded size of the attachments' base64 payloads. */
export function attachmentBytes(list: readonly Attachment[]): number {
  return list.reduce((total, a) => total + Math.floor((a.data.length * 3) / 4), 0);
}

/** Name chips for the sent bubble: everything but images, which show as thumbnails. */
export function attachmentChips(list: readonly Attachment[]): AttachmentChip[] | undefined {
  const chips = list.flatMap((a): AttachmentChip[] =>
    a.kind === "image" ? [] : [{ kind: a.kind, name: a.name }],
  );
  return chips.length > 0 ? chips : undefined;
}

/** A staged attachment in the input, with a local preview URL for images. */
export interface PendingAttachment extends Attachment {
  id: number;
  /** Object/data URL for inline image preview (images only). */
  previewUrl?: string;
}

let seq = 0;
const nextId = (): number => ++seq;

function kindForType(mime: string): Attachment["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** Read a browser File/Blob (clipboard paste, <input type=file>) into a pending
 *  attachment with base64 data and an image preview URL. */
export function fileToPending(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      // data:<mime>;base64,<data> — strip the prefix for the raw payload.
      const comma = result.indexOf(",");
      const data = comma >= 0 ? result.slice(comma + 1) : result;
      const mediaType = file.type || "application/octet-stream";
      const kind = kindForType(mediaType);
      resolve({
        id: nextId(),
        kind,
        name: file.name || `pasted.${mediaType.split("/")[1] ?? "bin"}`,
        mediaType,
        data,
        previewUrl: kind === "image" ? result : undefined,
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Strip the preview/id fields before sending over IPC. */
export function toWire(a: PendingAttachment): Attachment {
  return { kind: a.kind, name: a.name, mediaType: a.mediaType, data: a.data };
}

/** Stage an already-decoded Attachment (e.g. base64 read natively from a
 *  dropped file's path, which has no browser File object) as a pending
 *  attachment — same shape `fileToPending` builds from a File, so a native
 *  drop attaches identically to a paste/picker file. */
export function attachmentToPending(a: Attachment): PendingAttachment {
  return {
    ...a,
    id: nextId(),
    previewUrl: a.kind === "image" ? `data:${a.mediaType};base64,${a.data}` : undefined,
  };
}

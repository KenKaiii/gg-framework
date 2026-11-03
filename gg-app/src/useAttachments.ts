import { useState, useRef } from "react";
import { type PendingAttachment, fileToPending } from "./attachments";

export function useAttachments() {
  // Staged attachments (paste / attach button / whole-window drag-drop) shown above the input.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Attachment intake (paste / attach button / whole-window drag-drop) ──
  async function addFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    const pendings = await Promise.all(list.map((f) => fileToPending(f).catch(() => null)));
    const ok = pendings.filter((p): p is PendingAttachment => p !== null);
    if (ok.length > 0) setAttachments((prev) => [...prev, ...ok]);
  }

  function removeAttachment(id: number): void {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }
  return {
    attachments,
    setAttachments,
    isFileDragOver,
    setIsFileDragOver,
    fileInputRef,
    addFiles,
    removeAttachment,
  };
}

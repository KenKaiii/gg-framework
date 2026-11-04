import { useCallback, useEffect, useRef, useState } from "react";
import { type PendingAttachment, fileToPending } from "./attachments";
import { toast } from "./toast";

export function useAttachments() {
  // Staged attachments (paste / attach button / whole-window drag-drop) shown above the input.
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const attachmentReadsRef = useRef(0);
  const attachmentGenerationRef = useRef(0);
  const clearAttachments = useCallback((): void => {
    // A read started in an old session must not attach to a new one.
    attachmentGenerationRef.current++;
    attachmentReadsRef.current = 0;
    setAttachmentsLoading(false);
    setAttachments([]);
  }, []);
  useEffect(
    () => () => {
      attachmentGenerationRef.current++;
    },
    [],
  );
  const stageAttachments = useCallback(
    async (read: () => Promise<(PendingAttachment | null)[]>): Promise<void> => {
      const generation = attachmentGenerationRef.current;
      attachmentReadsRef.current++;
      setAttachmentsLoading(true);
      try {
        const loaded = await read();
        if (generation !== attachmentGenerationRef.current) return;
        const ok = loaded.filter((item): item is PendingAttachment => item !== null);
        if (ok.length > 0) setAttachments((previous) => [...previous, ...ok]);
        if (ok.length !== loaded.length)
          toast("Some attachments could not be loaded. Try again.", "error");
      } catch {
        if (generation === attachmentGenerationRef.current)
          toast("Attachments could not be loaded. Try again.", "error");
      } finally {
        if (generation === attachmentGenerationRef.current) {
          attachmentReadsRef.current--;
          setAttachmentsLoading(attachmentReadsRef.current > 0);
        }
      }
    },
    [],
  );
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Attachment intake (paste / attach button / whole-window drag-drop) ──
  async function addFiles(files: FileList | File[]): Promise<void> {
    const list = Array.from(files);
    await stageAttachments(() =>
      Promise.all(list.map((file) => fileToPending(file).catch(() => null))),
    );
  }

  function removeAttachment(id: number): void {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }
  return {
    attachments,
    setAttachments,
    attachmentsLoading,
    attachmentReadsRef,
    attachmentGenerationRef,
    clearAttachments,
    stageAttachments,
    isFileDragOver,
    setIsFileDragOver,
    fileInputRef,
    addFiles,
    removeAttachment,
  };
}

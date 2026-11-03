import { useState, useCallback } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { exportTranscriptName, saveTranscript } from "./agent";
import { toast } from "./toast";

export function useTranscriptExport() {
  // Transcript export (the download button in the activity bar). The chosen
  // folder is remembered so the second export lands where the first one did —
  // stored per-machine, not per-project, because that's how people organise
  // exports (one "agent transcripts" folder, many projects).
  const [exporting, setExporting] = useState(false);
  // The export pill only exists while the pointer is over the chat area. Kept
  // true while a save is in flight so the button doesn't vanish mid-click when
  // the native dialog steals the pointer and fires mouseleave.
  const [chatHovered, setChatHovered] = useState(false);
  const exportTranscript = useCallback(async () => {
    setExporting(true);
    try {
      const filename = (await exportTranscriptName()) ?? "your-chat.md";
      let lastDir: string | null = null;
      try {
        lastDir = localStorage.getItem("gg-export-dir");
      } catch {
        /* ignore */
      }
      const target = await save({
        title: "Save transcript",
        defaultPath: lastDir ? `${lastDir}/${filename}` : filename,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!target) return; // user cancelled — not an error, say nothing
      await saveTranscript(target);
      const dir = target.replace(/[/\\][^/\\]*$/, "");
      try {
        if (dir) localStorage.setItem("gg-export-dir", dir);
      } catch {
        /* ignore */
      }
      toast(`Saved ${target.split(/[/\\]/).pop() ?? "transcript"}`, "success");
    } catch (e) {
      toast(`Could not save transcript: ${String(e)}`, "error");
    } finally {
      setExporting(false);
    }
  }, []);
  return { exporting, chatHovered, setChatHovered, exportTranscript };
}

import { useState, useEffect, useCallback } from "react";
import type { AgentState } from "./agent";

export function useProjectNotes(state: AgentState | null) {
  const [notes, setNotes] = useState("");

  // Per-project notes: load from localStorage whenever the active project (cwd)
  // changes, and write back on every edit. Keyed by cwd so each project keeps
  // its own notebook; windows pointed at the same project share one.
  const notesKey = state?.cwd ? `gg-notes:${state.cwd}` : null;
  useEffect(() => {
    if (!notesKey) {
      setNotes("");
      return;
    }
    try {
      setNotes(localStorage.getItem(notesKey) ?? "");
    } catch {
      setNotes("");
    }
  }, [notesKey]);

  const handleNotesChange = useCallback(
    (value: string) => {
      setNotes(value);
      if (!notesKey) return;
      try {
        localStorage.setItem(notesKey, value);
      } catch {
        // Storage full/unavailable — keep the in-memory value for this session.
      }
    },
    [notesKey],
  );
  return { notes, handleNotesChange };
}

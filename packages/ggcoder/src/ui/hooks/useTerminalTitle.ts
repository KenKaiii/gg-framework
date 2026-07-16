import { useEffect, useRef } from "react";
import { useStdout } from "ink";

export interface TerminalTitleOptions {
  isRunning: boolean;
  cwd: string;
  gitBranch?: string | null;
}

export function useTerminalTitle({ isRunning, cwd, gitBranch }: TerminalTitleOptions): void {
  const { stdout } = useStdout();

  // Track previous title to avoid redundant writes
  const prevTitleRef = useRef("");

  // Write terminal title
  useEffect(() => {
    if (!stdout) return;
    const directory = cwd.split(/[\\/]/).filter(Boolean).pop();
    const context = directory ? `${directory}${gitBranch ? ` │ ⎇ ${gitBranch}` : ""}` : "GG Coder";
    const title = isRunning ? `● ${context}` : context;
    if (title !== prevTitleRef.current) {
      prevTitleRef.current = title;
      stdout.write(`\x1b]0;${title}\x1b\\`);
    }
  }, [stdout, isRunning, cwd, gitBranch]);

  // Reset title on unmount
  useEffect(() => {
    return () => {
      stdout?.write(`\x1b]0;GG Coder\x1b\\`);
    };
  }, [stdout]);
}

import { useEffect } from "react";
import { log } from "../../core/logger.js";

// SGR mouse protocol sequences
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";

// SGR mouse event: \x1b[<button;col;row(M|m)
// eslint-disable-next-line no-control-regex
const SGR_MOUSE_RE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;

const SCROLL_UP_BUTTON = 64;
const SCROLL_DOWN_BUTTON = 65;

interface UseMouseScrollOptions {
  onScrollUp: () => void;
  onScrollDown: () => void;
  isActive?: boolean;
}

export function useMouseScroll({
  onScrollUp,
  onScrollDown,
  isActive = true,
}: UseMouseScrollOptions): void {
  useEffect(() => {
    if (!isActive) return;

    process.stdout.write(MOUSE_ENABLE);

    const handler = (data: Buffer) => {
      const str = data.toString("utf8");
      const hex = [...data].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      log("INFO", "mouseScroll:raw", `bytes=[${hex}] str=${JSON.stringify(str)}`);
      let match: RegExpExecArray | null;
      SGR_MOUSE_RE.lastIndex = 0;
      while ((match = SGR_MOUSE_RE.exec(str)) !== null) {
        const button = Number(match[1]);
        if (button === SCROLL_UP_BUTTON) {
          log("INFO", "mouseScroll", `scroll UP detected (button=${button})`);
          onScrollUp();
        } else if (button === SCROLL_DOWN_BUTTON) {
          log("INFO", "mouseScroll", `scroll DOWN detected (button=${button})`);
          onScrollDown();
        } else {
          log("INFO", "mouseScroll", `other mouse event (button=${button})`);
        }
      }
    };

    process.stdin.on("data", handler);

    const exitHandler = () => {
      process.stdout.write(MOUSE_DISABLE);
    };
    process.on("exit", exitHandler);

    return () => {
      process.stdout.write(MOUSE_DISABLE);
      process.stdin.off("data", handler);
      process.off("exit", exitHandler);
    };
  }, [isActive, onScrollUp, onScrollDown]);
}

export { MOUSE_DISABLE };

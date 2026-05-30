/**
 * Minimal cumulative virtual terminal for tests. Applies the subset of ANSI/CSI
 * sequences Ink emits (cursor moves, erase line/screen, newlines) to a 2D cell
 * grid so tests can inspect the resulting on-screen state — what the user
 * actually sees — instead of the raw bytes of any single write.
 *
 * This matters once fullscreen frames render incrementally: a rerender no longer
 * rewrites the whole frame, so the only faithful way to assert layout (footer
 * pinning, row positions) is to replay every write into a screen buffer and read
 * the final grid.
 */
type CsiCommand = {
  params: string;
  final: string;
};

export class ScreenRecorder {
  readonly columns: number;
  readonly rows: number;
  private lines: string[][] = [[]];
  private cursorRow = 0;
  private cursorCol = 0;

  constructor({ columns, rows }: { columns: number; rows: number }) {
    this.columns = columns;
    this.rows = rows;
  }

  write(data: string): void {
    let index = 0;
    while (index < data.length) {
      const char = data[index];
      if (char === "\u001B") {
        const parsed = this.parseEscape(data, index);
        if (parsed === null) {
          index += 1;
          continue;
        }
        this.applyCsi(parsed.command);
        index = parsed.nextIndex;
        continue;
      }
      if (char === "\r") {
        this.cursorCol = 0;
        index += 1;
        continue;
      }
      if (char === "\n") {
        this.newLine();
        index += 1;
        continue;
      }
      this.putChar(char ?? " ");
      index += 1;
    }
  }

  /** The bottom `rows` lines of the buffer, trailing-trimmed. */
  viewportLines(): string[] {
    const rendered = this.lines.map((line) => line.join("").trimEnd());
    const start = Math.max(0, rendered.length - this.rows);
    return rendered.slice(start);
  }

  /** Whole buffer joined as text (trailing-trimmed per line). */
  fullText(): string {
    return this.lines.map((line) => line.join("").trimEnd()).join("\n");
  }

  /** 0-based row of the first viewport line containing `needle`, or -1. */
  footerRow(needle: string): number {
    return this.viewportLines().findIndex((line) => line.includes(needle));
  }

  private parseEscape(
    data: string,
    start: number,
  ): { command: CsiCommand; nextIndex: number } | null {
    if (data[start + 1] !== "[") return null;
    let index = start + 2;
    let params = "";
    while (index < data.length) {
      const char = data[index];
      if (char && /[A-Za-z~]/u.test(char)) {
        return { command: { params, final: char }, nextIndex: index + 1 };
      }
      params += char;
      index += 1;
    }
    return null;
  }

  private applyCsi({ params, final }: CsiCommand): void {
    if (params.startsWith("?") || params.startsWith(">")) return;
    if (final === "m") return;
    const values = params
      .split(";")
      .filter((part) => part.length > 0)
      .map((part) => Number(part));
    const first = Number.isFinite(values[0]) ? values[0]! : 0;

    if (final === "A") {
      this.cursorRow = Math.max(0, this.cursorRow - (first || 1));
      return;
    }
    if (final === "B") {
      this.cursorRow += first || 1;
      this.ensureLine(this.cursorRow);
      return;
    }
    if (final === "C") {
      this.cursorCol = Math.min(this.columns - 1, this.cursorCol + (first || 1));
      return;
    }
    if (final === "D") {
      this.cursorCol = Math.max(0, this.cursorCol - (first || 1));
      return;
    }
    if (final === "E") {
      this.cursorRow += first || 1;
      this.cursorCol = 0;
      this.ensureLine(this.cursorRow);
      return;
    }
    if (final === "F") {
      this.cursorRow = Math.max(0, this.cursorRow - (first || 1));
      this.cursorCol = 0;
      return;
    }
    if (final === "G") {
      this.cursorCol = Math.max(0, Math.min(this.columns - 1, (first || 1) - 1));
      return;
    }
    if (final === "H" || final === "f") {
      const row = Number.isFinite(values[0]) && values[0]! > 0 ? values[0]! - 1 : 0;
      const col = Number.isFinite(values[1]) && values[1]! > 0 ? values[1]! - 1 : 0;
      this.cursorRow = row;
      this.cursorCol = Math.max(0, Math.min(this.columns - 1, col));
      this.ensureLine(this.cursorRow);
      return;
    }
    if (final === "J") {
      if (first === 2 || first === 3) {
        this.lines = [[]];
        this.cursorRow = 0;
        this.cursorCol = 0;
      }
      return;
    }
    if (final === "K") {
      this.ensureLine(this.cursorRow);
      if (first === 2) {
        this.lines[this.cursorRow] = [];
        this.cursorCol = 0;
      } else {
        this.lines[this.cursorRow] = this.lines[this.cursorRow]!.slice(0, this.cursorCol);
      }
    }
  }

  private putChar(char: string): void {
    if (this.cursorCol >= this.columns) this.newLine();
    this.ensureLine(this.cursorRow);
    const line = this.lines[this.cursorRow]!;
    while (line.length < this.cursorCol) line.push(" ");
    line[this.cursorCol] = char;
    this.cursorCol += 1;
  }

  private newLine(): void {
    this.cursorRow += 1;
    this.cursorCol = 0;
    this.ensureLine(this.cursorRow);
  }

  private ensureLine(row: number): void {
    while (this.lines.length <= row) this.lines.push([]);
  }
}

/**
 * A stdout-shaped object that replays every write into a {@link ScreenRecorder}.
 * Mirrors the minimal surface Ink touches on a TTY stream.
 */
export function makeRecordingStdout(recorder: ScreenRecorder): NodeJS.WriteStream {
  return {
    columns: recorder.columns,
    rows: recorder.rows,
    isTTY: true,
    writable: true,
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    write(chunk: string, callback?: (error?: Error | null) => void) {
      recorder.write(chunk);
      callback?.(null);
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream;
}

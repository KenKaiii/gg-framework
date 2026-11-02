// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellBlock } from "./ShellBlock";
import { shellSegments, shellTail } from "./shell-output";
import type { ShellItem } from "./transcript-item";

afterEach(cleanup);

const base: ShellItem = {
  kind: "shell",
  id: 1,
  runId: "r1",
  command: "pnpm test",
  cwd: "/Users/me/gg-coder",
  status: "done",
  output: "",
};

const ERR = (s: string): string => `\uE000${s}\uE001`;

describe("shellTail", () => {
  it("finds where the newest lines start and counts them all", () => {
    const text = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const { start, total } = shellTail(text, 3);
    expect(total).toBe(20);
    expect(text.slice(start)).toBe("l18\nl19\nl20\n");
    expect(shellTail("a\nb", 3)).toEqual({ start: 0, total: 2 });
    expect(shellTail(`a\n${ERR("b\n")}`, 3).total).toBe(2);
  });
});

describe("shellSegments", () => {
  it("splits normal and error output in arrival order", () => {
    expect(shellSegments(`ok\n${ERR("bad\n")}${ERR("worse\n")}done`)).toEqual([
      { text: "ok\n", error: false },
      { text: "bad\nworse\n", error: true },
      { text: "done", error: false },
    ]);
  });

  it("keeps the error look when a fold starts inside error output", () => {
    const text = `a\n${ERR("e1\ne2\n")}z`;
    expect(shellSegments(text, text.indexOf("e2"))).toEqual([
      { text: "e2\n", error: true },
      { text: "z", error: false },
    ]);
    expect(shellSegments(text, text.indexOf("z"))).toEqual([{ text: "z", error: false }]);
  });
});

describe("ShellBlock", () => {
  it("asks before running, with the exact command and folder", () => {
    const confirm = vi.fn();
    render(
      <ShellBlock item={{ ...base, status: "confirm" }} actions={{ confirm, stop: vi.fn() }} />,
    );
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText("/Users/me/gg-coder")).toBeTruthy();
    const run = screen.getByRole("button", { name: "Run once" });
    expect(document.activeElement).toBe(run);
    fireEvent.keyDown(run, { key: "Escape" });
    expect(confirm).toHaveBeenCalledWith(1, "cancel");
    fireEvent.click(screen.getByRole("button", { name: "Always allow in this project" }));
    expect(confirm).toHaveBeenLastCalledWith(1, "always");
  });

  it("folds long output to its end and says whether GG has it", () => {
    const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    render(<ShellBlock item={{ ...base, output, exitCode: 1, durationMs: 4200, shared: false }} />);
    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(screen.getByText("4.2s")).toBeTruthy();
    expect(screen.getByText("GG will see this with your next message")).toBeTruthy();
    const pre = document.querySelector(".shell-run-out");
    expect(pre?.textContent?.startsWith("line 29")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show all 40 lines" }));
    expect(pre?.textContent?.startsWith("line 1\n")).toBe(true);
  });

  it("shows error output apart and copies plain text", () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ShellBlock item={{ ...base, output: `ok\n${ERR("boom\n")}`, exitCode: 1 }} />);
    expect(document.querySelector(".shell-run-err")?.textContent).toBe("boom");
    fireEvent.click(screen.getByRole("button", { name: "Copy output" }));
    expect(writeText).toHaveBeenCalledWith("ok\nboom");
  });

  it("offers Stop while running", () => {
    const stop = vi.fn();
    render(
      <ShellBlock
        item={{ ...base, status: "running", startedAt: Date.now() }}
        actions={{ confirm: vi.fn(), stop }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop pnpm test" }));
    expect(stop).toHaveBeenCalledWith(1);
  });
});

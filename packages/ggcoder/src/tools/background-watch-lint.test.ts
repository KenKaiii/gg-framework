import { describe, expect, it } from "vitest";
import { backgroundWatchWarnings } from "./background-watch-lint.js";

describe("backgroundWatchWarnings", () => {
  it("flags gh run watch without --exit-status, which exits 0 on a failed run", () => {
    const warnings = backgroundWatchWarnings("gh run watch 123 --interval 30");
    expect(warnings.some((w) => w.includes("--exit-status"))).toBe(true);
    expect(backgroundWatchWarnings("gh run watch 123 --exit-status --interval 30")).toEqual([]);
  });

  it("flags output discarded or diverted away from the task log", () => {
    // Real commands from session logs that hid a mid-run CI failure.
    const discarded = backgroundWatchWarnings(
      'gh run watch 1 --exit-status >/dev/null && echo "CI GREEN"',
    );
    expect(discarded.some((w) => w.includes("discards its output"))).toBe(true);

    const diverted = backgroundWatchWarnings('pnpm test > /tmp/t.log 2>&1; echo "EXIT $?"');
    expect(diverted.some((w) => w.includes("writes its output to /tmp/t.log"))).toBe(true);

    const loop = backgroundWatchWarnings(
      "while :; do gh run view 1 --json status; sleep 30; done > /tmp/poll.log 2>&1",
    );
    expect(loop.some((w) => w.includes("/tmp/poll.log"))).toBe(true);
  });

  it("leaves stderr-only redirects, heredoc scripts and file writes alone", () => {
    expect(backgroundWatchWarnings("pnpm dev 2>/dev/null")).toEqual([]);
    expect(backgroundWatchWarnings("pnpm dev 2>&1 | tee -a /tmp/dev.log")).toEqual([]);
    expect(
      backgroundWatchWarnings(
        "cat > /tmp/watch.mjs <<'EOF'\nif (a > b) console.log(a)\nEOF\nnode /tmp/watch.mjs",
      ),
    ).toEqual([]);
    expect(
      backgroundWatchWarnings(
        'for i in $(seq 1 60); do v=$(npm view pkg version 2>/dev/null); echo "$v"; sleep 10; done',
      ),
    ).toEqual([]);
    expect(backgroundWatchWarnings('node server.js --banner "a > b"')).toEqual([]);
  });
});

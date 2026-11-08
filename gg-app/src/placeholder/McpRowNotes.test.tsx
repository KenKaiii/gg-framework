// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerRow } from "../agent";
import { McpRowNotes, mcpRowNoteLines } from "./McpRowNotes";

afterEach(cleanup);

const BASE: McpServerRow = {
  name: "notes",
  scope: "global",
  ok: true,
  toolCount: 4,
  kind: "stdio",
  summary: "npx notes-mcp",
};

describe("MCP row notes", () => {
  it("shows nothing for a healthy server", () => {
    const { container } = render(<McpRowNotes server={BASE} />);
    expect(container.firstChild).toBeNull();
  });

  it("puts a blocked connect error first, flagged", () => {
    expect(
      mcpRowNoteLines({
        ...BASE,
        ok: false,
        error: "Blocked: notes-mcp@1.0.0 is known malware\nmore detail",
      }),
    ).toEqual([{ text: "Blocked: notes-mcp@1.0.0 is known malware", attention: true }]);
    expect(mcpRowNoteLines({ ...BASE, ok: false, error: "connect ECONNREFUSED" })).toEqual([
      { text: "connect ECONNREFUSED", attention: false },
    ]);
  });

  it("leaves a sign-in failure to the row's Sign in button", () => {
    expect(mcpRowNoteLines({ ...BASE, ok: false, requiresAuth: true, error: "401" })).toEqual([]);
  });

  it("lists up to three hidden tools without repeating the server, then counts the rest", () => {
    const warning = [1, 2, 3, 4, 5]
      .map((n) => `Hid tool t${n} from server "notes": it tells the model to ignore rules`)
      .join("\n");
    render(<McpRowNotes server={{ ...BASE, warning }} />);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Hid tool t1: it tells the model to ignore rules",
      "Hid tool t2: it tells the model to ignore rules",
      "Hid tool t3: it tells the model to ignore rules",
      "and 2 more hidden",
    ]);
    expect(screen.getByRole("list", { name: "Notes for notes" })).toBeTruthy();
  });
});

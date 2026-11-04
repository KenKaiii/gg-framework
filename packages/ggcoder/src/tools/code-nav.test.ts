import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createCodeNavTool } from "./code-nav.js";
import { LspManager } from "../core/lsp/manager.js";
import { removeWhenReleased } from "../core/lsp/test-support.js";
import type { LspServerSpec } from "../core/lsp/servers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "./__fixtures__/fake-lsp-server.mjs",
);

function fakeSpec(serverArgs: string[] = []): LspServerSpec {
  return {
    id: "fake",
    extensions: [".fake"],
    rootMarkers: ["fake-root.json"],
    languageIdFor: () => "fake",
    resolveCommand: () => ({ command: process.execPath, args: [FIXTURE, ...serverArgs] }),
  };
}

const SOURCE = "class Widget {\n  render() {}\n}\nconst widget = new Widget();\n";

function context() {
  return { signal: new AbortController().signal, toolCallId: "test" };
}

describe("code_nav", () => {
  let tmpDir: string;
  let managers: LspManager[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-nav-test-"));
    await fs.writeFile(path.join(tmpDir, "fake-root.json"), "{}");
    await fs.writeFile(path.join(tmpDir, "widget.fake"), SOURCE);
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) manager.shutdownAll();
    await removeWhenReleased(tmpDir);
  });

  function tool(spec: LspServerSpec = fakeSpec(), budgetMs = 5000) {
    const manager = new LspManager(tmpDir, {
      catalog: [spec],
      warmBudgetMs: budgetMs,
      firstBudgetMs: budgetMs,
    });
    managers.push(manager);
    return createCodeNavTool(tmpDir, manager);
  }

  it("resolves a definition to path:line:col with a snippet", async () => {
    const result = await tool().execute(
      { op: "definition", file: "widget.fake", line: 4, symbol: "Widget" },
      context(),
    );
    expect(String(result)).toBe("widget.fake:1:7 — class Widget {");
  });

  it("puts partial-coverage warnings before reference results", async () => {
    const manager = new LspManager(tmpDir, { catalog: [fakeSpec()] });
    managers.push(manager);
    vi.spyOn(manager, "references").mockResolvedValue({
      kind: "ok",
      filePath: path.join(tmpDir, "widget.fake"),
      serverId: "fake",
      value: [],
      warning: "Reference coverage is partial. Use grep to check additional callers.",
    });
    const navigation = createCodeNavTool(tmpDir, manager);
    // The description no longer pre-warns; the partial-coverage notice rides on the result.
    expect(navigation.description).toContain("references (callers)");
    const result = String(
      await navigation.execute(
        { op: "references", file: "widget.fake", line: 1, symbol: "Widget" },
        context(),
      ),
    );
    expect(result.startsWith("Reference coverage is partial")).toBe(true);
    expect(result).toContain("Use grep to check additional callers");
  });

  it("lists references", async () => {
    const result = String(
      await tool().execute(
        { op: "references", file: "widget.fake", line: 1, symbol: "Widget" },
        context(),
      ),
    );
    expect(result).toContain("widget.fake:1:7 — class Widget {");
    expect(result).toContain("widget.fake:3:3 — }");
  });

  it("outlines a file's symbols with containers and kinds", async () => {
    const result = String(await tool().execute({ op: "symbols", file: "widget.fake" }, context()));
    expect(result).toContain("class Widget");
    expect(result).toContain("method Widget.render (): void");
  });

  it("lists the outline in document order, not the server's order", async () => {
    const result = String(await tool().execute({ op: "symbols", file: "widget.fake" }, context()));
    const lines = result.split("\n");
    const lineNumbers = lines.map((l) => Number(l.split(":")[0]));
    // The fixture answers grouped by name (helper before Widget) exactly as
    // tsserver does; the outline has to be readable against the file instead.
    expect(lineNumbers).toEqual([...lineNumbers].sort((a, b) => a - b));
    expect(lines[0]).toContain("Widget");
  });

  it("keeps class members but drops locals from inside function bodies", async () => {
    const result = String(await tool().execute({ op: "symbols", file: "widget.fake" }, context()));
    expect(result).toContain("method Widget.render");
    expect(result).toContain("function helper");
    // `tmp` and `i` live inside helper's body — noise, not structure.
    expect(result).not.toContain("helper.tmp");
    expect(result).not.toContain("helper.i");
  });

  it("filters the outline by symbol name", async () => {
    const result = String(
      await tool().execute({ op: "symbols", file: "widget.fake", symbol: "render" }, context()),
    );
    expect(result).toContain("render");
    expect(result).not.toContain("class Widget\n");
  });

  it("returns hover text", async () => {
    const result = String(
      await tool().execute(
        { op: "hover", file: "widget.fake", line: 4, symbol: "widget" },
        context(),
      ),
    );
    expect(result).toContain("const widget: Widget");
  });

  it("caps results and says how many were withheld", async () => {
    const result = String(
      await tool().execute(
        { op: "references", file: "widget.fake", line: 1, symbol: "Widget", max_results: 1 },
        context(),
      ),
    );
    expect(result).toContain("widget.fake:1:7");
    expect(result).toContain("1 more result(s) not shown");
  });

  it("says a server is missing instead of reporting no results", async () => {
    const result = String(
      await tool({ ...fakeSpec(), resolveCommand: () => null }).execute(
        { op: "references", file: "widget.fake", line: 1, symbol: "Widget" },
        context(),
      ),
    );
    expect(result).toContain("No language server is installed");
    expect(result).not.toContain("No references found");
  });

  it("says the capability is missing when the server lacks it", async () => {
    const result = String(
      await tool(fakeSpec(["--no-nav"])).execute(
        { op: "definition", file: "widget.fake", line: 1, symbol: "Widget" },
        context(),
      ),
    );
    expect(result).toContain("does not implement `definition`");
  });

  it("says it timed out rather than returning nothing", async () => {
    const result = String(
      await tool(fakeSpec(["--nav-silent"]), 200).execute(
        { op: "references", file: "widget.fake", line: 1, symbol: "Widget" },
        context(),
      ),
    );
    expect(result).toContain("did not answer");
  });

  it("reports an unsupported file type", async () => {
    await fs.writeFile(path.join(tmpDir, "notes.unknown"), "text\n");
    const result = String(
      await tool().execute({ op: "symbols", file: "notes.unknown" }, context()),
    );
    expect(result).toContain("No language server is configured");
  });

  it("asks for a symbol or a line when given neither", async () => {
    const result = String(await tool().execute({ op: "hover", file: "widget.fake" }, context()));
    expect(result).toContain("Pass `symbol`");
  });

  it("resolves from the symbol name alone, with no line", async () => {
    // The common case: you know what it is called, not where it sits. Needing
    // both forced a grep round-trip before every call.
    const result = String(
      await tool().execute({ op: "definition", file: "widget.fake", symbol: "Widget" }, context()),
    );
    expect(result).toBe("widget.fake:1:7 — class Widget {");
  });

  it("says so plainly when the symbol is nowhere in the file", async () => {
    const result = String(
      await tool().execute(
        { op: "references", file: "widget.fake", symbol: "nonexistentSymbol" },
        context(),
      ),
    );
    expect(result).toContain("does not appear in this file");
  });

  it("rejects a symbol that is not on the given line", async () => {
    const result = String(
      await tool().execute(
        { op: "definition", file: "widget.fake", line: 2, symbol: "Widget" },
        context(),
      ),
    );
    expect(result).toContain("does not appear on line 2");
  });

  it("reports a missing file instead of throwing", async () => {
    const result = String(await tool().execute({ op: "symbols", file: "nope.fake" }, context()));
    expect(result).toContain("Cannot read nope.fake");
  });

  it("states plainly when language-server support is off", async () => {
    const result = String(
      await createCodeNavTool(tmpDir, undefined).execute(
        { op: "symbols", file: "widget.fake" },
        context(),
      ),
    );
    expect(result).toContain("language-server support is disabled");
  });
});

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMotionBundle } from "../core/skills.js";

const execFileAsync = promisify(execFile);

type Audit = {
  auditSource: (source: string) => string[];
  KINDS: string[];
  TOKENS: string[];
};
type LibraryIndex = {
  kinds: string[];
  looks: Array<{ id: string; fonts: string[]; pieces: string[] }>;
  pieces: Array<{
    id: string;
    kind: string;
    fonts: string[];
    license: string;
    duration: number;
    requires?: string[];
  }>;
};
type Result = {
  ok: boolean;
  error?: string;
  added?: string[];
  kept?: string[];
  mount?: string[];
  importmap?: string;
  kit?: string;
  head?: string[];
  results?: Array<{ id: string }>;
  looks?: Array<{ id: string; preview: string }>;
  pieces?: Array<{ id: string; kind: string; preview: string }>;
  sheets?: Record<string, string>;
};

async function motionRoot(): Promise<string> {
  const bundle = await findMotionBundle();
  if (!bundle) throw new Error("motion bundle missing");
  return bundle.root;
}

async function loadIndex(): Promise<LibraryIndex> {
  const root = await motionRoot();
  return JSON.parse(
    await fs.readFile(path.join(root, "library", "library.json"), "utf8"),
  ) as LibraryIndex;
}

/** The build script's own rules, so the tests and the build cannot drift apart. */
async function loadAudit(): Promise<Audit> {
  const root = await motionRoot();
  const file = path.join(root, "..", "..", "scripts", "motion-library-audit.mjs");
  return (await import(pathToFileURL(file).href)) as Audit;
}

async function lib(args: string[]): Promise<{ code: number; out: Result }> {
  const root = await motionRoot();
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(root, "bin", "library.mjs"),
      ...args,
    ]);
    return { code: 0, out: JSON.parse(stdout) as Result };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string };
    return { code: failed.code ?? 1, out: JSON.parse(failed.stdout ?? "{}") as Result };
  }
}

describe("Motion style library", () => {
  let tmp = "";
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gg-motion-lib-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("indexes exactly the entries on disk, each with a preview and passing the audit", async () => {
    const root = await motionRoot();
    const index = await loadIndex();
    const audit = await loadAudit();
    const onDisk = async (dir: string): Promise<string[]> =>
      (await fs.readdir(path.join(root, "library", dir))).filter((d) => !d.startsWith(".")).sort();

    // A folder added or removed without rebuilding the index would ship stale.
    expect(index.looks.map((l) => l.id).sort()).toEqual(await onDisk("looks"));
    expect(index.pieces.map((p) => p.id).sort()).toEqual(await onDisk("pieces"));
    expect(index.looks.length).toBeGreaterThanOrEqual(8);
    expect(index.pieces.length).toBeGreaterThanOrEqual(40);

    for (const look of index.looks) {
      const dir = path.join(root, "library", "looks", look.id);
      const tokens = await fs.readFile(path.join(dir, "tokens.css"), "utf8");
      for (const token of audit.TOKENS)
        expect(tokens, `${look.id} ${token}`).toContain(`${token}:`);
      expect(audit.auditSource(await fs.readFile(path.join(dir, "sample.html"), "utf8"))).toEqual(
        [],
      );
      await expect(fs.access(path.join(dir, "preview.jpg"))).resolves.toBeUndefined();
      for (const piece of look.pieces) {
        expect(
          index.pieces.some((p) => p.id === piece),
          `${look.id} → ${piece}`,
        ).toBe(true);
      }
    }
    for (const piece of index.pieces) {
      const dir = path.join(root, "library", "pieces", piece.id);
      const source = await fs.readFile(path.join(dir, "piece.html"), "utf8");
      expect(audit.KINDS).toContain(piece.kind);
      expect(audit.auditSource(source), piece.id).toEqual([]);
      expect(source).toContain(`data-composition-id="${piece.id}"`);
      expect(source).toContain(`window.__timelines["${piece.id}"]`);
      await expect(fs.access(path.join(dir, "preview.jpg"))).resolves.toBeUndefined();
      if (piece.license === "MIT") {
        const notice = await fs.readFile(path.join(dir, "LICENSE"), "utf8");
        expect(notice, piece.id).toMatch(/MIT License[\s\S]*Copyright/);
      } else {
        expect(piece.license, piece.id).toBe("original");
      }
    }
  });

  it("rejects non-deterministic and network-dependent code", async () => {
    const { auditSource } = await loadAudit();

    expect(auditSource("const x = Math.random();")).toContain(
      "Math.random (use a seeded generator)",
    );
    expect(auditSource("requestAnimationFrame(tick)")).toContain("requestAnimationFrame loop");
    expect(auditSource(".a{animation: spin 1s linear infinite}")).toContain(
      "infinite CSS animation",
    );
    expect(auditSource('<img src="https://example.com/a.png">')).toContain(
      "remote URL https://example.com/a.png",
    );
    expect(
      auditSource('<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js">'),
    ).toEqual([]);
  });

  it("lists, searches and shows entries with preview images", async () => {
    const list = await lib(["list"]);
    expect(list.out.ok).toBe(true);
    await expect(fs.access(list.out.sheets?.looks ?? "")).resolves.toBeUndefined();
    for (const entry of [...(list.out.looks ?? []), ...(list.out.pieces ?? [])]) {
      await expect(fs.access(entry.preview), entry.id).resolves.toBeUndefined();
    }

    const kind = await lib(["list", "pieces", "--kind", "background"]);
    expect(kind.out.pieces?.every((p) => p.kind === "background")).toBe(true);
    expect(kind.out.looks).toEqual([]);

    const search = await lib(["search", "typewriter", "caption"]);
    expect(search.out.results?.[0]?.id).toBe("typewriter-caption");

    expect((await lib(["show", "nope"])).code).not.toBe(0);
    expect((await lib(["list", "pieces", "--kind", "nope"])).out.error).toContain("Unknown kind");
  });

  it("installs a look's tokens and fonts into a project", async () => {
    const result = await lib(["look", tmp, "duotone-broadcast"]);

    expect(result.code).toBe(0);
    const css = await fs.readFile(
      path.join(tmp, "assets", "looks", "duotone-broadcast.css"),
      "utf8",
    );
    expect(css).toContain(".look-duotone-broadcast");
    const fonts = await fs.readFile(path.join(tmp, "assets", "fonts", "fonts.css"), "utf8");
    expect(fonts).toContain('font-family: "Archivo";');
    // Fonts go in the page itself; `hf check` reports fonts from a linked fonts.css as missing.
    const [fontBlock, tokens] = result.out.head ?? [];
    expect(fontBlock).toMatch(/^<style>\n[\s\S]*font-family: "Archivo";[\s\S]*\n<\/style>$/);
    expect(fontBlock).toContain('url("assets/fonts/archivo/');
    expect(tokens).toBe('<link rel="stylesheet" href="assets/looks/duotone-broadcast.css" />');
    expect(result.out.head?.join("\n")).not.toContain("fonts.css");
  });

  it("adds pieces without clobbering edited copies and carries MIT notices and 3D setup", async () => {
    const index = await loadIndex();
    const mit = index.pieces.find((p) => p.license === "MIT");
    const threeD = index.pieces.find((p) => p.requires?.includes("three"));
    if (!mit || !threeD) throw new Error("library needs an MIT piece and a 3D piece");

    const first = await lib(["add", tmp, "slam-word", mit.id, threeD.id]);
    expect(first.code).toBe(0);
    expect(first.out.added).toEqual(["slam-word", mit.id, threeD.id]);
    expect(first.out.mount?.[0]).toContain('data-composition-src="compositions/slam-word.html"');
    expect(first.out.importmap).toContain("./assets/vendor/three/build/three.module.min.js");
    await expect(
      fs.access(path.join(tmp, "assets", "vendor", "three", "build", "three.module.min.js")),
    ).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(tmp, "compositions", "licenses", `${mit.id}.txt`), "utf8"),
    ).resolves.toMatch(/MIT License/);
    await expect(fs.readFile(path.join(tmp, "CREDITS.md"), "utf8")).resolves.toContain("(MIT)");

    // An edited piece survives a second add; --force replaces it.
    const edited = path.join(tmp, "compositions", "slam-word.html");
    await fs.writeFile(edited, "<!-- edited for this video -->");
    const second = await lib(["add", tmp, "slam-word"]);
    expect(second.out.kept).toEqual(["slam-word"]);
    await expect(fs.readFile(edited, "utf8")).resolves.toBe("<!-- edited for this video -->");
    await lib(["add", tmp, "slam-word", "--force"]);
    await expect(fs.readFile(edited, "utf8")).resolves.toContain('data-composition-id="slam-word"');
  });

  it("installs the move kit for kit pieces and on its own", async () => {
    const index = await loadIndex();
    const kitPiece = index.pieces.find((p) => p.requires?.includes("kit"));
    if (!kitPiece) throw new Error("library needs a move-kit piece");
    const installed = path.join(tmp, "assets", "kit", "moves.js");

    const plain = await lib(["add", tmp, "slam-word"]);
    expect(plain.out.kit).toBeUndefined();
    await expect(fs.access(installed)).rejects.toThrow();

    const added = await lib(["add", tmp, kitPiece.id]);
    expect(added.code).toBe(0);
    expect(added.out.kit).toBe('<script src="assets/kit/moves.js"></script>');
    await expect(fs.readFile(installed, "utf8")).resolves.toContain("GGMotionKit");

    await fs.rm(installed);
    const direct = await lib(["kit", tmp]);
    expect(direct.out.kit).toBe('<script src="assets/kit/moves.js"></script>');
    await expect(fs.readFile(installed, "utf8")).resolves.toContain("GGMotionKit");
  });

  it("refuses unknown pieces and missing projects", async () => {
    expect((await lib(["add", tmp, "../../etc/passwd"])).out.error).toContain("Unknown piece");
    expect((await lib(["look", path.join(tmp, "nope"), "duotone-broadcast"])).out.error).toContain(
      "Project folder not found",
    );
    await expect(fs.readdir(tmp)).resolves.toEqual([]);
  });
});

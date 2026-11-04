import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkPackageInstall,
  clearPackageThreatCache,
  damerauLevenshtein,
  parsePackageInstalls,
} from "./package-threats.js";

vi.mock("./logger.js", () => ({ log: vi.fn() }));

function osvFetch(malicious: Record<string, string[]>): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      queries: Array<{ package: { name: string } }>;
    };
    const results = body.queries.map((q) => ({
      vulns: (malicious[q.package.name] ?? []).map((id) => ({ id })),
    }));
    return new Response(JSON.stringify({ results }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("parsePackageInstalls", () => {
  it.each([
    ["npm install react", ["react"]],
    ["pnpm add -D @types/node@20 vitest", ["@types/node", "vitest"]],
    ["yarn add lodash", ["lodash"]],
    ["bun i zod", ["zod"]],
    ["npx create-vite my-app", ["create-vite"]],
    ["pip install requests==2.31 Flask[async]", ["requests", "flask"]],
    ["uv pip install numpy", ["numpy"]],
    ["pip install -r requirements.txt", []],
    ["npm install ./local-pkg", []],
    ["npm test", []],
  ])("%s", (command, names) => {
    expect(parsePackageInstalls(command).map((r) => r.name)).toEqual(names);
  });
});

describe("damerauLevenshtein", () => {
  it("counts a transposition as one edit", () => {
    expect(damerauLevenshtein("raect", "react")).toBe(1);
    expect(damerauLevenshtein("react", "react")).toBe(0);
    expect(damerauLevenshtein("abc", "xyz")).toBe(3);
  });
});

describe("checkPackageInstall", () => {
  beforeEach(() => clearPackageThreatCache());

  it("warns on a typosquat of a popular package", async () => {
    const threats = await checkPackageInstall("npm install raect", { fetch: osvFetch({}) });
    expect(threats).toEqual([expect.objectContaining({ rule: "typosquat", severity: "warn" })]);
    expect(threats[0]?.detail).toContain("did you mean react");
  });

  it("does not warn for popular packages", async () => {
    expect(await checkPackageInstall("npm install react", { fetch: osvFetch({}) })).toEqual([]);
    expect(await checkPackageInstall("pip install requests", { fetch: osvFetch({}) })).toEqual([]);
  });

  it("blocks a package OSV flags as malware", async () => {
    const threats = await checkPackageInstall("npm i evil-pkg", {
      fetch: osvFetch({ "evil-pkg": ["MAL-2024-1", "GHSA-xxxx"] }),
    });
    expect(threats).toEqual([
      expect.objectContaining({ rule: "malicious-package", severity: "block" }),
    ]);
    expect(threats[0]?.detail).toContain("MAL-2024-1");
    expect(threats[0]?.detail).not.toContain("GHSA");
  });

  it("caches OSV answers per process", async () => {
    const f = osvFetch({});
    await checkPackageInstall("npm i some-pkg", { fetch: f });
    await checkPackageInstall("npm i some-pkg", { fetch: f });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("fails open when OSV is unreachable", async () => {
    const failing = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await checkPackageInstall("npm i some-pkg", { fetch: failing })).toEqual([]);
  });

  it("makes no request for non-install commands", async () => {
    const f = osvFetch({});
    expect(await checkPackageInstall("ls -la", { fetch: f })).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});

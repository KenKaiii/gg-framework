import { describe, expect, it } from "vitest";
import type { NotesReference } from "./notes-types";
import {
  canonicalReferenceIdentity,
  emptyNotesReferenceDraft,
  groupNotesReferences,
  normalizeCanonicalUrl,
  normalizeNotesReferenceDraft,
  NOTES_REFERENCE_METADATA_FIELDS,
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
  notesReferenceToDraft,
  referenceRepositoryKey,
  referenceRepositoryLabel,
  referenceSourceLabel,
} from "./notes-reference";

const REFERENCE: NotesReference = {
  id: "ref-1",
  provider: "github",
  tool: "search",
  canonicalUrl: "https://github.com/Owner/Repo/blob/abc/src/file.ts#L4-L8",
  owner: "Owner",
  repo: "Repo",
  revision: "abc",
  path: "src/file.ts",
  range: { startLine: 4, endLine: 8 },
  issue: null,
  pullRequest: null,
  query: "schema",
  anchor: "L4-L8",
  relevance: "Validates the schema boundary",
  capturedAt: "2026-07-25T12:00:00.000Z",
};

describe("structured reference helpers", () => {
  it("normalizes every draft field and preserves meaningful URL coordinates", () => {
    const result = normalizeNotesReferenceDraft({
      ...emptyNotesReferenceDraft(),
      provider: " GitHub ",
      tool: " search ",
      canonicalUrl: "HTTPS://GITHUB.COM:443/Owner/Repo/blob/abc/src/file.ts/#L4-L8",
      owner: " Owner ",
      repo: " Repo ",
      revision: " abc ",
      path: " src/file.ts ",
      startLine: "4",
      endLine: "8",
      query: " schema ",
      anchor: " L4-L8 ",
      relevance: " Validates the boundary ",
    });

    expect(result).toEqual({
      ok: true,
      input: {
        provider: "github",
        tool: "search",
        canonicalUrl: "https://github.com/Owner/Repo/blob/abc/src/file.ts#L4-L8",
        owner: "Owner",
        repo: "Repo",
        revision: "abc",
        path: "src/file.ts",
        range: { startLine: 4, endLine: 8 },
        issue: null,
        pullRequest: null,
        query: "schema",
        anchor: "L4-L8",
        relevance: "Validates the boundary",
      },
    });
  });

  it("converts empty optional strings to null and defaults provider to GitHub", () => {
    const result = normalizeNotesReferenceDraft({
      ...emptyNotesReferenceDraft(),
      canonicalUrl: "https://github.com/owner/repo/",
      owner: "owner",
      repo: "repo",
    });

    expect(result).toMatchObject({
      ok: true,
      input: {
        provider: "github",
        canonicalUrl: "https://github.com/owner/repo",
        tool: null,
        revision: null,
        path: null,
        range: null,
        issue: null,
        pullRequest: null,
        query: null,
        anchor: null,
      },
    });
  });

  it.each(NOTES_REFERENCE_METADATA_FIELDS)(
    "accepts the shared metadata limit and rejects larger %s drafts",
    (field) => {
      const baseline = {
        ...emptyNotesReferenceDraft(),
        provider: "example",
        canonicalUrl: "https://example.com/source",
        owner: "owner",
        repo: "repo",
      };
      const exact = normalizeNotesReferenceDraft({
        ...baseline,
        [field]: "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH),
      });
      const oversized = normalizeNotesReferenceDraft({
        ...baseline,
        [field]: "x".repeat(NOTES_REFERENCE_METADATA_MAX_LENGTH + 1),
      });

      expect(exact.ok).toBe(true);
      expect(oversized).toMatchObject({
        ok: false,
        errors: { [field]: expect.stringContaining("4,096") },
      });
    },
  );

  it("accepts the shared URL limit and rejects a larger canonical URL draft", () => {
    const prefix = "https://example.com/";
    const canonicalUrl = `${prefix}${"x".repeat(NOTES_REFERENCE_URL_MAX_LENGTH - prefix.length)}`;
    const baseline = {
      ...emptyNotesReferenceDraft(),
      provider: "example",
      owner: "owner",
      repo: "repo",
    };

    expect(normalizeNotesReferenceDraft({ ...baseline, canonicalUrl }).ok).toBe(true);
    expect(
      normalizeNotesReferenceDraft({ ...baseline, canonicalUrl: `${canonicalUrl}x` }),
    ).toMatchObject({
      ok: false,
      errors: { canonicalUrl: expect.stringContaining("2,048") },
    });
  });

  it.each([
    ["malformed URL", { canonicalUrl: "not a URL" }, "canonicalUrl"],
    ["URL username", { canonicalUrl: "https://user@github.com/owner/repo" }, "canonicalUrl"],
    ["URL password", { canonicalUrl: "https://:secret@github.com/owner/repo" }, "canonicalUrl"],
    ["GitHub host", { canonicalUrl: "https://gitlab.com/owner/repo" }, "canonicalUrl"],
    ["repository mismatch", { canonicalUrl: "https://github.com/other/repo" }, "canonicalUrl"],
    ["partial range", { startLine: "2" }, "endLine"],
    ["descending range", { startLine: "8", endLine: "4", path: "src/file.ts" }, "endLine"],
    ["range without path", { startLine: "4", endLine: "8" }, "path"],
    ["issue and PR", { issue: "4", pullRequest: "5" }, "pullRequest"],
    ["issue URL mismatch", { canonicalUrl: "https://github.com/owner/repo/issues/9" }, "issue"],
    [
      "PR URL mismatch",
      { canonicalUrl: "https://github.com/owner/repo/pull/9", pullRequest: "8" },
      "pullRequest",
    ],
  ])("associates %s errors with an actionable field", (_name, patch, expectedField) => {
    const result = normalizeNotesReferenceDraft({
      ...emptyNotesReferenceDraft(),
      canonicalUrl: "https://github.com/owner/repo",
      owner: "owner",
      repo: "repo",
      ...patch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected validation to fail");
    expect(result.errors[expectedField as keyof typeof result.errors]).toEqual(expect.any(String));
  });

  it("accepts mixed PR metadata when the direct URL number agrees", () => {
    const result = normalizeNotesReferenceDraft({
      ...notesReferenceToDraft(REFERENCE),
      canonicalUrl: "https://github.com/Owner/Repo/pull/117",
      pullRequest: "117",
    });

    expect(result).toMatchObject({
      ok: true,
      input: {
        pullRequest: 117,
        revision: "abc",
        path: "src/file.ts",
        range: { startLine: 4, endLine: 8 },
      },
    });
  });

  it("normalizes URL identity without dropping path, query, or fragment", () => {
    expect(normalizeCanonicalUrl("HTTPS://EXAMPLE.COM:443/a/b/?q=A#L2")).toBe(
      "https://example.com/a/b?q=A#L2",
    );
    expect(normalizeCanonicalUrl("ftp://example.com/a")).toBeNull();
    expect(normalizeCanonicalUrl("https://user@example.com/a")).toBeNull();
    expect(normalizeCanonicalUrl("https://:secret@example.com/a")).toBeNull();
    expect(
      canonicalReferenceIdentity({
        provider: " GitHub ",
        canonicalUrl: "HTTPS://GITHUB.COM:443/owner/repo/",
      }),
    ).toBe("github\nhttps://github.com/owner/repo");
  });

  it("groups and sorts repositories and rows deterministically without changing IDs", () => {
    const issue: NotesReference = {
      ...REFERENCE,
      id: "ref-issue-10",
      canonicalUrl: "https://github.com/Owner/Repo/issues/10",
      revision: null,
      path: null,
      range: null,
      issue: 10,
    };
    const other: NotesReference = {
      ...REFERENCE,
      id: "ref-other",
      owner: "alpha",
      repo: "tools",
      canonicalUrl: "https://github.com/alpha/tools/pull/2",
      revision: null,
      path: null,
      range: null,
      pullRequest: 2,
    };

    const groups = groupNotesReferences([issue, REFERENCE, other]);

    expect(groups.map(({ key }) => key)).toEqual(["github\nalpha/tools", "github\nowner/repo"]);
    expect(groups[1]!.references.map(({ id }) => id)).toEqual(["ref-issue-10", "ref-1"]);
    expect([issue.id, REFERENCE.id, other.id]).toEqual(["ref-issue-10", "ref-1", "ref-other"]);
  });

  it("builds compact repository and source labels for each coordinate type", () => {
    expect(referenceRepositoryKey(REFERENCE)).toBe("github\nowner/repo");
    expect(referenceRepositoryLabel(REFERENCE)).toBe("Owner/Repo");
    expect(referenceSourceLabel(REFERENCE)).toBe("src/file.ts:L4-L8");
    expect(referenceSourceLabel({ ...REFERENCE, range: { startLine: 4, endLine: 4 } })).toBe(
      "src/file.ts:L4",
    );
    expect(referenceSourceLabel({ ...REFERENCE, path: null, range: null, issue: 12 })).toBe(
      "Issue #12",
    );
    expect(referenceSourceLabel({ ...REFERENCE, path: null, range: null, pullRequest: 7 })).toBe(
      "Pull request #7",
    );
  });
});

import {
  normalizeCanonicalUrl,
  NOTES_REFERENCE_METADATA_FIELDS,
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
} from "@kenkaiiii/gg-core/project-notes";
import type { NotesReference } from "./notes-types";
export {
  canonicalReferenceIdentity,
  normalizeCanonicalUrl,
  NOTES_REFERENCE_METADATA_FIELDS,
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
} from "@kenkaiiii/gg-core/project-notes";

export type NotesReferenceInput = Omit<NotesReference, "id" | "capturedAt">;

export interface NotesReferenceDraft {
  provider: string;
  tool: string;
  canonicalUrl: string;
  owner: string;
  repo: string;
  revision: string;
  path: string;
  startLine: string;
  endLine: string;
  issue: string;
  pullRequest: string;
  query: string;
  anchor: string;
  relevance: string;
}

export type NotesReferenceDraftField = keyof NotesReferenceDraft;

export type NotesReferenceMetadataField = (typeof NOTES_REFERENCE_METADATA_FIELDS)[number];

export function notesReferenceFieldMaxLength(field: NotesReferenceDraftField): number | undefined {
  if (field === "canonicalUrl") return NOTES_REFERENCE_URL_MAX_LENGTH;
  return NOTES_REFERENCE_METADATA_FIELDS.includes(field as NotesReferenceMetadataField)
    ? NOTES_REFERENCE_METADATA_MAX_LENGTH
    : undefined;
}

export type NotesReferenceDraftResult =
  | { ok: true; input: NotesReferenceInput }
  | {
      ok: false;
      errors: Partial<Record<NotesReferenceDraftField, string>>;
      firstField: NotesReferenceDraftField;
    };

export interface NotesReferenceGroup {
  key: string;
  provider: string;
  owner: string;
  repo: string;
  references: NotesReference[];
}

const FIELD_ORDER: readonly NotesReferenceDraftField[] = [
  "provider",
  "tool",
  "canonicalUrl",
  "owner",
  "repo",
  "revision",
  "path",
  "startLine",
  "endLine",
  "issue",
  "pullRequest",
  "query",
  "anchor",
  "relevance",
];

export function emptyNotesReferenceDraft(): NotesReferenceDraft {
  return {
    provider: "github",
    tool: "",
    canonicalUrl: "",
    owner: "",
    repo: "",
    revision: "",
    path: "",
    startLine: "",
    endLine: "",
    issue: "",
    pullRequest: "",
    query: "",
    anchor: "",
    relevance: "",
  };
}

export function notesReferenceToDraft(reference: NotesReference): NotesReferenceDraft {
  return {
    provider: reference.provider,
    tool: reference.tool ?? "",
    canonicalUrl: reference.canonicalUrl,
    owner: reference.owner,
    repo: reference.repo,
    revision: reference.revision ?? "",
    path: reference.path ?? "",
    startLine: reference.range?.startLine.toString() ?? "",
    endLine: reference.range?.endLine.toString() ?? "",
    issue: reference.issue?.toString() ?? "",
    pullRequest: reference.pullRequest?.toString() ?? "",
    query: reference.query ?? "",
    anchor: reference.anchor ?? "",
    relevance: reference.relevance,
  };
}

export function normalizeNotesReferenceDraft(
  draft: NotesReferenceDraft,
): NotesReferenceDraftResult {
  const provider = draft.provider.trim().toLowerCase();
  const owner = draft.owner.trim();
  const repo = draft.repo.trim();
  const canonicalUrlValue = draft.canonicalUrl.trim();
  const canonicalUrl =
    draft.canonicalUrl.length <= NOTES_REFERENCE_URL_MAX_LENGTH
      ? normalizeCanonicalUrl(canonicalUrlValue)
      : null;
  const canonicalUrlExceedsLimit =
    draft.canonicalUrl.length > NOTES_REFERENCE_URL_MAX_LENGTH ||
    (canonicalUrl !== null && canonicalUrl.length > NOTES_REFERENCE_URL_MAX_LENGTH);
  const errors: Partial<Record<NotesReferenceDraftField, string>> = {};

  for (const field of NOTES_REFERENCE_METADATA_FIELDS) {
    if (draft[field].length > NOTES_REFERENCE_METADATA_MAX_LENGTH) {
      errors[field] =
        `Use ${NOTES_REFERENCE_METADATA_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`;
    }
  }

  if (!provider) errors.provider ??= "Provider is required.";
  if (!canonicalUrlValue) errors.canonicalUrl = "Canonical URL is required.";
  else if (canonicalUrlExceedsLimit) {
    errors.canonicalUrl = `Use ${NOTES_REFERENCE_URL_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`;
  } else if (!canonicalUrl) {
    errors.canonicalUrl = "Enter an absolute HTTP or HTTPS URL without a username or password.";
  }
  if (!owner) errors.owner ??= "Repository owner is required.";
  if (!repo) errors.repo ??= "Repository name is required.";

  const startLine = parseOptionalPositiveInteger(draft.startLine);
  const endLine = parseOptionalPositiveInteger(draft.endLine);
  const issue = parseOptionalPositiveInteger(draft.issue);
  const pullRequest = parseOptionalPositiveInteger(draft.pullRequest);

  if (startLine === "invalid") errors.startLine = "Enter a positive whole line number.";
  if (endLine === "invalid") errors.endLine = "Enter a positive whole line number.";
  if ((startLine === null) !== (endLine === null)) {
    if (startLine === null) errors.startLine = "Add both range endpoints.";
    if (endLine === null) errors.endLine = "Add both range endpoints.";
  }
  if (typeof startLine === "number" && typeof endLine === "number" && endLine < startLine) {
    errors.endLine = "End line must be at or after the start line.";
  }
  if (typeof startLine === "number" && !draft.path.trim()) {
    errors.path = "Path is required when a line range is present.";
  }
  if (issue === "invalid") errors.issue = "Enter a positive whole issue number.";
  if (pullRequest === "invalid") {
    errors.pullRequest = "Enter a positive whole pull request number.";
  }
  if (typeof issue === "number" && typeof pullRequest === "number") {
    errors.pullRequest = "Choose either an issue or a pull request, not both.";
  }

  if (
    canonicalUrl &&
    provider === "github" &&
    owner &&
    repo &&
    !errors.provider &&
    !errors.owner &&
    !errors.repo
  ) {
    validateGithubCoordinates(canonicalUrl, owner, repo, issue, pullRequest, errors);
  }

  const firstField = FIELD_ORDER.find((field) => errors[field] !== undefined);
  if (firstField) return { ok: false, errors, firstField };

  return {
    ok: true,
    input: {
      provider,
      tool: optionalString(draft.tool),
      canonicalUrl: canonicalUrl!,
      owner,
      repo,
      revision: optionalString(draft.revision),
      path: optionalString(draft.path),
      range:
        typeof startLine === "number" && typeof endLine === "number"
          ? { startLine, endLine }
          : null,
      issue: typeof issue === "number" ? issue : null,
      pullRequest: typeof pullRequest === "number" ? pullRequest : null,
      query: optionalString(draft.query),
      anchor: optionalString(draft.anchor),
      relevance: draft.relevance.trim(),
    },
  };
}

export function referenceRepositoryKey(
  reference: Pick<NotesReference, "provider" | "owner" | "repo">,
): string {
  return `${reference.provider.trim().toLowerCase()}\n${reference.owner.trim().toLowerCase()}/${reference.repo.trim().toLowerCase()}`;
}

export function groupNotesReferences(references: readonly NotesReference[]): NotesReferenceGroup[] {
  const groups = new Map<string, NotesReferenceGroup>();
  for (const reference of references) {
    const key = referenceRepositoryKey(reference);
    const group = groups.get(key) ?? {
      key,
      provider: reference.provider,
      owner: reference.owner,
      repo: reference.repo,
      references: [],
    };
    group.references.push(reference);
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((left, right) => compareText(left.key, right.key))
    .map((group) => ({
      ...group,
      references: group.references.sort(compareReferences),
    }));
}

export function referenceRepositoryLabel(
  reference: Pick<NotesReference, "owner" | "repo">,
): string {
  return `${reference.owner}/${reference.repo}`;
}

export function referenceSourceLabel(reference: NotesReference): string {
  if (reference.pullRequest !== null) return `Pull request #${reference.pullRequest}`;
  if (reference.issue !== null) return `Issue #${reference.issue}`;
  if (reference.path) {
    if (reference.range) {
      const range =
        reference.range.startLine === reference.range.endLine
          ? `L${reference.range.startLine}`
          : `L${reference.range.startLine}-L${reference.range.endLine}`;
      return `${reference.path}:${range}`;
    }
    return reference.path;
  }
  if (reference.revision) return `Revision ${reference.revision}`;
  return reference.tool ?? reference.provider;
}

function validateGithubCoordinates(
  canonicalUrl: string,
  owner: string,
  repo: string,
  issue: number | null | "invalid",
  pullRequest: number | null | "invalid",
  errors: Partial<Record<NotesReferenceDraftField, string>>,
): void {
  const url = new URL(canonicalUrl);
  if (url.hostname !== "github.com") {
    errors.canonicalUrl = "GitHub references must use a github.com URL.";
    return;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments.length < 2 ||
    segments[0]!.toLowerCase() !== owner.toLowerCase() ||
    segments[1]!.replace(/\.git$/i, "").toLowerCase() !== repo.replace(/\.git$/i, "").toLowerCase()
  ) {
    errors.canonicalUrl = "URL owner and repository must match the stored repository.";
    return;
  }

  const directType = segments[2];
  const directNumber = segments[3] && /^\d+$/.test(segments[3]) ? Number(segments[3]) : null;
  if (directType === "issues" && directNumber !== null) {
    if (issue !== directNumber)
      errors.issue = `Issue number must match URL issue #${directNumber}.`;
    if (typeof pullRequest === "number")
      errors.pullRequest = "An issue URL cannot target a pull request.";
  }
  if (directType === "pull" && directNumber !== null) {
    if (pullRequest !== directNumber) {
      errors.pullRequest = `Pull request number must match URL pull request #${directNumber}.`;
    }
    if (typeof issue === "number") errors.issue = "A pull request URL cannot target an issue.";
  }
}

function optionalString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function parseOptionalPositiveInteger(value: string): number | null | "invalid" {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : "invalid";
}

function compareReferences(left: NotesReference, right: NotesReference): number {
  return (
    compareText(referenceSourceLabel(left), referenceSourceLabel(right)) ||
    compareText(left.canonicalUrl, right.canonicalUrl) ||
    compareText(left.id, right.id)
  );
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
}

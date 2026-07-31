import { canonicalProjectKey } from "@kenkaiiii/gg-core/project-notes";
import {
  migrateNotesDocumentV2,
  migrateNotesDocumentV3PhaseShape,
  validateNotesDocumentV3,
} from "./notes-types";
import type {
  NotesDocumentV3,
  NotesLoadDiagnostic,
  NotesLoadResult,
  NotesParseResult,
  NotesSaveResult,
} from "./notes-types";

const LEGACY_PREFIX = "gg-notes:";
const V2_PREFIX = "gg-notes-v2:";
const V3_PREFIX = "gg-notes-v3:";

/** Browser Notes are retained only for one-time migration and run-local fallback recovery. */
export interface NotesRepository {
  load(cwd: string): NotesLoadResult;
  save(cwd: string, document: NotesDocumentV3): NotesSaveResult;
}

export { canonicalProjectKey };

export function legacyNotesKey(cwd: string): string {
  return `${LEGACY_PREFIX}${cwd}`;
}

export function v2NotesKey(cwd: string): string {
  return `${V2_PREFIX}${canonicalProjectKey(cwd)}`;
}

export function v3NotesKey(cwd: string): string {
  return `${V3_PREFIX}${canonicalProjectKey(cwd)}`;
}

export function createEmptyNotesDocument(now: string): NotesDocumentV3 {
  return {
    version: 3,
    reference: "",
    currentFocus: "",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: now,
    legacyImportedAt: null,
    phases: [],
    references: [],
  };
}

export function parseNotesDocument(raw: string): NotesParseResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed-json" };
  }

  if (!isRecord(value)) return { ok: false, reason: "invalid-shape" };
  if (value.version === 2) {
    const migrated = migrateNotesDocumentV2(value);
    return migrated.ok
      ? {
          ok: true,
          document: migrated.document,
          migratedFromV2: true,
          migratedArchiveShape: false,
        }
      : { ok: false, reason: "invalid-shape", error: migrated.error };
  }
  if (value.version !== 3) return { ok: false, reason: "unsupported-version" };
  const validated = validateNotesDocumentV3(value);
  if (validated.ok) {
    return {
      ok: true,
      document: validated.document,
      migratedFromV2: false,
      migratedArchiveShape: false,
    };
  }
  const migrated = migrateNotesDocumentV3PhaseShape(value);
  return migrated.ok
    ? {
        ok: true,
        document: migrated.document,
        migratedFromV2: false,
        migratedArchiveShape: true,
      }
    : { ok: false, reason: "invalid-shape", error: migrated.error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Open the migration/fallback browser repository; the sidecar is normal authority. */
export function createNotesRepository(
  storage: Storage,
  clock: () => string = () => new Date().toISOString(),
): NotesRepository {
  return {
    load(cwd) {
      const diagnostics: NotesLoadDiagnostic[] = [];
      const exactLegacyKey = legacyNotesKey(cwd);
      const canonicalV2Key = v2NotesKey(cwd);
      const canonicalV3Key = v3NotesKey(cwd);
      const legacyRecord = findLegacyRecord(storage, cwd, diagnostics);
      const v3Raw = readStorage(storage, canonicalV3Key, diagnostics);
      const v2Raw = v3Raw === null ? readStorage(storage, canonicalV2Key, diagnostics) : null;
      const structuredRaw = v3Raw ?? v2Raw;
      const now = clock();

      if (structuredRaw === null && legacyRecord === null) {
        const document = createEmptyNotesDocument(now);
        writeStorage(storage, canonicalV3Key, JSON.stringify(document), diagnostics);
        return loadResult(document, "empty", null, diagnostics);
      }

      if (structuredRaw === null && legacyRecord !== null) {
        const document = {
          ...createEmptyNotesDocument(now),
          reference: legacyRecord.value,
          legacyImportedAt: now,
        };
        const imported = writeStorage(
          storage,
          canonicalV3Key,
          JSON.stringify(document),
          diagnostics,
        );
        return {
          ...loadResult(document, "legacy", legacyRecord.key, diagnostics),
          v2ImportAttempted: true,
          v2ImportSucceeded: imported,
        };
      }

      const parsed = parseNotesDocument(structuredRaw as string);
      if (!parsed.ok) {
        diagnostics.push({ kind: "document-parse", reason: parsed.reason, error: parsed.error });
        const document = createEmptyNotesDocument(now);
        if (legacyRecord !== null) {
          document.reference = legacyRecord.value;
          return loadResult(document, "legacy-fallback", legacyRecord.key, diagnostics);
        }
        return loadResult(document, v3Raw === null ? "v2-migrated" : "v3", null, diagnostics);
      }

      if (parsed.migratedFromV2 || parsed.migratedArchiveShape) {
        const persisted = writeStorage(
          storage,
          canonicalV3Key,
          JSON.stringify(parsed.document),
          diagnostics,
        );
        return {
          ...loadResult(
            parsed.document,
            parsed.migratedFromV2 ? "v2-migrated" : "v3",
            legacyRecord?.key ?? null,
            diagnostics,
          ),
          v2ImportAttempted: parsed.migratedFromV2,
          v2ImportSucceeded: parsed.migratedFromV2 ? persisted : null,
        };
      }

      // Once a valid v3 document exists it is authoritative. The legacy key is
      // a rollback mirror only and cannot overwrite a newer structured save.
      if (legacyRecord !== null) {
        return loadResult(parsed.document, "v3", legacyRecord.key, diagnostics);
      }

      const recovered = writeStorage(
        storage,
        exactLegacyKey,
        parsed.document.reference,
        diagnostics,
      );
      return {
        ...loadResult(parsed.document, "v3", exactLegacyKey, diagnostics),
        legacyRecoveryAttempted: true,
        legacyRecoverySucceeded: recovered,
      };
    },

    save(cwd, document) {
      const legacyKey = legacyNotesKey(cwd);
      const v3Key = v3NotesKey(cwd);
      return {
        legacy: writeResult(storage, legacyKey, document.reference),
        v3: writeResult(storage, v3Key, JSON.stringify(document)),
      };
    },
  };
}

function loadResult(
  document: NotesDocumentV3,
  source: NotesLoadResult["source"],
  legacyKey: string | null,
  diagnostics: NotesLoadDiagnostic[],
): NotesLoadResult {
  return {
    document,
    value: document.reference,
    source,
    legacyKey,
    v2ImportAttempted: false,
    v2ImportSucceeded: null,
    legacyRecoveryAttempted: false,
    legacyRecoverySucceeded: null,
    diagnostics,
    migrationEligibility: migrationEligibility(source, diagnostics),
  };
}

function migrationEligibility(
  source: NotesLoadResult["source"],
  diagnostics: readonly NotesLoadDiagnostic[],
): NotesLoadResult["migrationEligibility"] {
  if (diagnostics.some((diagnostic) => diagnostic.kind === "storage-read")) {
    return "ineligible-unreadable";
  }
  if (source === "empty") return "empty";
  if (source === "legacy" || source === "legacy-fallback") return "valid-legacy";
  if (diagnostics.some((diagnostic) => diagnostic.kind === "document-parse")) {
    return "ineligible-invalid-document";
  }
  return source === "v2-migrated" ? "valid-v2-migrated" : "valid-v3";
}

function findLegacyRecord(
  storage: Storage,
  cwd: string,
  diagnostics: NotesLoadDiagnostic[],
): { key: string; value: string } | null {
  const exactKey = legacyNotesKey(cwd);
  const exactValue = readStorage(storage, exactKey, diagnostics);
  if (exactValue !== null) return { key: exactKey, value: exactValue };

  const canonical = canonicalProjectKey(cwd);
  const matchingKeys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (
        key?.startsWith(LEGACY_PREFIX) &&
        canonicalProjectKey(key.slice(LEGACY_PREFIX.length)) === canonical
      ) {
        matchingKeys.push(key);
      }
    }
  } catch (error) {
    diagnostics.push({ kind: "storage-read", key: LEGACY_PREFIX, error });
    return null;
  }

  matchingKeys.sort();
  const selectedKey = matchingKeys[0];
  if (!selectedKey) return null;
  if (matchingKeys.length > 1) {
    diagnostics.push({ kind: "ambiguous-legacy", selectedKey, matchingKeys });
  }
  const value = readStorage(storage, selectedKey, diagnostics);
  return value === null ? null : { key: selectedKey, value };
}

function readStorage(
  storage: Storage,
  key: string,
  diagnostics: NotesLoadDiagnostic[],
): string | null {
  try {
    return storage.getItem(key);
  } catch (error) {
    diagnostics.push({ kind: "storage-read", key, error });
    return null;
  }
}

function writeStorage(
  storage: Storage,
  key: string,
  value: string,
  diagnostics: NotesLoadDiagnostic[],
): boolean {
  const result = writeResult(storage, key, value);
  if (!result.ok) diagnostics.push({ kind: "storage-write", key, error: result.error });
  return result.ok;
}

function writeResult(storage: Storage, key: string, value: string): NotesSaveResult["legacy"] {
  try {
    storage.setItem(key, value);
    return { key, ok: true };
  } catch (error) {
    return { key, ok: false, error };
  }
}

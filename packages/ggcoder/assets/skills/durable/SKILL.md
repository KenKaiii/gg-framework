---
name: durable
description: "Use when data could be lost: migrations, destructive ops, real databases. Do NOT use for query speed."
license: Data-durability engineering guidance, not a DBA certification. Sources and snapshot date are recorded at the foot of each reference file.
compatibility: Snapshot dated 17 August 2026. Version behaviors (fast-path ALTERs, pooler modes, tool flags) decay — re-verify with web access before asserting them as current.
---

# Durable

Make user data survive everything: bad migrations, crashed writes, retried webhooks, full disks, dead servers, and the 3am `DELETE` without a `WHERE`. Built for the reality that users forgive slow and ugly; they do not forgive gone.

**This skill is on from the first table.** The default mode is the inline gate below — every schema change, import, and destructive path gets the durable treatment as it is written. The full pass is for existing projects and "is my data safe" checks.

## Governing rules

1. **The database is the last line of defense, not the app.** Constraints, foreign keys, uniqueness, and NOT NULL live in the store where enforcement cannot be bypassed. App-level validation is UX, not integrity — a bug, a script, or a direct SQL session walks right past it.
2. **Destructive operations are guilty until proven guarded.** Any `DROP`, `TRUNCATE`, `DELETE`, `UPDATE` without a `WHERE`, or overwrite of a column/file gets: a guard (`WHERE` + `LIMIT`), a dry-run count first, a backup or snapshot when anything of value exists, and an undo path (soft delete, staging table, or copy) for user-facing data.
3. **Migrations are code that runs on data you cannot recreate.** Checked in from day one, reviewed as SQL before applying (ORM-generated SQL included — generators will happily emit `DROP COLUMN` for a rename), never edited once applied, forward-only in production. `db push`-style sync is for throwaway dev databases only.
4. **One logical change, one transaction.** Multi-step writes either all land or none do. Anything a retry can hit twice (webhooks, queue jobs, imports, payment callbacks) is idempotent — a dedup key or upsert, not hope.
5. **Backups you have not restored are fiction.** Automated, off-platform (or at least off-instance), on anything with real user data — and the restore is exercised, timed, and recorded. RPO (how much loss is acceptable) and RTO (how long recovery takes) are stated numbers, not vibes.
6. **Fail loudly, not corruptly.** Partial imports, half-applied backfills, and crashed jobs leave the system in a state the next run can detect and resume — keyset-resumable batches, recorded checkpoints, no silent skips.
7. **Respect the writer.** SQLite has one writer; Postgres connections are processes; serverless poolers multiplex transactions and break session state. Designing against the store's real concurrency model is durability work, not just performance work.
8. **Numbers or silence.** A backup claim without a timed restore run is unverified. Label every claim `RUNTIME` (observed), `CODE` (read in source), `DEDUCED` (inferred), `SNAPSHOT` (dated source). Never claim data is "safe" — say what loss is survivable and what is not.
9. **Proportionality.** A prototype with test rows needs migrations and little else. The first real user row raises the floor: backups, then tested restore, then PITR-class recovery as the product matters.

## Two modes

**Inline gate** — while writing anything that touches stored data: the first table, a schema change, a backfill or import script, a delete/edit endpoint, a webhook that writes, a backup cron. Apply the binding defaults below, say one line about the guard you built, move on. Do not stop the build to lecture, and do not ship the unguarded version intending to "add safety later".

**Full pass** — triggered by "is my data safe", "will I lose my data if X", "back up my app", a migration about to run on production, or after any data scare. Run the workflow below. Migration and schema detail lives in `references/migrations-and-schema.md`; backups, recovery, and runtime data-safety detail lives in `references/backups-and-runtime.md`.

## Binding defaults (build mode)

Apply on every data-touching change, every store:

- **Migration tooling from the first table** — checked-in versioned migrations, generated with `--create-only`-style review when the ORM supports it, reviewed as SQL, applied via the tool's deploy path. Never hand-edit an applied migration; write a new one that corrects it.
- **Destructive ops carry their guard** — `WHERE` + `LIMIT` on mass changes, count-first dry run (`SELECT` the affected rows before `DELETE`/`UPDATE`), and for user-visible data prefer soft delete (`deleted_at`) with partial unique indexes over hard delete until retention policy says otherwise.
- **Constraints in the store** — `NOT NULL` on required fields, `UNIQUE` where identity lives (email, external IDs), foreign keys with explicit `ON DELETE` behavior chosen (not defaulted), and `CHECK` where a value has a domain. Orphaned rows and duplicate emails are app bugs the DB should have refused.
- **Transactions around multi-write invariants** — wrap create-order-plus-items, transfer-out-plus-transfer-in, and every read-modify-write that must not interleave. Where the store lacks multi-document transactions, the default is a single-document design or an outbox pattern, never "should be fine".
- **Idempotency keys on retried writes** — webhook event IDs, job dedup keys, `INSERT ... ON CONFLICT` upserts. Rule of thumb: if it can run twice, assume it will.
- **Batched, resumable bulk work** — keyset pagination (`WHERE id > last`), fixed batch size, sleep between batches, checkpoint recorded so a crash resumes rather than restarts or double-applies. Never one unbounded `UPDATE` over a production table.
- **Backups the moment real data exists** — automated (managed-provider backups, `pg_dump` cron, Litestream for SQLite, scheduled snapshots for document stores), retention of days not one copy, at least one copy off the same machine/account. State RPO/RTO in a comment where the backup is configured.
- **Connection and session hygiene** — close/release connections in `finally`; on serverless, assume transaction-mode pooling (no session state, no prepared statements unless the pooler supports them, no `LISTEN/NOTIFY`, no session advisory locks); one pool per function instance, not per request.
- **SQLite as SQLite** — WAL mode on, `busy_timeout` set, one writer (route writes through a single instance or a queue), database on local disk not network storage, Litestream-or-scheduled-backup for continuous protection. Do not pretend it is a client-server DB.

## Full-pass workflow

### 1. Profile the data from the code

Before asking anything: store type(s) and version, where data files live, ORM/migration tooling present or absent, what writes exist (endpoints, jobs, webhooks, imports), what deletes exist, whether backups are configured anywhere (deploy config, cron, provider settings), and — decisive — whether real user data exists. A repo with seed scripts only is a different engagement than one with a production URL.

### 2. Establish what loss would mean

From the code, answer: what is recreated (cache, derived data), what is user-entered and unrecoverable (posts, uploads, messages, payments), and what links out (files on disk referenced by rows, rows referencing deleted files). The unrecoverable set defines backup urgency; the links define cleanup discipline.

### 3. Sweep the six areas

In order of how often each actually loses data. Detection specifics and commands: the two reference files.

| # | Area | What you are hunting |
|---|---|---|
| 1 | **Backups & recovery** | No backups at all; backups only on the same machine/account; no retention; never-restored backups (the norm); no stated RPO/RTO; single copy of file uploads; managed backups assumed but not enabled |
| 2 | **Destructive paths** | `DELETE`/`UPDATE` without `WHERE` or `LIMIT`; cascade deletes that sweep further than intended (user → everything they own, intended or not); truncate/drop in scripts; no undo for user-facing deletes; `db push` or sync-style schema changes anywhere near production config |
| 3 | **Migrations health** | No migration tooling (schema by hand/script); applied migrations edited; pending destructive migration; generated SQL never reviewed; migrations untested against prod-shaped data; drift between schema files and the live DB |
| 4 | **Transactions & idempotency** | Multi-step writes without a transaction; webhook/job handlers that double-apply on retry; check-then-act races (read, decide, write without a constraint); imports that restart from zero |
| 5 | **Schema integrity** | Foreign keys absent or off (MySQL engines, SQLite `PRAGMA foreign_keys`); duplicate-prone columns without unique constraints; orphaned rows; `NOT NULL`-in-spirit columns that are nullable in fact; money/IDs stored in lossy types (float money, int IDs near overflow) |
| 6 | **Runtime data safety** | Transaction-pooled connections using session features; SQLite without WAL/busy_timeout or with concurrent writers across instances; files written non-atomically (no temp-then-rename); jobs that mutate state with no record of having run; queues with no dead-letter path |

### 4. Rank by survivability

| Severity | Meaning |
|---|---|
| **Critical** | Loss is certain or one common failure away: real user data with no backups; destructive path unguarded; pending migration that drops data; double-charge/double-apply on retry |
| **High** | Loss on a plausible bad day: backups exist but never restored; single copy on one machine/account; cascade deletes broader than intended; multi-write flows without transactions |
| **Medium** | Fragility that bites at scale or during recovery: missing constraints, schema drift, non-idempotent jobs, non-atomic file writes |
| **Low** | Hygiene: naming, unused staging tables, comments. Do these when adjacent to a real fix. |

Fix Critical and High first; three to five fixes, each verified. A backup you set up is finished only when a restore from it has run and been timed.

### 5. Verify

- **Restore drill for any backup fix**: snapshot state, note the time, make a recognizable change, restore to the noted time into a separate location, verify the change is absent, record the wall-clock duration — that number is the real RTO. `RUNTIME` label or it did not happen.
- **Guard drill for any destructive fix**: run the guarded path against a copy with a row that must survive and a row that must not; assert both outcomes.
- **Migration drill**: apply the pending migrations to a copy of production-shaped data (a fresh dump, a seeded volume) before it goes near the real thing.
- Label what you could not run — no environment, no data copy, managed console you cannot touch — as unverified, and say the exact command the user should run.

### 6. Leave a guard behind

A tested restore cron'd into a weekly job; a CI step that applies migrations to a throwaway DB before merge; a test that a retried webhook applies once; a constraint added to the store; `--create-only` review in the project's migration docs. One mechanical check beats a README paragraph.

### 7. Report

- Lead with the survivability statement in plain words: "if this server dies right now, you lose everything after [backup point]" — the RPO the user actually has, not the one they think they have.
- Then findings ranked, each with file/line and the fix.
- Then what was **not checked** — stores skipped, consoles inaccessible, uploads unexamined.
- Then what you fixed (with verification labels) vs. what needs the user (provider settings, paid tiers, their call on retention).
- Label every claim `RUNTIME` / `CODE` / `DEDUCED` / `SNAPSHOT`.

## Honesty rules

- Never state or imply data is "safe" or "backed up" without an observed, timed restore. "Backups are configured" is a `CODE` claim; "recoverable" requires a `RUNTIME` one.
- Never present a retention number, provider tier, or version behavior as current without verifying — provider backup defaults change; mark the snapshot date.
- Never run a destructive command, however obviously safe, against a database with real data without an explicit backup or the user's go-ahead.
- "I could not verify this" is a legitimate output. A fabricated restore test is the worst lie this skill could tell.

## Reference map

Resolve every path from the installed skill root. Load only what the profile triggered.

- `references/migrations-and-schema.md` — the migration discipline: expand-contract with concrete lock behavior, batched resumable backfills, index and FK lock-safety, ORM-specific traps (Prisma, Drizzle, and friends), forward-only production, CI and deploy-time application, and schema integrity checks. Read for any migration or schema finding.
- `references/backups-and-runtime.md` — backup tiers and the restore drill, RPO/RTO, 2026 managed-provider baselines (Supabase, Neon, RDS, Crunchy), self-hosted tooling (pgBackRest, WAL-G, Litestream, restic), file-upload protection, idempotency and outbox patterns, pooling and serverless session-state pitfalls, SQLite runtime rules, and atomic file writes. Read for any backup, recovery, or runtime finding.

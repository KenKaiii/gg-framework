---
name: durable
description: "Use to keep stored data from being lost: before running or writing anything that could delete, overwrite or reshape it, and when asked whether data is backed up and recoverable. Do NOT use for read-only queries or query speed."
license: Data-durability engineering guidance, not a DBA certification. Sources and snapshot date are recorded at the foot of each reference file.
compatibility: Snapshot dated 3 October 2026; Prisma 7/8 status and agent safeguards, PostgreSQL 19 status and the Neon, RDS and D1 retention rows re-verified 22 October 2026. Re-verify version behaviours and provider defaults before asserting them as current.
---

# Durable

**Route first:**

| You are… | Mode | Do next |
|---|---|---|
| About to run *any* command against a database yourself (migrate, reset, push, seed, SQL shell, delete script) | **Agent gate** | Run the agent gate below before the command. Always. |
| Writing code that touches stored data (table, migration, import, delete endpoint, webhook write, backup cron) | **Inline gate** | Apply binding defaults; one line on the guard you built; keep building. |
| Asked "is my data safe / back up my app", a migration is about to hit production, or after a data scare | **Full pass** | Run the full-pass workflow. |

Never say data is "safe": say what loss is survivable and what is not.

## Agent gate — binding rules for you, the agent

Coding agents have wiped production data during a natural-language code freeze (Replit, July 2025; `references/agent-db-safety.md`). These rules are the mechanism.

1. **Identify the target before every command.** Resolve which database the command will hit. Classify it `throwaway` / `shared-dev` / `may-hold-real-data` using the detection list in `references/agent-db-safety.md`. Unknown = `may-hold-real-data`.
2. **On `may-hold-real-data`, read-only by default.** Inspect with `SELECT`/`EXPLAIN`/`\d`, a read-only role, or `BEGIN READ ONLY`. No DDL, no writes, no `migrate dev|reset`, `db push`, `--force`, `--accept-data-loss`, `flush`, `dropDatabase`, `TRUNCATE`, seed scripts.
3. **Destructive or schema-changing commands on real data require all of:** (a) a backup or PITR point you verified exists *for this database* (`RUNTIME` or provider-console evidence, not assumption), (b) a dry-run count of affected rows shown to the user, (c) the exact command shown, and (d) the user's explicit go-ahead in this conversation for that command. "Go ahead and fix it" does not cover a `DROP`.
4. **Experiment on a branch, not the original.** Use a provider branch, restored clone or local copy; prove the change there, then hand back the production step with evidence.
5. **Never bypass a tool's safety interlock yourself.** If a CLI refuses because it detected an agent (e.g. Prisma 7's AI-consent check), a platform holds your request for the user's approval (e.g. Prisma Console agent approvals), or a prompt asks for confirmation: stop and ask. Never set a consent variable, approve your own request, or pass `--force`/`--yes` on your own initiative.
6. **Surprising results mean stop, not fix.** Empty tables, missing rows, failed restores: report what you observed and ask. Never "repair" by recreating, reseeding, or fabricating data, and never declare data unrecoverable without checking the provider's backups/PITR.
7. **Report exactly what you ran** — every command that touched a database, its target, and its result, including mistakes, immediately.

Also flag (do not silently fix) setups where the agent's shell holds production write credentials: recommend separate dev/prod credentials, a read-only role for inspection, and production URLs absent from local `.env`.

## Governing rules

1. **The store is the last line of defence.** `NOT NULL`, `UNIQUE`, foreign keys with a chosen `ON DELETE`, `CHECK` — in the database, where scripts and bugs cannot walk past them.
2. **Destructive operations are guilty until guarded**: `WHERE` + batch limit, dry-run count first, backup when anything of value exists, undo path (soft delete, staging copy) for user-facing data.
3. **Migrations run on data you cannot recreate.** Checked in, reviewed as SQL (ORM output included — a rename can become `DROP` + `ADD`), never edited once applied, forward-only in production. Push/sync commands are for throwaway databases.
4. **One logical change, one transaction; anything retried is idempotent.**
5. **Backups you have not restored are fiction.** Automated, off-instance, stated RPO/RTO, timed restore drill.
6. **Fail loudly, not corruptly.** Bulk jobs are keyset-resumable with durable checkpoints.
7. **Respect the store's concurrency model** — SQLite has one writer; transaction poolers break session state.
8. **Evidence labels on every claim:** `RUNTIME` (observed), `CODE` (read in source), `DEDUCED` (inferred), `SNAPSHOT` (dated external source).
9. **Proportionality.** Test rows need migrations; the first real user row raises the floor to backups, then tested restore, then PITR.

## Binding defaults (inline gate)

- **Migration tooling from the first table.** Generate without applying (`prisma migrate dev --create-only`, `drizzle-kit generate`), read the SQL, apply via the deploy path (`prisma migrate deploy`, `drizzle-kit migrate`). Corrections are new migrations.
- **Destructive code carries its guard**: count-first, `WHERE` + batch, soft delete (`deleted_at` + partial unique index) for user-visible data.
- **Constraints in the store** per rule 1; integer cents or `NUMERIC` for money; `bigint`/UUID keys (`uuidv7()` built in from Postgres 18).
- **Transactions around multi-write invariants**; across systems, use an outbox.
- **Idempotency keys on retried writes**: unique event/job IDs + `INSERT … ON CONFLICT`.
- **Batched, resumable bulk work** (keyset, fixed batch, checkpoint, sleep) — never one unbounded `UPDATE` on production.
- **Backups the moment real data exists**: confirm the plan actually includes them (free tiers often do not), add an off-account copy, state RPO/RTO where configured. Uploads need bucket versioning — DB backups do not cover objects.
- **Serverless connections**: assume transaction-mode pooling (no session state); one pool per instance; release in `finally`.
- **SQLite as SQLite**: WAL, `busy_timeout`, `foreign_keys=ON` per connection, one writer, local disk, continuous or scheduled backup.

## Full-pass workflow

1. **Profile from the code.** Stores, migration tooling, write/delete paths, backup config, environments and credentials, and whether real user data exists.
2. **Define loss.** Recreatable vs unrecoverable (user content, uploads, payments), and rows ↔ files links.
3. **Sweep the seven areas** (detail in references):

| # | Area | Hunting for |
|---|---|---|
| 1 | Backups & recovery | None; same machine/account only; free tier assumed to be PITR; never restored; no RPO/RTO; unversioned upload buckets |
| 2 | Destructive paths | Unguarded `DELETE`/`UPDATE`; cascades sweeping too far; reset/push/drop in scripts or CI near production config |
| 3 | Agent & credential exposure | Prod write URL in local `.env`; agent/CI tokens with DDL rights; no branch/dev DB to experiment on |
| 4 | Migrations health | No tooling; edited applied migrations; unreviewed destructive SQL; lock-unsafe DDL; drift |
| 5 | Transactions & idempotency | Multi-writes without a transaction; double-apply on retry; check-then-act races |
| 6 | Schema integrity | Missing FKs/uniques/`NOT NULL`; orphans; float money; int IDs near overflow |
| 7 | Runtime data safety | Session state through transaction poolers; SQLite multi-writer; non-atomic file writes; no dead-letter path |

4. **Rank by survivability.**

| Severity | Meaning |
|---|---|
| Critical | Loss certain or one common failure away: real data with no backups; unguarded destructive path; pending data-dropping migration; agent/CI holding prod write creds with no verified backup; double-charge on retry |
| High | Loss on a plausible bad day: never-restored backups; single copy; broad cascades; multi-writes without transactions |
| Medium | Bites at scale or in recovery: missing constraints, drift, non-idempotent jobs, non-atomic writes |
| Low | Hygiene; fix only when adjacent |

5. **Report, then fix what the user selects**, Critical and High first (three to five, each verified). Fix straight away only when the user asked for fixes.
6. **Verify.**
   - *Restore drill* (any backup fix): note a point, insert a canary, restore to the point **into a separate location**, confirm the canary is absent, record wall-clock time as the real RTO. `RUNTIME` or it did not happen.
   - *Guard drill* (destructive fix): on a copy, one row that must survive and one that must not; assert both.
   - *Migration drill*: apply pending migrations to a branch or prod-shaped copy first, with `lock_timeout` set.
   - Not run: label it unverified and give the exact command.
7. **Leave a guard behind** with tools already installed and the existing CI: CI migrations on a throwaway DB, a scheduled restore test, a constraint, or a read-only agent role. A new package or workflow (e.g. a migration linter) is a recommendation unless the user agrees.
8. **Report**: lead with the RPO the user *actually* has ("if this server died now you lose everything since …"); then ranked findings with file:line and fix; then **not checked**; then fixed (with labels) vs needs-the-user (provider settings, paid tiers, retention choices).

## Scaling: one agent or several

- Stay single-threaded for the agent gate, inline gate, small edits, and a full pass on one store and one deployable.
- Fan out a full pass over several stores, services or deployables: read-only repo helpers, one per disjoint slice of the ledger (7 areas × stores/services); a researcher for dated provider or version claims.
- Helpers never connect to or run commands against any database. A production migration plan or "is my data safe" verdict also gets a fresh-context check that tries to disprove the findings and the restore evidence.
- **Database commands are never parallel.** Migrations, restores and writes to shared or production data run serially on the main thread, after the agent gate.

Helper types, brief contents and merge rules come with the skill loader.

## Honesty rules

- "Backups are configured" is `CODE`; "recoverable" needs a `RUNTIME` restore. Never say "safe".
- Never claim data is gone, or restored, without checking. A fabricated restore test is the worst lie this skill could tell.

## Reference map

Resolve paths from the skill root; load only what the profile triggers.

- `references/agent-db-safety.md` — incident, production-target detection, safe inspection, branches, tool interlocks. Before any agent-run command on a non-throwaway database; area 3.
- `references/migrations-and-schema.md` — expand/contract, lock-safety table, Postgres 18/19 notes, backfills, ORM traps (Prisma 7/8, Drizzle), integrity sweep. Areas 2, 4, 6.
- `references/backups-and-runtime.md` — tiers, restore drill, provider PITR snapshot, SQLite/Litestream, object versioning, idempotency/outbox, poolers. Areas 1, 5, 7.

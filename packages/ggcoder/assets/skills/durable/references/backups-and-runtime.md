# Durable — backups, recovery & runtime data safety

Load for any backup, recovery, or runtime finding. `SNAPSHOT` = sourced 3 October 2026 — provider tiers and defaults change often; verify before asserting.

Contents: Part 1 — RPO/RTO, tiers, provider snapshot, restore drill, uploads. Part 2 — idempotency/outbox, poolers, SQLite, atomic files.

## Part 1 — Backups & recovery

### RPO/RTO first

- **RPO** (Recovery Point Objective): how much data loss is acceptable — "5 minutes" vs "a day".
- **RTO** (Recovery Time Objective): how long until you are back up.

Pick both consciously; they dictate the tier. An app where users type for hours wants an RPO near zero; a read-mostly catalog may accept a day. Stating them where the backup is configured turns "we have backups" into an actual contract.

### The tiers, best to weakest

1. **PITR (point-in-time recovery)** — base backup + continuous write-ahead-log archive; restore to any second in the retention window. RPO of seconds-to-minutes. Gold standard for transactional data.
2. **Scheduled logical dumps** (`pg_dump`, `mongodump`, Firestore export) — portable, cheap, easy to verify by inspection; but restore time scales with size and everything after the dump starts is lost. Fine as the archive layer or the only layer for small apps.
3. **Storage/block snapshots** — fast, near-zero impact; restoring a running DB from a raw snapshot leaves crash recovery to do the rest. Good for staging clones; for disaster recovery prefer PITR.
4. **Nothing / a copy on the same machine** — the default state of most small projects, and the finding most often reported after it stops mattering.

**3-2-1 floor**: at least 3 copies, 2 different media/systems, 1 off-site (different provider or account is fine). A dump cron writing to the same VPS is one disk failure from zero.

### Managed-provider baselines (`SNAPSHOT` 3 Oct 2026 — verify the project's actual settings before quoting)

| Provider | What the docs say |
|---|---|
| Supabase | Daily backups: Pro 7 days, Team 14, Enterprise up to 30. PITR is a paid **add-on** (Pro+, needs at least Small compute). Backups exclude Storage objects — restoring does not bring back deleted files. Custom-role passwords not in daily backups |
| Neon | Restore window (WAL history) powers instant restore, time travel, and branching from the past: Free capped at 6 hours (1 GB); Launch default 1 day, max 7; Scale default 1 day, max 30 |
| PlanetScale Postgres | Scheduled + on-demand backups and PITR via WAL archiving; check the branch's schedule |
| AWS RDS | Retention 0–35 days; default 1 day via API/CLI, 7 days via console. 0 disables automated backups and PITR |
| Cloudflare D1 | Time Travel always on: restore to any minute in the last 30 days |
| Turso | PITR: Free 24 hours; Developer 10, Scaler 30, Pro 90 days; deleted DBs restorable up to 5 days on paid plans |
| Firestore | Without PITR, version retention is 1 hour; enabling PITR gives 7 days. Scheduled exports for longer history |
| MongoDB Atlas | Cloud backups / continuous backup by cluster tier — not verified this snapshot; check the cluster's backup policy |

Not re-verified this snapshot (removed): Crunchy Bridge numbers. Aurora: same 1–35 day continuous backup model as RDS — confirm per cluster.

The recurring failure: the free tier's weekly backup or none at all, assumed to be PITR because the marketing page said "backups". Check the project's actual settings, not the provider's homepage.

**Self-hosted Postgres**: pgBackRest, Barman, or WAL-G → S3-compatible storage. **Self-hosted/embedded SQLite**: Litestream (continuous replication to object storage). The 2025 rewrite (v0.5.x, `SNAPSHOT`) stores changes as LTX files (sorted page changesets that compact), giving faster point-in-time restores, and uses compare-and-swap leases on object storage to avoid two primaries; configs from 0.3.x need review on upgrade. Weaker floor: `sqlite3 .backup` / `VACUUM INTO` on a schedule, shipped off-machine with restic/borg. **Firestore/DynamoDB-style**: scheduled exports to storage — PITR is a paid or absent feature; check the project's state.

### The restore drill (the only proof)

1. Note the current time / snapshot point of a known state.
2. Make a recognizable change (insert a canary row).
3. Restore to the noted point into a *separate* location — never over the live DB.
4. Verify the canary is absent. Time the whole operation — that measured duration is the real RTO; write it down.
5. Repeat on a schedule (quarterly is the common bar); the drill doc itself is the runbook you'll follow at 3am.

**File uploads need their own answer** — DB backups don't cover a disk of user uploads unless the backup includes the volume or the uploads live in object storage with versioning (S3 versioning or equivalent preserves deleted/overwritten objects — turn it on and add a lifecycle rule for noncurrent versions). For ransomware-grade or compliance retention, S3 Object Lock (requires versioning) stores objects write-once-read-many; use governance mode unless you truly need compliance mode, which nobody — including you — can shorten. A credential that can delete the bucket can delete its backups: keep backup copies in a different account. DB row + orphaned-file mismatch is a finding: cleanup discipline (delete file then row, in that order, with the row's file path recorded for resweep) or accept orphans.

### What a backup must exclude/include

Include: the data, schema history (migrations), and anything unrecreatable (uploads, generated-but-expensive artifacts). Exclude/rotate: secrets in plaintext dumps (a dump with PII inherits compliance-guard's storage rules — encrypt at rest, restrict access), logs, caches. Test that the restore includes what you think: a backup that skips a table because of a wrong flag is the most humiliating restore failure.

## Part 2 — Runtime data safety

### Idempotency & exactly-once writes

Anything retried — webhooks, queue jobs, mobile clients on flaky networks, imports — **will** run twice. Patterns, in order of preference:

- **Store-side dedup**: unique constraint on the natural key (webhook event ID, job ID + attempt) and `INSERT ... ON CONFLICT DO NOTHING` returning whether it inserted. The store is the arbiter; no race can beat it.
- **Upsert by natural key**: `ON CONFLICT ... DO UPDATE` with a deterministic outcome, so replay converges instead of duplicating.
- **Compare-and-set / optimistic concurrency**: `UPDATE ... WHERE version = :expected`, check affected count — the guard for read-modify-write races (balance updates, seat claims, counter increments).
- **Outbox pattern**: state changes and the events they trigger written in one transaction to an outbox table, published by a separate relay — eliminates "DB updated but email/queue lost" (and its evil twin, "email sent but DB rolled back"). The default answer where a store lacks cross-service transactions.

Check-then-act without a constraint (`if not exists: insert`) is a bug that just hasn't raced yet.

### Connection & session pitfalls (correctness, not speed)

- **Transaction-mode poolers** (PgBouncer, Supabase port 6543 — Supavisor on the shared pooler, PgBouncer on the dedicated one; port 5432 is direct or session mode — Neon's `-pooler` endpoint which runs PgBouncer, RDS Proxy): each transaction may run on a different connection — session state breaks. Protocol-level named prepared statements work through PgBouncer ≥ 1.21 when `max_prepared_statements` is non-zero (on by default, 200, since PgBouncer 1.24; SQL-level `PREPARE` still breaks). Self-hosted PgBouncer: run ≥ 1.26.0 (23 Sep 2026), which fixes pre-auth crash/hang CVEs (CVE-2026-19888, CVE-2026-6668) and CVE-2026-6669 (`SNAPSHOT`). Run migrations over a **direct/session** connection, not the transaction pooler. Other casualties: session-level `SET`, advisory locks, `LISTEN/NOTIFY`, temp tables, `COPY`. Patterns: keep per-transaction state in SQL (`SET LOCAL`), use `pg_advisory_xact_lock` (transaction-scoped), or route state-needing work to a direct/session connection.
- **Serverless functions**: one pool per *instance* (module scope), never per request; assume the process freezes between invocations — no in-memory "it'll flush later".
- **Postgres connections are processes** — exhausting them fails every new client; the fix is a pooler, not a bigger `max_connections`. (Sizing the pool for throughput is lean's lane.)
- **Always release/close in `finally`** — a leaked connection per request is a slow outage and a durability finding.

### SQLite runtime rules

- **WAL mode on** (`PRAGMA journal_mode=WAL`) — readers don't block the writer; the default rollback journal serializes everything.
- **`busy_timeout` set** (e.g. 5000ms) — without it, concurrent access returns `SQLITE_BUSY` instantly instead of waiting.
- **`PRAGMA foreign_keys = ON` on every connection** — it is per-connection and off by default; constraints silently unenforced is a schema-integrity finding wearing runtime clothes.
- **One writer** — route writes through a single instance or a write queue; multiple app instances writing one SQLite file on shared/network storage corrupts. Local disk (NVMe), not NFS.
- **Backup without Litestream**: `VACUUM INTO 'backup.db'` or the `sqlite3 .backup` command — never copy the file mid-write; the WAL file and the checkpoint state are part of the database.

### Atomic file writes and cleanup

- **Temp-then-rename** for any file a reader may open: write to `path.tmp`, `fsync`, then `rename` over the target. Atomic on POSIX; a crash mid-write never leaves a truncated JSON the app will happily parse.
- **Delete in dependency order and resweep**: child rows then parent; file after the row referencing it is gone (or record orphans for a sweep job). Reversible orderings first: soft-delete the row, mark the file, sweep files later — undoability beats tidiness.

---

**Provenance:** snapshot 3 October 2026. Accessed 3 Oct 2026: https://supabase.com/docs/guides/platform/backups ; https://neon.com/docs/introduction/restore-window ; https://planetscale.com/docs/postgres/backups ; https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html ; https://developers.cloudflare.com/d1/reference/time-travel/ ; https://docs.turso.tech/features/point-in-time-recovery ; https://cloud.google.com/firestore/native/docs/use-pitr ; https://fly.io/blog/litestream-revamped/ ; https://litestream.io/ ; https://www.pgbouncer.org/config.html ; https://www.pgbouncer.org/changelog.html ; https://neon.com/docs/connect/connection-pooling ; https://supabase.com/docs/guides/database/connecting-to-postgres ; https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html . Earlier sources: Postgres WAL/PITR documentation and pgBackRest/Barman/WAL-G docs, Litestream documentation (SQLite WAL replication), provider documentation for Supabase/Neon/RDS/Crunchy/MongoDB Atlas backup tiers (tier specifics are `SNAPSHOT` — they change often), PgBouncer documentation (transaction-mode feature matrix), SQLite documentation (WAL, busy_timeout, foreign_keys pragma, VACUUM INTO), current disaster-recovery practice guides (3-2-1, RPO/RTO, restore drills). Provider tiers and defaults decay fastest — re-verify before asserting.

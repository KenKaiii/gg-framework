# Durable — agent database safety

Load before the agent runs any command against a database that is not provably throwaway, and for full-pass area 3. `SNAPSHOT` = sourced 3 October 2026.

## Why this file exists

`SNAPSHOT` — July 2025, SaaStr founder Jason Lemkin's public "vibe coding" experiment on Replit: the agent deleted a live project database during an explicit, repeated code freeze, produced misleading output (including fabricated records), and said rollback was impossible — which proved false. Replit responded by separating dev and production databases, adding approval for destructive commands, and pointing to tested backups. Lessons this skill encodes:

- A natural-language "don't touch it" is not a control. Credentials, read-only roles, and branches are.
- Agents misread anomalies (empty results) as problems to fix. Anomaly → stop and report.
- Agents misreport recoverability. Check backups/PITR before saying anything about loss.

## Classify the target (before every command)

Treat as **`may-hold-real-data`** if any is true; unknown also counts:

- Host is not `localhost`/`127.0.0.1`/a docker-compose service/`file:` under the repo's dev path.
- Host or name matches a managed provider (`*.supabase.co`, `*.pooler.supabase.com`, `*.neon.tech`, `*.psdb.cloud`/PlanetScale, `*.rds.amazonaws.com`, `*.turso.io`, `mongodb+srv://`, Firestore project IDs) and is not a known branch/preview.
- Variable or file name contains `prod`, `production`, `live`, `main`; or it is the value in `.env.production`, deploy config, or CI secrets.
- `NODE_ENV`/`RAILS_ENV`/`APP_ENV`/`DJANGO_SETTINGS_MODULE` points at production.
- Row counts or timestamps suggest real use (inspect read-only: `SELECT count(*), max(created_at) FROM users`).

**`throwaway`** only when you created it this session, or it is a local container/file seeded by the repo, or a branch you just made.

Never print full connection strings; show host and database name only.

## Read-only inspection

| Store | Read-only pattern |
|---|---|
| Postgres | Dedicated role with `SELECT` only; or `psql` with `BEGIN READ ONLY;` / `SET default_transaction_read_only = on` (a session setting, not a security boundary) |
| MySQL | User with `SELECT` grant only; `START TRANSACTION READ ONLY` |
| SQLite | Open with `?mode=ro` or `sqlite3 -readonly`; or inspect a copy |
| MongoDB | User with the `read` role |

Recommend the user create the read-only role; do not create roles on production yourself without the gate.

## Branch / clone first

| Platform | Experiment surface (`SNAPSHOT`, verify flags) |
|---|---|
| Neon | Branches (copy-on-write, can be created from a past point in the restore window) |
| Supabase | Branching (preview branches) or restore into a new project |
| PlanetScale | Development branches |
| Any Postgres | `pg_dump` → local container; or provider snapshot restored to a new instance |
| SQLite / D1 / Turso | Copy the file; D1/Turso restore to a point into a new database where supported |

Run the migration on the branch, record the result and timing, then present the production step for the user's go-ahead.

## Tool interlocks — respect, never bypass

- **Prisma** (`SNAPSHOT`): dangerous CLI actions such as `migrate reset` refuse when run by a detected AI agent and require `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` set to the user's exact consent message. Stop and ask; only the user's literal words may be passed.
- Prompts like "data loss will occur, continue?" (`db push`, `drizzle-kit push`) are a stop sign. Never pipe `yes`, never add `--force`/`--accept-data-loss` yourself.
- Prefer commands that print the plan without applying: `prisma migrate diff`, `drizzle-kit generate` (then read SQL), Rails `db:migrate:status`, Django `sqlmigrate` / `migrate --plan`.

## Credential hygiene to recommend

- Separate dev/prod credentials and URLs; production values only in the deploy platform's secret store.
- The agent's shell gets dev or read-only creds by default; production writes go through CI/deploy, not a laptop.
- Migration role ≠ app role ≠ read-only inspection role.
- PITR enabled and verified on any database an agent can reach with write rights.

## Dry-run counts

Before any `DELETE`/`UPDATE` you are asked to run: execute the same `WHERE` as `SELECT count(*)` (and a sample of ids), show the user, then run inside a transaction and check the affected count matches before `COMMIT`.

---

**Provenance:** snapshot 3 October 2026. Sources (accessed 3 Oct 2026): The Register via Slashdot, 21 Jul 2025 — https://developers.slashdot.org/story/25/07/21/1338204/ ; heise, 25 Jul 2025 — https://www.heise.de/en/news/Artificial-intelligence-Vibe-coding-service-Replit-deletes-production-database-10499597.html ; incident summary — https://openleash.com/blog/ai-agents-deleted-production-databases-replit-pocketos ; Prisma CLI reference (AI-agent consent) — https://www.prisma.io/docs/orm/reference/prisma-cli-reference . Branching surfaces from provider docs; verify flags before asserting.

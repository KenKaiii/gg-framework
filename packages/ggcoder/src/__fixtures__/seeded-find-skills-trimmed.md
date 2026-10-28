---
name: find-skills
description: Use when the user wants to find or install a skill for some capability. Do NOT use for normal coding.
---

# Find Skills

Help the user discover and install reusable agent skills from the open ecosystem.

## When to use

Activate this skill when the user:

- Asks "how do I do X" for a specialized, recurring task
- Says "find a skill for…", "add a skill that…", "is there something that handles…"
- Wants to extend the agent with capabilities that likely already exist

## Install location — read this carefully

- **Default: project-local** → `./.gg/skills/`. Project-specific skills (React testing, Convex patterns, Next.js conventions, etc.) must live with the project they belong to. A React skill installed globally pollutes every other project.
- **Global** → `~/.gg/skills/`. Only install here if the user **explicitly** asks ("install globally", "across all projects") and the skill is genuinely cross-cutting (e.g. a release-notes generator, a git-hygiene helper).

When in doubt, install to the project. It is trivial to promote a project skill to global later; harder to unpollute a global namespace.

## Where to look

- **Catalog**: https://skills.sh — browsable leaderboard
- **Vercel Labs**: https://github.com/vercel-labs/agent-skills
- **Anthropic**: https://github.com/anthropics/skills
- Any trusted GitHub repo containing a `SKILL.md`

Prefer publishers with track record (vercel-labs, anthropics) and repos with stars + recent commits.

## Process

1. **Clarify the need** in one question if it's not obvious from context — what domain, what task?
2. **Search** using the `web_search` and `web_fetch` tools. Use precise terms ("react testing skill" beats "testing").
3. **Shortlist 2–3 candidates.** Present each with: name, one-line description, source repo URL, why it fits. Don't just install the first hit.
4. **Confirm scope** with the user: project (default) or global.
5. **Install** using the `bash` tool (see below).
6. **Verify** the file landed and tell the user to start a new gg-coder session so the loader picks it up.

## How to install

Skills come in two shapes. gg-coder's loader handles both.

### Shape A — single file

A single `SKILL.md` (or `<name>.md`). Install as one flat file:

```bash
mkdir -p .gg/skills
curl -fsSL <raw-githubusercontent-url> -o .gg/skills/<skill-name>.md
```

### Shape B — directory with supporting files

A directory containing `SKILL.md` plus scripts, reference docs, or assets. Preserve the directory:

```bash
mkdir -p .gg/skills
# Simplest: tarball the repo, extract only the skill path
curl -fsSL https://github.com/<owner>/<repo>/archive/refs/heads/main.tar.gz \
  | tar -xz --strip-components=2 -C .gg/skills <repo>-main/skills/<skill-name>
```

If that layout doesn't match the source repo, inspect with `gh api repos/<owner>/<repo>/contents/<path>` and fetch individual files via their `download_url`.

For global installs, swap `.gg/skills` for `~/.gg/skills` — but remember the default is project.

## If nothing fits

- Say so honestly — don't fabricate a match.
- Offer to either (a) complete the task directly this once, or (b) scaffold a new `./.gg/skills/<name>.md` based on what the user describes. A minimal skill is just frontmatter plus instructions:

```markdown
---
name: my-skill
description: One-line description of when this skill should be used
---

Instructions the agent should follow when invoked…
```

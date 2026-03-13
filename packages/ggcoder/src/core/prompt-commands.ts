/**
 * Prompt-template commands — slash commands that inject detailed prompts
 * into the agent loop. Each command maps to a full prompt the agent executes.
 */

export interface PromptCommand {
  name: string;
  aliases: string[];
  description: string;
  prompt: string;
}

export const PROMPT_COMMANDS: PromptCommand[] = [
  {
    name: "scan",
    aliases: [],
    description: "Find dead code, bugs, and security issues",
    prompt: `Find quick wins in this codebase. Spawn 5 sub-agents in parallel using the subagent tool (call the subagent tool 5 times in a single response, each with a different task), each focusing on one area. Adapt each area to what's relevant for THIS project's stack and architecture.

**Agent 1 - Performance**: Inefficient algorithms, unnecessary work, missing early returns, blocking operations, things that scale poorly

**Agent 2 - Dead Weight**: Unused code, unreachable paths, stale comments/TODOs, obsolete files, imports to nowhere

**Agent 3 - Lurking Bugs**: Unhandled edge cases, missing error handling, resource leaks, race conditions, silent failures

**Agent 4 - Security**: Hardcoded secrets, injection risks, exposed sensitive data, overly permissive access, unsafe defaults

**Agent 5 - Dependencies & Config**: Unused packages, vulnerable dependencies, misconfigured settings, dead environment variables, orphaned config files

## The Only Valid Findings

A finding is ONLY valid if it falls into one of these categories:

1. **Dead** - Code that literally does nothing. Unused, unreachable, no-op.
2. **Broken** - Will cause errors, crashes, or wrong behavior. Not "might" - WILL.
3. **Dangerous** - Security holes, data exposure, resource exhaustion.

That's it. Three categories. If it doesn't fit, don't report it.

**NOT valid findings:**
- "This works but could be cleaner" - NO
- "Modern best practice suggests..." - NO
- "This is verbose/repetitive but functional" - NO
- "You could use X instead of Y" - NO
- "This isn't how I'd write it" - NO

If the code works, isn't dangerous, and does something - leave it alone.

## Output Format

For each finding:
\`\`\`
[DEAD/BROKEN/DANGEROUS] file:line - What it is
Impact: What happens if left unfixed
\`\`\`

Finding nothing is a valid outcome. Most codebases don't have easy wins - that's fine.`,
  },
  {
    name: "verify",
    aliases: [],
    description: "Verify code against docs and best practices",
    prompt: `Verify this codebase against current best practices and official documentation. Spawn 8 sub-agents in parallel using the subagent tool (call the subagent tool 8 times in a single response, each with a different task), each focusing on one category. Each agent must VERIFY findings using real code samples or official docs - no assumptions allowed.

**Agent 1 - Core Framework**: Detect the main framework, verify usage patterns against official documentation

**Agent 2 - Dependencies/Libraries**: Check if library APIs being used are current or deprecated. Verify against library documentation

**Agent 3 - Language Patterns**: Identify the primary language, verify idioms and patterns are current

**Agent 4 - Configuration**: Examine build tools, bundlers, linters, and config files. Verify settings against current tool documentation

**Agent 5 - Security Patterns**: Review auth, data handling, secrets management. Verify against current security guidance and OWASP recommendations

**Agent 6 - Testing**: Identify test framework in use, verify testing patterns match current library recommendations

**Agent 7 - API/Data Handling**: Review data fetching, state management, storage patterns. Verify against current patterns and framework docs

**Agent 8 - Error Handling**: Examine error handling patterns, verify they match library documentation

## Agent Workflow

Each agent MUST follow this process:
1. **Identify** - What's relevant in THIS project for your category
2. **Find** - Locate specific implementations in the codebase
3. **Verify** - Check against real code or official docs
4. **Report** - Only report when verified current practice differs from codebase

## The Only Valid Findings

A finding is ONLY valid if:
1. **OUTDATED** - Works but uses old patterns with verified better alternatives
2. **DEPRECATED** - Uses APIs marked deprecated in current official docs
3. **INCORRECT** - Implementation contradicts official documentation

**NOT valid findings:**
- "I think there's a better way" without verification - NO
- "This looks old" without proof - NO
- Style preferences or subjective improvements - NO
- Anything not verified via real code or official docs - NO

## Output Format

For each finding:
\`\`\`
[OUTDATED/DEPRECATED/INCORRECT] file:line - What it is
Current: How it's implemented now
Verified: What the correct/current approach is
Source: URL to official docs or evidence
\`\`\`

No findings is a valid outcome. If implementations match current practices, that's good news.`,
  },
  {
    name: "research",
    aliases: [],
    description: "Research best tools, deps, and patterns",
    prompt: `Research the best tools, dependencies, and architecture for this project.

First, if it's not clear what the project is building, ask me to describe the features, target platform, and any constraints. If you can infer this from the codebase, proceed directly.

Then spawn 6 sub-agents in parallel using the subagent tool (call the subagent tool 6 times in a single response, each with a different task). Every agent must verify ALL recommendations - no training-data assumptions allowed.

**Agent 1 - Project Scan**: Read the current working directory. Catalog what already exists: config files, installed deps, directory structure, language/framework already chosen. Report exactly what's in place.

**Agent 2 - Stack Validation**: Research whether the current framework/language is the best choice for this project. Compare top 2-3 alternatives on performance, ecosystem, and developer experience. Pick ONE winner with evidence.

**Agent 3 - Core Dependencies**: For EACH feature, find the single best library for this stack. Confirm latest stable versions. No outdated packages. Output: package name, version, one-line purpose.

**Agent 4 - Dev Tooling**: Research the best dev tooling for this stack: package manager, bundler, linter, formatter, test framework, type checker. Pick ONE per category with exact versions.

**Agent 5 - Architecture**: Find how real projects of this type structure their code. Look for directory layouts, file naming conventions, and key patterns. Output a concrete directory tree and list of patterns.

**Agent 6 - Config & Integration**: Research required config files for the chosen stack and tools. Cover: linter config, formatter config, TS/type config, env setup, CI/CD basics.

## Agent Rules

1. Every recommendation MUST be verified - no guessing
2. Confirm latest stable versions - do not assume version numbers
3. Pick ONE best option per category - no "you could also use X"
4. No prose, no hedging, no alternatives lists - decisive answers only

## Output

After all agents complete, synthesize findings into a single RESEARCH.md file:

\`\`\`markdown
# RESEARCH: [short project description]
Generated: [today's date]
Stack: [framework + language + runtime]

## INSTALL
[exact shell commands - copy-paste ready]

## DEPENDENCIES
| package | version | purpose |
[each purpose max 5 words]

## DEV DEPENDENCIES
| package | version | purpose |

## CONFIG FILES TO CREATE
### [filename]
[exact file contents or key settings]

## PROJECT STRUCTURE
[tree showing recommended directories]

## SETUP STEPS
1. [concrete action]

## KEY PATTERNS
[brief list of architectural patterns]

## SOURCES
[URLs used for verification]
\`\`\`

Write the file, then summarize what was researched.`,
  },
  {
    name: "init",
    aliases: [],
    description: "Generate or update CLAUDE.md for this project",
    prompt: `Generate or update a minimal CLAUDE.md with project structure, guidelines, and quality checks.

## Step 1: Check if CLAUDE.md Exists

If CLAUDE.md exists:
- Read the existing file
- Preserve custom sections the user may have added
- Update the structure, quality checks, and organization rules

If CLAUDE.md does NOT exist:
- Create a new one from scratch

## Step 2: Analyze Project (Use Sub-agents in Parallel)

Spawn 3 sub-agents in parallel using the subagent tool (call the subagent tool 3 times in a single response):

1. **Project Purpose Agent**: Analyze README, package.json description, main files to understand what the project does
2. **Directory Structure Agent**: Map out the folder structure and what each folder contains
3. **Tech Stack Agent**: Identify languages, frameworks, tools, dependencies

Wait for all sub-agents to complete, then synthesize the information.

## Step 3: Detect Project Type & Commands

Check for config files:
- package.json -> JavaScript/TypeScript (extract lint, typecheck, server scripts)
- pyproject.toml or requirements.txt -> Python
- go.mod -> Go
- Cargo.toml -> Rust

Extract linting commands, typechecking commands, and server start command (if applicable).

## Step 4: Generate Project Tree

Create a concise tree structure showing key directories and files with brief descriptions.

## Step 5: Generate or Update CLAUDE.md

Create CLAUDE.md with: project description, project structure tree, organization rules (one file per component, single responsibility), and zero-tolerance code quality checks with the exact commands for this project.

Keep total file under 100 lines. If updating, preserve any custom sections the user added.`,
  },
  {
    name: "setup-lint",
    aliases: [],
    description: "Generate a /fix command for linting and typechecking",
    prompt: `Detect the project type and generate a /fix command for linting and typechecking.

## Step 1: Detect Project Type

Check for config files:
- package.json -> JavaScript/TypeScript
- pyproject.toml or requirements.txt -> Python
- go.mod -> Go
- Cargo.toml -> Rust
- composer.json -> PHP

Read the relevant config file to understand the project structure.

## Step 2: Check Existing Tools

Based on the project type, check if linting/typechecking tools are already configured:

- **JS/TS**: eslint, prettier, typescript — check package.json scripts and config files
- **Python**: mypy, pylint, black, ruff — check dependencies and config files
- **Go**: go vet, gofmt, staticcheck
- **Rust**: clippy, rustfmt

## Step 3: Install Missing Tools (if needed)

Only install what's missing. Use the detected package manager.

## Step 4: Generate /fix Command

Create the directory \`.gg/commands/\` if it doesn't exist, then write \`.gg/commands/fix.md\`:

\`\`\`markdown
---
name: fix
description: Run typechecking and linting, then spawn parallel agents to fix all issues
---

Run all linting and typechecking tools, collect errors, group them by domain, and use the subagent tool to spawn parallel sub-agents to fix them.

## Step 1: Run Checks

[INSERT PROJECT-SPECIFIC COMMANDS — e.g. npm run lint, npm run typecheck, etc.]

## Step 2: Collect and Group Errors

Parse the output. Group errors by domain:
- **Type errors**: Issues from TypeScript, mypy, etc.
- **Lint errors**: Issues from eslint, pylint, ruff, clippy, etc.
- **Format errors**: Issues from prettier, black, rustfmt, gofmt

## Step 3: Spawn Parallel Agents

For each domain with issues, use the subagent tool to spawn a sub-agent to fix all errors in that domain.

## Step 4: Verify

After all agents complete, re-run all checks to verify all issues are resolved.
\`\`\`

Replace [INSERT PROJECT-SPECIFIC COMMANDS] with the actual commands for the detected project.

## Step 5: Confirm

Report what was detected, what was installed, and that /fix is now available.`,
  },
  {
    name: "setup-commit",
    aliases: [],
    description: "Generate a /commit command with quality checks",
    prompt: `Detect the project type and generate a /commit command that enforces quality checks before committing.

## Step 1: Detect Project and Extract Commands

Check for config files and extract the lint/typecheck commands:
- package.json -> Extract lint, typecheck scripts
- pyproject.toml -> Use mypy, pylint/ruff
- go.mod -> Use go vet, gofmt
- Cargo.toml -> Use cargo clippy, cargo fmt --check

## Step 2: Generate /commit Command

Create the directory \`.gg/commands/\` if it doesn't exist, then write \`.gg/commands/commit.md\`:

\`\`\`markdown
---
name: commit
description: Run checks, commit with AI message, and push
---

1. Run quality checks:
   [PROJECT-SPECIFIC LINT/TYPECHECK COMMANDS]
   Fix ALL errors before continuing. Use auto-fix commands where available.

2. Review changes: run git status and git diff --staged and git diff

3. Stage relevant files with git add (specific files, not -A)

4. Generate a commit message:
   - Start with verb (Add/Update/Fix/Remove/Refactor)
   - Be specific and concise, one line preferred

5. Commit and push:
   git commit -m "your generated message"
   git push
\`\`\`

Replace [PROJECT-SPECIFIC LINT/TYPECHECK COMMANDS] with the actual commands.

Keep the command file under 20 lines.

## Step 3: Confirm

Report that /commit is now available with quality checks and AI-generated commit messages.`,
  },
  {
    name: "setup-tests",
    aliases: [],
    description: "Set up testing and generate a /test command",
    prompt: `Set up comprehensive testing for this project and generate a /test command.

## Step 1: Analyze Project

Detect the project type, framework, and architecture. Identify all critical business logic that needs testing.

## Step 2: Determine Testing Strategy

Use these tools based on project type (2025-2026 best practices):

| Language | Unit/Integration | E2E | Notes |
|----------|------------------|-----|-------|
| JS/TS | Vitest (not Jest) | Playwright | Vitest is faster, native ESM/TS. Use Testing Library for components. |
| Python | pytest | Playwright | pytest-django for Django, httpx+pytest-asyncio for FastAPI. |
| Go | testing + testify | httptest | testcontainers-go for integration. Table-driven tests. |
| Rust | #[test] + rstest | axum-test | assert_cmd for CLI, proptest for property-based. |
| PHP | Pest 4 (Laravel) / PHPUnit 12 | Laravel Dusk | Pest preferred for Laravel. |

## Step 3: Set Up Testing Infrastructure

Spawn 4 sub-agents in parallel using the subagent tool (call the subagent tool 4 times in a single response):

**Agent 1 - Dependencies & Config**: Install test frameworks and create config files
**Agent 2 - Unit Tests**: Create comprehensive unit tests for all business logic, utilities, and core functions
**Agent 3 - Integration Tests**: Create integration tests for APIs, database operations, and service interactions
**Agent 4 - E2E Tests** (if applicable): Create end-to-end tests for critical user flows

Each agent should create COMPREHENSIVE tests covering all critical code paths - not just samples.

## Step 4: Verify and Generate /test Command

Run the tests to verify everything works. Fix any issues.

Then create the directory \`.gg/commands/\` if it doesn't exist and write \`.gg/commands/test.md\` with:

\`\`\`markdown
---
name: test
description: Run tests, then spawn parallel agents to fix failures
---

Run all tests for this project, collect failures, and use the subagent tool to spawn parallel sub-agents to fix them.

## Step 1: Run Tests

[PROJECT-SPECIFIC TEST COMMANDS with options for watch mode, coverage, filtering]

## Step 2: If Failures

For each failing test, use the subagent tool to spawn a sub-agent to fix the underlying issue (not the test).

## Step 3: Re-run

Re-run tests to verify all fixes.
\`\`\`

Replace placeholders with the actual test commands for this project.

## Step 5: Report

Summarize what was set up, how many tests were created, and that /test is now available.`,
  },
  {
    name: "setup-update",
    aliases: [],
    description: "Generate an /update command for dependency updates",
    prompt: `Detect the project type and generate an /update command for dependency updates and deprecation fixes.

## Step 1: Detect Project Type & Package Manager

Check for config files and lock files:
- package.json + package-lock.json -> npm
- package.json + yarn.lock -> yarn
- package.json + pnpm-lock.yaml -> pnpm
- pyproject.toml + poetry.lock -> poetry
- requirements.txt -> pip
- go.mod -> Go
- Cargo.toml -> Rust

## Step 2: Generate /update Command

Create the directory \`.gg/commands/\` if it doesn't exist, then write \`.gg/commands/update.md\`:

\`\`\`markdown
---
name: update
description: Update dependencies, fix deprecations and warnings
---

## Step 1: Check for Updates

[OUTDATED CHECK COMMAND for detected package manager]

## Step 2: Update Dependencies

[UPDATE COMMAND + SECURITY AUDIT]

## Step 3: Check for Deprecations & Warnings

Run a clean install and read ALL output carefully. Look for:
- Deprecation warnings
- Security vulnerabilities
- Peer dependency warnings
- Breaking changes

## Step 4: Fix Issues

For each warning/deprecation:
1. Research the recommended replacement or fix
2. Update code/dependencies accordingly
3. Re-run installation
4. Verify no warnings remain

## Step 5: Run Quality Checks

[PROJECT-SPECIFIC LINT/TYPECHECK COMMANDS]

Fix all errors before completing.

## Step 6: Verify Clean Install

Delete dependency folders/caches, run a fresh install, verify ZERO warnings/errors.
\`\`\`

Replace all placeholders with the actual commands for the detected project type and package manager.

## Step 3: Confirm

Report that /update is now available with dependency updates, security audits, and deprecation fixes.`,
  },
  {
    name: "worktree",
    aliases: ["wt"],
    description: "Create an isolated worktree and explore the focus area",
    prompt: `Create an isolated git worktree for focused work and explore the relevant code.

## Special case: "list"

If the user's argument is "list", use the worktree tool with action "list" and display the results. Do NOT create a new worktree. Stop here.

## Special case: "remove"

If the user's argument starts with "remove", use the worktree tool with action "remove" and path set to the worktree path the user specifies. The tool handles hook integration and cleanup. Stop here.

## Creating a new worktree

The user's argument describes what they're working on (e.g. "refactoring the auth flow", "adding pagination to the API").

### Step 1: Generate a slug

From the description, generate a short kebab-case slug (e.g. "auth-flow", "api-pagination"). Use only lowercase letters, numbers, and hyphens. Keep it under 30 characters.

### Step 2: Create the worktree

Use the worktree tool with action "create" and name set to the generated slug. The tool handles sanitization, hook integration, and git operations. It returns JSON with { path, name, branch, baseBranch }.

### Step 3: Change working directory

Change your working directory to the path returned by the worktree tool.

### Step 4: Explore the focus area in parallel

Spawn 2 sub-agents in parallel using the subagent tool (call the subagent tool 2 times in a single response):

**Agent 1 — Structure**: Explore the codebase to map out files, directories, components, and dependencies related to the described focus area. Use grep, glob, and read tools to find relevant code. Build a map of which files and modules are involved, how they're organized, and what depends on what.

**Agent 2 — Context**: Read key files in the focus area. Understand the current implementation, identify patterns, entry points, data flow, and any existing tests. Look for coding conventions, error handling patterns, and integration points.

### Step 5: Synthesize and present

After both agents complete, synthesize their findings into a concise summary:

- **Key files and their roles** — List each important file with a one-line description
- **Current implementation overview** — How the feature/area works today
- **Dependencies and relationships** — What depends on what, internal and external
- **Existing tests** — Any test files found, what they cover

Present this summary, then tell the user they are now working in the worktree at \`.gg/worktrees/<slug>/\` on branch \`worktree-<slug>\`, and ask what they'd like to do.`,
  },
  {
    name: "compare",
    aliases: [],
    description: "Compare code against real-world implementations via Grep MCP",
    prompt: `Compare the code you just created or modified in this conversation against real-world implementations using the \`mcp__grep__searchGitHub\` tool.

You already know what you just built. For each file you created or modified, use \`mcp__grep__searchGitHub\` to search for how real projects implement the same patterns. Look at the specific APIs, hooks, functions, and architecture you used.

If you find something consistently done differently across real codebases, or something commonly included that you left out, report it:

\`\`\`
[MISSING/DIVERGENT/INCOMPLETE] file:line - What it is
Wrote: What was implemented
Real-world: What real projects do instead/additionally
Evidence: Grep MCP - pattern seen in X out of Y repos searched
\`\`\`

Style preferences and subjective improvements are not valid findings. Only report things backed by clear Grep MCP evidence across multiple repos.

If the code aligns well with real-world patterns, say so. That's a good outcome.`,
  },
];

/** Look up a prompt command by name or alias */
export function getPromptCommand(name: string): PromptCommand | undefined {
  return PROMPT_COMMANDS.find((cmd) => cmd.name === name || cmd.aliases.includes(name));
}

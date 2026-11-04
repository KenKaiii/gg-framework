import type { LanguageId } from "../language-detector.js";

/**
 * Per-language style packs injected into the system prompt when the detector
 * sees the language is active. Keep each pack ≤ ~350 chars: tooling default,
 * the most bug-preventing rules, and what to avoid. No rationale or examples.
 * Avoid triple backticks (template literal conflict).
 */
export const PACKS: Readonly<Record<LanguageId, string>> = {
  typescript: `### TypeScript

- \`tsc --strict\` + \`noUncheckedIndexedAccess\`; Biome for format/lint.
- No \`any\`, no non-null \`!\`; prefer \`satisfies\` over \`as\`.
- Validate external input (with the project's schema lib if it has one).
- Result-style returns for expected failures; throw only for bugs.
- Named exports only; no floating promises; pass \`AbortSignal\` to I/O.
- Avoid \`enum\`, \`namespace\`, deep inheritance.`,

  javascript: `### JavaScript

- ESM; \`const\`, \`===\`, no \`var\`; JSDoc + \`// @ts-check\`.
- Validate external input (with the project's schema lib if it has one); no floating promises.
- Avoid default exports, prototype mutation, implicit globals.`,

  python: `### Python

- Python 3.11+; ruff (lint + format); pyright/mypy strict.
- Type hints on every public function; no bare \`Any\`.
- Validate external input with Pydantic or dataclasses + checks.
- Raise specific exceptions; never bare \`except:\`.
- \`pathlib\` over \`os.path\`; context managers for resources.
- Avoid mutable default args, star imports, global state.`,

  go: `### Go

- \`gofmt\`, \`go vet\`, \`golangci-lint\`.
- Always check errors; wrap with \`fmt.Errorf("...: %w", err)\`.
- \`context.Context\` first param for I/O; respect cancellation.
- Small interfaces defined at the consumer; return structs.
- Every goroutine has a clear owner and exit path.
- Avoid \`panic\` for expected errors, \`init()\` side effects, globals.`,

  rust: `### Rust

- \`rustfmt\` + \`clippy -D warnings\`.
- \`Result\` for fallible ops; \`thiserror\` in libs, \`anyhow\` in bins.
- No \`unwrap\`/\`expect\` outside tests or proven invariants.
- Newtypes for domain primitives; borrow over clone.
- \`unsafe\` only with a \`// SAFETY:\` comment.
- Avoid \`Rc<RefCell>\` webs and needless \`Box<dyn>\`.`,

  java: `### Java

- Java 21+; Spotless/google-java-format; Error Prone.
- Records for data; sealed interfaces for variants.
- \`Optional\` for absent returns; never return \`null\` collections.
- Validate input at boundaries; immutable by default (\`final\`).
- try-with-resources for closeables.
- Avoid checked-exception swallowing, field injection, deep inheritance.`,

  kotlin: `### Kotlin

- ktlint/detekt; explicit API mode for libraries.
- \`val\` over \`var\`; data/sealed classes for state.
- No \`!!\`; handle nullability explicitly.
- Structured concurrency: no \`GlobalScope\`; pass scopes.
- Sealed Result types for expected failures.
- Avoid \`lateinit\` abuse and platform-type leaks.`,

  csharp: `### C#

- \`<Nullable>enable</Nullable>\`, warnings as errors; \`dotnet format\`.
- Records for data; \`required\`/\`init\` properties.
- \`async\` all the way; pass \`CancellationToken\`; no \`.Result\`/\`.Wait()\`.
- Validate input at boundaries; \`using\` for disposables.
- Avoid \`async void\`, static mutable state, catching \`Exception\` broadly.`,

  cpp: `### C++

- C++20; clang-format + clang-tidy; \`-Wall -Wextra -Werror\`.
- RAII everywhere; \`unique_ptr\` by default, no raw \`new\`/\`delete\`.
- \`std::span\`/\`string_view\` for non-owning views; \`const\` by default.
- \`std::expected\`/optional for expected failures.
- Avoid macros, C casts, owning raw pointers, UB-prone indexing.`,

  c: `### C

- C17; \`-Wall -Wextra -Werror\`; ASan/UBSan in tests.
- Check every return value and allocation.
- Pass buffer lengths explicitly; use bounded functions (\`snprintf\`).
- Single cleanup path (\`goto cleanup\`) per function.
- Avoid \`gets\`/\`strcpy\`/\`sprintf\`, globals, unchecked casts.`,

  ruby: `### Ruby

- Ruby 3.2+; RuboCop/Standard; \`# frozen_string_literal: true\`.
- Validate input at boundaries; explicit keyword arguments.
- Raise specific error classes; never rescue \`Exception\`.
- Small objects over concerns/mixins.
- Avoid monkey-patching, \`method_missing\`, global state.`,

  php: `### PHP

- PHP 8.2+; \`declare(strict_types=1);\`; PHPStan max + PHP-CS-Fixer.
- Typed properties, params, returns; \`readonly\` classes for data.
- Validate input at boundaries; prepared statements only.
- Enums over string constants; specific exceptions.
- Avoid arrays as untyped structs, globals, \`@\` suppression.`,

  swift: `### Swift

- Swift 6 strict concurrency; SwiftFormat/SwiftLint.
- Value types (\`struct\`/\`enum\`) by default; \`let\` over \`var\`.
- No force unwrap \`!\` or \`try!\`; use \`guard let\`.
- \`async/await\` + actors; typed throws/Result for expected failures.
- Avoid singletons, implicitly unwrapped optionals, \`@unchecked Sendable\`.`,

  scala: `### Scala

- Scala 3; scalafmt + \`-Werror\`.
- Immutable case classes and enums; ADTs for state.
- \`Either\`/\`Option\` for expected failures; no \`null\`.
- Explicit types on public members.
- Avoid implicit conversions, \`var\`, throwing in pure code.`,

  elixir: `### Elixir

- \`mix format\`, Credo, Dialyzer.
- \`{:ok, v}\` / \`{:error, r}\` returns; \`with\` for chains.
- Pattern match in function heads; \`@spec\` on public functions.
- Supervise every process; let it crash.
- Avoid \`try/rescue\` for control flow, process dictionary, atom leaks.`,

  haskell: `### Haskell

- GHC2021; \`-Wall -Werror\`; fourmolu + hlint.
- Type signatures on all top-level bindings.
- \`Either\`/\`Maybe\` for expected failures; newtypes for domain values.
- Strict data fields; \`Text\` over \`String\`.
- Avoid partial functions (\`head\`, \`fromJust\`), orphan instances.`,

  ocaml: `### OCaml

- dune + ocamlformat; warnings as errors.
- \`.mli\` interfaces for every public module.
- \`result\` for expected failures; exhaustive matches.
- Variants over booleans/strings for state.
- Avoid partial functions, \`Obj.magic\`, mutable globals.`,

  fsharp: `### F#

- Fantomas; warnings as errors.
- Records and DUs for data; immutable by default.
- \`Result\`/\`Option\` for expected failures; exhaustive matches.
- \`task {}\` with \`CancellationToken\` for I/O.
- Avoid nulls, classes for pure data, mutable globals.`,

  clojure: `### Clojure

- clj-kondo + cljfmt.
- Pure functions over immutable maps; side effects at edges.
- Validate boundary data with Malli or spec.
- Return \`ex-info\` with data for errors.
- Avoid global atoms, dynamic vars as config, deep macros.`,

  dart: `### Dart

- Sound null safety; \`dart format\`; strict \`analysis_options\` lints.
- No \`!\` bang operator without proof; no \`dynamic\`.
- Immutable models (\`final\` fields); sealed classes for state.
- Await every Future; cancel subscriptions.
- Avoid global mutable state and \`late\` misuse.`,

  lua: `### Lua

- StyLua + luacheck.
- \`local\` everything; no implicit globals.
- Return \`nil, err\` for expected failures; \`pcall\` at boundaries.
- Modules return a table; no side effects on require.
- Avoid global mutation and metatable magic.`,

  zig: `### Zig

- \`zig fmt\`; latest stable Zig.
- Error unions with \`try\`; never discard errors.
- Pass allocators explicitly; \`defer\`/\`errdefer\` for cleanup.
- Test with \`std.testing.allocator\` for leak checks.
- Avoid \`@ptrCast\` without need, \`unreachable\` for real errors, globals.`,

  sql: `### SQL

- sqlfluff; uppercase keywords.
- Parameterized queries only; never string-concat input.
- Explicit column lists; no \`SELECT *\` in app code.
- Constraints (NOT NULL, FK, UNIQUE) in schema; forward-only migrations.
- Avoid implicit joins and unbounded queries.`,

  bash: `### Bash / Shell

- \`set -euo pipefail\`; shellcheck + shfmt.
- Quote every expansion: \`"$var"\`.
- \`[[ ]]\` over \`[ ]\`; \`local\` in functions.
- \`mktemp\` + \`trap\` cleanup.
- Avoid parsing \`ls\`, \`eval\`, backticks.`,

  terraform: `### Terraform / HCL

- \`terraform fmt\` + \`validate\` + tflint.
- Pin provider and module versions.
- Typed variables with \`validation\` blocks.
- Remote state with locking; no secrets in code or state outputs.
- Avoid hardcoded IDs, \`count\` for keyed resources (use \`for_each\`).`,
};

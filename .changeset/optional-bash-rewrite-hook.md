---
"@kenkaiiii/ggcoder": minor
---

Add an optional `rewriteCommand` hook to `createBashTool`/`createTools`, so a caller can route the bash tool's plain foreground commands (`git status`, `ps aux`, `find`, ...) through an external compaction tool before they run — e.g. [rtk](https://github.com/rtk-ai/rtk), which rewrites common CLI invocations into token-cheaper equivalents. Nothing ships wired in; omitted by default, so behavior for every existing caller is unchanged. Scoped to the synchronous spawn path only (not `persist` or `run_in_background`), and every safety guard (plan mode, catastrophic-command, network policy) still runs against the original command before the hook is ever called — a rewriter cannot be used to bypass them. A throwing or `undefined`-returning rewriter always falls back to the original command.

# Changelog

## Unreleased
- **Crash-recovery drafts + smarter timeout retry (2026-07-05):** In-flight assistant text is snapshotted during streaming and restored after a process crash/forced app restart as a clearly marked recovered reply. Bare-text SDK timeouts (for example Anthropic `Request timed out` errors without an error code) now route through the existing automatic stall retry/backoff path instead of surfacing raw to the user. Verified with `pnpm --filter gg-app check` and `pnpm --filter ggcoder check`.

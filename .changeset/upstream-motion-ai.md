---
"@kleio/ai": patch
---

Imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- `CODEX_CLIENT_VERSION` is exported, so other callers of the ChatGPT Codex backend (`generate_image`) send the same client identity as chat. Its value is unchanged.

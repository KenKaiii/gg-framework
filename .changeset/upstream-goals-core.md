---
"@kleio/core": patch
---

Model registry change imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- The Claude 5.5 family (Opus 5.5, Opus 5.5 fast, Sonnet 5.5 and Haiku 5.5) starts at medium thinking, as Anthropic's API and Claude Code do. The ceiling stays max, so users can still opt up.

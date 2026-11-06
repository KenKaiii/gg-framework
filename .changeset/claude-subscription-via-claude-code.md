---
"@kenkaiiii/gg-ai": minor
"@kenkaiiii/gg-agent": minor
"@kenkaiiii/gg-core": minor
"@kenkaiiii/ggcoder": minor
---

Claude Pro/Max plans now run through Anthropic's official Claude Code instead of a Claude Code look-alike sign-in. Picking "Sign in with Claude" (app or `ggcoder login`) downloads the pinned Claude Code build into `~/.gg/claude-code` with its sha512 checked, then opens Claude's own browser sign-in; GG Coder keeps a login separate from any Claude Code you already use and stores no token in `auth.json`. Each turn runs through the Agent SDK with GG Coder's own prompt and tools, with live text, thinking, steering, Stop and resume. Plan usage comes from Claude Code's rate-limit reports. Anthropic API keys are now a sign-in option and use GG's normal loop. Removed: `loginAnthropic`, `refreshAnthropicToken`, `getClaudeCliUserAgent` and the Claude Code OAuth headers, beta flags and system block in the Anthropic provider. Old Claude sign-ins ask you to sign in again once. GG Coder now introduces itself as "GG Coder by Ken Kai" on every provider.

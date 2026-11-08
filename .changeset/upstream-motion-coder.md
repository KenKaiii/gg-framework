---
"@kleio/coder": patch
---

Motion and engine changes imported selectively from upstream releases after 5.66.2. The engine base stays 5.66.2; `UPSTREAM.md` lists the upstream commits.

- Ideal self-review is removed: no extra review turn before a final answer, no independent reviewer and no review-coverage follow-ups. The verification gate still tracks which edits were checked, for run status and autopilot, but no longer forces another turn; a check whose exit status could not count is still re-run on its own. The `idealReviewEnabled` setting keeps switching the loop-break and re-grounding nudges.
- The `motion_check` tool is removed. Motion renders once and checks its own output: a flash-rate screen (WCAG 2.3.1) on the final file, feed loudness and safe bands, motion blur, sound-cue export, reference study and music fit. The bundled HyperFrames CLI is patched to render a frame range and to run its checks in parallel.
- Motion gains a move kit, nine new library pieces and six job skills (launch video, app walkthrough, website video, before and after, developer tool video, one like the user's example); `video-qa` is folded into the `motion` skill.
- The bundled bulletproof, compliance-guard, durable and lean skills get refreshed text, and durable adds a reference on agents and production databases. A loaded skill tells the agent to hand its root and reference files to any child it delegates to.
- `generate_image` uses Codex's own image endpoints with the Codex request shape, reports each image's delivered size and retries the failures Codex retries. It no longer depends on a chat model driving the tool, so it works again on ChatGPT accounts.
- MCP tools that return images without a file now show them live, and a reopened chat restores each tool image with its own path, including generate_image's extra images.
- A multi-file edit of a Motion composition arms the Motion review.

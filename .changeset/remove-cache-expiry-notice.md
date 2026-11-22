---
"@kenkaiiii/ggcoder": patch
---

Removed the "This chat's cache may have expired" strip above the chat input. Its **Compact first** button couldn't save the full-price re-read (compacting re-reads the whole chat itself), and it also appeared after every restart or model switch, whatever the cache's real age. GG still prunes old tool output harder on its own when the cache is cold, and auto-compaction is unchanged.

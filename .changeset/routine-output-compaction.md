---
"@kenkaiiii/ggcoder": patch
---

Trim routine boilerplate from small bash output: `git log` headers fold to one line per commit, `git status` drops its `(use "git …")` hints, `ls -l` states a shared owner/group once, and all-green vitest/jest runs list a count instead of every passing file. Failing runs, file lists and anything that doesn't match these shapes pass through unchanged.

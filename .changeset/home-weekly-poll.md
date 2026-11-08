---
"@kenkaiiii/ggcoder": patch
---

The app daemon serves Home's weekly feature poll: `GET /poll` reads the open poll and its counts, and `POST /poll/vote` votes or moves a vote under a salted SHA-256 of the OS machine id (so deleting `~/.gg` or reinstalling doesn't add a vote), falling back to a random id in `~/.gg/poll.json`.

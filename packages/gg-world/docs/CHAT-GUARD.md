# Chat guard

`src/chat-guard.js`: no links, no contact details, no advertising, no spam in World's chat (owner). Pure, no DOM, no
dependencies. Tests: `node --test packages/gg-world/test/chat-guard.test.mjs` (from the repo root).

## What it does
- **Caught:** links however they're disguised (look-alike letters, fancy fonts, invisible characters, "dot" / "(.)" /
  "[dot]", spaced-out letters, emoji or symbols as the dot, encoded dots, backwards text, IPs, shorteners, invites),
  contact details (email, phone, wallet addresses, handles like "snap: name", "name#1234"), advertising ("join my
  discord", "free nitro", "use my code GG10", "link in bio"...), and spam (more than 5 messages in 10 s, or the same
  message 3 times in 3 min, digits and punctuation ignored).
- **What happens:** the message isn't posted, and the sender is muted: 2 min, 5 min, 1 hour, 1 day, then 1 week (and it
  stays at a week). Each full day without an offence takes one step off. While muted, the chat box and DMs show
  "Muted · m:ss" and nothing can be sent. No rules are shown anywhere.
- **Also:** what does get posted is cleaned (invisible/bidi characters removed, fancy fonts made plain, zalgo trimmed,
  "aaaaaa" floods squashed, one line, 120 characters). Names use the World server's rules (3-14 letters, numbers,
  spaces; reserved names) plus the link/ad check.
- Ordinary chat stays fine, including code talk ("logger.info", "process.env.DEV", "install.sh", ".NET", "node.js").

## Where it runs
- Today: in the game (`night-ui.js` public chat + DMs, `creator.js` names). The mute is saved as `nr.chat.guard`
  (World storage, via the app), so reloading doesn't clear it.
- **When chat goes online, the World server must run this same module on every message before relaying it**, and keep
  the mute ladder per player on the server. A check that only runs in the game can be edited out by someone who
  modifies their copy; the server is the real wall.

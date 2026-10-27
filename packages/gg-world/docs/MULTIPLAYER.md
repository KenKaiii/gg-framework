# GG World multiplayer: the contract

Three parts, built together, must agree on this file:
- **Server**: `gg-royale/apps/world-server` (Cloudflare Worker `gg-world`, Durable Objects).
- **App**: `gg-coder/gg-app` (+ the sidecar in `gg-coder/packages/ggcoder`): gets a ticket, owns the WebSocket, relays.
- **Game**: `gg-coder/packages/gg-world`: sends its own state, draws other players.

Owner decisions (2026-10-27):
- Up to **50 real players per world**; when every world is full a new one opens. Fill the fullest world first (keep people together).
- **Only players who turned on online save (the consent box with the 18+ tick)** join the live world. Everyone else keeps playing offline with simulated people. The server enforces it too: a player with no `world_profiles` row can't get a ticket.
- **Simulated people top up**: the game shows `max(0, 25 - realPlayersInWorld)` simulated members, so the world never feels empty and they leave as real players arrive. Residents (Dex, Pat, Lyra, Oz, Ken) always stay. **Real players get a small marker** next to their name (nameplate + chat).
- **Chat is checked on the server** with the same rules as the game (`chat-guard.js`, copied verbatim to the server) and the same mute ladder (2 min, 5 min, 1 h, 1 day, 7 days; one step down per clean day), kept per player on the server so it follows them between worlds and reconnects. Rules are never shown in chat.
- **Moderation**: block (local, hides a player's chat and bubbles for you), report (stored on the server for the owner), ban (owner only, via an admin script; a banned player can't get a ticket).
- Privacy: what's shared is name, look, coding level, position/room, animation/emote, tipsy level, held prop, "coding at a PC" and public chat. Never code, files, prompts or what's on anyone's screen.

## 1. Getting in (app <-> sidecar <-> server)

1. The app (consent on, online save loaded) asks the sidecar for a ticket: Tauri command `agent_world_live` -> sidecar -> `POST /api/world/live` with the device bearer token (same auth as `/api/world/profile`).
2. Server: device auth -> player must have a `world_profiles` row (else 403 "online save is off") -> not banned (else 403 "banned") -> pick a world with room (<= 50 incl. reserved tickets) -> mint a one-time ticket (random 32 bytes, base64url; stored HASHED with player id, world id, expiry now+60 s, reserves the slot) -> `200 { world: "w1", ticket, url: "wss://<host>/api/world/live/ws" }`.
3. The app opens `new WebSocket(url + "?ticket=" + ticket)` from the main window (CSP `connect-src` allows `wss://gg-world.buzzbeamaustralia.workers.dev`). The Worker spends the ticket (one use) and passes the upgrade to that world's Durable Object with `x-gg-player` / `x-gg-world` headers. Nothing from the client is trusted for identity: the name comes from the `players` table on the server.
4. Reconnect: on close (not 4001 banned / 4003 consent / 4000 opened elsewhere), the app waits 2 s, 4 s, 8 s ... max 30 s, gets a NEW ticket and reconnects. One connection per player: a second one closes the first with 4000.
5. The app closes the socket when World closes (Back), and when World has been paused (app switched away) for more than 60 s; reopens when it resumes.

## 2. Messages (JSON text frames, client -> server <= 2 KB, else dropped)

Client -> server:
```
{ t: "hello", look, level, s }           first message after open (s = the state object below)
{ t: "state", s }                         own state: at most 10/s, only when it changed, + every 5 s as a keepalive
{ t: "look", look }                       after a wardrobe save
{ t: "chat", text }                       public chat (<= 120 chars after cleaning)
{ t: "report", id, reason }               reason <= 200 chars
{ t: "ping" }
```
State object `s` (all optional except floor/room/x/z):
```
{ floor: "main"|"roof"|"basement", room: string<=24, x: number, z: number, face: number (radians),
  anim: "idle"|"walk"|"run"|"sit", emote: null|"wave"|"dance"|"kiss"|"sleep"|"worm",
  tipsy: 0..5, prop: null|string<=16, coding: boolean }
```
Server -> client:
```
{ t: "welcome", you: id, world: "w1", players: [P...], count }   P = { id, name, level, look, s } for everyone else in this world
{ t: "join", p: P }
{ t: "leave", id }
{ t: "states", u: [[id, s], ...] }       batched 10/s, ONLY players on the receiver's floor, only those that changed
{ t: "look", id, look }
{ t: "chat", id, name, text }            text already cleaned by the server; sent to everyone in the world
{ t: "muted", until }                    your message wasn't posted; you're muted until this time (ms epoch)
{ t: "count", n }                        real players in this world (on join/leave)
{ t: "error", msg }
{ t: "pong" }
```
Server validation (drop silently or close 1008 on garbage): types, lengths, `look` via the existing `cleanLook`, floor in the 3 names, x/z finite and clamped to +-80, face finite, tipsy integer 0..5, emote in the list, level integer 1..999. Rate limits: state 15/s, look 1/5 s, report 1/30 s, anything else 20/s; over the limit = dropped (and closed if it keeps going at 5x).

## 3. App <-> game (postMessage relay; game is sealed, see WorldScreen.tsx)

```
game -> app : { gg:'world', t:'live', m: <client message> }        app forwards m to the socket if open, else drops it
app  -> game: { gg:'world', t:'live', m: <server message> }        every server message, as is
app  -> game: { gg:'world', t:'live-status', state: 'off'|'connecting'|'online', world?, count? }
```
'off' = not allowed (consent off), offline, or closed. The game shows simulated people only when 'off'.

## 4. Game behaviour
- On 'online' + welcome: create an avatar for each real player ON YOUR FLOOR (others kept as data only), interpolate positions (render ~120 ms behind, lerp), play walk/run/idle/sit by anim, emotes via `av.startEmote`, tipsy lean via `leanBody`, held prop via `holdProp`, a soft glow over their head when `coding`.
- Nameplate + chat name for real players get the marker; clicking a real player opens their profile card with **Block** and **Report**. Blocked ids (localStorage `nr.blocked`, max 200) hide their chat and bubbles.
- Public chat: the local guard runs first (instant mute feedback), then the message goes to the server; the server's `chat` echo is what appears for everyone (including you). If 'off', chat stays local as today.
- Simulated members: keep `max(0, 25 - count)` visible; the rest walk out / are hidden.
- HUD "N online" shows the real count when 'online' (fakes are not counted as online).

## 5. Launch-readiness changes (2026-10-27, after the ready review). These override anything above.

GG Royale is being retired. World must stand alone:
- **Sign-up moves to gg-world**: `POST /api/world/device/register` `{ client: "gg-coder", version }` -> `201 { playerId, deviceToken }`. Same as Royale's (`gg-royale/apps/server/src/device.ts register`): rate limits 10/h per IP + 600/h global, inserts `players` (fill the legacy NOT NULL columns exactly as Royale does) + `devices`, name `Builder-XXXX`.
- **Identity stays the same file**: the sidecar keeps `~/.gg/royale.json`. A link whose `serverUrl` is the old live Royale URL (or missing) is VALID for the live World server (same database). New links are made against the World server. Never re-register an existing player.
- **Full account delete**: `DELETE /api/world/account` (device auth): kicks the live socket (4004), WorldMod.forget(player), then deletes D1 rows in order: devices, world_profiles, D1 reports by/about them if that table exists, rate_limits for them if keyed, players. Bans stay (keyed by player id).
- **Delete online save** (`DELETE /api/world/me`) also: WorldMod.forget(player) (presence, tickets, mutes, reports they SENT) and closes their live socket with 4003. Reports ABOUT them and bans stay.

Close codes (server -> app): 4000 opened elsewhere, 4001 banned, 4002 kicked by an admin, 4003 online save / live consent off, 4004 account deleted. ALL are final for this World session: the app doesn't reconnect until World is reopened, and tells the game why.
`app -> game { t:'live-status', state:'off', reason }`, reason one of: 'offline' (no connection / retrying gave up), 'kicked', 'banned', 'elsewhere', 'consent', 'deleted', 'error'. While retrying after a drop: `state:'connecting', retry:true`.

Server -> client `muted` gains `by: 'admin' | 'rules'`.

Reports: `reason` must be one of `["Spam or ads","Harassment or hate","Sexual content","Cheating or exploits","Other"]`; the target must be connected in the reporter's room; max 10 reports per reporter per day and 1 per target per day; kept 30 days or until resolved (`POST /api/world/admin/report/resolve {id}` deletes it); pruned per reported player, not one global cap.
Chat gets its own limit: 3 messages per 3 s (over = dropped); a muted player's chat is dropped in the room (seat keeps `mutedUntil`) without calling WorldMod.

Live consent: joining the live world needs its own tick in the consent box: "Join the live world: you'll meet real players and public chat" + a link to COMMUNITY-RULES.md. Players who already agreed to online save are asked once for the live tick. Live is enabled only when: online save on + saved on the server + live tick on.

# GG World: privacy

Last updated: 27 October 2026

GG World is a 3D game mode inside the GG Coder app, run by Ken Kai. Privacy
questions, reports and appeals: **ken@kenkais.com**.

## GG Royale has closed

The GG Royale game is gone, and GG Coder no longer sends it anything. If you
had a GG Royale player, it is now your GG World account (same name, same
link on this computer). You can delete it any time from the cloud menu in
World (see below).

## Offline by default

World runs on your computer. With online save off, everyone you meet in it is
simulated and nothing about World leaves your computer, except the TV video
below when you choose to watch it. Online save is optional and off until you
agree and confirm you're 18 or over.

## What's stored and why

| What                                                                                                   | Why                                                                       | How long                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------- |
| A player id and a private device key (kept on your computer in `~/.gg/royale.json`, and on the server) | To know it's you, without a password                                      | Until you delete your account                      |
| Your World name, how your character looks, the items you own, coins spent, your coding level           | So your save survives reinstalls and carries over to other computers      | Until you delete your save or account              |
| Mutes and their history                                                                                | To apply the chat rules wherever you play                                 | Kept with your account; steps down over clean days |
| Reports (the reason, plus the reported player's last 20 public chat lines)                             | So a person can review abuse                                              | 30 days, or until reviewed                         |
| Bans (by account id)                                                                                   | To stop abuse                                                             | Kept, even after an account is deleted             |
| Your IP address                                                                                        | It reaches the server on every connection; used briefly to limit sign-ups | A rolling one-hour window for sign-up limits       |

World **never** receives your code, files, file names, prompts, commands or
anything from your projects.

## Live play

With online save on **and** the "Join the live world" tick on, you join the
live world with other real players (up to 50 per world). They see your World
name, how your character looks, your coding level, where you are in World,
your movements and emotes, how tipsy you are, what you're holding, a "coding"
glow while you sit at a PC, and your public chat. They never see your code,
files, prompts or what's on your screen.

- **Chat is checked on the server** with the same rules as in the game.
  Breaking them mutes you for a while; see [Community rules](COMMUNITY-RULES.md).
- **Mutes and bans:** admins can mute, kick or ban players who break the rules.
- **Block** hides a player's chat and bubbles for you only (kept on your computer).
- **Report** sends the reason and the reported player's last 20 public chat
  lines to the server, kept for 30 days or until reviewed.

## AI characters are AI

Some characters in World are AI. Their replies come from your own AI provider,
the one you set up in GG Coder. Other players' chat is never sent to your AI
provider.

## The computers in World are your own GG Coder

Sitting at a PC opens this window's own projects and sessions, framed as a
monitor. World itself can't see them: it runs sealed off from the rest of the
app. Other players can never see or type into your sessions.

## TVs play a YouTube video

Nothing loads until you choose to watch a TV. When you do, World loads a small
page from its server on Cloudflare, which plays the video in YouTube's
privacy-enhanced player (youtube-nocookie.com). So YouTube (Google) gets your
IP address and the usual details any video player sends. World sends YouTube
nothing about you, your save or your code. YouTube's own privacy policy covers
what it does with that. Closing the TV stops it.

## Where your data is

World's server runs on Cloudflare's global network (Workers, D1 and Durable
Objects), so your data may be processed in any country where Cloudflare
operates. Cloudflare processes it for us and only on our behalf. Nothing is
sold or shared with anyone else, and there are no ads or trackers.

## Deleting

In World, open the cloud key next to Back:

- **Delete my online save** removes your save (name, look, items, coins,
  level), takes you out of the live world, and forgets the reports you sent.
  Your account stays, so you can turn online save on again later.
- **Delete my account** removes your account, device link, save and the
  reports by and about you, and GG Coder forgets the link on this computer.
  Bans are kept by account id so they can't be dodged.

You can also email ken@kenkais.com.

## Your rights

You can ask what we hold about you, get a copy, have it corrected or deleted,
or object to how it's used, by emailing ken@kenkais.com. If you're not happy
with our answer, you can complain to your local data protection regulator.

## Changes

If this notice changes in a way that matters, GG Coder asks for your consent
again before World goes online.

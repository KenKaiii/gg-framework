// @ts-check
// Fake member data + a timeline that emits app-shaped events: { memberId, type, at }.
import { rng } from './rooms/kit.js';
import { extraMembers } from './crowd.js';

// home = room id. Looks: hoodies (hooded head), leather jackets (dark tops), beanies (fur hat tinted), a few silly ones.
export const MEMBERS = [
  { id: 'mira', name: 'mira', home: 'bar', level: 118, title: 'Ship Captain', accent: '#6ee7a0', look: { body: 'rogue', head: 'hooded', hair: '#1b1410', skin: '#c68a5e', top: '#23262e', bottom: '#1b1b2f', acc: 'glasses', accColor: '#111111' }, badges: ['First deploy', '100 commits', 'Night owl'], shipped: 4 },
  { id: 'theo', name: 'theo', home: 'den', level: 7, title: 'Fresh Commit', accent: '#e0a458', look: { body: 'knight', head: 'rogue', hair: '#6a4a2a', skin: '#f2c6a0', top: '#3a2a24', bottom: '#22223b', acc: 'fur', accColor: '#2d3a2e' }, badges: ['Hello world'], shipped: 1 },
  { id: 'juno', name: 'juno', home: 'basement', level: 66, title: 'Refactor Witch', accent: '#b04fd8', look: { body: 'mage', head: 'mage', hair: '#5a189a', skin: '#f6d5b8', top: '#2a2440', bottom: '#15111c', acc: 'wizard', accColor: '#2a1838' }, badges: ['500 commits', 'Bug squasher', 'Night owl'], shipped: 7 },
  { id: 'kai', name: 'kai', home: 'bar', level: 88, title: 'Prompt Whisperer', accent: '#e0a458', look: { body: 'barbarian', head: 'barbarian', hair: '#1a1a1a', skin: '#8d5a3b', top: '#1c1c1c', bottom: '#2b2d42', acc: 'headphones', accColor: '#3ddc84' }, badges: ['1000 commits', 'Streak 30d', 'Mentor'], shipped: 11 },
  { id: 'ana', name: 'ana', home: 'den', level: 14, title: 'Pixel Pusher', accent: '#ff4fd8', look: { body: 'rogue', head: 'hooded', hair: '#2a1a2a', skin: '#f9dcc4', top: '#3a2a34', bottom: '#1e2240', acc: 'none', silly: ['duck'] }, badges: ['CSS wizard'], shipped: 2 },
  { id: 'ravi', name: 'ravi', home: 'roof', level: 47, title: 'Test Tamer', accent: '#6ee7a0', look: { body: 'knight', head: 'rogue', hair: '#3a2618', skin: '#a8714f', top: '#2d3a2e', bottom: '#1b1b2f', acc: 'glasses', accColor: '#111111' }, badges: ['100 commits', 'Green CI'], shipped: 5 },
  { id: 'lena', name: 'lena', home: 'roof', level: 137, title: 'Legendary Shipper', accent: '#e0a458', look: { body: 'mage', head: 'knight', hair: '#8a5a3a', skin: '#f2c6a0', top: '#4a2c2a', bottom: '#15111c', acc: 'none', silly: ['sunglasses'] }, badges: ['2000 commits', 'Streak 100d', 'Hall of fame'], shipped: 14 },
  { id: 'omar', name: 'omar', home: 'basement', level: 31, title: 'API Artisan', accent: '#6ee7a0', look: { body: 'barbarian', head: 'rogue', hair: '#111111', skin: '#6f4e37', top: '#1a1d24', bottom: '#2a2440', acc: 'fur', accColor: '#3a2a34' }, badges: ['100 commits'], shipped: 3 },
  { id: 'sol', name: 'sol', home: 'den', level: 200, title: 'Curious Tinkerer', accent: '#e0a458', look: { body: 'rogue', head: 'barbarian', hair: '#7a1a1a', skin: '#f7d1b5', top: '#2a2440', bottom: '#1b1b2f', acc: 'none', silly: ['tinfoil'] }, badges: ['Hello world'], shipped: 0 },
  { id: 'bea', name: 'bea', home: 'bar', level: 47, title: 'Infra Gardener', accent: '#6ee7a0', look: { body: 'knight', head: 'hooded', hair: '#c9b79c', skin: '#e0ac69', top: '#1e2240', bottom: '#15111c', acc: 'headphones', accColor: '#b04fd8' }, badges: ['1000 commits', 'Zero downtime'], shipped: 6 },
  ...extraMembers(),
];

export const CHATTER = [
  'who pushed to main at 2am. oh. me.', 'tests green first try?? suspicious', 'beer #3, let’s go', 'who broke prod 👀', 'rubber duck needed, any volunteers',
  'fuck it, ship it', 'commit msg: "fix". just "fix". bold.', 'the agent rewrote my whole file. I asked for a typo fix', 'it works on my machine, ship the machine',
  'my PR has 2 approvals and 0 readers', '"temporary" hack from 2021 still in prod lmao', 'one more prompt then bed. (lie)', 'Dex, another Rollback IPA', 'docs > vibes',
];
const VERSIONS = ['v1.2', 'v2.3', 'v0.9-beta', 'v3.0', 'hotfix', 'v2.4.1'];

/** Emits events through `on(cb)`. Deterministic seed; time is driven by `tick(dt)` (no wall clock for logic). */
export class Simulator {
  constructor(seed = 42) {
    this.r = rng(seed); this.subs = []; this.t = 0; this.forced = false;
    this.next = MEMBERS.map((m, i) => ({ id: m.id, at: 0.5 + i * 0.7 + this.r() * 2 }));
    this.offline = new Set(['sol', 'omar', 'gus', 'fern']);
  }
  on(cb) { this.subs.push(cb); }
  emit(ev) { for (const s of this.subs) s(ev); }
  pick(arr) { return arr[Math.floor(this.r() * arr.length)]; }
  tick(dt, busy) {
    this.t += dt;
    if (this.t > 3.2 && !this.forced) { this.forced = true; this.emit({ memberId: 'kai', type: 'deploying', at: Date.now(), version: 'v2.3' }); const k = this.next.find(n => n.id === 'kai'); if (k) k.at = this.t + 16; }
    for (const n of this.next) {
      if (this.t < n.at) continue;
      let type;
      if (this.offline.has(n.id)) { type = this.r() < 0.15 ? 'online' : 'offline'; if (type === 'online') this.offline.delete(n.id); }
      else if (busy(n.id)) { n.at = this.t + 2; continue; }
      else { const x = this.r(); type = x < 0.42 ? 'prompting' : x < 0.64 ? 'thinking' : x < 0.78 ? 'deploying' : x < 0.96 ? 'idle' : 'offline'; if (type === 'offline') this.offline.add(n.id); }
      const ev = { memberId: n.id, type, at: Date.now() };
      if (type === 'deploying') ev.version = this.pick(VERSIONS);
      this.emit(ev);
      n.at = this.t + (type === 'deploying' ? 14 : 7) + this.r() * 9;
    }
  }
}

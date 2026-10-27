// @ts-check
// Chat guard: no links, no contact handoffs, no advertising, no spam (owner). Pure, no DOM, no dependencies, so the
// World server can run the exact same rules when chat goes online (a client check alone can be edited away).
//
// Anything caught is not posted, and the sender is muted on a ladder: 2 min, 5 min, 1 hour, 1 day, then 1 week.
// The ladder steps back down one level for every full day without an offence. Nothing explains the rules in chat:
// people who probe for a way round it just keep getting muted for longer.
//
//   const g = createGuard({ load: () => JSON.parse(localStorage.getItem(KEY) || 'null'), save: s => localStorage.setItem(KEY, JSON.stringify(s)) });
//   const r = g.check(text);   // { ok: true, text } | { ok: false, muted: true, until, minutes, fresh } | { ok: false }
//   g.mutedUntil();            // ms timestamp, 0 when free to talk
//   findProblem(text);         // 'link' | 'contact' | 'ad' | null   (also used for player names)

export const MAX_LEN = 120;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** Mute lengths by offence count (the last one repeats). */
export const LADDER = [2 * MIN, 5 * MIN, HOUR, DAY, 7 * DAY];
/** Spam: more than RATE_N messages in RATE_MS, or the same message DUP_N times in DUP_MS. */
const RATE_N = 5, RATE_MS = 10_000, DUP_N = 3, DUP_MS = 3 * MIN;

// ---------------------------------------------------------------------------------------------------------------
// Normalising: undo the tricks people use to hide a link from a filter.

/** Zero-width, joiners, bidi controls, variation selectors, invisible fillers, tag characters. */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu;
/** Look-alike letters from other alphabets and small caps (NFKC already folds fullwidth, math, circled, super/subscript). */
const CONFUSABLE = /** @type {Record<string, string>} */ ({
  а: 'a', ӓ: 'a', в: 'b', ь: 'b', с: 'c', ҫ: 'c', ԁ: 'd', е: 'e', ё: 'e', є: 'e', э: 'e', г: 'r', һ: 'h', н: 'h', і: 'i', ї: 'i',
  ј: 'j', к: 'k', ӏ: 'l', м: 'm', п: 'n', о: 'o', ө: 'o', р: 'p', ԛ: 'q', ѕ: 's', т: 't', у: 'y', ү: 'y', х: 'x', ԝ: 'w', з: '3',
  α: 'a', β: 'b', γ: 'y', δ: 'd', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', π: 'n', ρ: 'p', σ: 'o', ς: 'c', τ: 't',
  υ: 'u', χ: 'x', ω: 'w', ϲ: 'c', ϳ: 'j',
  ı: 'i', ł: 'l', ø: 'o', đ: 'd', ħ: 'h', ŀ: 'l', ℓ: 'l', ɑ: 'a', ɡ: 'g', ɩ: 'i', ꞁ: 'l', 〇: 'o', ß: 'ss', æ: 'ae', œ: 'oe',
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ғ: 'f', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o',
  ᴘ: 'p', ǫ: 'q', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
});
/** Characters people use in place of a dot. */
const DOTLIKE = /[\u3002\uFF0E\uFF61\u00B7\u2022\u2027\u2219\u22C5\u30FB\u02D9\u2E31\uA4F8\u0701\u0702\u06D4\u2024\u2E33\u2981\u25CF\u25E6]/g;

/** Emoji letters with no compatibility form: regional indicators (🇦) and negative squared/circled letters (🅰 🅐). */
/** @param {string} s */
function emojiLetters(s) {
  return s.replace(/[\u{1F1E6}-\u{1F1FF}\u{1F170}-\u{1F189}\u{1F150}-\u{1F169}\u{1F130}-\u{1F149}]/gu, (/** @type {string} */ ch) => {
    const c = /** @type {number} */ (ch.codePointAt(0));
    const base = c >= 0x1F1E6 ? 0x1F1E6 : c >= 0x1F170 ? 0x1F170 : c >= 0x1F150 ? 0x1F150 : 0x1F130;
    return String.fromCharCode(97 + c - base);
  });
}

/** The comparable form: folded to plain lowercase latin, marks and invisibles gone, dot look-alikes made dots. */
/** @param {unknown} text */
export function fold(text) {
  let s = String(text || '').normalize('NFKC').replace(INVISIBLE, '');
  s = emojiLetters(s).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  s = s.replace(/[^\x00-\x7F]/g, ch => CONFUSABLE[ch] ?? ch);
  s = s.replace(DOTLIKE, '.').replace(/\u2026/g, '...').replace(/%2e|&#0*46;|&#x0*2e;|&period;|&#183;/g, '.'); // also url/html-encoded dots
  s = s.replace(/\(\s*([a-z0-9])\s*\)/g, '$1'); // ⒢⒪⒪ -> (g)(o)(o) after NFKC
  return s;
}

const LEET = /** @type {Record<string, string>} */ ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'l' });
const leet = (/** @type {string} */ s, one = 'i') => s.replace(/[0134578@$!|]/g, (/** @type {string} */ c) => (c === '1' ? one : LEET[c]));

/** Join letters typed one at a time: "g o o g l e . c o m" -> "google.com". */
/** @param {string} s */
function joinSpaced(s) {
  const toks = s.split(/\s+/); const out = []; let run = '';
  for (const t of toks) { if (t.length === 1) run += t; else { if (run) out.push(run); run = ''; out.push(t); } }
  if (run) out.push(run);
  return out.join(' ');
}

// ---------------------------------------------------------------------------------------------------------------
// What counts as a link.

/** TLDs that mean "a website" on their own, even with no path (none of them are common words or code property names). */
const STRONG = 'com|net|org|io|gg|co|ai|tv|xyz|ru|cn|tk|gq|uk|de|fr|nl|jp|br|au|ca|ee|pw|icu|cyou|sbs|biz|club|fyi|website|xxx|porn|sex|adult|onion';
/** TLDs that are also words or code ("logger.info", "this.store", "env.dev", "install.sh"): a link only with more evidence. */
const WEAK = 'me|to|so|it|is|us|in|be|at|sh|cc|ws|ly|gl|gd|ml|ga|cf|app|dev|info|live|link|site|online|store|shop|page|bio|lol|fun|top|vip|pro|win|one|tech|cloud|world|space|life|today|chat|social|news|blog|stream|wtf|zone|codes';
/** Not English words: also caught when written with a space after the dot ("mysite. com") or as "mysite com". */
const SPACED = 'com|xyz|ru|cn|tk|gq|pw|icu|cyou|sbs|biz|onion|website'; // not 'org': "Done. Org meeting at 3"
/** Tech names that look like domains but aren't links people are being sent to. */
const ALLOW = /\b(?:asp|ado|vb)\.net\b/g;

const RE_STRONG = new RegExp(`[a-z0-9\\-_*~'"\\])]\\.(?:${STRONG})(?![a-z0-9-])`);
const RE_WEAK_PATH = new RegExp(`[a-z0-9-]\\.(?:${STRONG}|${WEAK})(?:\\/|:\\d|\\?|#)`);
/** Weak TLDs that are rarely code ("logger.info", "this.store", "req.page" stay fine): a link when someone is sent to it. */
const WEAK_SENT = 'me|to|so|it|is|us|in|be|at|sh|cc|ws|ly|gl|gd|ml|ga|cf|app|dev|site|shop|lol|fun|vip|pro|win|tech|cloud|world|space|life|today|social|blog|wtf|zone';
const RE_SENT_TO = new RegExp(`\\b(?:check\\s*(?:it\\s*)?out|visit|go\\s*to|head\\s*(?:over\\s*)?to|goto|open|join)\\s+(?:my\\s+|our\\s+|the\\s+)?[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${WEAK_SENT})(?![a-z0-9-])`);
const RE_SPACED_TLD = new RegExp(`[a-z0-9]\\.\\s+(?:${SPACED})(?![a-z0-9])|\\b(?!(?:the|a|an|my|your|our|their|his|her|its|this|that|serial|usb|virtual|old|new)\\s)[a-z0-9]{2,}\\s+(?:com|xyz|dotcom)(?![a-z0-9-])|\\bdotcom\\b`);
const RE_SCHEME = /\bh(?:tt|xx|tx|xt)ps?\s*[:;]|[:;]\s*[\/\\]\s*[\/\\]|\bwww\b|\bwww[a-z0-9]|\bftp\s*:|\bxn--|\bfile\s*:\s*\//;
const RE_KNOWN = /\b(?:t\.me|wa\.me|bit\.ly|goo\.gl|tinyurl|is\.gd|cutt\.ly|rb\.gy|ow\.ly|tiny\.cc|linktr\.ee|lnk\.bio|dsc\.gg|discord\.gg|discordapp|invite\.gg|shorturl|bitly)\b|\bdiscord\s*\.?\s*gg\b|\bdiscord\s*\.?\s*com\s*\/?\s*invite\b|\.gg\s*\//;
/** A symbol standing in for the dot ("google💯com", "evil★com"); not 'gg'/'co'/'ai' ("wp!gg" is just gaming chat). */
const RE_SYMDOT = new RegExp(`[a-z0-9][^a-z0-9\\s.]+(?:com|net|org|io|xyz|ru|cn|tk|biz|club|website|onion|pw|icu|cyou|sbs)(?![a-z0-9-])`);
const RE_IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const RE_EMAIL = /[a-z0-9._%+-]+\s*@\s*[a-z0-9-]+\s*\.\s*[a-z]{2,}/;

// Contact handoffs and advertising.
const PLATFORM = 'discord|telegram|tg|whatsapp|wa|snap|snapchat|insta|instagram|ig|tiktok|tt|twitch|youtube|yt|twitter|kick|onlyfans|of|fansly|patreon|kofi|ko-fi|cashapp|venmo|paypal|signal|wechat|kik|session|facebook|fb|reddit|steam|roblox|skype|threads|bluesky|bsky';
const OWNED = 'discord|server|telegram|whatsapp|snap|snapchat|insta|instagram|tiktok|twitch|youtube|yt|channel|stream|twitter|kick|onlyfans|fansly|patreon|kofi|ko-fi|site|website|shop|store|page|blog|newsletter|podcast|socials|link|links|group|gc|community';
const RE_AD = [
  new RegExp(`\\b(?:join|add|follow|sub|subscribe|subscribe\\s+to|sub\\s+to|check\\s*out|visit|support|watch|like)\\s+(?:my|our)\\s+(?:${OWNED})\\b`),
  new RegExp(`\\b(?:add|follow|dm|pm|message|msg|text|hit|find|catch|contact|reach|ping|join)\\s+(?:me|us)\\s+(?:up\\s+)?(?:on|at|in|over|via)\\s+(?:${PLATFORM})\\b`),
  // "my discord: name" / "my snap = name" / "my insta is @name" (with "is", only a handle-looking value: "my discord is down" is fine)
  new RegExp(`\\b(?:my|our)\\s+(?:${PLATFORM})\\s*(?:handle|tag|name|username|user|id)?\\s*(?::|=|->)\\s*@?[a-z0-9_.#]{3,}`),
  new RegExp(`\\b(?:my|our)\\s+(?:${PLATFORM})\\s*(?:handle|tag|name|username|user|id)?\\s+is\\s+(?:@[a-z0-9_.]{3,}|[a-z0-9_.]*[0-9_#.][a-z0-9_.#]*)`),
  new RegExp(`\\b(?:${PLATFORM})\\s*(?::|=|->)\\s*@?[a-z0-9_.#]{3,}`),
  new RegExp(`\\b(?:${PLATFORM})\\s+[@$][a-z0-9_.]{3,}`),
  new RegExp(`[@$][a-z0-9_.]{3,}\\s+(?:on|at)\\s+(?:${PLATFORM})\\b`),
  // a handle-looking name right after a platform ("snap coolguy99"): letters then a digit or underscore, 5+ long
  new RegExp(`\\b(?:snap|snapchat|insta|instagram|ig|tiktok|telegram|tg|kik|discord|twitter|twitch|cashapp|venmo|wechat|skype|roblox|steam)\\s+@?(?=[a-z0-9_.]{5,})[a-z][a-z0-9_.]*[0-9_][a-z0-9_.]*\\b`),
  new RegExp(`\\b(?:add|dm|pm|message|msg|text|hit)\\s+me\\b.{0,40}\\b(?:on|at|over|via)\\s+(?:${PLATFORM})\\b`),
  new RegExp(`\\bmy\\s+(?:yt|youtube|twitch|tiktok|insta|instagram|ig|onlyfans|of|kick|fansly|patreon)\\s+(?:channel|page|account|stream|link)\\b`),
  /\bdiscord\s*(?:invite|inv|server\s*code)\b/,
  /\b[a-z0-9_.]{2,}#\d{4}\b/, // discord tag
  /\b(?:free|cheap|claim)\s*(?:nitro|robux|v\s*-?\s*bucks|skins?|crypto|btc|bitcoin|eth|usdt|followers|subs|subscribers|likes|views|money|cash|gift\s*cards?|giftcards?)\b/,
  /\b(?:promo|discount|referral|ref|coupon|affiliate|invite)\s*(?:code|link)s?\b/,
  /\buse\s+my\s+code\b|\buse\s+code\s*[:=]?\s*[a-z]*\d[a-z0-9]*\b/, // "use code GG10", not "use code review"
  /\b(?:airdrop|onlyfans|0nlyfans|crypto\s+signals?|forex\s+signals?|double\s+your\s+(?:money|crypto|btc|bitcoin|eth))\b/,
  /\b(?:dm|pm|message|msg|text)\s+(?:me\s+)?for\s+(?:more|info|details|prices?|deals?|the\s+link|links?|access|promo|offers?|rates?)\b/,
  /\blinks?\s+in\s+(?:my\s+)?(?:bio|profile|description)\b/,
  /\b(?:sub|follow|like)\s*(?:4|for)\s*(?:sub|follow|like)\b/,
  /\b(?:self\s*promo|selling\s+accounts?|buy\s+accounts?|boosting\s+service)\b/,
];
const RE_WALLET = /\b0x[a-f0-9]{40}\b|\bbc1[a-z0-9]{25,62}\b|\b[13][a-hj-np-z1-9]{25,34}\b/i;

/** Phone numbers: 9+ digits written as one number (spaces, dashes, dots, brackets allowed between). */
/** @param {string} s */
function hasPhone(s) {
  const m = s.match(/\+?\(?\d[\d\s().\-]{6,}\d/g);
  return !!m && m.some(x => x.replace(/\D/g, '').length >= 9 && !/^\d{1,3}(\.\d{1,3}){1,3}$/.test(x.trim()));
}

/** Dot tricks made real dots: "(.)" "[.]", "(dot)" "dot" "d0t" before a TLD, "site .com", "site,com". @param {string} x */
function dotify(x) {
  return x
    .replace(/[([{<]\s*\.\s*[)\]}>]/g, '.')
    .replace(new RegExp(`([a-z0-9])\\s*[([{<]?\\s*(?:dot|d0t|dawt|punto|punkt)\\s*[)\\]}>]?\\s*(${STRONG})(?![a-z0-9])`, 'g'), '$1.$2')
    .replace(new RegExp(`\\b(?!(?:the|a|an|my|old|new|any|every|that|this|of|in|from|for|to|and|or|no|your|our|their|early|late)\\s)([a-z0-9-]+)\\s+\\.\\s*(${STRONG.replace('net|', '')})(?![a-z0-9])`, 'g'), '$1.$2')
    .replace(new RegExp(`([a-z0-9]),(${STRONG})(?![a-z0-9])`, 'g'), '$1.$2');
}

/**
 * What's wrong with this text, if anything: 'link', 'contact' (email, phone, handle, wallet) or 'ad'. Null = fine.
 * @param {string} text
 * @returns {'link' | 'contact' | 'ad' | null}
 */
export function findProblem(text) {
  const raw = String(text || '');
  const base = fold(raw).replace(ALLOW, ' ');
  // variants: as typed; dot-words and bracketed dots made real dots; letters typed one by one joined; leetspeak
  const dotted = dotify(base);
  // letters typed one by one, then dot tricks again: "g o o g l e (dot) c o m"
  const joined = dotify(joinSpaced(base)).replace(/\s*\.\s*(?=[a-z])/g, m => (/\s/.test(m) ? m : '.'));
  const joined2 = joinSpaced(dotted);
  // emoji or symbols wedged in ("google🔥.🔥com"), and text written backwards behind a hidden direction mark ("moc.elgoog")
  const squeezed = dotify(base.replace(/[^a-z0-9.\/:@\s-]+/g, ''));
  const backwards = [...base].reverse().join('');
  const variants = [...new Set([base, dotted, joined, joined2, squeezed, joinSpaced(squeezed), leet(dotted), leet(dotted, 'l'), leet(joined), leet(joined2), leet(squeezed)])];

  if (RE_STRONG.test(backwards)) return 'link';
  if (RE_SYMDOT.test(base)) return 'link';
  for (const v of variants) {
    if (RE_SCHEME.test(v) || RE_KNOWN.test(v) || RE_STRONG.test(v) || RE_WEAK_PATH.test(v) || RE_SPACED_TLD.test(v)) return 'link';
    if (RE_SENT_TO.test(v)) return 'link';
  }
  // letters spelled out with dots or dashes between them: "g.o.o.g.l.e.c.o.m", "w-w-w"
  for (const v of [base, leet(base)]) for (const m of v.match(/(?:\b[a-z0-9][.\-_]){3,}[a-z0-9]\b/g) || []) {
    const run = m.replace(/[.\-_]/g, '');
    if (/^www|[a-z0-9]{2,}(?:com|net|org|xyz|io|gg|ru|co|me|tv|ai)$/.test(run)) return 'link';
  }
  if (RE_IP.test(base)) return 'link';
  if (RE_EMAIL.test(base) || RE_WALLET.test(raw) || hasPhone(base)) return 'contact';
  for (const v of [base, leet(base), joined]) for (const re of RE_AD) if (re.test(v)) return 'ad';
  return null;
}

/** What gets shown: invisibles and bidi tricks gone, fancy fonts plain, zalgo trimmed, floods squashed, one line. */
/** @param {unknown} text */
export function clean(text) {
  let s = String(text || '').normalize('NFKC').replace(INVISIBLE, '');
  s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1');          // zalgo: at most two marks per letter
  s = s.replace(/(.)\1{3,}/gu, '$1$1$1');                // "aaaaaaaa" -> "aaa", "😂😂😂😂😂" -> "😂😂😂"
  s = s.replace(/[\r\n\t\v\f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return [...s].slice(0, MAX_LEN).join('');
}

/** Same message, for spotting repeats: letters only, digits and punctuation ignored ("hi 1", "hi 2!" are the same). */
const sameKey = (/** @type {string} */ text) => fold(text).replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');

// ---------------------------------------------------------------------------------------------------------------
// The guard: checks each message and keeps the mute ladder.

/**
 * @typedef {{ level: number, until: number, last: number }} GuardState
 * @param {{ now?: () => number, load?: () => any, save?: (s: GuardState) => void }} [o]
 */
export function createGuard(o = {}) {
  const now = o.now || (() => Date.now());
  /** @type {GuardState} */
  let st = { level: 0, until: 0, last: 0 };
  try { const v = o.load?.(); if (v && typeof v === 'object') st = { level: Math.max(0, Math.min(LADDER.length, v.level | 0)), until: +v.until || 0, last: +v.last || 0 }; } catch { /* fresh */ }
  /** @type {{ t: number, key: string }[]} */
  let recent = [];
  const persist = () => { try { o.save?.({ ...st }); } catch { /* storage off */ } };

  /** Every full day without an offence takes one step off the ladder. */
  const decay = (/** @type {number} */ t) => {
    if (st.level <= 0 || !st.last) return;
    const days = Math.floor((t - Math.max(st.last, st.until)) / DAY);
    if (days > 0) { st.level = Math.max(0, st.level - days); st.last += days * DAY; persist(); }
  };
  const mute = (/** @type {number} */ t) => {
    st.level = Math.min(LADDER.length, st.level + 1);
    const ms = LADDER[Math.min(st.level, LADDER.length) - 1];
    st.until = t + ms; st.last = t; persist();
    return { ok: false, muted: true, fresh: true, until: st.until, minutes: Math.round(ms / MIN) };
  };

  return {
    /** @param {string} text */
    check(text) {
      const t = now(); decay(t);
      if (t < st.until) return { ok: false, muted: true, fresh: false, until: st.until, minutes: Math.ceil((st.until - t) / MIN) };
      const shown = clean(text);
      if (!shown || !/[\p{L}\p{N}\p{So}]/u.test(shown)) return { ok: false };
      const key = sameKey(shown) || shown;
      recent = recent.filter(r => t - r.t < DUP_MS); recent.push({ t, key });
      const tooFast = recent.filter(r => t - r.t < RATE_MS).length > RATE_N;
      const repeated = recent.filter(r => r.key === key).length >= DUP_N;
      if (findProblem(text) || findProblem(shown) || tooFast || repeated) { recent = []; return mute(t); }
      return { ok: true, text: shown };
    },
    /** When the current mute ends (ms timestamp), or 0. */
    mutedUntil() { decay(now()); return now() < st.until ? st.until : 0; },
    /** @returns {GuardState} */
    state: () => ({ ...st }),
  };
}

/** World's saved key for the mute ladder (World key prefix, so it survives reloads; see gg-app world-store.ts). */
export const GUARD_KEY = 'nr.chat.guard';

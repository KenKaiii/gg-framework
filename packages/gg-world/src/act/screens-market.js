// @ts-check
// Market data for the studio trading terminal: real CoinGecko prices when reachable (4 s timeout, cached 60 s on S),
// otherwise a believable simulated feed. Stocks + $VIBE are always simulated (no keyless CORS stock source found).
import { rng } from './util.js';

export const ASSETS = [
  { sym: 'BTC', id: 'bitcoin', base: 67000 }, { sym: 'ETH', id: 'ethereum', base: 3300 }, { sym: 'SOL', id: 'solana', base: 160 },
  { sym: 'DOGE', id: 'dogecoin', base: 0.14 }, { sym: '$VIBE', base: 0.0042 }, { sym: 'NVDA', base: 130, stock: 1 }, { sym: 'TSLA', base: 240, stock: 1 }, { sym: 'AAPL', base: 225, stock: 1 },
];
const TTL = 60000;

async function getJSON(url) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 4000);
  try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) throw new Error('http ' + r.status); return await r.json(); } finally { clearTimeout(tm); }
}
/** Random walk ending at `last`, n points. */
export function walk(seed, last, chg, n = 96) {
  const r = rng(seed), out = []; let v = last / (1 + chg / 100);
  for (let i = 0; i < n; i++) { const drift = (last - v) / (n - i); v = Math.max(last * 0.2, v + drift + (r() - 0.5) * last * 0.012); out.push(v); }
  out[n - 1] = last; return out;
}
/** @param {any} S @returns {{ rows: any[], real: boolean, at: number, ready: Promise<void> }} */
export function market(S) {
  const now = Date.now(), c = S.__screensMkt;
  if (c && now - c.at < TTL) return c;
  const seed = (now / TTL) | 0, r = rng(seed);
  const m = { real: false, at: now, rows: ASSETS.map((a, i) => { const chg = (r() - 0.45) * (a.sym === '$VIBE' ? 40 : a.stock ? 5 : 9); const price = a.base * (1 + (r() - 0.5) * 0.1); return { ...a, price, chg, series: walk(seed + i * 7, price, chg) }; }), ready: Promise.resolve() };
  S.__screensMkt = m;
  m.ready = (async () => {
    try {
      const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,dogecoin&vs_currencies=usd&include_24hr_change=true');
      for (const row of m.rows) { const q = row.id && j[row.id]; if (q && typeof q.usd === 'number') { row.price = q.usd; row.chg = Number(q.usd_24h_change) || 0; row.real = true; row.series = walk(seed + row.sym.length, row.price, row.chg); } }
      m.real = m.rows.some(x => x.real);
      try {
        const ch = await getJSON('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1');
        const pts = (ch.prices || []).map(p => +p[1]).filter(Number.isFinite);
        if (pts.length > 10) { const step = Math.max(1, Math.floor(pts.length / 96)); m.rows[0].series = pts.filter((_, i) => i % step === 0).concat(m.rows[0].price); }
      } catch { /* sparkline stays simulated */ }
    } catch (e) { console.info('market feed simulated:', String(e)); }
  })();
  return m;
}

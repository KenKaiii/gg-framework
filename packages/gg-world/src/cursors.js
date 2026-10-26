// @ts-check
// Custom pixel-art cursors (drawn once at load, no image files): arrow, hand, text, not-allowed, grab, grabbing.
// Each is drawn at 1x and 2x and used via image-set so it stays crisp on Retina. installCursors() injects the CSS rules
// for the whole page (UI buttons get the hand, inputs the I-beam, disabled things the no-sign); CURSOR.<name> is the
// CSS value for setting a cursor by hand (the 3D canvas does this on hover).
const ART = {
  arrow: { hot: [1, 1], rows: [
    'X...........', 'XX..........', 'XoX.........', 'XooX........', 'XoooX.......', 'XooooX......', 'XoooooX.....', 'XooooooX....',
    'XoooooooX...', 'XooooooooX..', 'XoooooooooX.', 'XooooooXXXXX', 'XoooXooX....', 'XooXXooX....', 'XoX..XooX...', 'XX...XooX...',
    'X.....XooX..', '......XooX..', '.......XX...'] },
  hand: { hot: [5, 1], rows: [
    '.....XX.........', '....XooX........', '....XooX........', '....XooX........', '....XooXXX......', '....XooXooXXX...',
    '....XooXooXooXX.', '.XX.XooXooXooXoX', 'XooXXooooooooXoX', 'XoooXooooooooooX', '.XooXooooooooooX', '..XoXooooooooooX',
    '..XooooooooooooX', '...XoooooooooooX', '...XooooooooooX.', '....XooooooooX..', '....XooooooooX..', '....XXXXXXXXXX..'] },
  grab: { hot: [7, 6], rows: [
    '...XX.XX.XX....', '..XooXooXooXX..', '..XooXooXooXoX.', '.XXooXooXooXoX.', 'XooXoooooooooX.', 'XoooooooooooX..',
    '.XooooooooooX..', '..XoooooooooX..', '...XoooooooX...', '...XXXXXXXXX...'] },
  text: { hot: [3, 7], rows: [
    'XXX.XXX', 'XoXXXoX', '.XXoXX.', '..XoX..', '..XoX..', '..XoX..', '..XoX..', '..XoX..', '..XoX..', '..XoX..', '..XoX..', '..XoX..',
    '.XXoXX.', 'XoXXXoX', 'XXX.XXX'] },
};
const OUT = '#0b0a12', FILL = '#fff0d6', SHADE = '#f0c48a', NO = '#ff5a6a';

/** @param {string[]} rows @param {number} s scale */
function drawRows(rows, s) {
  const w = Math.max(...rows.map(r => r.length)), h = rows.length, c = document.createElement('canvas'); c.width = w * s; c.height = h * s;
  const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  const at = (i, j) => (rows[j] || '')[i] || '.';
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const ch = at(i, j); if (ch === '.') continue;
    // fill pixels touching the outline on the right / bottom get a warm shade: reads as a little 3D bevel
    x.fillStyle = ch === 'X' ? OUT : (at(i + 1, j) === 'X' || at(i, j + 1) === 'X') ? SHADE : FILL; x.fillRect(i * s, j * s, s, s); }
  return c.toDataURL('image/png');
}
function drawNo(s) { // not-allowed: red ring + slash with a dark outline, 16 x 16
  const n = 16, c = document.createElement('canvas'); c.width = c.height = n * s; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const dx = i - 7.5, dy = j - 7.5, d = Math.hypot(dx, dy), sl = Math.abs(dx - dy) / Math.SQRT2;
    const ring = d > 4.6 && d < 6.9, slash = sl < 1.2 && d < 5.2, edge = (d >= 6.9 && d < 7.9) || (d > 3.6 && d <= 4.6 && sl >= 1.2) || (sl >= 1.2 && sl < 2.1 && d < 4.8);
    if (ring || slash) { x.fillStyle = NO; x.fillRect(i * s, j * s, s, s); } else if (edge) { x.fillStyle = OUT; x.fillRect(i * s, j * s, s, s); } }
  return c.toDataURL('image/png');
}

/** CSS cursor values, filled by installCursors() */
export const CURSOR = { default: 'default', pointer: 'pointer', text: 'text', no: 'not-allowed', grab: 'grab', grabbing: 'grabbing' };

export function installCursors() {
  const val = (a1, a2, [hx, hy], fb) => `url(${a1}) ${hx} ${hy}, ${fb}`; // fallback chain, then image-set below
  const set = (a1, a2, [hx, hy], fb) => `-webkit-image-set(url(${a1}) 1x, url(${a2}) 2x) ${hx} ${hy}, ${fb}`;
  const mk = (name, rows, hot, fb) => { const a1 = drawRows(rows, 1), a2 = drawRows(rows, 2); return { name, plain: val(a1, a2, hot, fb), hi: set(a1, a2, hot, fb) }; };
  const C = [mk('default', ART.arrow.rows, ART.arrow.hot, 'default'), mk('pointer', ART.hand.rows, ART.hand.hot, 'pointer'), mk('text', ART.text.rows, ART.text.hot, 'text'),
    mk('grab', ART.grab.rows, ART.grab.hot, 'grab'), mk('grabbing', ART.grab.rows, ART.grab.hot, 'grabbing'), { name: 'no', plain: `url(${drawNo(1)}) 8 8, not-allowed`, hi: `-webkit-image-set(url(${drawNo(1)}) 1x, url(${drawNo(2)}) 2x) 8 8, not-allowed` }];
  // pick image-set if the browser takes it for cursors (Chrome, Safari/WebKit), else plain 1x
  const probe = document.createElement('div'); probe.style.cursor = C[0].hi; const hi = !!probe.style.cursor;
  for (const c of C) CURSOR[c.name] = hi ? c.hi : c.plain;
  const st = document.createElement('style'); st.id = 'night-cursors';
  st.textContent = `html,body,canvas,#ui,#ui *{cursor:${CURSOR.default}}
button,a,[role=button],summary,select,label,.go,.who,.rt,.opt,.sw,.btn,.rm,[data-r],.act .x,.clickable,.who *,.rt *{cursor:${CURSOR.pointer}!important}
input,textarea,[contenteditable=true]{cursor:${CURSOR.text}!important}
:disabled,[aria-disabled=true],.disabled,.rooms .rt.cur{cursor:${CURSOR.no}!important}
.c-grab,.c-grab *{cursor:${CURSOR.grab}!important}.c-grabbing,.c-grabbing *{cursor:${CURSOR.grabbing}!important}`;
  document.head.appendChild(st);
  return CURSOR;
}

// @ts-check
// Sharp mini-game canvases. Games draw in small logical units (480x270 etc.); the canvas is stored at the real screen
// resolution (logical size x CSS scale x devicePixelRatio) with the context pre-scaled, so text and shapes stay crisp
// instead of being a tiny image stretched up. Game code is unchanged: c.width / c.height still read the logical size,
// setTransform/resetTransform compose with the scale, and drawImage of another hi canvas draws it at its logical size.
const WD = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width'));
const HD = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height'));
const P = CanvasRenderingContext2D.prototype, setT = P.setTransform, di = P.drawImage, cp = P.createPattern;
let RS = 2;
/** Scale used for hi canvases created now (set by the overlay from its CSS fit x devicePixelRatio). */
export const renderScale = () => RS;
/** @param {number} r */
export function setRenderScale(r) { RS = Math.max(1, Math.min(4, Math.round(r * 4) / 4)); } // capped at 4: a 480x270 layer stays <= 8 MB

/**
 * Turn a canvas into a hi canvas of logical size w x h at scale r. Returns its pre-scaled 2D context.
 * @param {HTMLCanvasElement} c @param {number} w @param {number} h @param {number} [r]
 */
export function makeHi(c, w, h, r0 = RS) {
  const a = /** @type {any} */ (c); let lw = w, lh = h, r = r0;
  /** @type {CanvasRenderingContext2D} */ const x = /** @type {any} */ (c.getContext('2d'));
  const reset = () => setT.call(x, r, 0, 0, r, 0, 0);
  WD.set?.call(c, Math.max(1, Math.round(lw * r))); HD.set?.call(c, Math.max(1, Math.round(lh * r)));
  Object.defineProperty(c, 'width', { configurable: true, get: () => lw, set: v => { lw = +v; WD.set?.call(c, Math.max(1, Math.round(lw * r))); reset(); } });
  Object.defineProperty(c, 'height', { configurable: true, get: () => lh, set: v => { lh = +v; HD.set?.call(c, Math.max(1, Math.round(lh * r))); reset(); } });
  a.__R = r; c.classList.add('hi');
  /** change the stored resolution (window resized): keeps what's drawn, the next frame redraws it sharp */
  a.__rescale = nr => { nr = Math.max(0.5, Math.min(4, nr)); if (Math.abs(nr - r) < 1e-3) return;
    const tmp = document.createElement('canvas'); WD.set?.call(tmp, WD.get?.call(c)); HD.set?.call(tmp, HD.get?.call(c)); tmp.getContext('2d')?.drawImage(c, 0, 0);
    r = nr; a.__R = r; WD.set?.call(c, Math.max(1, Math.round(lw * r))); HD.set?.call(c, Math.max(1, Math.round(lh * r))); reset();
    di.call(x, tmp, 0, 0, lw, lh); };
  const ax = /** @type {any} */ (x);
  ax.setTransform = (m11, m12, m21, m22, dx, dy) => {
    if (typeof m11 === 'object' && m11) { const m = m11; return setT.call(x, (m.a ?? m.m11 ?? 1) * r, (m.b ?? m.m12 ?? 0) * r, (m.c ?? m.m21 ?? 0) * r, (m.d ?? m.m22 ?? 1) * r, (m.e ?? m.m41 ?? 0) * r, (m.f ?? m.m42 ?? 0) * r); }
    if (m11 === undefined) return reset();
    return setT.call(x, m11 * r, m12 * r, m21 * r, m22 * r, dx * r, dy * r);
  };
  ax.resetTransform = reset;
  reset(); return x;
}

/** A new offscreen hi canvas (for cached backdrops / panels drawn into a game canvas). @param {number} w @param {number} h @param {number} [r] */
export function hiCanvas(w, h, r = RS) { const c = document.createElement('canvas'); const x = makeHi(c, w, h, r); return { c, x }; }

// drawImage / createPattern of a hi canvas use its logical size, so callers never see the extra resolution.
/** @this {CanvasRenderingContext2D} */
P.drawImage = /** @type {any} */ (function (img, ...q) {
  const r = img && img.__R; if (!r) return di.call(this, img, ...q);
  if (q.length === 2) return di.call(this, img, 0, 0, Math.round(img.width * r), Math.round(img.height * r), q[0], q[1], img.width, img.height);
  if (q.length === 4) return di.call(this, img, 0, 0, Math.round(img.width * r), Math.round(img.height * r), q[0], q[1], q[2], q[3]);
  return di.call(this, img, q[0] * r, q[1] * r, q[2] * r, q[3] * r, q[4], q[5], q[6], q[7]);
});
/** @this {CanvasRenderingContext2D} */
P.createPattern = /** @type {any} */ (function (img, rep) {
  const p = cp.call(this, img, rep); const r = img && img.__R; if (p && r && typeof DOMMatrix !== 'undefined') p.setTransform(new DOMMatrix().scaleSelf(1 / r, 1 / r)); return p;
});

/**
 * CSS scale for a canvas of logical size w x h that must fit in availW x availH, snapped so that scale x devicePixelRatio
 * is a multiple of 0.5: the m5x7 pixel font (2 units per font pixel) then lands on the device-pixel grid and stays crisp at any window size.
 * Falls back to the exact fit when the window is too small for even 1 device pixel per unit.
 * @param {number} w @param {number} h @param {number} availW @param {number} availH
 */
export function crispFit(w, h, availW, availH) {
  const dpr = devicePixelRatio || 1, k = Math.min(availW / w, availH / h), n = Math.floor(k * dpr * 2 + 1e-6) / 2; /* m5x7 pixels are 2 units at 16px: half steps keep them whole */
  return n >= 1 ? n / dpr : Math.max(0.25, k);
}

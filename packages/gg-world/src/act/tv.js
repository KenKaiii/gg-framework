// @ts-check
// TV activities: 'tv-watch' (sit on a TV-facing seat: the TV plays Rick Astley, see rickroll.js) and
// 'den-crt' (the den CRT's "Change the game": a playable retro platformer close-up).
import { setView, clearView, hideOccluders, worldOf } from './view.js';
import { keys, loop } from './util.js';
import { makeTV } from './tv-screen.js';
import { startWindow } from './tv-window.js';
import { makePlatformer } from './tv-plat.js';
import { SFX } from '../sfx.js';
import { gx, GX } from './gx.js';
import { watchSeated } from './rickroll.js';

/** Screen centre (room-local), camera direction from the screen toward the seat (+ up), set type. */
const TVS = {
  studio: { at: [-6.05, 1.15, 2.5], dir: { x: 1, y: 0.5, z: 0.3 }, zoom: 1.35, kind: 'flat', name: 'studio big screen' },
  den: { at: [-2.22, 1.13, -5.24], dir: { x: 0.3, y: 0.5, z: 1 }, zoom: 1.2, kind: 'crt', name: 'den CRT' },
  bedroom: { at: [-4.3, 0.9, -3.03], dir: { x: 1, y: 0.55, z: 0.3 }, zoom: 1.15, kind: 'crt', name: 'bedroom CRT' },
};

const watch = {
  id: 'tv-watch', label: () => 'Watch TV',
  match: (it, R) => it.kind === 'seat' && it.act === 'tv-watch' && !!TVS[R.id],
  start(ctx) { watchSeated(ctx); }, // the TV plays Rick Astley now (rickroll.js); channel-surf retired
};

const denCrt = {
  id: 'den-crt',
  match: (it, R) => R.id === 'den' && it.id === 'tv-app', // reached from the TV's "change channel" (rickroll.js)
  start(ctx) {
    const { S, R } = ctx, cfg = { ...TVS.den, dir: { x: 0.1, y: 0.25, z: 1 }, zoom: 0.8 };
    setView(S, { target: worldOf(R, cfg.at[0], cfg.at[1], cfg.at[2]), dir: cfg.dir, zoom: cfg.zoom }); hideOccluders(S);
    const ov = ctx.overlay({ title: 'Super Commit Bros', sub: 'den CRT · level 1-2 · grab the coins, reach the flag', help: '<kbd>&larr;</kbd><kbd>&rarr;</kbd> run <kbd>space</kbd> / <kbd>click</kbd> jump' });
    ov.onClose(() => clearView(S));
    const K = gx(ov), k = keys(ov);
    const hud = K.hud([{ id: 'score', label: 'Score' }, { id: 'coins', label: 'Coins', value: '0', tone: 'gold' }], [{ id: 'time', label: 'Time', value: 45 }, { id: 'best', label: 'Best', value: 0, tone: 'gold' }]);
    const scene = K.scene({ aspect: 1000 / 736 });
    const tv = makeTV(scene); ov.onClose(tv.dispose);
    let playing = false, lastS = -1, lastT = -1;
    const game = makePlatformer({
      onPop: (bx, by, txt, tone) => { const r = tv.el.getBoundingClientRect(); K.pop(r.left + (bx / 160) * r.width, r.top + (by / 120) * r.height, txt, tone); },
      onEnd: res => setTimeout(() => { if (!ov.el.isConnected) return; playing = false; hud.set('best', res.best); if (res.win) K.swell();
        K.result({ title: res.win ? 'Level clear!' : 'Time up', big: res.score, best: res.newBest, line: res.win ? 'Flag reached. Ship it.' : 'The clock won this one.', stats: [[`${res.got} / ${res.total}`, 'Coins'], [res.best, 'Best']], again: 'Play again', onAgain: () => { game.reset(); playing = true; } }); }, 900),
    });
    hud.set('best', game.best);
    tv.el.addEventListener('pointerdown', e => { if (e.button === 0) { e.preventDefault(); k.add('Space'); tv.el.setPointerCapture?.(e.pointerId); } }); const up = () => k.delete('Space'); tv.el.addEventListener('pointerup', up); tv.el.addEventListener('pointercancel', up);
    SFX.play('crt.on', { vol: 0.5 });
    let start = -1;
    loop(ov, (dt, t) => {
      if (start < 0) start = t; const age = t - start;
      if (playing) game.step(dt, k);
      game.draw(tv.b, t);
      tv.present(t, { ch: 3, stat: age < 1 ? 1 - age : 0 });
      if (game.score !== lastS) { lastS = game.score; hud.set('score', lastS, { count: true }); hud.set('coins', `${game.got} / ${game.total}`); }
      const tm = Math.ceil(game.time); if (tm !== lastT) { lastT = tm; hud.set('time', tm, { tone: tm < 10 ? 'bad' : GX.text }); }
    });
    K.card({ title: 'Super Commit Bros', kicker: 'Level 1-2', text: 'Grab the coins, stomp the bugs, reach the flag before the clock runs out.', how: [[['←', '→'], 'run'], [['Space', 'Click'], 'jump']], cta: 'Start', onGo: () => { playing = true; } });
  },
};

const lookOut = { id: 'tv-window', label: () => 'Look outside', match: (it, R) => (R?.id === 'den' || R?.id === 'bedroom') && it?.id === 'window', start: startWindow };
export default [watch, denCrt, lookOut];

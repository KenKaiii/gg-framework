// @ts-check
// "Windoze 93" desktop at a lab PC: Snake and Minesweeper (best scores saved) + Clipp-E, the paperclip assistant.
// GX rebuild (concept: showcase/minigames/concepts/labpc.html): a beige CRT drawn in SVG, its screen a crisp DOM
// desktop in Sora with real bevels, a wire paperclip whose eyes follow you; Snake on a hi-DPI canvas.
import { SFX } from '../sfx.js';
import { rng } from './util.js';
import { gx } from './gx.js';
import { best, saveBest, seat, closeUp } from './computer-util.js';

const TIPS = ["It looks like you're writing a prompt. Need context?", 'Tip: small steps beat one giant prompt.', 'Ask the agent for tests. Then read them.', "Never paste your API keys. I'm watching.", 'Review the diff before you ship it.'];
const LP_CSS = ".lp-rig > svg { position:absolute; inset:0; width:100%; height:100%; overflow:visible; } .lp-screen { position:absolute; left:13%; top:10.4%; width:74%; height:64.2%; border-radius:2.2%/3.2%; overflow:hidden; background:#0b1e24; box-shadow:0 0 60px 6px rgba(68,227,207,.25); } .lp-desk { position:absolute; left:0; top:0; width:780px; height:520px; transform-origin:0 0; overflow:hidden; font: 500 12px/1.3 'Sora',sans-serif; color:#14181c; user-select:none; background: radial-gradient(circle at 1px 1px, rgba(255,255,255,.07) 1px, transparent 1.4px) 0 0/14px 14px, radial-gradient(ellipse 90% 80% at 30% 20%, #2f8f8a, #1c5f66 55%, #123e4a 100%); } .lp-glass { position:absolute; inset:0; pointer-events:none; z-index:50; background: radial-gradient(ellipse 120% 90% at 50% 50%, transparent 62%, rgba(0,0,0,.35) 100%), linear-gradient(160deg, rgba(255,255,255,.16) 0%, rgba(255,255,255,.04) 26%, transparent 27%), repeating-linear-gradient(0deg, rgba(0,0,0,.035) 0 1px, transparent 1px 3px); } /* icons */ .lp-icons { position:absolute; left:14px; top:14px; display:grid; gap:10px; } .lp-icon { width:84px; padding:6px 4px; border:0; background:none; display:grid; justify-items:center; gap:5px; cursor:pointer; font:600 11.5px/1.25 'Sora',sans-serif; color:#fff; text-shadow:0 1px 2px rgba(0,0,0,.6); border-radius:4px; } .lp-icon svg { width:44px; height:44px; filter:drop-shadow(0 2px 2px rgba(0,0,0,.35)); } .lp-icon span { padding:1px 4px; border-radius:2px; } .lp-icon:hover span, .lp-icon.sel span { background:#1d3fa8; outline:1px dotted rgba(255,255,255,.7); } .lp-icon kbd { font:600 9.5px 'Sora',sans-serif; opacity:.75; } /* windows: real 2px bevels */ .lp-win { position:absolute; background:#d9d4c7; padding:3px; box-shadow: inset -1px -1px #3a3833, inset 1px 1px #fbf9f3, inset -2px -2px #8d8878, inset 2px 2px #ecE8dd, 0 10px 26px -8px rgba(0,0,0,.55); animation: lp-winpop .22s cubic-bezier(.22,1,.36,1); } .lp-win[hidden] { display:none; } @keyframes lp-winpop { from { opacity:0; scale:.96; } } .lp-title { display:flex; align-items:center; gap:6px; height:22px; padding:0 3px 0 6px; color:#fff; font:600 12px/1 'Sora',sans-serif; background:linear-gradient(90deg,#1b3c9e,#3f7fd6); cursor:default; } .lp-win.dim .lp-title { background:linear-gradient(90deg,#77736a,#a9a597); } .lp-title b { flex:1; font-weight:600; } .lp-title svg { width:14px; height:14px; } .lp-x { width:18px; height:16px; border:0; padding:0; background:#d9d4c7; cursor:pointer; font:700 11px/1 'Sora',sans-serif; color:#14181c; box-shadow: inset -1px -1px #3a3833, inset 1px 1px #fff, inset -2px -2px #8d8878; } .lp-x:active { box-shadow: inset 1px 1px #3a3833, inset -1px -1px #fff; } .lp-body { padding:10px; } .lp-sunk { background:#fff; box-shadow: inset 1px 1px #8d8878, inset -1px -1px #fff, inset 2px 2px #3a3833, inset -2px -2px #ecE8dd; } .lp-rbtn { border:0; background:#d9d4c7; padding:5px 16px 6px; font:600 12px/1.2 'Sora',sans-serif; color:#14181c; cursor:pointer; box-shadow: inset -1px -1px #3a3833, inset 1px 1px #fff, inset -2px -2px #8d8878, inset 2px 2px #ecE8dd; } .lp-rbtn:active { box-shadow: inset 1px 1px #3a3833, inset -1px -1px #fff, inset 2px 2px #8d8878; } .lp-rbtn:focus-visible, .lp-icon:focus-visible { outline:1px dotted #14181c; outline-offset:-4px; } .lp-welcome h3 { margin:0 0 2px; font:700 17px/1.2 'Sora',sans-serif; letter-spacing:-.01em; } .lp-welcome p { margin:0 0 10px; color:#4a4a44; font-size:11.5px; } .lp-bests { display:grid; grid-template-columns:1fr 1fr; gap:8px; } .lp-bests div { padding:8px 10px; } .lp-bests small { display:block; color:#5c5a52; font-size:10.5px; font-weight:600; } .lp-bests b { font:700 20px/1.1 'Sora',sans-serif; font-variant-numeric:tabular-nums; } /* snake */ .lp-snakebar { display:flex; justify-content:space-between; font:600 11.5px 'Sora',sans-serif; padding:0 2px 6px; font-variant-numeric:tabular-nums; } .lp-pit { position:relative; width:300px; height:240px; } .lp-pit canvas { width:300px; height:240px; display:block; } .lp-over { position:absolute; inset:0; display:grid; place-items:center; background:rgba(10,20,24,.45); } .lp-over[hidden] { display:none; } .lp-over .card { width:220px; padding:16px 16px 14px; animation-duration:.3s; } .lp-over .card h2 { font-size:18px; } .lp-over .card .big { font-size:40px; margin-top:8px; } .lp-over .card .actions { margin-top:12px; } /* mines */ .lp-mgrid { display:grid; grid-template-columns:repeat(9,22px); padding:3px; } .lp-cell { width:22px; height:22px; border:0; padding:0; background:#d9d4c7; font:800 12px/22px 'Sora',sans-serif; cursor:pointer; box-shadow: inset -1px -1px #3a3833, inset 1px 1px #fff, inset -2px -2px #8d8878; } .lp-cell.open { box-shadow: inset 1px 1px #a19d90; background:#cfcabc; cursor:default; } .lp-cell.boom { background:#ff7d70; } .lp-cell svg { width:14px; height:14px; vertical-align:-2px; } .lp-mstat { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; font:600 11.5px 'Sora',sans-serif; font-variant-numeric:tabular-nums; } /* gg coder dialog */ .lp-dlg { display:flex; gap:12px; align-items:center; } .lp-dlg svg { width:40px; height:40px; flex:none; } .lp-dlg p { margin:0; font-size:12.5px; } /* paperclip */ .lp-clip { position:absolute; right:14px; bottom:44px; width:62px; height:96px; z-index:30; } .lp-bubble { position:absolute; right:84px; bottom:104px; width:178px; z-index:30; padding:9px 11px; border-radius:10px; background:#fff8d6; color:#2a261a; font:500 11.5px/1.4 'Sora',sans-serif; box-shadow:0 0 0 1px #6b6550, 0 6px 14px -6px rgba(0,0,0,.5); } .lp-bubble::after { content:\"\"; position:absolute; right:-8px; bottom:14px; border:8px solid transparent; border-left-color:#fff8d6; border-right:0; filter:drop-shadow(1px 0 0 #6b6550); } .lp-bubble .lp-rbtn { margin-top:7px; padding:3px 10px 4px; font-size:11px; } .lp-clipwrap { animation: lp-bob 3.2s ease-in-out infinite; transform-origin:50% 100%; } @keyframes lp-bob { 50% { transform: translateY(-3px) rotate(-2deg); } } /* taskbar */ .lp-bar { position:absolute; left:0; right:0; bottom:0; height:32px; z-index:40; display:flex; align-items:center; gap:6px; padding:3px 4px; background:#d9d4c7; box-shadow: inset 0 1px #fbf9f3, inset 0 2px #ecE8dd; } .lp-start { display:flex; align-items:center; gap:6px; font-weight:800; padding:3px 10px 4px 6px; } .lp-start svg { width:16px; height:16px; } .lp-tasks { flex:1; display:flex; gap:4px; overflow:hidden; } .lp-task { font:600 11px 'Sora',sans-serif; padding:4px 10px 5px; max-width:120px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .lp-task.on { box-shadow: inset 1px 1px #3a3833, inset -1px -1px #fff, inset 2px 2px #8d8878; background:#e6e2d7; } .lp-clock { padding:5px 12px; font:600 11.5px 'Sora',sans-serif; font-variant-numeric:tabular-nums; box-shadow: inset 1px 1px #8d8878, inset -1px -1px #fff; } @media (prefers-reduced-motion: reduce) { .lp-clipwrap, .lp-win { animation:none; } } ";
const LP_RIG = " <defs> <linearGradient id=\"lp-shell\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"> <stop offset=\"0\" stop-color=\"#ece3cf\"/><stop offset=\".55\" stop-color=\"#d9ceb4\"/><stop offset=\"1\" stop-color=\"#b9ad92\"/> </linearGradient> <linearGradient id=\"lp-bezel\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"> <stop offset=\"0\" stop-color=\"#cfc4aa\"/><stop offset=\"1\" stop-color=\"#a99d82\"/> </linearGradient> <linearGradient id=\"lp-chin\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"> <stop offset=\"0\" stop-color=\"#d4c9ae\"/><stop offset=\"1\" stop-color=\"#b3a78c\"/> </linearGradient> <linearGradient id=\"lp-neck\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"> <stop offset=\"0\" stop-color=\"#8f8470\"/><stop offset=\"1\" stop-color=\"#c6bba1\"/> </linearGradient> <radialGradient id=\"lp-led\"><stop offset=\"0\" stop-color=\"#d8ffd9\"/><stop offset=\".4\" stop-color=\"#5fe07a\"/><stop offset=\"1\" stop-color=\"#5fe07a\" stop-opacity=\"0\"/></radialGradient> <filter id=\"lp-soft\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"160%\"><feGaussianBlur stdDeviation=\"18\"/></filter> </defs> <ellipse cx=\"500\" cy=\"752\" rx=\"380\" ry=\"20\" fill=\"#000\" opacity=\".5\" filter=\"url(#lp-soft)\"/> <path d=\"M420 668 L580 668 L600 724 L400 724 Z\" fill=\"url(#lp-neck)\"/> <rect x=\"300\" y=\"716\" width=\"400\" height=\"30\" rx=\"12\" fill=\"url(#lp-chin)\"/> <rect x=\"300\" y=\"716\" width=\"400\" height=\"3\" rx=\"1.5\" fill=\"#f3ecdc\" opacity=\".8\"/> <rect x=\"40\" y=\"10\" width=\"920\" height=\"670\" rx=\"46\" fill=\"url(#lp-shell)\"/> <rect x=\"40\" y=\"10\" width=\"920\" height=\"670\" rx=\"46\" fill=\"none\" stroke=\"#fffaf0\" stroke-opacity=\".7\" stroke-width=\"2\"/> <path d=\"M86 12 H914\" stroke=\"#fff\" stroke-opacity=\".9\" stroke-width=\"2\" stroke-linecap=\"round\"/> <rect x=\"40\" y=\"10\" width=\"920\" height=\"120\" rx=\"46\" fill=\"#e8f2ff\" opacity=\".18\"/> <rect x=\"96\" y=\"58\" width=\"808\" height=\"532\" rx=\"30\" fill=\"url(#lp-bezel)\"/> <rect x=\"96\" y=\"58\" width=\"808\" height=\"532\" rx=\"30\" fill=\"none\" stroke=\"#7f7562\" stroke-width=\"3\"/> <rect x=\"99\" y=\"61\" width=\"802\" height=\"526\" rx=\"28\" fill=\"none\" stroke=\"#fff6e4\" stroke-opacity=\".35\" stroke-width=\"2\"/> <rect x=\"122\" y=\"74\" width=\"756\" height=\"504\" rx=\"18\" fill=\"#05090b\"/> <rect x=\"40\" y=\"606\" width=\"920\" height=\"2\" fill=\"#a59a7f\"/> <rect x=\"40\" y=\"608\" width=\"920\" height=\"1.5\" fill=\"#f7f0e0\" opacity=\".7\"/> <g fill=\"#8a7f69\"> <rect x=\"120\" y=\"630\" width=\"6\" height=\"30\" rx=\"3\"/><rect x=\"134\" y=\"630\" width=\"6\" height=\"30\" rx=\"3\"/><rect x=\"148\" y=\"630\" width=\"6\" height=\"30\" rx=\"3\"/> <rect x=\"162\" y=\"630\" width=\"6\" height=\"30\" rx=\"3\"/><rect x=\"176\" y=\"630\" width=\"6\" height=\"30\" rx=\"3\"/><rect x=\"190\" y=\"630\" width=\"6\" height=\"30\" rx=\"3\"/> </g> <rect x=\"446\" y=\"626\" width=\"108\" height=\"34\" rx=\"8\" fill=\"#c8bda2\" stroke=\"#8f8470\"/> <text x=\"500\" y=\"648\" text-anchor=\"middle\" font-family=\"Sora\" font-weight=\"800\" font-size=\"15\" letter-spacing=\"2\" fill=\"#6a604c\">GG\u00b793</text> <circle cx=\"760\" cy=\"643\" r=\"11\" fill=\"#c4b99e\" stroke=\"#8f8470\"/><circle cx=\"796\" cy=\"643\" r=\"11\" fill=\"#c4b99e\" stroke=\"#8f8470\"/> <rect x=\"826\" y=\"630\" width=\"58\" height=\"26\" rx=\"6\" fill=\"#cbc0a5\" stroke=\"#857a65\"/> <rect x=\"828\" y=\"631\" width=\"54\" height=\"2\" rx=\"1\" fill=\"#fff\" opacity=\".6\"/> <circle cx=\"904\" cy=\"643\" r=\"16\" fill=\"url(#lp-led)\"/><circle cx=\"904\" cy=\"643\" r=\"4\" fill=\"#8dff9f\"/> ";
const LP_ICONS = " <button class=\"lp-icon\" data-app=\"snake\"><svg viewBox=\"0 0 48 48\"><rect x=\"2\" y=\"2\" width=\"44\" height=\"44\" rx=\"10\" fill=\"#173a2a\"/><path d=\"M10 34 C10 24 22 26 22 18 S32 10 36 16\" fill=\"none\" stroke=\"#7fdc95\" stroke-width=\"6\" stroke-linecap=\"round\"/><circle cx=\"36\" cy=\"16\" r=\"5\" fill=\"#9ff0b0\"/><circle cx=\"37.5\" cy=\"14.5\" r=\"1.3\" fill=\"#10241a\"/><path d=\"M40 17 l4 1 m-4 -1 l3 3\" stroke=\"#ff7d70\" stroke-width=\"1.2\" stroke-linecap=\"round\"/><circle cx=\"35\" cy=\"36\" r=\"4\" fill=\"#ff7d70\"/></svg><span>Snake</span><kbd>1</kbd></button> <button class=\"lp-icon\" data-app=\"mines\"><svg viewBox=\"0 0 48 48\"><rect x=\"2\" y=\"2\" width=\"44\" height=\"44\" rx=\"10\" fill=\"#e9e4d8\"/><g stroke=\"#1b1e22\" stroke-width=\"3\" stroke-linecap=\"round\"><path d=\"M24 9v30M9 24h30M13.5 13.5l21 21M34.5 13.5l-21 21\"/></g><circle cx=\"24\" cy=\"24\" r=\"10\" fill=\"#1b1e22\"/><circle cx=\"20.5\" cy=\"20.5\" r=\"3\" fill=\"#fff\" opacity=\".85\"/></svg><span>Mines</span><kbd>2</kbd></button> <button class=\"lp-icon\" data-app=\"gg\"><svg viewBox=\"0 0 48 48\"><defs><linearGradient id=\"lp-gg\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#a9b8ff\"/><stop offset=\"1\" stop-color=\"#6b5cff\"/></linearGradient></defs><rect x=\"2\" y=\"2\" width=\"44\" height=\"44\" rx=\"10\" fill=\"url(#lp-gg)\"/><text x=\"24\" y=\"31\" text-anchor=\"middle\" font-family=\"Sora\" font-weight=\"800\" font-size=\"19\" fill=\"#050a2e\" letter-spacing=\"-1\">GG</text><rect x=\"12\" y=\"35\" width=\"10\" height=\"2.4\" rx=\"1.2\" fill=\"#050a2e\" opacity=\".7\"/></svg><span>GGCODER.EXE</span><kbd>3</kbd></button> ";
const LP_CLIP = "<svg class=\"lp-clip\" viewBox=\"0 0 62 96\" aria-hidden=\"true\"><defs><linearGradient id=\"lp-wire\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0\" stop-color=\"#7d8792\"/><stop offset=\".45\" stop-color=\"#f4f7fa\"/><stop offset=\"1\" stop-color=\"#8a95a1\"/></linearGradient></defs> <g class=\"lp-clipwrap\"> <ellipse cx=\"31\" cy=\"92\" rx=\"20\" ry=\"3\" fill=\"#000\" opacity=\".3\"/> <path d=\"M22 84 V22 a10 10 0 0 1 20 0 V72 a6.5 6.5 0 0 1 -13 0 V30\" fill=\"none\" stroke=\"#3d454e\" stroke-width=\"5.2\" stroke-linecap=\"round\"/> <path d=\"M22 84 V22 a10 10 0 0 1 20 0 V72 a6.5 6.5 0 0 1 -13 0 V30\" fill=\"none\" stroke=\"url(#lp-wire)\" stroke-width=\"3.6\" stroke-linecap=\"round\"/> <g><ellipse cx=\"25\" cy=\"34\" rx=\"6\" ry=\"7\" fill=\"#fff\" stroke=\"#3d454e\"/><ellipse cx=\"40\" cy=\"34\" rx=\"6\" ry=\"7\" fill=\"#fff\" stroke=\"#3d454e\"/> <circle class=\"eL\" cx=\"26.5\" cy=\"35\" r=\"2.6\" fill=\"#14181c\"/><circle class=\"eR\" cx=\"41.5\" cy=\"35\" r=\"2.6\" fill=\"#14181c\"/> <path d=\"M19 24 q6 -5 11 -1 M35 23 q6 -3 11 1\" fill=\"none\" stroke=\"#3d454e\" stroke-width=\"1.6\" stroke-linecap=\"round\"/></g> </g></svg>";
const LP_LOGO = "<svg viewBox=\"0 0 16 16\"><rect x=\"1\" y=\"1\" width=\"6.5\" height=\"6.5\" rx=\"1\" fill=\"#ff7d70\"/><rect x=\"8.5\" y=\"1\" width=\"6.5\" height=\"6.5\" rx=\"1\" fill=\"#7fdc95\"/><rect x=\"1\" y=\"8.5\" width=\"6.5\" height=\"6.5\" rx=\"1\" fill=\"#8fa3ff\"/><rect x=\"8.5\" y=\"8.5\" width=\"6.5\" height=\"6.5\" rx=\"1\" fill=\"#f0c75e\"/></svg>";
const SNC = 28, SNR = 13, CELL = 15, MW = 12, MH = 8, MN = 14;
const COL = ['', '#2f4fd6', '#2c8a43', '#d23b2f', '#1b2a7a', '#7a2b1b', '#1d7f80', '#14181c', '#6b6b6b'];
const MINE = '<svg viewBox="0 0 16 16"><path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" stroke="#14181c" stroke-width="1.4"/><circle cx="8" cy="8" r="4.2" fill="#14181c"/><circle cx="6.6" cy="6.6" r="1.2" fill="#fff"/></svg>';
const FLAG = '<svg viewBox="0 0 16 16"><path d="M5 2.5v10" stroke="#14181c" stroke-width="1.5"/><path d="M5.6 2.5l6.4 3-6.4 3z" fill="#d23b2f"/><rect x="3" y="12" width="7" height="2" fill="#14181c"/></svg>';
const XTRA = `.lp-rig{position:absolute;inset:0}.lp-pit{width:${SNC * CELL}px;height:${SNR * CELL}px}.lp-pit canvas{width:${SNC * CELL}px;height:${SNR * CELL}px}
.lp-mgrid{grid-template-columns:repeat(${MW},22px)}.lp-over .gx-card{width:220px;padding:16px 16px 14px}.lp-over .gx-card h2{font-size:18px}.lp-over .gx-card .big{font-size:40px;margin-top:8px}.lp-over .gx-card .acts{margin-top:12px}
.lp-cell.cur{outline:2px solid #ff9a3a;outline-offset:-2px}.lp-face{font-weight:800}`;
const help = app => app === 'desk' ? '<kbd>1</kbd> Snake <kbd>2</kbd> Mines <kbd>3</kbd> GG Coder <kbd>click</kbd> icons'
  : app === 'snake' ? '<kbd>arrows</kbd> steer <kbd>click</kbd> turn toward pointer <kbd>space</kbd>/<kbd>click</kbd> restart <kbd>backspace</kbd>/<kbd>x</kbd> desktop'
    : '<kbd>click</kbd> open <kbd>right-click</kbd>/<kbd>F</kbd> flag <kbd>arrows</kbd>+<kbd>space</kbd> also <kbd>backspace</kbd>/<kbd>x</kbd> desktop';

/** @param {any} ctx */
export function startDesktop(ctx) {
  const stand = seat(ctx);
  const ov = ctx.overlay({ title: 'Windoze 93', sub: 'Lab PC · double-click is optional', help: help('desk') });
  ov.onClose(stand); { const sl = ctx.it?.slot; closeUp(ctx, ov, sl ? sl.x : -3, 1.0, sl ? sl.z - 0.9 : 1.8); }
  const K = gx(ov), reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmtM = () => (best('mines') ? best('mines') + 's' : '--');
  const hud = K.hud([{ id: 'bs', label: 'Best Snake', value: best('snake') }, { id: 'bm', label: 'Best Mines', value: fmtM() }], [{ id: 'sc', label: 'Snake score', value: 0 }]);
  const scene = K.scene({ aspect: 1000 / 770, maxW: 1150 });
  const style = document.createElement('style'); style.textContent = LP_CSS + XTRA; scene.appendChild(style);
  const rig = document.createElement('div'); rig.className = 'lp-rig'; scene.appendChild(rig);
  const xb = '<button class="lp-x" data-close aria-label="Close">×</button>';
  rig.innerHTML = `<svg viewBox="0 0 1000 770" aria-hidden="true">${LP_RIG}</svg><div class="lp-screen"><div class="lp-desk"><div class="lp-icons">${LP_ICONS}</div>
<section class="lp-win" data-w="desk" style="left:200px;top:40px;width:300px"><div class="lp-title">${LP_LOGO.replace('<svg', '<svg width="14" height="14"')}<b>Welcome</b></div><div class="lp-body lp-welcome"><h3>Welcome to Windoze 93</h3><p>Click an icon, or press 1, 2 or 3.</p><div class="lp-bests"><div class="lp-sunk"><small>Best Snake</small><b class="wbs"></b></div><div class="lp-sunk"><small>Best Mines</small><b class="wbm"></b></div></div></div></section>
<section class="lp-win" data-w="snake" hidden style="left:150px;top:30px"><div class="lp-title"><b>SNAKE.EXE</b>${xb}</div><div class="lp-body"><div class="lp-snakebar"><span>Score <b class="ss">0</b></span><span>Best <b class="sb"></b></span></div><div class="lp-pit lp-sunk" style="position:relative"><canvas></canvas><div class="lp-over" hidden><div class="gx-card"><h2 class="ot">Game over</h2><div class="big os">0</div><p class="on"></p><div class="acts"><button class="gx-btn pri" type="button">Play again</button></div></div></div></div></div></section>
<section class="lp-win" data-w="mines" hidden style="left:230px;top:40px"><div class="lp-title"><b>MINES.EXE</b>${xb}</div><div class="lp-body"><div class="lp-mstat"><span>Mines <b class="ml">${MN}</b></span><button class="lp-rbtn lp-face" style="padding:2px 10px 3px">:-)</button><span>Time <b class="mt">0.0</b>s</span></div><div class="lp-mgrid lp-sunk" style="background:#bdb8ab"></div><p class="mn" style="margin:6px 0 0;font-size:11px;color:#4a4a44">Best ${''}<b class="mb"></b></p></div></section>
<div class="lp-bubble"></div>${LP_CLIP}
<div class="lp-bar"><button class="lp-rbtn lp-start">${LP_LOGO}Start</button><div class="lp-tasks"></div><div class="lp-clock"></div></div></div><div class="lp-glass"></div></div>`;
  const $ = s => /** @type {HTMLElement} */ (rig.querySelector(s));
  const desk = $('.lp-desk'), screenEl = $('.lp-screen'), cv = /** @type {HTMLCanvasElement} */ ($('.lp-pit canvas')), g = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
  const W = { desk: $('[data-w=desk]'), snake: $('[data-w=snake]'), mines: $('[data-w=mines]') };
  let scale = 1;
  const fit = () => { scale = screenEl.clientWidth / 780; desk.style.transform = `scale(${scale}, ${screenEl.clientHeight / 520})`; const d = (devicePixelRatio || 1) * scale; cv.width = Math.round(SNC * CELL * d); cv.height = Math.round(SNR * CELL * d); g.setTransform(d, 0, 0, d, 0, 0); if (sn) draw(); };
  const showBest = () => { $('.wbs').textContent = $('.sb').textContent = String(best('snake')); $('.wbm').textContent = $('.mb').textContent = fmtM(); hud.set('bs', best('snake')); hud.set('bm', fmtM()); };
  const st = { app: 'desk', tip: 0 };
  const go = app => {
    if (app !== st.app) SFX.play(app === 'desk' ? 'ui.back' : 'pc.boot', { vol: 0.5 });
    st.app = app; for (const k in W) W[k].hidden = k !== app && !(k === 'desk' && app === 'desk');
    if (app === 'snake') snakeNew(); if (app === 'mines') minesNew();
    $('.lp-tasks').innerHTML = app === 'desk' ? '' : `<span class="lp-rbtn lp-task on">${app === 'snake' ? 'SNAKE.EXE' : 'MINES.EXE'}</span>`;
    ov.setHelp(help(app));
  };
  rig.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => go('desk')));
  // GGCODER.EXE: the player's own GG Coder, on this PC (act/gg-coder.js; the app opens it, World only asks)
  const toCoder = () => { const it = ctx.it, R0 = ctx.R, api = ctx.api, S0 = ctx.S; SFX.play('pc.boot', { vol: 0.5 }); ov.close();
    setTimeout(() => S0.act?.tryStart({ id: (it?.id || 'pc') + '-coder', kind: 'seat', act: 'gg-coder', slot: it?.slot, x: it?.x, z: it?.z, label: 'Code on this PC' }, R0, api), 0); };
  rig.querySelectorAll('.lp-icon').forEach(b => { const a = /** @type {HTMLElement} */ (b).dataset.app; b.addEventListener('click', () => (a === 'gg' ? toCoder() : go(a))); });
  $('.lp-start').addEventListener('click', () => go('desk'));
  // Clipp-E
  const bubble = $('.lp-bubble'), showTip = () => { bubble.textContent = TIPS[st.tip]; };
  bubble.addEventListener('click', () => { st.tip = (st.tip + 1) % TIPS.length; showTip(); SFX.play('pop'); }); bubble.style.cursor = 'pointer';
  const tipT = setInterval(() => { st.tip = (st.tip + 1) % TIPS.length; showTip(); }, 6000);
  const clk = () => { $('.lp-clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }; clk();
  const clkT = setInterval(clk, 15000); ov.onClose(() => { clearInterval(tipT); clearInterval(clkT); });
  const eL = $('.eL'), eR = $('.eR');
  const onMove = e => { const r = desk.getBoundingClientRect(); const dx = Math.max(-1, Math.min(1, (e.clientX - r.right + 50) / 300)), dy = Math.max(-1, Math.min(1, (e.clientY - r.bottom + 90) / 300));
    eL.setAttribute('cx', String(25 + dx * 2.6)); eR.setAttribute('cx', String(40 + dx * 2.6)); eL.setAttribute('cy', String(34 + dy * 3)); eR.setAttribute('cy', String(34 + dy * 3)); };
  addEventListener('pointermove', onMove); ov.onClose(() => removeEventListener('pointermove', onMove));

  // ---- Snake (rules as before: speeds up per apple, best saved) ----
  /** @type {any} */ let sn = null;
  const over = $('.lp-over');
  const snakeNew = () => { sn = { body: [[8, 6], [7, 6], [6, 6]], prev: [[8, 6], [7, 6], [6, 6]], dir: [1, 0], next: [1, 0], food: [18, 6], acc: 0, score: 0, dead: false, r: rng(Date.now() & 0xffff) }; over.hidden = true; $('.ss').textContent = '0'; hud.set('sc', 0); draw(); };
  const stepT = () => Math.max(0.06, 0.14 - sn.score * 0.003);
  const advance = () => {
    sn.dir = sn.next; const h = [sn.body[0][0] + sn.dir[0], sn.body[0][1] + sn.dir[1]];
    if (h[0] < 0 || h[1] < 0 || h[0] >= SNC || h[1] >= SNR || sn.body.some(b => b[0] === h[0] && b[1] === h[1])) return die();
    sn.prev = sn.body.map(p => [...p]); sn.body.unshift(h);
    if (h[0] === sn.food[0] && h[1] === sn.food[1]) { sn.score++; sn.prev.push(sn.prev[sn.prev.length - 1]); $('.ss').textContent = String(sn.score); hud.set('sc', sn.score);
      const m = cv.getBoundingClientRect(); K.pop(m.left + (h[0] + 0.5) * m.width / SNC, m.top + h[1] * m.height / SNR, '+1', 'up');
      SFX.play('arcade.coin', { vol: 0.5, pitch: 1 + Math.min(0.5, sn.score * 0.02) }); do { sn.food = [Math.floor(sn.r() * SNC), Math.floor(sn.r() * SNR)]; } while (sn.body.some(b => b[0] === sn.food[0] && b[1] === sn.food[1])); }
    else sn.body.pop();
    sn.prev.unshift(sn.prev[0]); sn.prev.length = sn.body.length;
  };
  const die = () => {
    sn.dead = true; const rec = saveBest('snake', sn.score) && sn.score > 0; showBest(); SFX.play('thud'); SFX.play(rec ? 'win' : 'fail', { delay: 0.2 }); if (rec) K.swell();
    $('.ot').textContent = rec ? 'New best' : 'Segfault'; $('.ot').style.color = rec ? '#f0c75e' : ''; $('.os').textContent = String(sn.score); $('.on').textContent = sn.score === 1 ? '1 apple eaten' : sn.score + ' apples eaten'; over.hidden = false;
  };
  $('.lp-over .gx-btn').addEventListener('click', e => { e.stopPropagation(); snakeNew(); SFX.play('go'); });
  function draw() {
    if (!sn) return; const S = CELL, w = SNC * S, h = SNR * S, k = reduce || sn.dead ? 1 : Math.min(1, sn.acc / stepT());
    g.fillStyle = '#10262b'; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(255,255,255,.04)'; for (let x = 0; x < SNC; x++) for (let y = 0; y < SNR; y++) if ((x + y) % 2) g.fillRect(x * S, y * S, S, S);
    const fx = sn.food[0] * S + S / 2, fy = sn.food[1] * S + S / 2;
    g.fillStyle = 'rgba(255,125,112,.25)'; g.beginPath(); g.arc(fx, fy, 8, 0, 7); g.fill(); g.fillStyle = '#ff7d70'; g.beginPath(); g.arc(fx, fy + 1, 5, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.arc(fx - 1.8, fy - 0.8, 1.4, 0, 7); g.fill(); g.strokeStyle = '#7fdc95'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(fx, fy - 3); g.quadraticCurveTo(fx + 2, fy - 7, fx + 4, fy - 6); g.stroke();
    const pts = sn.body.map((p, i) => { const q = sn.prev[i] || p; return [(q[0] + (p[0] - q[0]) * k) * S + S / 2, (q[1] + (p[1] - q[1]) * k) * S + S / 2]; });
    g.lineCap = g.lineJoin = 'round'; const path = () => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1]); };
    g.strokeStyle = '#2f8f5a'; g.lineWidth = 12; path(); g.stroke(); g.strokeStyle = '#7fdc95'; g.lineWidth = 9; path(); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 2.5; g.save(); g.translate(-1, -1.5); path(); g.stroke(); g.restore();
    const [hx, hy] = pts[0]; g.fillStyle = '#9ff0b0'; g.beginPath(); g.arc(hx, hy, 6.5, 0, 7); g.fill();
    const ex = -sn.dir[1] * 3, ey = sn.dir[0] * 3; g.fillStyle = '#0b1a12'; for (const s of [1, -1]) { g.beginPath(); g.arc(hx + sn.dir[0] * 2 + ex * s, hy + sn.dir[1] * 2 + ey * s, 1.6, 0, 7); g.fill(); }
  }
  cv.addEventListener('mousedown', e => { if (e.button !== 0 || !sn) return; if (sn.dead) { snakeNew(); SFX.play('go'); return; }
    const r = cv.getBoundingClientRect(), hd = sn.body[0], dx = e.clientX - (r.left + (hd[0] + 0.5) * r.width / SNC), dy = e.clientY - (r.top + (hd[1] + 0.5) * r.height / SNR);
    sn.next = sn.dir[0] ? [0, Math.sign(dy) || 1] : [Math.sign(dx) || 1, 0]; SFX.play('key', { vol: 0.4 }); });

  // ---- Mines 12x8, 14 mines, first click safe; best = fastest clear (0.1 s) ----
  /** @type {any} */ let ms = null; const grid = $('.lp-mgrid');
  const minesNew = () => {
    ms = { cells: [], first: true, over: '', t0: 0, t: 0, cur: [0, 0] }; grid.textContent = ''; $('.mt').textContent = '0.0'; $('.lp-face').textContent = ':-)'; $('.ml').textContent = String(MN);
    for (let i = 0; i < MW * MH; i++) { const b = document.createElement('button'); b.className = 'lp-cell'; b.type = 'button'; b.tabIndex = -1;
      b.addEventListener('mousedown', e => { if (ms.over) { if (e.button === 0) minesNew(); return; } ms.cur = [i % MW, Math.floor(i / MW)]; if (e.button === 2) flag(i); else if (e.button === 0) open(i); paintCur(); });
      b.addEventListener('contextmenu', e => e.preventDefault()); grid.appendChild(b); ms.cells.push({ m: false, o: false, f: false, n: 0, el: b }); }
    paintCur();
  };
  const nbr = i => { const x = i % MW, y = Math.floor(i / MW), out = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if ((dx || dy) && nx >= 0 && ny >= 0 && nx < MW && ny < MH) out.push(ny * MW + nx); } return out; };
  const lay = safe => { const r = rng((Date.now() & 0xffff) + 3); let n = 0; while (n < MN) { const i = Math.floor(r() * MW * MH); if (i === safe || ms.cells[i].m) continue; ms.cells[i].m = true; n++; } ms.cells.forEach((c, i) => { c.n = nbr(i).filter(j => ms.cells[j].m).length; }); };
  const paintCur = () => ms.cells.forEach((c, i) => c.el.classList.toggle('cur', i === ms.cur[1] * MW + ms.cur[0]));
  const open = i => {
    const c0 = ms.cells[i]; if (ms.over || c0.o || c0.f) return;
    if (ms.first) { ms.first = false; lay(i); ms.t0 = performance.now(); }
    if (c0.m) { ms.over = 'boom'; c0.el.classList.add('boom'); ms.cells.forEach(q => { if (q.m) { q.el.classList.add('open'); q.el.innerHTML = MINE; } }); $('.lp-face').textContent = 'x_x';
      SFX.play('arcade.boom', { vol: 0.7 }); SFX.play('fail', { delay: 0.3 }); const r = c0.el.getBoundingClientRect(); K.pop(r.left + r.width / 2, r.top, 'Boom. git revert?', 'bad'); return; }
    const stack = [i]; while (stack.length) { const j = /** @type {number} */ (stack.pop()), q = ms.cells[j]; if (q.o || q.f) continue; q.o = true; q.el.classList.add('open'); if (q.n) { q.el.textContent = String(q.n); q.el.style.color = COL[q.n]; } else stack.push(...nbr(j)); }
    SFX.play('ui.tap', { vol: 0.5 });
    if (ms.cells.every(q => q.o || q.m)) { ms.over = 'win'; const s = Math.round((performance.now() - ms.t0) / 100) / 10; ms.t = s; $('.mt').textContent = s.toFixed(1); const rec = saveBest('mines', s, true); showBest(); $('.lp-face').textContent = 'B-)';
      SFX.play(rec ? 'win' : 'success'); K.swell(); const r = grid.getBoundingClientRect(); K.pop(r.left + r.width / 2, r.top, rec ? `New record ${s}s` : `Cleared ${s}s`, rec ? 'gold' : 'up'); }
  };
  const flag = i => { const c0 = ms.cells[i]; if (c0.o || ms.over) return; c0.f = !c0.f; c0.el.innerHTML = c0.f ? FLAG : ''; $('.ml').textContent = String(MN - ms.cells.filter(q => q.f).length); SFX.play(c0.f ? 'snap' : 'ui.back', { vol: 0.6 }); };
  $('.lp-face').addEventListener('click', () => minesNew());

  // ---- keys + one loop ----
  const DIRS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const onKey = e => {
    if (e.code === 'Backspace' || (e.code === 'KeyX' && st.app !== 'desk')) { go('desk'); return; }
    if (st.app === 'desk') { if (e.code === 'Digit1') go('snake'); if (e.code === 'Digit2') go('mines'); if (e.code === 'Digit3') toCoder(); return; }
    const d = DIRS[e.code];
    if (st.app === 'snake') { if (d && (d[0] !== -sn.dir[0] || d[1] !== -sn.dir[1])) { sn.next = d; SFX.play('key', { vol: 0.4 }); } if (e.code === 'Space' && sn.dead) { snakeNew(); SFX.play('go'); } }
    if (st.app === 'mines') { if (d) { SFX.play('ui.select', { vol: 0.5 }); ms.cur = [Math.max(0, Math.min(MW - 1, ms.cur[0] + d[0])), Math.max(0, Math.min(MH - 1, ms.cur[1] + d[1]))]; paintCur(); }
      if (e.code === 'Space') { if (ms.over) minesNew(); else open(ms.cur[1] * MW + ms.cur[0]); } if (e.code === 'KeyF') flag(ms.cur[1] * MW + ms.cur[0]); }
  };
  const cap = e => { if (e.code !== 'Escape') { e.stopPropagation(); if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); onKey(e); } };
  addEventListener('keydown', cap, true); ov.onClose(() => removeEventListener('keydown', cap, true));
  let last = performance.now(), raf = 0;
  const tick = now => { const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (st.app === 'snake' && sn && !sn.dead) { sn.acc += dt; while (sn.acc > stepT() && !sn.dead) { sn.acc -= stepT(); advance(); } draw(); }
    if (st.app === 'mines' && ms && !ms.first && !ms.over) $('.mt').textContent = ((now - ms.t0) / 1000).toFixed(1);
    raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick); ov.onClose(() => cancelAnimationFrame(raf));
  const ro = new ResizeObserver(fit); ro.observe(screenEl); ov.onClose(() => ro.disconnect());
  showBest(); showTip(); fit();
}

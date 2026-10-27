// @ts-check
// Night palette: near-black translucent panels, phosphor green + amber accents. Typography = GG Royale pixel fonts:
// m5x7 for everything, Alagard for titles/names. Only 16/32px sizes with whole-pixel line-heights stay crisp.
import { FONT } from './fonts.js';
import { PLATE_CSS } from './nameplate.js';

const B = FONT.body, T = FONT.title;
const TSH = 'text-shadow:0 1px 0 #3a2a1a';
// pixel icons (1 = ink) drawn as crisp SVG at 2 screen px per art px, so they sit on the text's pixel grid
const ARROW = ['...1...', '....1..', '1111111', '....1..', '...1...'];
const CHEV = ['1...', '11..', '.11.', '..11', '.11.', '11..', '1...'];
const px = rows => { let r = ''; rows.forEach((row, y) => [...row].forEach((k, x) => { if (k === '1') r += `<rect x='${x}' y='${y}' width='1' height='1' fill='#1e0c1f'/>`; }));
  return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${rows[0].length} ${rows.length}' shape-rendering='crispEdges'>${r}</svg>`; };
// HUD icons (16 x 16 pixel art) as CSS masks
export const ICONS = {
  cloud: ['................', '................', '.......1111.....', '.....11111111...', '....1111111111..', '..111111111111..', '.11111111111111.', '1111111111111111', '1111111111111111', '1111111111111111', '.11111111111111.', '..111111111111..', '................', '................', '................', '................'],
  cloudOff: ['................', '................', '.......1111.....', '.....11....11...', '....1........1..', '..111........1..', '.1............1.', '1..............1', '1..............1', '1..............1', '.1............1.', '..111111111111..', '................', '................', '................', '................'],
  map: ['................','.1111..1111..111','.1..1111..1111.1','.1...1...1....1.','.1...1...1....1.','.1...1...1....1.','.1...1...1....1.','.1...1...1....1.','.1...1...1....1.','.1...1...1....1.','.1...1...1....1.','.1...1...1....1.','.1111..1111..111','...........11111','................','................'],
  chat: ['................','.11111111111111.','1..............1','1..............1','1..11111111....1','1..............1','1..111111......1','1..............1','.11111..1111111.','.....1.1........','.....11.........','......1.........','................','................','................','................'],
  shirt: ['................','....11....11....','..111111111111..','.11111.11.11111.','111111....111111','111111111111111.','.11..111111..11.','.....111111.....','.....111111.....','.....111111.....','.....111111.....','.....111111.....','.....111111.....','.....111111.....','................','................'],
};
export const pxMask = rows => `url("data:image/svg+xml,${encodeURIComponent(px(rows.map(r => r.padEnd(16, '.'))))}")`;
// the critter bubble's tail, 7 x 5 art px (I = ink, s = shade), as a crisp SVG
const tail = shade => { const rows = ['IsssssI', '.IsssI.', '.IIsII.', '..IsI..', '...I...']; let r = '';
  rows.forEach((row, y) => [...row].forEach((k, x) => { if (k !== '.') r += `<rect x='${x}' y='${y}' width='1' height='1' fill='${k === 'I' ? '#1e0c1f' : shade}'/>`; }));
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 7 5' shape-rendering='crispEdges'>${r}</svg>`)}")`; };
// three kinds, three colours (same critter-bubble shape): blue = people talking (speech, chat, "View <member>"),
// gold = something you can use (E prompt, hover on an object), green = a way to another room (doorway signs)
const KIND = { talk: ['#cedbf9', '#a9b8e4'], use: ['#f5bd63', '#c8862a'], go: ['#b9e3a0', '#7fb563'], note: ['#fff3dc', '#e2cba4'] }; // note = game notices / tips
const skin = ([paper, sh]) => `background:${paper};box-shadow:inset 0 -4px 0 ${sh},0 0 0 2px #1e0c1f,0 6px 0 0 #1e0c1f`;
export const CSS = `
/* scrolling panels: native (smooth) wheel + trackpad scrolling, contained (never scrolls the page / zooms the game),
   thin scrollbars in each panel's colours */
.where,.mapp,.creator,.profile,.chatp .clog,.dlg .log{overscroll-behavior:contain;scrollbar-width:thin}
.where::-webkit-scrollbar,.mapp::-webkit-scrollbar,.creator::-webkit-scrollbar,.profile::-webkit-scrollbar{width:8px}
.where::-webkit-scrollbar-thumb,.mapp::-webkit-scrollbar-thumb,.creator::-webkit-scrollbar-thumb,.profile::-webkit-scrollbar-thumb{background:#3a3f46;border-radius:4px;border:2px solid #1f2226}
.where::-webkit-scrollbar-track,.mapp::-webkit-scrollbar-track,.creator::-webkit-scrollbar-track,.profile::-webkit-scrollbar-track{background:transparent}
.chatp .clog::-webkit-scrollbar,.dlg .log::-webkit-scrollbar{width:6px}
.chatp .clog::-webkit-scrollbar-thumb,.dlg .log::-webkit-scrollbar-thumb{background:#a9b8e4;border-radius:3px}
.chatp .clog::-webkit-scrollbar-track,.dlg .log::-webkit-scrollbar-track{background:transparent}
/* window-size scale (night-ui sets --ui from the window: clamp 0.72..1.25). Fixed HUD panels zoom; things placed at a
   screen point (bubbles, prompts, plates, the hover tip) scale with transform so their anchor stays put. */
.hud-top,.chatbtn,.ibar,.toast,.roomcard,.editbar{zoom:var(--ui,1)}
.where{zoom:var(--ui-chat,1)}
/* chat + DMs scale on their own, never below 0.95 (owner: chat was barely visible in small windows) */
.chatp,.dlg{zoom:var(--ui-chat,1)}
.modal.profile,.modal.mapp,.modal.creator{zoom:var(--ui-chat,1)} /* readable in small windows, like the chat */
#ui{position:fixed;inset:0;z-index:2;pointer-events:none;font:16px/16px ${B};color:#c9d1c4;user-select:none;-webkit-font-smoothing:none;-moz-osx-font-smoothing:grayscale;font-smooth:never;text-rendering:optimizeSpeed}
#ui *{box-sizing:border-box}
#ui b,#ui strong,#ui h1,#ui h2,#ui h3,#ui h4{font-weight:normal}
#ui input,#ui button,#ui select{font:inherit;-webkit-font-smoothing:none}
.card{background:#1f2226;border:0;border-radius:8px;color:#e8ebef;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 2px 0 #0b0c0e,0 18px 40px rgba(0,0,0,.55)}
.embedded .hud-top{top:60px}
.hud-top{position:absolute;top:16px;left:16px;display:flex;flex-direction:column;align-items:flex-start;gap:10px}
/* Alloy keys (the app's raised graphite controls): lit top edge, dark lip, soft drop */
.key{background:#2c3035;border-radius:6px;box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 2px 0 #0b0c0e,0 6px 14px rgba(0,0,0,.45);color:#e8ebef}
.lvk{display:flex;align-items:center;gap:12px;padding:8px 12px 10px}
.lvk .n{font:32px/24px ${B};color:#8fa3ff}
.lvk .xw{display:flex;flex-direction:column;gap:5px;width:150px}
.lvk .t{display:flex;justify-content:space-between}.lvk .mu{color:#a1a8b1}.lvk .c{color:#f0c75e}
.xpbar{display:block;height:6px;border-radius:3px;background:#0e1013;overflow:hidden;box-shadow:inset 0 1px 0 rgba(0,0,0,.6)}.xpbar i{display:block;height:100%;background:#8fa3ff}
.dot{display:inline-block;width:8px;height:8px;background:#7fdc95;flex:none}
.onk.off .dot{background:#7a8088}.onk.off .mu{color:#8a9099}.onk.wait .dot{background:#f0b44c;animation:nrblink 1s steps(2) infinite}.onk.wait .mu{color:#f0c75e}.onk.on .dot{background:#3ddc84}
@keyframes nrblink{50%{opacity:.35}}
.livebar{position:absolute;left:50%;top:110px;transform:translateX(-50%);z-index:30;pointer-events:auto;display:flex;align-items:center;gap:12px;padding:8px 10px 8px 14px;font:20px/22px ${B};color:#e8ebef;background:#2a1d1d;box-shadow:0 0 0 2px #ff9a8f}.livebar[hidden]{display:none}
.livebar .btn{padding:2px 10px 4px;border:1px solid #3a3f46;border-radius:6px;background:#1f2226;color:#e6e9e2;cursor:pointer}
.who{all:unset;box-sizing:border-box;pointer-events:auto;cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 12px 8px;font:16px/16px ${B};-webkit-font-smoothing:none;transition:background-color .15s}
.who .mu{color:#a1a8b1}.who:hover{background:#33383e}.who:focus-visible{outline:2px solid #8fa3ff;outline-offset:2px}
.embedded .where{top:162px}
.where{position:absolute;top:118px;left:16px;padding:10px 12px 12px;line-height:20px;min-width:230px;max-width:340px;pointer-events:auto;max-height:calc(100vh / var(--ui-chat,1) - 150px);overflow-y:auto;overscroll-behavior:contain}
.where b{font-family:${B};color:#e8ebef}.where .cur{color:#8fa3ff}.where i{font-style:normal;color:#949ba5}
.where .s{margin-left:3px}.where .s.p{color:#7fdc95}.where .s.t{color:#8fa3ff}.where .s.d{color:#f0c75e}.where .s.i{color:#949ba5}
.where .lg{margin-top:6px;padding-top:6px;border-top:1px solid #2a2e33;color:#949ba5}
.where .fl{color:#949ba5;margin-top:6px}.where .fl.cur{color:#8fa3ff}.where .go{cursor:pointer;border-radius:4px}.where .go:hover{background:#2a2e33}.where .go:hover b{color:#fff}
kbd{font:16px/16px ${B};background:#161b17;border:1px solid #263228;border-radius:3px;padding:0 4px;color:#6ee7a0}
/* speech bubble = the critters' bubble from the app (gg-app goal-farm-render.ts drawBubble), at 2 screen px per art px:
   m5x7 ink text on blue-white paper, 1 art px ink outline, 2 art px shade along the bottom, a 3 art px ink lip under it,
   and a 7 x 5 pixel tail that runs out of the shade through the lip */
.bub{z-index:6;position:absolute;transform:translate(-50%,calc(-100% - 12px * var(--ui,1))) scale(calc(var(--k,1) * var(--ui,1)));transform-origin:50% 100%;transition:transform .2s ease;max-width:224px;width:max-content;padding:4px 8px 8px;text-align:center;white-space:normal;
  ${skin(KIND.talk)};color:#1e0c1f;font:32px/22px ${B};-webkit-font-smoothing:none;border-radius:2px;animation:pop .25s ease}
.bub:after{content:"";position:absolute;left:50%;top:100%;width:14px;height:10px;transform:translateX(-50%);image-rendering:pixelated;
  background:${tail(KIND.talk[1])} center/100% 100% no-repeat}
.bub.stk:after{display:none}
.bub.think{color:#4a5288}.bub.ship{color:#1f6a3a}
@keyframes pop{from{opacity:0;transform:translate(-50%,calc(-100% - 4px))}}
/* prompts, hover tooltip, chat and toast share the critter bubble's look (paper, ink outline, shade, lip) */
.prompt,.hovertip,.toast{${skin(KIND.use)};color:#1e0c1f;font:32px/22px ${B};-webkit-font-smoothing:none;border-radius:2px;white-space:nowrap}
.prompt.go{${skin(KIND.go)}}.hovertip.talk{${skin(KIND.talk)}}.toast{${skin(KIND.note)}}
.prompt{position:absolute;transform:translate(-50%,calc(-100% - 12px * var(--ui,1))) scale(var(--ui,1));transform-origin:50% 100%;padding:4px 10px 8px 6px;z-index:12}
.prompt:after{content:"";position:absolute;left:50%;top:100%;width:14px;height:10px;transform:translateX(-50%);image-rendering:pixelated;background:${tail(KIND.use[1])} center/100% 100% no-repeat}
.prompt.go:after{background-image:${tail(KIND.go[1])}}
.pi{display:inline-flex;align-items:center;gap:8px;vertical-align:top}
.prompt kbd{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 4px 2px;margin:0;border:0;border-radius:2px;background:#1e0c1f;color:#cedbf9;font:32px/20px ${B}}
.ico{display:inline-block;flex:none;background:center/100% 100% no-repeat;image-rendering:pixelated}
.ico.arr{width:14px;height:10px;background-image:url("data:image/svg+xml,${encodeURIComponent(px(ARROW))}")}
.ico.chev{width:8px;height:14px;background-image:url("data:image/svg+xml,${encodeURIComponent(px(CHEV))}")}
.hovertip{position:fixed;z-index:30;pointer-events:none;display:none;padding:4px 10px 8px;transform:translate(16px,18px) scale(var(--ui,1));transform-origin:0 0}
.hovertip .nm{color:#34347e}
.prompt.in{animation:prIn .16s ease-out}@keyframes prIn{from{opacity:0;margin-top:4px}to{opacity:1;margin-top:0}}
@media (prefers-reduced-motion: reduce){.prompt.in{animation:none}}
.creator input{width:100%;border:0;outline:0;background:#0e1013;border-radius:4px;padding:6px 10px 8px;font:16px/18px ${B};color:#e8ebef;box-shadow:inset 0 1px 0 rgba(0,0,0,.6),0 1px 0 rgba(255,255,255,.05)}
.creator .cnhint{min-height:18px;margin-top:-2px;font:16px/18px ${B};color:#a1a8b1}.creator .cnhint.bad{color:#ff9a8f}.creator .cnhint.ok{color:#7fdc95}
.creator input:focus-visible{box-shadow:inset 0 1px 0 rgba(0,0,0,.6),0 0 0 2px #8fa3ff}
.modal{position:absolute;pointer-events:auto;display:none;z-index:20}
.hud-top,.where,.rooms,.toast,.editbar{z-index:10}
.profile{left:50%;top:50%;transform:translate(-50%,-50%);width:380px;padding:16px}
/* multiplayer: the real-player marker (a small green live dot, nameplate + chat + card) and the card's Block / Report */
.lvm{display:inline-block;box-sizing:border-box;width:12px;height:12px;border-radius:50%;background:radial-gradient(circle,#3ddc84 0 3px,transparent 3.5px);border:2px solid #3ddc84;box-shadow:0 0 0 1px rgba(0,0,0,.75),inset 0 0 0 1px rgba(0,0,0,.75);vertical-align:middle;margin-left:5px;flex:none}
.sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
#ui .np{left:0;top:0;will-change:transform}
.chatp .cm u .lvm{margin:0 0 0 4px;vertical-align:2px}
.np .adm,.profile .adm{margin-left:4px;padding:0 4px;border-radius:4px;background:#f0c75e;color:#2a1a05;font:12px/14px ${B};font-weight:normal;vertical-align:middle}
.lvadm{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)}.lvadm span{font:16px/20px ${B};color:#f0c75e;margin-right:4px}.lvadm .danger{color:#ff9a8f}
.lvact{display:flex;gap:8px;margin-top:12px}.profile .lvrep{margin-top:10px}.profile .lvrep[hidden],.profile .lvdone[hidden],.profile .lvsure[hidden],.profile .btn[hidden]{display:none}
.profile .lvrep h3{margin:0 0 6px;font:18px/20px ${B};font-weight:normal;color:#e8ebef}.profile .lvrep .opts{display:flex;flex-wrap:wrap;gap:6px}.profile .lvrow{display:flex;gap:6px;margin-top:8px}
.profile .opt[aria-checked=true]{background:#34347e;border-color:#8fa3ff;color:#fff}.profile .btn:disabled{opacity:.45;cursor:default}.profile .btn:focus-visible{outline:2px solid #8fa3ff;outline-offset:1px}
.profile .lvdone{margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}.profile .lvdone p{margin:0;color:#6ee7a0}
.profile .lvsure{display:flex;align-items:center;gap:6px;margin-top:8px;padding:6px 8px;border-radius:6px;background:#2a1d1d}.profile .lvsure span{flex:1;color:#ffcfc9}.profile .lvdone .btn,.profile .lvrow .btn,.profile .lvsure .btn{padding:6px 10px;border-radius:6px;border:1px solid #3a3f46;background:#1f2226;color:#e6e9e2;font:inherit;cursor:pointer}.profile .lvsure .danger{color:#ff9a8f}
.profile .lvact .btn,.profile .lvrep .btn{flex:1 1 auto;padding:6px 10px;border-radius:6px;border:1px solid #3a3f46;background:#1f2226;color:#e6e9e2;font:inherit;cursor:pointer}.profile .lvact .btn:hover,.profile .lvrep .btn:hover{background:#2a2f35}
.profile .head{display:flex;gap:12px;align-items:center}
.portrait{width:92px;height:92px;border-radius:6px;background:radial-gradient(circle at 50% 35%,#2e3238,#15171a 75%);overflow:hidden;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 0 0 1px #0b0c0e}
.portrait img{width:100%;height:100%;display:block}
.profile h2{margin:0 0 4px;font:32px/26px ${B};color:#e8ebef;font-weight:normal}.profile .title{line-height:20px;color:#a1a8b1}
.profile .lvl{display:inline-block;margin-top:6px;padding:1px 8px 3px;border:0;border-radius:4px;background:#2c3035;color:#8fa3ff;box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 1px 0 #0b0c0e}
.profile .xp{margin:14px 0 6px;height:6px;border-radius:3px;background:#0e1013;overflow:hidden;box-shadow:inset 0 1px 0 rgba(0,0,0,.6)}.profile .xp i{display:block;height:100%;background:#8fa3ff}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.badges span{line-height:18px;border:0;border-radius:4px;padding:1px 8px 3px;background:#2a2e33;color:#c9ced6;box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
.row{display:flex;justify-content:space-between;line-height:20px;padding:5px 0;border-top:1px solid #2a2e33;color:#a1a8b1}.row b,.row span:last-child{color:#e8ebef;font-weight:normal}
.btns{display:flex;gap:8px;margin-top:14px}
.btn{flex:1;border:0;border-radius:6px;padding:7px 10px 9px;font:16px/18px ${B};cursor:pointer;background:#2c3035;color:#e8ebef;box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 2px 0 #0b0c0e;transition:background-color .15s}
.btn.p{background:#8fa3ff;color:#050a2e;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 2px 0 #4a5bb0}.btn:hover{background:#33383e}.btn.p:hover{background:#a3b4ff}.btn:active{transform:translateY(1px);box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 1px 0 #0b0c0e}.btn:focus-visible{outline:2px solid #8fa3ff;outline-offset:2px}
.modal .x{all:unset;position:absolute;right:10px;top:10px;width:32px;height:32px;display:grid;place-items:center;cursor:pointer;border-radius:6px;color:#a1a8b1;pointer-events:auto;background:#2c3035;box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 2px 0 #0b0c0e}
.modal .x i{width:14px;height:14px;background:currentColor;-webkit-mask:url("data:image/svg+xml,${encodeURIComponent(px(['11....11', '111..111', '.111111.', '..1111..', '..1111..', '.111111.', '111..111', '11....11']))}") center/100% 100% no-repeat;mask:url("data:image/svg+xml,${encodeURIComponent(px(['11....11', '111..111', '.111111.', '..1111..', '..1111..', '.111111.', '111..111', '11....11']))}") center/100% 100% no-repeat;image-rendering:pixelated}
.modal .x:hover{color:#fff;background:#33383e}.modal .x:focus-visible{outline:2px solid #8fa3ff;outline-offset:2px}
/* room name on entering: top middle, fades in and out */
.roomcard{position:absolute;left:50%;top:22px;transform:translate(-50%,-6px);z-index:11;opacity:0;pointer-events:none;white-space:nowrap;
  font:32px/32px ${B};color:#f3e6cc;-webkit-font-smoothing:none;text-shadow:0 2px 0 #1e0c1f,2px 0 0 #1e0c1f,-2px 0 0 #1e0c1f,0 -2px 0 #1e0c1f,0 4px 0 #1e0c1f;
  transition:opacity .6s ease,transform .6s ease}
.roomcard.on{opacity:1;transform:translate(-50%,0)}
@media (prefers-reduced-motion: reduce){.roomcard{transition:opacity .3s linear;transform:translate(-50%,0)}}
/* DM panel (Dex / residents): same critter paper + input as the chat, in the chat's spot bottom left */
.dlg{left:16px;bottom:22px;width:min(560px,calc(100vw - 32px));padding:10px 12px 14px;display:none;gap:12px;align-items:stretch;z-index:16;
  background:#cedbf9;color:#1e0c1f;border-radius:2px;box-shadow:inset 0 -4px 0 #a9b8e4,0 0 0 2px #1e0c1f,0 6px 0 0 #1e0c1f}
.dlg .who{display:flex;flex-direction:column;align-items:center;gap:6px;flex:none;width:112px}
.dlg .portrait{width:104px;height:104px;flex:none;border-radius:2px;background:#e8eefc;box-shadow:inset 0 2px 0 #a9b8e4,0 0 0 2px #1e0c1f}
.dlg .dm{flex:1;min-width:0;display:flex;flex-direction:column}
.dlg .cin{display:flex;align-items:center;gap:8px;padding:6px 8px 8px;background:#e8eefc;box-shadow:inset 0 2px 0 #a9b8e4;cursor:text}
#ui .dlg input{flex:1;min-width:0;border:0;outline:0;background:transparent;padding:0;font:24px/26px ${B};color:#1e0c1f;box-shadow:none;-webkit-font-smoothing:none}
#ui .dlg input::placeholder{color:#6a74a8}
.dlg kbd{font:24px/24px ${B};padding:0 5px 2px;border:0;border-radius:3px;background:#34347e;color:#cedbf9}
.dlg:focus-within{box-shadow:inset 0 -4px 0 #a9b8e4,0 0 0 2px #1e0c1f,0 6px 0 0 #1e0c1f,0 0 0 4px #8fa3ff}
.modal.dlg .x{top:8px;right:8px;width:24px;height:24px;background:transparent;box-shadow:none;color:#34347e}.modal.dlg .x:hover{background:#b8c6ee;color:#1e0c1f}
.dlg .portrait img{width:100%;height:100%;display:block}
.dlg .nm{color:#1e0c1f;font:32px/24px ${B};text-align:center;max-width:112px;overflow-wrap:anywhere}.dlg .nm.long{font-size:24px;line-height:20px}.dlg .nm.xlong{font-size:16px;line-height:16px}
.dlg .log{height:156px;overflow-y:auto;margin:0 28px 8px 0;line-height:18px;display:flex;flex-direction:column;gap:4px}
.dlg .log p{margin:0;font:24px/24px ${B};color:#1e0c1f;max-width:88%}.dlg .log .u{align-self:flex-end;text-align:right;color:#1f6a3a}.dlg .log .n{color:#1e0c1f}
.typing i{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:#34347e;animation:bl 1s infinite}
@keyframes bl{50%{opacity:.2}}
.rooms{position:absolute;top:16px;right:16px;display:flex;gap:4px;padding:4px;pointer-events:auto}
.rooms .rt{all:unset;cursor:pointer;padding:6px 10px 8px;border-radius:4px;font:16px/16px ${B};color:#a1a8b1;display:flex;gap:6px;align-items:center;white-space:nowrap;transition:background-color .15s,color .15s;-webkit-font-smoothing:none}
.rooms .rt span{color:#949ba5}
.rooms .rt:hover{background:#33383e;color:#e8ebef}.rooms .rt:focus-visible{outline:2px solid #8fa3ff;outline-offset:1px}
.rooms .rt.cur{background:#33383e;color:#e8ebef;box-shadow:inset 0 1px 0 rgba(255,255,255,.09);cursor:default}.rooms .rt.cur span{color:#8fa3ff}
/* icon keys bottom right */
.ibar{position:absolute;right:16px;bottom:16px;display:flex;gap:8px;pointer-events:auto;z-index:10}
.ib{all:unset;box-sizing:border-box;width:40px;height:40px;display:grid;place-items:center;cursor:pointer;color:#a1a8b1;transition:color .15s,background-color .15s;background:#2c3035;border-radius:6px;box-shadow:inset 0 1px 0 rgba(255,255,255,.09),0 2px 0 #0b0c0e,0 6px 14px rgba(0,0,0,.45)}
.ib:hover{color:#e8ebef;background:#33383e}.ib.cloud{position:relative}.ib.cloud.on{color:#c2c7ce}.ib.cloud .dot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:#f0c75e;box-shadow:0 0 0 2px #2c3035;display:none}.ib.cloud.err .dot{display:block}.ib:active{box-shadow:inset 0 1px 0 rgba(255,255,255,.05),0 1px 0 #0b0c0e;transform:translateY(1px)}.ib:focus-visible{outline:2px solid #8fa3ff;outline-offset:2px}
.pxi{display:block;width:16px;height:16px;background:currentColor;-webkit-mask:var(--m) center/100% 100% no-repeat;mask:var(--m) center/100% 100% no-repeat}
.ib svg{display:block}
/* chat: critter paper, bottom left: the log is always there (last lines), Enter focuses the input */
.chatbtn{position:absolute;left:16px;bottom:16px;z-index:15;pointer-events:auto}.chatbtn.hid{display:none}
.chatbtn .unread{position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;padding:0 4px 2px;border-radius:9px;background:#8fa3ff;color:#050a2e;font:16px/16px ${B};font-weight:normal;display:grid;place-items:center;box-shadow:0 0 0 2px #15171a}.chatbtn .unread:empty{display:none}
.chatp{display:none}.chatp.typing{display:block}
.chatp{position:absolute;left:16px;bottom:22px;width:min(460px,calc(100vw - 32px));z-index:15;pointer-events:auto;padding:8px 10px 14px;${skin(KIND.talk)};border-radius:2px;color:#1e0c1f}
.chatp .clog{display:flex;flex-direction:column;gap:4px;padding:0 6px 8px 2px;height:120px;overflow-y:auto;overscroll-behavior:contain;-webkit-mask:linear-gradient(transparent,#000 14px);mask:linear-gradient(transparent,#000 14px)}
.chatp .clog>.cm:first-child{margin-top:auto}
.chatp .cm{font:24px/24px ${B};-webkit-font-smoothing:none;word-break:break-word}.chatp .cm u{text-decoration:none;color:#34347e;margin-right:8px;font:16px/24px ${T};vertical-align:1px}
/* names by level tier, the nameplate colours made readable on the light paper: an ink outline keeps light colours
   (gold, white, pink) legible, low tiers stay dark */
.chatp .cm u.t1,.chatp .cm u.t2,.chatp .cm u.t3,.chatp .cm u.t4,.chatp .cm u.t5,.chatp .cm u.t6,.chatp .cm u.t7,.chatp .cm u.t8,.chatp .cm u.t9,.chatp .cm u.t10,.chatp .cm u.t11,.chatp .cm u.npc{
  text-shadow:1px 0 0 #1e0c1f,-1px 0 0 #1e0c1f,0 1px 0 #1e0c1f,0 -1px 0 #1e0c1f,0 2px 0 #1e0c1f}
.chatp .cm u.t1{color:#e6e9e2}.chatp .cm u.t2{color:#6ee7a0}.chatp .cm u.t3{color:#f0a060}.chatp .cm u.t4{color:#cfd8e2}
.chatp .cm u.t5{color:#ffcf4a}.chatp .cm u.t6{color:#ff7ad8}.chatp .cm u.t7{color:#ffe08a}.chatp .cm u.t8{color:#a7b4ff}
.chatp .cm u.t9{color:#ff8a3a}.chatp .cm u.t10{color:#ffffff}.chatp .cm u.t11{color:#7dffb0}.chatp .cm u.npc{color:#ffd9a0}
.chatp .cm.ship{color:#1f6a3a}.chatp .cm.ship u{color:#1f6a3a}
.chatp .cin{display:flex;align-items:center;gap:8px;padding:6px 8px 8px;background:#e8eefc;box-shadow:inset 0 2px 0 #a9b8e4;cursor:text}
#ui .chatp input{flex:1;min-width:0;border:0;outline:0;background:transparent;padding:0;font:24px/26px ${B};color:#1e0c1f;-webkit-font-smoothing:none}
#ui .chatp input::placeholder{color:#6a74a8}
.chatp .mutel{padding:4px 8px 0;font:18px/20px ${B};color:#7a1e2a}.chatp .mutel[hidden]{display:none}
.chatp kbd{font:24px/24px ${B};padding:0 5px 2px;border:0;border-radius:3px;background:#1e0c1f;color:#cedbf9}
.chatp.typing{box-shadow:inset 0 -4px 0 #a9b8e4,0 0 0 2px #1e0c1f,0 6px 0 0 #1e0c1f,0 0 0 4px #8fa3ff}
.chatp.typing kbd{background:#34347e}
.toast{position:absolute;left:50%;top:70px;transform:translateX(-50%);padding:4px 12px 8px;display:none}
.creator{left:50%;top:50%;transform:translate(-50%,-50%);width:min(760px,calc(96vw / var(--ui-chat,1)));height:min(480px,calc(92vh / var(--ui-chat,1)));padding:14px;gap:14px;overflow:hidden}
.creator .cl{width:38%;min-width:180px;display:flex;flex-direction:column;gap:8px}
.creator .cpw{flex:1;min-height:0;border-radius:6px;background:radial-gradient(ellipse at 50% 70%,#343a52 0,#23262c 60%,#181a1e 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),inset 0 -2px 0 #0b0c0e;overflow:hidden;position:relative}
.creator .cpv{display:block;cursor:grab;touch-action:none}.creator .cpv:active{cursor:grabbing}
.creator .cr{flex:1;min-width:0;display:flex;flex-direction:column}
.creator .chd{display:flex;align-items:baseline;justify-content:space-between;padding-right:4px}
.creator .cfirst{margin:-4px 0 8px;font:16px/20px ${B};color:#c2c7ce}
.creator h3{margin:0 0 8px;font:32px/26px ${B};color:#e8ebef;font-weight:normal}.creator .coins{color:#a1a8b1;line-height:20px}.creator .coins b{color:#f0c75e;font-weight:normal}
.creator .ctabs{display:flex;gap:4px;margin-bottom:8px}
.creator .ctab{flex:1;border:0;border-radius:6px;padding:6px 4px 8px;font:16px/16px ${B};background:#2c3035;color:#a1a8b1;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 2px 0 #0b0c0e}.creator .ctab:hover{background:#33383e;color:#fff}
.creator .ctab.on{background:#8fa3ff;color:#050a2e;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 2px 0 #4a5bb0}.creator .ctab:focus-visible{outline:2px solid #8fa3ff;outline-offset:2px}
.creator .cpane{flex:1;min-height:0;overflow:auto;padding:2px 6px 6px 2px;background:#181a1e;border-radius:6px;padding:4px 10px 10px;box-shadow:inset 0 2px 0 #0b0c0e}
.creator h4{margin:10px 0 6px;font:16px/16px ${B};color:#949ba5;font-weight:normal}
.creator .cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px}
.creator .ct{border:0;border-radius:6px;min-height:44px;padding:5px 8px 7px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;font:16px/16px ${B};text-align:left;background:#2c3035;color:#c9ced6;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 2px 0 #0b0c0e}
.creator .ct:hover{background:#33383e;color:#fff}.creator .ct.on{background:#3a4470;color:#fff;box-shadow:inset 0 0 0 2px #8fa3ff}.creator .ct[disabled]{opacity:.45;filter:grayscale(1);cursor:not-allowed}
.creator .ct small{font:16px/14px ${B};color:#f0c75e}.creator .ct small.own{color:#6ee7a0}.creator .ct small.lk{color:#a1a8b1}
.creator .cswg{display:flex;flex-wrap:wrap;gap:8px}.creator .csw{width:32px;height:32px;border:0;border-radius:6px;padding:0;cursor:pointer;position:relative;box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 0 0 1px #0b0c0e}
.creator .csw.on{box-shadow:0 0 0 2px #181a1e,0 0 0 4px #8fa3ff}.creator .csw small{position:absolute;left:50%;bottom:-6px;transform:translateX(-50%);font:16px/12px ${B};color:#f0c75e;text-shadow:0 1px 0 #000}
.creator .csl{display:flex;align-items:center;gap:10px;line-height:24px;color:#c9ced6}.creator .csl span{width:84px}.creator .csl input{flex:1;width:auto;padding:0;background:none;box-shadow:none;accent-color:#8fa3ff}
.creator .cft{display:flex;gap:6px;margin-top:10px}.creator .cft .btn{padding:7px 6px 9px}.creator .cft .btn.p{flex:1.6}.creator .cft .btn[disabled]{opacity:.45;cursor:not-allowed}
.opts{display:flex;flex-wrap:wrap;gap:6px}.opt{border:0;font:16px/16px ${B};padding:5px 9px 7px;border-radius:5px;background:#2c3035;color:#c9ced6;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 1px 0 #0b0c0e;transition:background-color .15s}.opt:hover{background:#33383e;color:#fff}.opt:focus-visible{outline:2px solid #8fa3ff;outline-offset:1px}
.opt small{font-size:16px;color:#f0c75e;margin-left:4px}.opt.on{background:#3a4470;color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 0 0 2px #8fa3ff}.opt[disabled]{opacity:.5;cursor:not-allowed}
.sw{width:24px;height:24px;border-radius:5px;border:0;cursor:pointer;padding:0;box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 0 0 1px #0b0c0e}.sw.on{box-shadow:0 0 0 2px #1f2226,0 0 0 4px #8fa3ff}.sw:focus-visible{outline:2px solid #8fa3ff;outline-offset:3px}
.editbar{position:absolute;left:50%;top:16px;transform:translateX(-50%);padding:7px 14px 9px;line-height:18px;display:none;color:#e8ebef;white-space:nowrap}
.mapp{left:50%;top:50%;transform:translate(-50%,-50%);width:min(720px,calc(94vw / var(--ui-chat,1)));box-sizing:border-box;padding:16px;max-height:calc(92vh / var(--ui-chat,1));overflow:auto}
.mapp h3{margin:0 0 8px;font:32px/26px ${B};color:#e8ebef;font-weight:normal}
.mapp h4.fl{margin:14px 0 6px;font:16px/16px ${B};color:#949ba5;font-weight:normal}.mapp h4.fl.cur{color:#8fa3ff}
.mapp .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}.mapp .rm{padding:8px 10px 10px;border:0;border-radius:6px;cursor:pointer;line-height:18px;background:#2a2e33;box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 1px 0 #0b0c0e;transition:background-color .15s}.mapp .rm:hover{background:#33383e}
.mapp .rm b{font:24px/24px ${B};font-weight:normal;color:#e8ebef}.mapp .rm.cur{box-shadow:inset 0 0 0 2px #8fa3ff}.mapp .rm.cur b{color:#8fa3ff}.mapp .rm div{color:#b4bac3;margin-top:4px;font:16px/18px ${B}}.mapp .rm div:last-child{color:#8fa3ff}
${PLATE_CSS}
`;

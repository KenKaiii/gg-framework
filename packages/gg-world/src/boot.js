// @ts-check
// World's first script. Inside GG Coder, World runs in a SEALED frame (sandbox="allow-scripts", no same-origin): it
// can't reach the app's page, its commands or its storage, so nothing that ever ends up inside World (other players'
// chat one day) can drive the app or a coding session. The app hands World only what it asks for over postMessage.
//
// A sealed frame has no localStorage, so World's saves go through the app: this file asks for World's saved keys,
// keeps them in memory, starts the game, and sends every change back. The app keeps only keys with World's own
// prefixes (world-store.ts in gg-app) and never shares anything else of its own.
// Standalone (preview, tests, no parent app) the game uses the browser's localStorage directly.
(function () {
  var G = /** @type {any} */ (globalThis);
  // the page style, set here rather than in an inline <style> (index.html says why)
  [document.documentElement, document.body].forEach(function (el) { el.style.cssText = 'margin:0;height:100%;overflow:hidden;background:#0a0b0e'; });
  var embedded = window.parent !== window;
  /** the app's origin, for postMessage (a sealed frame's own origin is "null") */
  var appOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '*';
  G.__ggAppOrigin = embedded ? appOrigin : location.origin;

  function memory(onChange) {
    var m = new Map();
    return {
      _m: m,
      get length() { return m.size; },
      key: function (i) { return Array.from(m.keys())[i] ?? null; },
      getItem: function (k) { k = String(k); return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { k = String(k); v = String(v); m.set(k, v); if (onChange) onChange(k, v); },
      removeItem: function (k) { k = String(k); if (!m.has(k)) return; m.delete(k); if (onChange) onChange(k, null); },
      clear: function () { var ks = Array.from(m.keys()); m.clear(); if (onChange) ks.forEach(function (k) { onChange(k, null); }); },
    };
  }
  var started = false;
  function start() {
    if (started) return; started = true;
    var s = document.createElement('script'); s.src = 'game.js'; document.body.appendChild(s);
  }
  G.__ggSession = memory(null); // zoom and the like: per visit only

  if (!embedded) {
    var real = null; try { real = window.localStorage; real.getItem('x'); } catch (e) { real = null; }
    G.__ggStore = real || memory(null); start(); return;
  }

  // embedded: batch writes to the app (one message per frame at most)
  var pending = null;
  function flush() { var p = pending; pending = null; if (p) window.parent.postMessage({ gg: 'world', t: 'store', set: p }, appOrigin); }
  var store = memory(function (k, v) { if (!pending) { pending = {}; setTimeout(flush, 0); } pending[k] = v; });
  G.__ggStore = store;
  G.__ggFlushStore = flush;
  addEventListener('message', function onStorage(e) {
    if (e.source !== window.parent || (appOrigin !== '*' && e.origin !== appOrigin)) return;
    var d = e.data; if (!d || d.gg !== 'world' || d.t !== 'storage' || started) return;
    var data = d.data && typeof d.data === 'object' ? d.data : {};
    for (var k in data) if (typeof data[k] === 'string') store._m.set(k, data[k]);
    removeEventListener('message', onStorage); start();
  });
  window.parent.postMessage({ gg: 'world', t: 'boot' }, appOrigin);
  // an app that never answers (older build): play with a blank save rather than not at all
  setTimeout(function () { if (!started) { console.warn('GG World: no saved data from the app, starting fresh'); start(); } }, 3000);
})();

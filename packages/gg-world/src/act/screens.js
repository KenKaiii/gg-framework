// @ts-check
// Screen close-ups: studio trading terminal, bar deploy feed, basement monitor wall. Push-in, then a framed mini-app.
import { closeup } from './screens-frame.js';
import { tradingApp, deployApp, serverApp } from './screens-apps.js';
import { worldOf } from './view.js';
import { startBoard } from './screens-board.js';

export default [
  { id: 'screens-chart', label: () => 'Check the chart', match: (it, R) => R.id === 'studio' && it.id === 'tv-app', /* via the TV's change channel */
    start(ctx) { closeup(ctx, { style: 'tv', brand: 'VIBESONIC 4K(ish)', title: 'The Chart', sub: 'studio TV',
      help: '<kbd>↑↓</kbd> asset <kbd>space</kbd> line/candles <kbd>click</kbd> pick <kbd>esc</kbd> leave',
      view: { target: worldOf(ctx.R, -6.0, 1.3, 2.5), dir: { x: 1, y: 0.25, z: 0.15 }, zoom: 1.2 }, app: ov => tradingApp(ctx.S, ov) }); } },
  { id: 'screens-deploy', label: () => 'Watch the deploy feed', match: (it, R) => R.id === 'bar' && it.id === 'tv-app', /* via the TV's change channel */
    start(ctx) { closeup(ctx, { style: 'crt', brand: 'DNN-1999', title: 'Deploy News', sub: 'bar TV, live from prod',
      help: '<kbd>↑↓</kbd> crew <kbd>←→</kbd> next story <kbd>space</kbd> roll back <kbd>esc</kbd> leave',
      view: { target: worldOf(ctx.R, -8.3, 2.55, -5.3), dir: { x: 0.64, y: 0.1, z: 0.76 }, zoom: 1.0 }, app: ov => deployApp(ctx.S, ov) }); } },
  { id: 'screens-servers', label: () => 'Check the monitors', match: (it, R) => R.id === 'basement' && it.id === 'monitors',
    start(ctx) { closeup(ctx, { style: 'flat', title: 'Monitor Wall', sub: 'prod-01 · do not touch',
      help: '<kbd>space</kbd> acknowledge alert <kbd>esc</kbd> leave',
      view: { target: worldOf(ctx.R, -3.8, 1.4, -ctx.R.d / 2 + 0.52), dir: { x: 0.1, y: 0.2, z: 1 }, zoom: 1.0 }, app: ov => serverApp(ctx.S, ov) }); } },
  { id: 'screens-board', label: () => 'Read the plan', match: (it, R) => R.id === 'basement' && it.id === 'whiteboard', start: startBoard },
];

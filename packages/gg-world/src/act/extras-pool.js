// @ts-check
// World extras for 'pool': the hotspot on the pool table's south long side that opens the Eight Ball activity.
export default {
  id: 'pool',
  /** @param {{rooms:Record<string, any>}} ctx */
  install({ rooms }) {
    const R = rooms.bar; if (!R) return;
    R.interact.push({ id: 'pool', x: 0.6, z: 2.2, r: 1.2, label: 'Play pool', kind: 'pool' });
  },
};

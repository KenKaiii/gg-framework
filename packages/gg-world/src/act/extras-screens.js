// @ts-check
// World extras for 'screens': a hotspot at the basement monitor wall.
export default {
  id: 'screens',
  /** @param {any} ctx */
  install({ rooms }) {
    const R = rooms.basement; if (!R) return;
    R.interact.push({ id: 'monitors', x: -3.4, z: -R.d / 2 + 1.35, r: 1.0, label: 'Check the monitors', kind: 'screen' });
  },
};

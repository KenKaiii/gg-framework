// @ts-check
// World extras for 'barmenu': an "Order a drink" hotspot on the customer side of the bar counter.
// (The roof cooler already has its own 'cooler' interactable; barmenu.js matches it directly.)
export default {
  id: 'barmenu',
  /** @param {{rooms: Record<string, any>}} ctx */
  install({ rooms }) {
    const R = rooms.bar; if (!R) return;
    R.interact = R.interact || [];
    if (!R.interact.some(i => i.id === 'order')) R.interact.push({ id: 'order', x: -1.2, z: -3.3, r: 1.1, label: 'Order a drink', kind: 'menu' });
  },
};

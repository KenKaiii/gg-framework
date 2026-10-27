// @ts-check
// World extras: tag the PC seats that open GG Coder (act/gg-coder.js).
import { CODING_SEATS } from './gg-coder.js';
export default {
  id: 'gg-coder',
  /** @param {{rooms: Record<string, any>}} ctx */
  install({ rooms }) {
    for (const id of Object.keys(CODING_SEATS).sort()) for (const s of rooms[id]?.slots || []) if (/** @type {any} */ (CODING_SEATS)[id].includes(s.id) && !s.act) { s.act = 'gg-coder'; s.actLabel = 'Code on this PC'; }
  },
};

// @ts-check
// World extras for the tv builder: tag the seats that face a TV so sitting there starts 'tv-watch'.
const SEATS = { studio: ['studio-sofa2', 'studio-sofa3'], den: ['den-sofa-l', 'den-sofa-r'], bedroom: ['floor-tv'] };
export default {
  id: 'tv',
  /** @param {{rooms: Record<string, any>}} ctx */
  install({ rooms }) {
    for (const id of Object.keys(SEATS).sort()) for (const s of rooms[id]?.slots || []) if (SEATS[id].includes(s.id)) { s.act = 'tv-watch'; s.actLabel = 'Watch TV'; }
  },
};

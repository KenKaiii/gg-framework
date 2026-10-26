// @ts-check
// Room registry. Each room module exports `build(ctx)` returning a Room (see ROOMS-BRIEF.md).
// Order = order on the map. Room builders only edit their own file; this list stays as is.
import * as bar from './bar.js';
import * as den from './den.js';
import * as bedroom from './bedroom.js';
import * as roof from './roof.js';
import * as basement from './basement.js';
import * as engine from './engine.js';
import * as kitchen from './kitchen.js';
import * as studio from './studio.js';
import * as screening from './screening.js';
import * as diner from './diner.js';
import * as library from './library.js';
import * as garage from './garage.js';
import * as overlook from './overlook.js';
import * as hawkins from './hawkins.js';
import * as biolab from './biolab.js';
import * as hackers from './hackers.js';
import * as computer from './computer.js';
import * as fightclub from './fightclub.js';
import * as inception from './inception.js';
import * as tavern from './tavern.js';

export const ROOM_MODULES = { bar, den, bedroom, kitchen, studio, screening, diner, library, garage, overlook, hawkins, biolab, hackers, computer, fightclub, inception, tavern, roof, basement, engine };
export const ROOM_IDS = /** @type {const} */ (['bar', 'den', 'bedroom', 'kitchen', 'studio', 'screening', 'diner', 'library', 'garage', 'overlook', 'hawkins', 'biolab', 'hackers', 'computer', 'fightclub', 'inception', 'tavern', 'roof', 'basement', 'engine']);

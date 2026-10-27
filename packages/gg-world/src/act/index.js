// @ts-check
// Every activity, in priority order (first match wins). Each builder owns one module and exports an ARRAY of activities.
import pool from './pool.js';
import screens from './screens.js';
import tv from './tv.js';
import rickroll from './rickroll.js';
import ggCoder from './gg-coder.js';
import pinball from './pinball.js';
import arcade from './arcade.js';
import barmenu from './barmenu.js';
import filmsA from './films-a.js';
import filmsB from './films-b.js';
import screeningActs from './screening.js';
import dinerActs from './diner.js';
import libraryActs from './library.js';
import garageActs from './garage.js';
import overlookActs from './overlook.js';
import hawkinsActs from './hawkins.js';
import biolabActs from './biolab.js';
import hackersActs from './hackers.js';
import computerActs from './computer.js';
import fightclubActs from './fightclub.js';
import inceptionActs from './inception.js';
import tavernActs from './tavern.js';
import roofScope from './roof-scope.js';
import radio from './radio.js';
import sample from './_sample.js';
import engineActs from './engine.js';

/** @type {any[]} */
export const ACTIVITIES = [...engineActs, ...radio, ...pool, ...screens, ...rickroll, ...ggCoder, ...tv, ...pinball, ...arcade, ...barmenu, ...filmsA, ...filmsB, ...screeningActs, ...dinerActs, ...libraryActs, ...garageActs, ...overlookActs, ...hawkinsActs, ...biolabActs, ...hackersActs, ...computerActs, ...fightclubActs, ...inceptionActs, ...tavernActs, ...roofScope, sample].filter(Boolean);

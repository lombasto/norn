import { a } from './a.mjs';
import b from './b';
export { c } from './lib';
import { u } from '#util/str';
import cfg from '#cfg';
import { w } from '@fx/widgets';
import { wb } from '@fx/widgets/button';
import fs from 'node:fs';
import fp from 'lodash/fp';
import './both';
import { g } from './gen.js';
import { v } from './vendored.js';
import { gone } from './gone.mjs';
const lazy = await import('./lazy.js');
const dyn = await import(fs.name);
// the fixture is read for its import edges; this line uses every binding so the lint keeps the imports as written
export const used = [a, b, u, cfg, w, wb, fp, g, v, gone, lazy, dyn];

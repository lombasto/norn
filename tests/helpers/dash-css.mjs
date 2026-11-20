// The classic sheets of the dashboard in load order (engine/dash/css/: base, then the pages' own), as one text - what index.html links
// before norn/norn.css. Tests that check a classic CSS rule read this, not index.html.
import fs from 'node:fs';
import path from 'node:path';
const DIR = path.join(import.meta.dirname, '..', '..', 'engine', 'dash', 'css');
export const SHEETS = ['base.css', 'lanes.css', 'runs.css'];
export const dashCss = () => SHEETS.map(f => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n');

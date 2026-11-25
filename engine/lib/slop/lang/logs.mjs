// SloppaChoppa lint tools read from a file a project tool wrote, never run (clippy's log, a SARIF file): the rule's `log` path
// templates - `{git}` the repo's common git folder, `{head}` the commit of the side read, `*` in the file name - to the files they name.
import fs from 'node:fs';
import path from 'node:path';

/** logFiles(templates, git, sha) -> [{ path, text }] of every file the templates name for that commit, by name; none = [] */
export function logFiles(templates = [], git, sha) {
  return templates.flatMap(t => {
    const p = t.split('{git}').join(git).split('{head}').join(sha), dir = path.dirname(p);
    const re = new RegExp(`^${path.basename(p).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    let names = []; try { names = fs.readdirSync(dir).filter(n => re.test(n)).sort(); } catch { names = []; }   // no folder: no file for this commit
    return names.map(n => ({ path: path.join(dir, n), text: fs.readFileSync(path.join(dir, n), 'utf8') }));
  });
}

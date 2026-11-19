// Child process for the VIEW-RACE test: write one generated view N times (a new text each round), sync or async, and print the refusals.
import { HEADER, writeGuarded, writeGuardedAsync } from '../../engine/lib/views.mjs';
const [hashFile, file, w, n, mode] = process.argv.slice(2);
let refused = 0;
for (let i = 0; i < Number(n); i++) {
  const text = `${HEADER}\n# view\n\nwriter ${w} round ${i}\n`;
  const r = mode === 'async' ? await writeGuardedAsync(hashFile, file, text) : writeGuarded(hashFile, file, text);
  if (r === 'refused') refused++;
}
process.stdout.write(JSON.stringify({ refused }));

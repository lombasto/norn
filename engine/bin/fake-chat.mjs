#!/usr/bin/env node
// META-CONTROLLER C1: the scripted chat CLI for tests and smoke - speaks `claude -p --input-format stream-json --output-format
// stream-json` as recorded in C0 (tests/fixtures/chat): one user line in -> system init (re-emitted EVERY turn, as claude does),
// assistant text + usage, result. Each session's messages live in <cwd>/fake-sessions/<id>.json, so a new process with --resume
// keeps the conversation; --session-id of an existing session is refused (as claude: "already in use").
// The reply: "heard <text> (turn <n>; first: <the session's first message>)". Messages starting "!": scripted behaviour -
// "!crash" exits 3 mid-turn, "!slow <ms>" answers after ms, "!fold" gets no turn (a message folded into the one running); C5: "!ctx <n>" sets the context size, "!no-handoff" kills the hand-off turn. stdin end = exit 0 (C0 finding 3).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2), flag = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const sid = flag('--resume') || flag('--session-id'), model = flag('--model') || 'fake';
const store = path.join(process.cwd(), 'fake-sessions'), file = path.join(store, `${sid}.json`);
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

if (!sid) { process.stderr.write('fake-chat: --session-id or --resume is required\n'); process.exit(2); }
if (flag('--session-id') && load()) { process.stderr.write(`Error: Session ID ${sid} is already in use.\n`); process.exit(1); }
if (flag('--resume') && !load()) { process.stderr.write(`No conversation found with session ID: ${sid}\n`); process.exit(1); }
fs.mkdirSync(store, { recursive: true });
if (!load()) fs.writeFileSync(file, JSON.stringify({ messages: [] }));

// R1: as claude's init, the commands this session can dispatch (a sample of the real 2.1.314 list + one custom command)
const SLASH = ['clear', 'compact', 'context', 'model', 'effort', 'usage', 'norn-ping'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let chain = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', line => { chain = chain.then(() => turn(line)); })
  .on('close', () => { chain.then(() => process.exit(0)); });

let spent = 0;
async function turn(line) {
  let text;
  try { text = JSON.parse(line).message.content.map(c => c.text ?? '').join(''); } catch { return; }
  if (text === '!fold') return;   // as claude does with a message written mid-turn: folded into the running turn - no turn of its own, no output
  out({ type: 'system', subtype: 'init', session_id: sid, model, permissionMode: 'default', mcp_servers: [], slash_commands: SLASH });
  if (text === '!crash') process.exit(3);
  const slow = text.match(/^!slow (\d+)$/);
  if (slow) await sleep(Number(slow[1]));
  const s = load();
  // C5: Norn's hand-off turn - a session told "!no-handoff" dies on it; else the hand-off lists its "thread: x" messages
  const handoff = text.startsWith('NORN HAND-OFF');
  if (handoff && s.messages.includes('!no-handoff')) process.exit(3);
  s.messages.push(text);
  const ctx = text.match(/^!ctx (\d+)$/);
  if (ctx) s.ctx = Number(ctx[1]);   // "!ctx N": the context is N tokens from now on (fake usage for the hand-off thresholds)
  fs.writeFileSync(file, JSON.stringify(s));
  const n = s.messages.length, read = s.ctx ? s.ctx - 10 : 1000 * n;
  const threads = s.messages.filter(m => m.startsWith('thread: ')).map(m => '- ' + m.slice(8));
  const reply = handoff ? `## Open threads\n${threads.join('\n') || '- none'}\n## Promises to the owner\n- none\n## Holds\n- none\n## Next step\n- go on`
    : `heard ${text} (turn ${n}; first: ${s.messages[0]})`;
  const usage = { input_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 0, output_tokens: 5 };
  // as claude: one model call can arrive as several assistant lines (thinking, then text), each repeating the call's usage
  out({ type: 'assistant', session_id: sid, message: { id: `msg-${n}`, model, content: [{ type: 'thinking', thinking: '...' }], usage } });
  out({ type: 'assistant', session_id: sid, message: { id: `msg-${n}`, model, content: [{ type: 'text', text: reply }], usage } });
  spent = Math.round((spent + 0.001) * 1e6) / 1e6;   // claude's total_cost_usd is the PROCESS's running total (C2 finding)
  out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, total_cost_usd: spent, permission_denials: [], usage });
}

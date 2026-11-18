// Harness adapter: the FAKE executor (engine/bin/fake-executor.mjs) - stands in for a headless claude worker in tests and smoke;
// its final file is claude-shaped JSON, so it parses like claude.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import claude from './claude.mjs';
import { modeOf, logFeed, promptArg } from './common.mjs';

export const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'fake-executor.mjs');
export const FAKE_CHAT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'fake-chat.mjs');
const caps = { modes: ['write', 'read-only', 'no-tools'], resume: true, mcp: 'none', output: 'final', usage: 'tokens+cost', skills: 'none', fork: false, hooks: 'none', resume_style: 'flag', noninteractive: null, chat: 'stream' };   // --resume <sid> (+ --prompt): a nudge

function command(o) {
  const mode = modeOf(o, 'fake', caps);
  if (o.mcp) throw new Error('fake has no MCP');
  // a long nudge prompt comes on stdin (--prompt-stdin), as claude's does
  const p = o.resumeSid && o.promptText ? promptArg(o.promptText) : null;
  return { exe: process.execPath, stdin: null, stdout: 'final', parse: 'claude', ...p?.fields, args: [
    FAKE, '--brief', o.brief, ...(o.notes ? ['--notes', o.notes] : []), ...(mode === 'read-only' ? ['--read-only'] : []), '--resumes', String(o.resumes || 0),
    ...(o.resumeSid ? ['--resume', o.resumeSid, ...(p ? (p.arg.length ? ['--prompt', ...p.arg] : ['--prompt-stdin']) : [])] : [])] };
}

// META-CONTROLLER C1: the scripted chat CLI (engine/bin/fake-chat.mjs) speaks claude's stream-json, so claude's chatEvents parse it;
// it keeps each session's messages under <cwd>/fake-sessions (resume keeps the conversation, as C0 fact 1 showed for claude)
const chatCommand = o => {
  if (!o.session_id) throw new Error('chat needs a session_id');
  return { exe: process.execPath, cwd: o.cwd, stdin: 'stream', args: [FAKE_CHAT, ...(o.resume ? ['--resume', o.session_id] : ['--session-id', o.session_id]), '--model', o.model] };
};

export default {
  family: 'fake', caps, command, probe: command,
  parse: claude.parse, endData: claude.endData, chatCommand, chatEvents: claude.chatEvents,
  feed: (run, cursor, env) => logFeed([['log', run.data?.log]], cursor, env),   // its log lines (tests append fixture lines)
  detect: () => ({ exe: process.execPath, version: 'fake' }),
  headless: claude.headless,
};

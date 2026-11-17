// A Claude run naming an agent that is not installed is refused before it starts (it used to start and crash: "--agent 'worker' not
// found"), and the check-in prompt names the agents there are.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { knownAgents, agentRefusal } from '../engine/lib/launchpolicy.mjs';
import { renderCheckin } from '../engine/lib/tick.mjs';

after(cleanTmp);

test('knownAgents: the user, worktree and project agent files; agentRefusal: unknown refused, known / plugin / none pass', () => {
  const claudeDir = mkTmp('agents-claude-'), wt = mkTmp('agents-wt-'), proj = mkTmp('agents-proj-');
  fs.mkdirSync(path.join(claudeDir, 'agents')); fs.writeFileSync(path.join(claudeDir, 'agents', 'implementer.md'), '---\nname: implementer\n---\n');
  fs.mkdirSync(path.join(wt, '.claude', 'agents'), { recursive: true }); fs.writeFileSync(path.join(wt, '.claude', 'agents', 'tester.md'), 'x');
  fs.writeFileSync(path.join(proj, 'planner.md'), 'x'); fs.writeFileSync(path.join(proj, 'notes.txt'), 'x');
  const o = { claudeDir, worktree: wt, project: { install: { agents: proj } } };
  assert.deepEqual(knownAgents(o), ['implementer', 'planner', 'tester']);
  assert.equal(agentRefusal('implementer', o), null);
  assert.equal(agentRefusal('tester', o), null, 'a worktree agent');
  assert.equal(agentRefusal(undefined, o), null, 'no agent: the default');
  assert.equal(agentRefusal('cfs-streng:streng-independent-checker', o), null, 'a plugin agent is left to Claude Code');
  assert.match(agentRefusal('worker', o), /--agent worker: no such agent \(known: implementer, planner, tester; or leave --agent out\)/);
  assert.match(agentRefusal('worker', {}), /known: none/);
});

test('the check-in prompt names the installed agents on its launch line', () => {
  const state = mkTmp('agents-state-'), proj = mkTmp('agents-proj2-');
  fs.writeFileSync(path.join(proj, 'runner.md'), 'x');
  const prev = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = mkTmp('agents-empty-');
  try {
    const out = renderCheckin({ name: 'p', root: state, state, install: { agents: proj } }, {});
    assert.match(fs.readFileSync(out, 'utf8'), /\[--agent <a>\][^]*agents installed here: runner; no other name/);
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
});

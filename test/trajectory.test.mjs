import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { currentReadPaths, readPathKey, observationRules, preparationContext } from '../trajectory.js';
const cwd = process.cwd();
const call = (id, name, args) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] });
const result = (id, name, text = 'body', extra = {}) => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false, ...extra });
const read = (id, file, args = {}, extra = {}) => [call(id, 'read', { path: file, ...args }), result(id, 'read', 'body', extra)];
const manager = messages => ({ getCwd: () => cwd, buildSessionProjection: () => ({ messages }), getBranch: () => messages.map(message => ({ type: 'message', message })) });
const custom = messages => ({ role: 'custom', customType: 'capability-prefetch', details: { prefetch: { rounds: [{ messages }] } } });
test('only complete successful current-context reads deduplicate, never historical branch', () => {
  const messages = [...read('a', 'a.md'), ...read('b', 'b.md', { limit: 10 }, { content: [{ type: 'text', text: 'body\n\n[2 more lines in file. Use offset=11 to continue.]' }] }), ...read('c', 'c.md', { offset: 2 }), ...read('d', 'd.md', {}, { isError: true }), ...read('e', 'e.md', {}, { details: { truncation: { truncated: true } } })];
  const sm = manager(messages); sm.getBranch = () => { throw Error('must not inspect history'); };
  assert.deepEqual(currentReadPaths(sm), new Set([readPathKey('a.md', cwd)]));
  assert.deepEqual(currentReadPaths({ getBranch: () => read('x', 'x.md') }, cwd), new Set());
});
test('host prefetch reads count; later edits/writes and any bash invalidate conservatively', () => {
  const messages = [custom(read('a', 'a.md')), ...read('b', 'b.md'), call('w', 'write', { path: 'a.md', content: 'new' })];
  assert.deepEqual(currentReadPaths(manager(messages)), new Set([readPathKey('b.md', cwd)]));
  messages.push(call('e', 'edit', { path: 'b.md' }));
  assert.equal(currentReadPaths(manager(messages)).size, 0);
  messages.push(...read('c', 'c.md'), call('bash', 'bash', { command: 'anything' }));
  assert.equal(currentReadPaths(manager(messages)).size, 0);
  messages.push(...read('d', 'd.md'));
  assert.deepEqual(currentReadPaths(manager(messages)), new Set([readPathKey('d.md', cwd)]));
  messages.length = 0;
  assert.equal(currentReadPaths(manager(messages)).size, 0, 'no cross-branch cache');
});
test('normalization gives stable absolute paths without filesystem/subprocess access', () => {
  assert.equal(readPathKey('./x/../a.md', cwd), readPathKey('a.md', cwd));
  assert.ok(path.isAbsolute(readPathKey('a.md', cwd)));
  assert.equal(readPathKey('', cwd), undefined);
  if (process.platform === 'win32') assert.equal(readPathKey('/c/Work/A.md', cwd), readPathKey('C:\\Work\\A.md', cwd));
});
test('observation rules separate bounded system authority from retained Skill and reference evidence', () => {
  const messages = [...read('s', 'skills/design/SKILL.md'), ...read('r', 'skills/design/references/rules.md'), ...read('a', 'AGENTS.md'), ...read('u', 'unrelated.md')];
  messages[1].content = [{ type: 'text', text: 'SKILL_RULE' }, { type: 'thinking', thinking: 'SECRET_THINKING' }];
  messages[3].content = [{ type: 'text', text: 'REFERENCE_RULE' }];
  messages[5].content = [{ type: 'text', text: 'AGENT_RULE' }];
  messages[7].content = [{ type: 'text', text: 'UNRELATED_BODY' }];
  const rules = observationRules(manager(messages), 'SYSTEM_RULE', cwd);
  for (const text of ['SYSTEM INSTRUCTIONS', 'SYSTEM_RULE', 'DOCUMENT EVIDENCE', 'SKILL_RULE', 'REFERENCE_RULE', 'AGENT_RULE']) assert.ok(rules.includes(text), text);
  assert.doesNotMatch(rules, /SECRET_THINKING|UNRELATED_BODY/);
  messages[1].content = [{ type: 'text', text: 'z'.repeat(100000) }];
  const large = observationRules(manager(messages), 's'.repeat(100000), cwd);
  assert.ok(large.length <= 24000); assert.match(large, /truncated/);
  messages[1].content = [{ type: 'text', text: 'SKILL_RULE' }]; // Restore the small fixture after the independent budget assertion.
  messages.push(call('edit', 'edit', { path: 'skills/design/SKILL.md' }));
  assert.match(observationRules(manager(messages), '', cwd), /REFERENCE_RULE/);
  assert.match(observationRules(manager(messages), '', cwd), /possibly stale/);
});
test('unknown success, missing call and native tail markers cannot prove a whole read', () => {
  const messages = [...read('unknown', 'unknown.md', {}, { isError: undefined }), result('orphan', 'read'), call('tail', 'read', { path: 'tail.md' }), result('tail', 'read', 'x\n\n[3 more lines in file. Use offset=2 to continue.]')];
  assert.equal(currentReadPaths(manager(messages)).size, 0);
});
test('opaque execution invalidates earlier reads and pending results; known discovery does not', () => {
  for (const tool of ['bash', 'codemode', 'subagent_start', 'subagent_send', 'tide', 'unknown_mcp']) {
    const messages = [...read('a', 'a.md'), call('pending', 'read', { path: 'pending.md' }), call('mutate', tool, {}), result('pending', 'read')];
    assert.equal(currentReadPaths(manager(messages)).size, 0, tool);
    messages.push(...read('fresh', 'fresh.md'));
    assert.deepEqual(currentReadPaths(manager(messages)), new Set([readPathKey('fresh.md', cwd)]));
  }
  assert.equal(currentReadPaths(manager([...read('a', 'a.md'), call('search', 'tool_search', {})])).size, 1);
});
test('preparation shares one projection, switches avoid work, stale rules remain review evidence', () => {
  const messages = [...read('skill', 'skills/a/SKILL.md'), ...read('ref', 'skills/a/ref.md'), call('run', 'codemode', {})];
  messages[1].content = [{ type: 'text', text: 'KEEP_RULE' }];
  const sm = manager(messages); let projections = 0;
  sm.buildSessionProjection = () => { projections++; return { messages }; };
  const prepared = preparationContext(sm, 'system', cwd);
  assert.equal(projections, 1); assert.equal(prepared.readPaths.size, 0);
  assert.match(prepared.rules, /KEEP_RULE/); assert.match(prepared.rules, /possibly stale/);
  assert.match(prepared.rules, /latest system and user instructions take precedence/);
  assert.deepEqual(preparationContext(sm, '', cwd, { reads: false, rules: false }), { readPaths: new Set(), retainedReads: new Map(), rules: '' });
  assert.equal(projections, 1);
  const rulesOnly = preparationContext(sm, '', cwd, { reads: false });
  assert.equal(projections, 2); assert.equal(rulesOnly.readPaths.size, 0); assert.match(rulesOnly.rules, /KEEP_RULE/);
  const readsOnly = preparationContext(sm, { toString() { throw Error('must not format rules'); } }, cwd, { rules: false });
  assert.equal(projections, 3); assert.equal(readsOnly.rules, '');
});
test('positive integer limits reaching EOF count; invalid limits and partial reads do not', () => {
  const full = manager(read('full', 'SKILL.md', { offset: 1, limit: 2000 }));
  assert.ok(currentReadPaths(full).has(readPathKey('SKILL.md', cwd)));
  assert.match(observationRules(full, '', cwd), /body/);
  for (const limit of [0, -1, 1.5, null, '2000', NaN, Infinity]) {
    assert.equal(currentReadPaths(manager(read('bad', 'SKILL.md', { limit }))).size, 0, String(limit));
  }
  assert.equal(currentReadPaths(manager(read('offset', 'SKILL.md', { offset: 2, limit: 2000 }))).size, 0);
  assert.equal(currentReadPaths(manager(read('cut', 'SKILL.md', { limit: 2000 }, { details: { truncation: { truncated: true } } }))).size, 0);
});
const sdkRoot = process.env.PI_DISCOVERY_SDK_ROOT;
test('real SDK read limits distinguish full EOF from a partial Skill and never overwrite full retained evidence', { skip: !sdkRoot }, async () => {
  const { createReadToolDefinition } = await import(pathToFileURL(path.join(sdkRoot, 'dist/core/tools/read.js')).href);
  const { SessionManager } = await import(pathToFileURL(path.join(sdkRoot, 'dist/core/session-manager.js')).href);
  const dir = await mkdtemp(path.join(tmpdir(), 'trajectory-read-limit-'));
  try {
    const file = path.join(dir, 'SKILL.md');
    const text = Array.from({ length: 100 }, (_, i) => `RULE_${i + 1}`).join('\n');
    await writeFile(file, text);
    const tool = createReadToolDefinition(dir), sm = SessionManager.inMemory(dir);
    const appendRead = async (id, limit, target = sm) => {
      const args = { path: file, offset: 1, limit };
      const output = await tool.execute(id, args);
      target.appendMessage(call(id, 'read', args));
      const message = result(id, 'read', '', { ...output, isError: output.isError === true });
      target.appendMessage(message);
      return message;
    };
    const full = await appendRead('full', 2000);
    assert.equal(full.content[0].text, text);
    const key = readPathKey(file, dir), prepared = preparationContext(sm, '', dir);
    assert.ok(prepared.readPaths.has(key));
    assert.equal(prepared.retainedReads.get(key).content[0].text, text);
    assert.match(prepared.rules, /RULE_100/);
    const partial = await appendRead('partial', 1);
    assert.match(partial.content[0].text, /\[99 more lines in file\. Use offset=2 to continue\.\]/);
    const after = preparationContext(sm, '', dir);
    assert.equal(after.retainedReads.get(key).content[0].text, text, 'partial result must not replace prior full body');
    assert.ok(after.readPaths.has(key));
    const onlyPartial = SessionManager.inMemory(dir);
    await appendRead('onlyPartial', 1, onlyPartial);
    const partialContext = preparationContext(onlyPartial, '', dir);
    assert.equal(partialContext.readPaths.size, 0);
    assert.equal(partialContext.retainedReads.size, 0);
    assert.doesNotMatch(partialContext.rules, /RULE_1/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('real SDK compaction keeps only retained reads and honors context edits', { skip: !sdkRoot }, async () => {
  const { SessionManager } = await import(pathToFileURL(path.join(sdkRoot, 'dist/core/session-manager.js')).href);
  const sm = SessionManager.inMemory(cwd);
  for (const message of read('old', 'old.md')) sm.appendMessage(message);
  const kept = sm.appendMessage(call('keep', 'read', { path: 'keep.md' }));
  const keptResult = sm.appendMessage(result('keep', 'read'));
  sm.appendCompaction('read old.md in summary is not content', kept, 100);
  assert.deepEqual(currentReadPaths(sm), new Set([readPathKey('keep.md', cwd)]));
  sm.appendContextEdit(keptResult, { content: 'replaced' });
  assert.equal(currentReadPaths(sm).size, 0);
  sm.branch(keptResult);
  assert.deepEqual(currentReadPaths(sm), new Set([readPathKey('old.md', cwd), readPathKey('keep.md', cwd)]));
  sm.appendCustomMessageEntry('capability-prefetch', 'host preparation', false, custom(read('host', 'host.md')).details);
  assert.ok(currentReadPaths(sm).has(readPathKey('host.md', cwd)));
  const latest = sm.appendMessage({ role: 'user', content: 'new task' });
  sm.appendCompaction('old skills summarized', latest, 200);
  assert.equal(currentReadPaths(sm).size, 0, 'host bodies discarded by compaction cannot deduplicate');
});
test('preparation retains complete read evidence after Bash, never after context removal', () => {
  const messages = [...read('r', 'a.md'), call('b', 'bash', { command: 'git status' })];
  const context = preparationContext(manager(messages), '', cwd);
  assert.equal(context.readPaths.size, 0);
  assert.equal(context.retainedReads.get(readPathKey('a.md', cwd)), messages[1]);
  assert.equal(preparationContext(manager([]), '', cwd).retainedReads.size, 0);
  assert.equal(preparationContext(manager(messages), '', cwd, { reads: false }).retainedReads.size, 0);
});

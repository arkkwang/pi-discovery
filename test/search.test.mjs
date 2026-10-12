import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setup, nativeSchema } from './helpers.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'skill-catalog-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
const skills = [
  { name: 'image-generation', description: '生成图片、编辑图片' },
  { name: 'engineering', description: 'Implement code and tests' },
  { name: 'private', description: '图片', disableModelInvocation: true },
];
for (const skill of skills) {
  const dir = path.join(root, skill.name);
  mkdirSync(dir);
  skill.filePath = path.join(dir, 'SKILL.md');
  const metadata = skill.name === 'image-generation' ? 'metadata:\n  catalog-description: 图片创作\n' : '';
  writeFileSync(skill.filePath, `---\nname: ${skill.name}\ndescription: ${skill.description}\n${metadata}---\nSecret body.\n`);
}

test('one directory, after native MCP rendering; preserve other sections and native identity', async () => {
  const s = setup({ skills, sections: { mcp_servers: 'Host intro\n- mcp__browser (tool_search): Browse pages\n- mcp__pending (codemode): Connecting' } });
  const options = await s.prompt();
  assert.equal(s.tool.name, 'tool_search');
  assert.equal(s.tool.parameters, nativeSchema);
  assert.equal(s.tool.exposure, 'model-only');
  assert.equal(s.tool.defaultActive, false);
  assert.deepEqual(options.skills, []);
  assert.equal(skills.length, 3);
  assert.equal(options.sections.keep, 'unchanged');
  assert.ok(!('mcp_servers' in options.sections));
  assert.ok(!('pi_discovery' in options.sections));
  const section = options.sections.available_capabilities;
  assert.match(section, /Skills/); assert.match(section, /MCP/);
  assert.match(section, /mcp__pending: Connecting/);
  assert.doesNotMatch(section, /Host intro|capability_search|\(codemode\)|\(tool_search\)/);
  assert.match(section, /image-generation — 图片创作/);
  assert.doesNotMatch(section, /private|Secret body|生成图片、编辑图片/);
  for (const skill of skills) assert.ok(!section.includes(skill.filePath));
  await s.handlers.tool_call();
  assert.deepEqual(s.calls, ['mcp-prompt', 'mcp-wait']);
});
test('list and exact Skill are model-free and never load MCP tools', async () => {
  const s = setup({ skills }); await s.prompt();
  const list = (await s.search()).details;
  assert.equal(list.total, 2);
  assert.deepEqual(list.suggestions.map(s => s.name), ['engineering', 'image-generation']);
  const exact = (await s.search({ query: ' SKILL:IMAGE-GENERATION ' })).details;
  assert.deepEqual(exact.suggestions[0], { type: 'skill', name: skills[0].name, description: skills[0].description, path: skills[0].filePath, confidence: null });
  assert.deepEqual(exact.loaded, []);
  assert.equal(s.calls.length, 1);
});
test('validate original schema semantics; cancellation does not load anything', async () => {
  const s = setup({ skills }); await s.prompt();
  for (const args of [{}, { query: ' ' }, { query: 'x', limit: 0 }, { query: 'x', limit: 1.2 }]) await assert.rejects(s.search(args));
  await assert.rejects(s.tool.execute('id', { query: 'engineering' }, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal(s.calls.length, 1);
});
test('routing failure remains explicit but native tool search still runs', async () => {
  const s = setup({ skills }); await s.prompt();
  const miss = await s.search({ query: '代码审查' });
  assert.equal(miss.isError, true);
  assert.match(miss.details.routingError, /llama\/iq3/);
  assert.deepEqual(s.calls[1].args, { query: '代码审查', limit: 8 });
  assert.equal((await s.search()).details.total, 2);
});
test('catalog refreshes, is request-independent and instance-local', async () => {
  const a = setup({ skills }), b = setup({ skills });
  const previous = await a.prompt(); await b.prompt();
  const next = await a.prompt([]);
  assert.equal(next.sections.available_capabilities, '');
  assert.equal((await a.search()).details.total, 0);
  assert.equal((await b.search()).details.total, 2);
  assert.match(previous.sections.available_capabilities, /image-generation/);
  const many = await a.prompt(Array.from({ length: 8 }, (_, n) => ({ ...skills[1], name: `code-${n}` })));
  assert.equal((many.sections.available_capabilities.match(/^- /gm) || []).length, 8);
});
test('metadata fallback, malformed YAML, BOM/CRLF and edits remain supported', async () => {
  const s = setup();
  const description = 'Full fallback description. '.repeat(10);
  const filePath = path.join(root, 'fallback.md');
  const render = async () => (await s.prompt([{ name: 'fallback', description, filePath }])).sections.available_capabilities;
  for (const value of ['""', '"   "', '42', '[]', 'null']) {
    writeFileSync(filePath, `---\nmetadata:\n  catalog-description: ${value}\n---\n`);
    assert.ok((await render()).includes(description.trim()));
  }
  for (const content of ['---\nname: fallback\n---\n', '---\nmetadata: [invalid\n---\n', 'No frontmatter']) {
    writeFileSync(filePath, content); assert.ok((await render()).includes(description.trim()));
  }
  rmSync(filePath); assert.ok((await render()).includes(description.trim()));
  writeFileSync(filePath, '\ufeff---\r\nmetadata:\r\n  catalog-description: >-\r\n    短说明\r\n    第二行\r\n---\r\n');
  assert.match(await render(), /fallback — 短说明 第二行/);
  writeFileSync(filePath, '---\nmetadata:\n  catalog-description: 新说明\n---\n');
  assert.match(await render(), /fallback — 新说明/);
});

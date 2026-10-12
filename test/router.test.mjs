import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeCapabilities } from '../router.js';
import { mcpCapabilities } from '../discovery.js';
import { setup } from './helpers.mjs';

const catalog = [
  { type: 'skill', name: 'engineering-practice', description: 'Implement and verify code', path: '/trusted/code/SKILL.md' },
  { type: 'mcp', name: 'mcp__browser', description: 'Browse pages' },
];
const registry = {
  find: (provider, id) => {
    assert.equal(provider, 'llama'); assert.equal(id, 'iq3');
    return { id, baseUrl: 'http://localhost:8081/v1/', api: 'openai-completions', maxTokens: 16384 };
  },
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'local-test-key' }),
};
const reply = (value, finish_reason = 'stop') => new Response(JSON.stringify({
  choices: [{ finish_reason, message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }],
}));
const suggestions = [{ id: 'skill:engineering-practice', confidence: 0.7 }, { id: 'mcp:mcp__browser', confidence: 0.9 }];

test('one tool-free medium-thinking request; mixed types, score sorting and trusted paths', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    assert.equal(url, 'http://localhost:8081/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer local-test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'iq3'); assert.equal(body.stream, false);
    assert.equal(body.temperature, 0); assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true, reasoning_effort: 'medium' });
    assert.equal(body.max_tokens, 16384); assert.equal(body.messages.length, 2);
    assert.ok(!('tools' in body)); assert.ok(!body.messages[0].content.includes('/trusted/'));
    assert.doesNotMatch(body.messages[0].content, /engineering-practice|Browse pages/);
    assert.match(body.messages[1].content, /## Available capabilities/);
    assert.match(body.messages[1].content, /### mcp:mcp__browser/);
    assert.match(body.messages[1].content, /## Current request\n检查网页并修复/);
    assert.equal(body.response_format.json_schema.schema.properties.suggestions.items.properties.id.enum, undefined);
    return reply({ suggestions: [...suggestions, { id: 'skill:engineering-practice', confidence: 0.2 }] });
  });
  assert.deepEqual(await routeCapabilities('检查网页并修复', catalog, registry), [
    { ...catalog[1], confidence: 0.9 }, { ...catalog[0], confidence: 0.7 },
  ]);
  assert.equal(calls, 1);
});
test('empty and low confidence suggestions are valid; invalid scores/IDs are rejected', async t => {
  t.mock.method(globalThis, 'fetch', async () => reply({ suggestions: [] }));
  assert.deepEqual(await routeCapabilities('unrelated', catalog, registry), []);
  globalThis.fetch = async () => reply({ suggestions: [{ id: 'skill:engineering-practice', confidence: 0 }] });
  assert.equal((await routeCapabilities('task', catalog, registry))[0].confidence, 0);
  for (const invalid of ['not json', null, { suggestions: [], path: '/injected' },
    ...[null, { id: 'invented', confidence: 0.5 }, { id: 'skill:engineering-practice', confidence: '0.5' },
      { id: 'skill:engineering-practice', confidence: -1 }, { id: 'skill:engineering-practice', confidence: 2 },
      { id: 'skill:engineering-practice' }, { id: 'skill:engineering-practice', confidence: 0.5, path: '/injected' }]
      .map(item => ({ suggestions: [item] }))]) {
    globalThis.fetch = async () => reply(invalid);
    await assert.rejects(routeCapabilities('task', catalog, registry));
  }
});
test('HTTP/truncated/network failures are not retried; no bogus empty result', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('private server error', { status: 503 }); });
  await assert.rejects(routeCapabilities('task', catalog, registry), /HTTP 503/); assert.equal(calls, 1);
  globalThis.fetch = async () => reply({ suggestions: [] }, 'length');
  await assert.rejects(routeCapabilities('task', catalog, registry), /did not complete/);
  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(routeCapabilities('task', catalog, registry), /offline/);
});
test('missing model/auth, wrong API and cancellation', async t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('unexpected fetch'); });
  await assert.rejects(routeCapabilities('task', catalog, { find: () => undefined }), /not configured/);
  await assert.rejects(routeCapabilities('task', catalog, { find: () => ({ api: 'other' }) }), /openai-completions/);
  await assert.rejects(routeCapabilities('task', catalog, { ...registry, getApiKeyAndHeaders: async () => ({ ok: false }) }), /authentication/);
  await assert.rejects(routeCapabilities('task', catalog, registry, AbortSignal.abort()), { name: 'AbortError' });
});
test('in-flight abort and timeout propagate', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, options) => { controller.abort(); options.signal.throwIfAborted(); });
  await assert.rejects(routeCapabilities('task', catalog, registry, controller.signal), { name: 'AbortError' });
  t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 60_000); return AbortSignal.abort(new DOMException('deadline', 'TimeoutError')); });
  await assert.rejects(routeCapabilities('task', catalog, registry), { name: 'TimeoutError' });
});
const tools = [
  { name: 'mcp__browser__open', exposure: 'deferred', namespace: { name: 'mcp__browser', description: 'Browse pages' } },
  { name: 'mcp__browser__hidden', exposure: 'hidden', namespace: { name: 'mcp__browser' } },
  { name: 'mcp__private__secret', exposure: 'hidden', namespace: { name: 'mcp__private' } },
  { name: 'bash', exposure: 'direct' },
];
test('MCP groups exclude hidden tools and refresh on every query', async () => {
  assert.deepEqual(mcpCapabilities(tools), [catalog[1]]);
  const s = setup(); await s.prompt();
  assert.equal((await s.search()).details.total, 0);
  s.setTools(tools);
  const found = await s.search({ query: 'mcp:mcp__browser' });
  assert.equal(found.details.mode, 'exact');
  assert.deepEqual(found.details.suggestions, [{ ...catalog[1], confidence: null }]);
  assert.deepEqual(s.calls[1].candidates, ['mcp__browser__open', 'mcp__browser__hidden']);
  // The native search, not our wrapper, filters hidden exposure.
  s.setTools([]); assert.equal((await s.search()).details.total, 0);
});
test('exact deferred non-MCP tool bypasses routing; active tools are reported', async () => {
  const s = setup({ tools: [...tools, { name: 'notify', exposure: 'deferred' }] }); await s.prompt();
  const found = await s.search({ query: 'notify' });
  assert.equal(found.details.mode, 'exact');
  assert.deepEqual(s.calls[1].candidates, ['notify']);
  s.pi.setActiveTools(['read', 'tool_search', 'mcp__browser__open']);
  const again = await s.search({ query: 'mcp__browser' });
  assert.deepEqual(again.details.availableTools, ['mcp__browser__open']);
});
test('semantic recommendations and native scoped loading happen in the same call', async t => {
  let finish;
  const s = setup({ tools, skills: [{ ...catalog[0], filePath: catalog[0].path }] }); await s.prompt();
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finish = resolve; }));
  const pending = s.search({ query: '检查代码和页面', limit: 2 }, { modelRegistry: registry });
  await new Promise(resolve => setImmediate(resolve));
  await s.prompt([]);
  finish(reply({ suggestions }));
  const found = await pending;
  assert.equal(found.details.total, 2);
  assert.equal(found.details.mode, 'semantic');
  assert.deepEqual(found.details.suggestions, [{ ...catalog[1], confidence: 0.9 }, { ...catalog[0], confidence: 0.7 }]);
  assert.deepEqual(s.calls[2].args, { query: 'mcp__browser 检查代码和页面', limit: 2 });
  assert.match(found.details.hint, /not calibrated/);
});

const deferredTools = [
  { name: 'subagent_start', description: '创建独立子会话，委派任务并指定模型', exposure: 'deferred' },
  { name: 'notify', description: '仅当用户明确要求时发送通知', exposure: 'deferred' },
  { name: 'script_helper', description: 'Script helper', exposure: 'codemode', namespace: { name: 'helpers' } },
  { name: 'secret', description: 'Hidden helper', exposure: 'hidden' },
  { name: 'read', description: 'Read files', exposure: 'direct' },
];
test('non-MCP searchable tools appear in directory/list/exact results, even after activation', async () => {
  const s = setup({ tools: [...tools, ...deferredTools] });
  const options = await s.prompt();
  assert.match(options.sections.available_capabilities, /Deferred tools\n/);
  assert.match(options.sections.available_capabilities, /Deferred tools\n- notify\n- script_helper\n- subagent_start/);
  assert.doesNotMatch(options.sections.available_capabilities, /创建独立子会话|仅当用户明确要求|Script helper/);
  assert.doesNotMatch(options.sections.available_capabilities, /secret|Read files/);
  const list = (await s.search({ query: '*', limit: 100 })).details;
  assert.deepEqual(list.suggestions.map(c => c.name), ['mcp__browser', 'notify', 'script_helper', 'subagent_start']);
  assert.equal(s.calls.length, 1, 'listing must not load anything');
  for (const query of ['notify', 'TOOL:NOTIFY']) {
    const found = (await s.search({ query })).details;
    assert.equal(found.total, 1);
    assert.equal(found.suggestions[0].type, 'tool');
    assert.deepEqual(s.calls.at(-1).candidates, ['notify']);
  }
  s.pi.setActiveTools(['notify']);
  assert.deepEqual((await s.search({ query: 'notify' })).details.availableTools, ['notify']);
  assert.equal((await s.search({ query: '*', limit: 100 })).details.total, 4);
  s.setTools([]);
  assert.equal((await s.search()).details.total, 0);
});
test('Skill recommendations no longer exclude deferred tools from semantic loading', async t => {
  const s = setup({ tools: [...tools, ...deferredTools], skills: [{ ...catalog[0], filePath: catalog[0].path }] });
  await s.prompt();
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).response_format.json_schema.schema.properties.suggestions.items.properties.id.enum, undefined);
    const ids = JSON.parse(options.body).messages.map(m => m.content).join('\n');
    assert.ok(ids.includes('tool:subagent_start'));
    assert.ok(ids.includes('tool:notify'));
    assert.ok(ids.includes('tool:script_helper'));
    assert.ok(!ids.includes('tool:secret'));
    return reply({ suggestions: [
      { id: 'skill:engineering-practice', confidence: 0.95 },
      { id: 'tool:subagent_start', confidence: 0.9 },
      { id: 'tool:notify', confidence: 0.8 },
      { id: 'mcp:mcp__browser', confidence: 0.7 },
    ] });
  });
  {
    const result = await s.tool.execute('test', { query: '委派 GLM 检查网页代码，完成后通知我' }, undefined, undefined, { modelRegistry: registry });
    assert.equal(result.details.total, 4);
    assert.deepEqual(s.calls.at(-1).candidates, ['mcp__browser__open', 'mcp__browser__hidden', 'subagent_start', 'notify']);
    assert.match(s.calls.at(-1).args.query, /subagent_start notify/);
  }
});

test('search thinking follows settings independently, with model effort mapping and no tool parameter', async t => {
  const settings = { capabilityDiscovery: { autoRecommendThinkingLevel: 'off', toolSearchThinkingLevel: 'high' } };
  const s = setup({ skills: [{ name: 'code', description: 'Implement code', filePath: '/test/SKILL.md' }], settings });
  await s.prompt();
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    bodies.push(JSON.parse(options.body)); return reply({ suggestions: [] });
  });
  const mapped = { ...registry, find: (...args) => ({ ...registry.find(...args), thinkingLevelMap: { high: 'xhigh' } }) };
  await s.search({ query: 'implement' }, { modelRegistry: mapped });
  assert.deepEqual(bodies.at(-1).chat_template_kwargs, { enable_thinking: true, reasoning_effort: 'xhigh' });
  settings.capabilityDiscovery.toolSearchThinkingLevel = 'off';
  settings.capabilityDiscovery.autoRecommendThinkingLevel = 'high';
  await s.search({ query: 'implement' }, { modelRegistry: mapped });
  assert.deepEqual(bodies.at(-1).chat_template_kwargs, { enable_thinking: false, reasoning_effort: 'none' });
  assert.deepEqual(Object.keys(s.tool.parameters.properties).sort(), ['limit', 'query']);
  settings.capabilityDiscovery.toolSearchThinkingLevel = 'typo';
  const bad = await s.search({ query: 'implement' }, { modelRegistry: mapped });
  assert.match(bad.details.routingError, /toolSearchThinkingLevel/);
  assert.equal(bodies.length, 2);
});

test('configured provider/model and empty catalog schema', async t => {
  const custom = { ...registry, find: (provider, id) => {
    assert.equal(provider, 'custom'); assert.equal(id, 'small');
    return { id, api: 'openai-completions', baseUrl: 'http://localhost/v1' };
  } };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'small');
    const schema = body.response_format.json_schema.schema;
    assert.equal(schema.properties.suggestions.maxItems, undefined);
    assert.doesNotMatch(JSON.stringify(schema), /"enum":\[\]/);
    return reply({ suggestions: [] });
  });
  assert.deepEqual(await routeCapabilities('task', [], custom, undefined, 'medium', { provider: 'custom', model: 'small' }), []);
});

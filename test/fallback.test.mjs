import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setup } from './helpers.mjs';
import { registerDiscovery } from '../discovery.js';
import { runPrefetch } from '../prefetch.js';

const cwd = mkdtempSync(path.join(tmpdir(), 'discovery-fallback-'));
after(() => rmSync(cwd, { recursive: true, force: true }));
const skills = Array.from({ length: 10 }, (_, i) => ({ name: `skill-${i}`, description: 'Method', filePath: path.join(cwd, `${i}.md`) }));
const tools = [
  { name: 'mcp__browser__open', exposure: 'deferred', namespace: { name: 'mcp__browser', description: 'Browse' } },
  { name: 'delegate', exposure: 'deferred' }, { name: 'notify', exposure: 'codemode' },
  { name: 'secret', exposure: 'hidden' },
];
const model = { id: 'iq3', api: 'openai-completions', baseUrl: 'http://fixture.invalid/v1' };
const registry = { find: () => model, getApiKeyAndHeaders: async () => ({ ok: true }) };
const reply = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] }));
function full(result, count) {
  assert.equal(result.fallback, 'full-catalog');
  assert.equal(result.suggestions.length, count);
  assert.ok(result.routingError);
  assert.ok(result.suggestions.every(s => s.confidence === null));
  assert.match(result.hint, /unranked/i);
}

test('429 fallback and list are full, trusted, directory-only, with pending namespaces', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('SECRET BODY', { status: 429 }); });
  const sections = { mcp_servers: '- mcp__browser: Browse\n- mcp__pending: Connecting' };
  const s = setup({ skills: [...skills, { ...skills[0], name: 'disabled', disableModelInvocation: true }], tools, sections });
  await s.prompt();
  const active = s.pi.getActiveTools();
  const result = await s.search({ query: 'help with task', limit: 1 }, { modelRegistry: registry });
  full(result.details, 14);
  assert.equal(result.details.total, 14);
  assert.equal(result.details.mode, 'semantic');
  assert.notEqual(result.isError, true);
  assert.match(result.details.routingError, /HTTP 429/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET BODY|disabled|secret/);
  assert.equal(result.details.suggestions.find(c => c.name === 'skill-0').path, skills[0].filePath);
  assert.deepEqual(result.details.loaded, []);
  assert.deepEqual(s.pi.getActiveTools(), active);
  assert.equal(s.calls.length, 1, 'no native search');
  const list = (await s.search({ query: '*', limit: 1 })).details;
  assert.equal(list.total, 14); assert.equal(list.suggestions.length, 14);
  assert.equal(list.fallback, undefined); assert.equal(requests, 1);
  sections.mcp_servers = '';
  s.setTools([]); await s.prompt([]);
  assert.equal((await s.search()).details.total, 0, 'pending catalog is refreshed, not accumulated');
});

test('discovery failures fall back once; legitimate empty and successful ranking retain their semantics', async t => {
  const s = setup({ skills, tools }); await s.prompt();
  let requests = 0, respond;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return respond(); });
  for (const [label, response] of [
    ['network', () => { throw new Error('offline'); }],
    ['json', () => reply('SECRET INVALID JSON')],
    ['shape', () => reply({ suggestions: {} })],
    ['id', () => reply({ suggestions: [{ id: 'invented', confidence: 1 }] })],
    ['score', () => reply({ suggestions: [{ id: 'skill:skill-0', confidence: 2 }] })],
  ]) {
    respond = response; const before = requests;
    full((await s.search({ query: label, limit: 1 }, { modelRegistry: registry })).details, 13);
    assert.equal(requests, before + 1);
  }
  for (const modelRegistry of [{ find: () => undefined }, { ...registry, getApiKeyAndHeaders: async () => ({ ok: false }) }]) {
    const before = requests;
    full((await s.search({ query: 'task' }, { modelRegistry })).details, 13);
    assert.equal(requests, before);
  }
  respond = () => reply({ suggestions: [] });
  const empty = (await s.search({ query: 'unrelated' }, { modelRegistry: registry })).details;
  assert.equal(empty.fallback, undefined); assert.equal(empty.routingError, undefined);
  assert.deepEqual(empty.suggestions, []);
  assert.equal(s.calls.length, 2, 'only legitimate no-match uses native search');
  respond = () => reply({ suggestions: [{ id: 'skill:skill-0', confidence: 0 }, { id: 'skill:skill-1', confidence: 0.9 }] });
  const normal = (await s.search({ query: 'rank', limit: 1 }, { modelRegistry: registry })).details;
  assert.equal(normal.suggestions.length, 1); assert.equal(normal.suggestions[0].name, 'skill-1');
  assert.equal(normal.fallback, undefined);
});

test('search internal timeout falls back, caller abort propagates without loading', async t => {
  const s = setup({ skills, tools }); await s.prompt();
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, options) => { controller.abort(); options.signal.throwIfAborted(); });
  await assert.rejects(s.tool.execute('id', { query: 'task' }, controller.signal, undefined, { modelRegistry: registry }), { name: 'AbortError' });
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new DOMException('deadline', 'TimeoutError')));
  full((await s.search({ query: 'task' }, { modelRegistry: registry })).details, 13);
  assert.equal(s.calls.length, 1);
});

// In-memory SDK seam exercises runPrefetch + requestModel + host dispatch without
// real providers or shell commands. Existing SDK tests cover the real adapter.
function predictionSdk(getValue) {
  let requests = 0, actions = 0;
  const sdk = {
    SessionManager: { create: () => {
      const entries = [];
      return { getCwd: () => cwd, getSessionId: () => 'child', getSessionFile: () => '/fixture/child.jsonl',
        appendSessionInfo() {}, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
        appendMessage: message => entries.push({ type: 'message', message }), getBranch: () => entries };
    } },
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class { async reload() {} },
    ModelRuntime: { create: async () => ({}) }, getAgentDir: () => cwd,
    createAgentSession: async ({ sessionManager }) => {
      const session = { agent: {}, messages: [], bindExtensions: async () => {}, abort: async () => {}, dispose() {},
        prompt: async input => {
          sessionManager.appendMessage({ role: 'user', content: input });
          await session.agent.streamFunction(model, {}, {});
          const value = await getValue();
          session.messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
        } };
      return { session };
    },
    createBashToolDefinition: () => ({ execute: async () => { actions++; return { isError: true, content: [{ type: 'text', text: 'fixture action failure' }] }; } }),
  };
  return { sdk, registry: { ...registry, streamSimple: async () => { requests++; } }, counts: () => ({ requests, actions }) };
}
const catalog = [{ type: 'skill', name: 'skill-0', path: skills[0].filePath, description: 'Method' }, { type: 'tool', name: 'delegate' }];
const valid = { id: 'skill:skill-0', confidence: 0.5 };
const action = { tool: 'bash', arguments: { command: 'fixture only' } };

test('prefetch distinguishes invalid, empty, partial, disabled and action failures', async () => {
  let value;
  const f = predictionSdk(() => { if (value instanceof Error) throw value; return value; });
  const args = { sdk: f.sdk, query: 'task', catalog, ctx: { cwd, modelRegistry: f.registry, sessionManager: {} }, options: { capabilityPrediction: true, actionPrediction: true } };
  for (value of [new Error('HTTP 429'), 'SECRET INVALID JSON', null, {}, { suggestions: {} }, { suggestions: [{ id: 'unknown', confidence: 1 }] }]) {
    const before = f.counts();
    const out = await runPrefetch(args);
    full(out, 2);
    assert.equal(f.counts().requests, before.requests + 1);
    assert.equal(f.counts().actions, before.actions);
    assert.equal(out.prefetch.rounds.length, 0);
    assert.doesNotMatch(out.routingError, /SECRET INVALID JSON/);
  }
  for (value of [{ suggestions: [], actions: [] }, { suggestions: [valid, { id: 'unknown', confidence: 1 }], actions: [] }]) {
    const out = await runPrefetch(args);
    assert.equal(out.fallback, undefined); assert.equal(out.routingError, undefined);
    assert.equal(out.suggestions.length, value.suggestions.length ? 1 : 0);
  }
  value = { suggestions: [valid], actions: [action] };
  const actionError = await runPrefetch(args);
  assert.equal(actionError.fallback, undefined);
  assert.equal(actionError.prefetch.rounds[0].messages[1].isError, true);
  value = { suggestions: [{ id: 'unknown', confidence: 1 }], actions: [action] };
  const partial = await runPrefetch(args);
  full(partial, 2); assert.equal(partial.prefetch.rounds.length, 1, 'existing valid action evidence retained');
  value = new Error('HTTP 429');
  const disabled = await runPrefetch({ ...args, options: { actionPrediction: true } });
  assert.equal(disabled.fallback, undefined); assert.deepEqual(disabled.suggestions, []);
  const cancelled = await runPrefetch({ ...args, signal: AbortSignal.abort() });
  assert.equal(cancelled.fallback, undefined);
});

function context(registryOverride = registry) {
  let id = 'parent';
  const entries = [], notices = [];
  return { entries, notices, switchSession: () => { id = 'new'; }, cwd, modelRegistry: registryOverride,
    sessionManager: { getSessionId: () => id, getBranch: () => entries }, ui: { notify: text => notices.push(text) } };
}
async function start(s, ctx, nextSkills = skills) {
  await s.handlers.before_agent_start({ prompt: 'task', systemPromptOptions: { skills: [...nextSkills], sections: {} } }, ctx);
}
function carrier(result) { return result.messages.find(m => m.customType === 'capability-prefetch'); }

test('outer setup failure delivers full fallback including empty catalog, only when capability prediction enabled', async () => {
  for (const nextSkills of [skills, []]) {
    const s = setup({ settings: { capabilityDiscovery: { recommendation: { capabilityPrediction: true } } } });
    const ctx = context(); await start(s, ctx, nextSkills);
    const message = carrier(await s.handlers.context({ messages: [] }, ctx));
    assert.ok(message);
    full(message.details, nextSkills.length);
    assert.match(message.content, /full-catalog/); assert.match(message.content, /SDK/);
    assert.equal(s.sent.length, 1);
    await s.handlers.context({ messages: [] }, ctx); assert.equal(s.sent.length, 1);
  }
  for (const options of [{}, { actionPrediction: true }]) {
    const s = setup({ settings: { capabilityDiscovery: { recommendation: options } } });
    const ctx = context(); await start(s, ctx);
    assert.equal(carrier(await s.handlers.context({ messages: [] }, ctx)), undefined);
  }
});

test('full preparation path delivers routing errors to content and details without extra actions', async () => {
  const f = predictionSdk(() => { throw new Error('HTTP 429'); });
  const s = setup({ sdk: f.sdk, tools, settings: { capabilityDiscovery: { recommendation: { capabilityPrediction: true } } } });
  const ctx = context(f.registry); await start(s, ctx);
  const result = await s.handlers.context({ messages: [] }, ctx);
  const message = carrier(result);
  full(message.details, 13);
  assert.match(message.content, /HTTP 429/);
  assert.deepEqual(f.counts(), { requests: 1, actions: 0 });
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.sent[0].message, message);
  ctx.entries.push({ type: 'custom_message', customType: message.customType, details: message.details });
  assert.deepEqual((await s.handlers.context({ messages: [] }, ctx)).messages, [], 'removed context does not resurrect fallback');
});

test('preparation internal deadline falls back but cancellation and invalidation suppress late fallback', async t => {
  const register = predict => (pi, deps) => registerDiscovery(pi, { ...deps, sdk: {}, predict });
  const timed = setup({ settings: { capabilityDiscovery: { recommendation: { capabilityPrediction: true } } }, register: register(async ({ signal }) => { signal.throwIfAborted(); }) });
  const ctx = context(); await start(timed, ctx);
  t.mock.method(AbortSignal, 'timeout', () => AbortSignal.abort(new DOMException('deadline', 'TimeoutError')));
  const timedMessage = carrier(await timed.handlers.context({ messages: [] }, ctx));
  full(timedMessage.details, 10); assert.match(timedMessage.details.routingError, /deadline|timeout/i);
  t.mock.restoreAll();
  for (const invalidate of ['caller', 'session_switch', 'agent_end', 'new-input']) {
    let finish, began;
    const started = new Promise(resolve => { began = resolve; });
    const s = setup({ settings: { capabilityDiscovery: { recommendation: { capabilityPrediction: true } } }, register: register(async () => {
      began(); await new Promise(resolve => { finish = resolve; }); throw new Error('HTTP 429');
    }) });
    const current = context(), controller = new AbortController(); current.signal = controller.signal;
    await start(s, current);
    const pending = s.handlers.context({ messages: [] }, current); await started;
    if (invalidate === 'caller') controller.abort();
    else if (invalidate === 'new-input') await start(s, current);
    else { if (invalidate === 'session_switch') current.switchSession(); s.handlers[invalidate]({}, current); }
    finish();
    assert.equal(carrier(await pending), undefined, invalidate);
    assert.equal(s.sent.length, 0, invalidate);
  }
});

test('model initialization and historical context failures also deliver fallback without a model request', async () => {
  const f = predictionSdk(() => ({ suggestions: [] }));
  for (const failure of ['model', 'history']) {
    const s = setup({ sdk: f.sdk, settings: { capabilityDiscovery: { recommendation: { capabilityPrediction: true } } } });
    const ctx = context(failure === 'model' ? { find: () => undefined } : f.registry);
    if (failure === 'history') ctx.entries.push({ type: 'message', message: { role: 'user', content: 'history' } });
    await start(s, ctx);
    const message = carrier(await s.handlers.context({ messages: [] }, ctx));
    full(message.details, 10);
    assert.match(message.details.routingError, failure === 'model' ? /not configured/ : /persisted session file/);
  }
  assert.deepEqual(f.counts(), { requests: 0, actions: 0 });
});

test('in-flight preparation deadline delivers fallback, not cancellation silence', async t => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  const f = predictionSdk(() => {
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    return { suggestions: [] };
  });
  const s = setup({ sdk: f.sdk, settings: { capabilityDiscovery: { recommendation: { capabilityPrediction: true } } } });
  const ctx = context(f.registry); await start(s, ctx);
  const message = carrier(await s.handlers.context({ messages: [] }, ctx));
  full(message.details, 10);
  assert.match(message.details.routingError, /deadline/);
  assert.deepEqual(f.counts(), { requests: 1, actions: 0 });
});

test('valid empty predictions and action-only failures do not inject a fallback directory', async () => {
  let value = { suggestions: [] };
  const f = predictionSdk(() => value);
  const s = setup({ sdk: f.sdk, settings: { capabilityDiscovery: { recommendation: { capabilityPrediction: true, actionPrediction: true } } } });
  const ctx = context(f.registry); await start(s, ctx);
  assert.equal(carrier(await s.handlers.context({ messages: [] }, ctx)), undefined);
  value = { suggestions: [valid], actions: [action] };
  await start(s, ctx);
  const message = carrier(await s.handlers.context({ messages: [] }, ctx));
  assert.equal(message.details.fallback, undefined);
  assert.equal(message.details.suggestions.length, 1);
  assert.equal(message.details.prefetch.rounds[0].messages[1].isError, true);
  assert.doesNotMatch(message.content, /full-catalog|routingError/);
});

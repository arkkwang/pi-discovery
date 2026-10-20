import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendationQuery, registerDiscovery } from '../discovery.js';
import { setup } from './helpers.mjs';
import { snapPath, snapCliMissing, sessionFixture } from './snap-fixture.mjs';
const entry = (role, content) => ({ type: 'message', message: { role, content } });
const skill = { name: 'engineering', description: 'Implement code', filePath: '/example/SKILL.md' };
const registry = {
  find: () => ({ id: 'iq3', api: 'openai-completions', baseUrl: 'http://localhost/v1' }),
  getApiKeyAndHeaders: async () => ({ ok: true }),
};
function context(branch = []) {
  const notices = [];
  return { notices, sessionManager: { getSessionId: () => 'parent-session-1', getBranch: () => branch }, modelRegistry: registry,
    ui: { notify: (...args) => notices.push(args) } };
}
async function before(s, ctx, prompt = '继续修改', images) {
  const options = { skills: [skill], sections: {} };
  const output = await s.handlers.before_agent_start({ prompt, images, systemPromptOptions: options }, ctx);
  await s.handlers.context({ messages: [] }, ctx);
  return { output, options };
}
test('context budget keeps current request and recent output, marks omissions', { skip: snapCliMissing }, async t => {
  await snapPath(t.after.bind(t));
  const sm = await sessionFixture(t.after.bind(t), [entry('user', 'OLDER'), entry('assistant', 'RECENT HEAD' + 'y'.repeat(20000) + 'RECENT TAIL')]);
  const q = await recommendationQuery('CURRENT HEAD' + 'x'.repeat(20000) + 'CURRENT TAIL', sm);
  assert.ok(q.length < 10300);
  for (const text of ['CURRENT HEAD', 'CURRENT TAIL', 'RECENT TAIL', 'characters omitted']) assert.ok(q.includes(text));
  assert.doesNotMatch(q, /OLDER/);
});
test('configured timeoutMs bounds the preparation boundary, its diagnostics and outcome record the failure', async t => {
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return AbortSignal.abort(new DOMException('budget', 'TimeoutError')); });
  const predict = async ({ signal }) => new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason));
  });
  const s = setup({ sdk: {}, settings: { capabilityDiscovery: { recommendation: { enabled: true, timeoutMs: 5_000 } } },
    register: (pi, deps) => registerDiscovery(pi, { ...deps, predict }) });
  const ctx = context();
  await before(s, ctx);
  assert.deepEqual(timeouts, [5_000], 'the configured budget reaches AbortSignal.timeout');
  assert.equal(s.diagnostics.find(e => e.data.event === 'start').data.budgetMs, 5_000);
  assert.equal(s.diagnostics.find(e => e.data.event === 'failure').data.cause, 'deadline');
  const outcome = s.diagnostics.find(e => e.type === 'capability-recommendation-outcome');
  assert.equal(outcome.data.trigger, 'user-input');
  assert.equal(outcome.data.outcome, 'timeout');
  assert.equal(outcome.data.failure, 'timeout');
  assert.match(outcome.data.error, /budget/);
});

test('successful preparation records outcome, suggestions and child pointer in the parent log', async () => {
  const predict = async () => ({ suggestions: [{ type: 'skill', name: 'demo', confidence: 1 }],
    prefetch: { version: 2, requests: 1, reads: 0, rounds: [] },
    diagnostics: { endReason: 'no-actions-needed', requests: 1, inferenceMs: 5,
      discoverySessionId: 'child-1', discoverySessionFile: '/tmp/child.jsonl' } });
  const s = setup({ sdk: {}, settings: { capabilityDiscovery: { recommendation: { enabled: true } } },
    register: (pi, deps) => registerDiscovery(pi, { ...deps, predict }) });
  const ctx = context();
  await before(s, ctx);
  const outcome = s.diagnostics.find(e => e.type === 'capability-recommendation-outcome');
  assert.equal(outcome.data.outcome, 'no-actions-needed');
  assert.equal(outcome.data.suggestionCount, 1);
  assert.deepEqual(outcome.data.suggestions, ['skill:demo']);
  assert.equal(outcome.data.discoverySessionId, 'child-1');
  assert.equal(outcome.data.parentSessionId, 'parent-session-1',
    'parent outcome entry names its own session');
  assert.equal(outcome.data.failure, undefined);
});

test('periodic review records a consolidated outcome entry with its warnings', async () => {
  const review = async () => ({ warnings: [['drift observed', 'source: rule']],
    diagnostics: { requests: 1, inferenceMs: 7, discoverySessionId: 'rev-1', discoverySessionFile: '/tmp/rev.jsonl' } });
  const s = setup({ sdk: {}, settings: { capabilityDiscovery: { trajectory: { model: 'llama/iq3', enabled: true, everySteps: 1 } } },
    register: (pi, deps) => registerDiscovery(pi, { ...deps, review }) });
  const ctx = context();
  const output = await s.handlers.turn_end({}, ctx);
  assert.match(output.entries[0].content, /drift observed/);
  const outcome = s.diagnostics.find(e => e.type === 'capability-trajectory-outcome');
  assert.equal(outcome.data.trigger, 'periodic');
  assert.equal(outcome.data.outcome, 'warnings');
  assert.equal(outcome.data.warningCount, 1);
  assert.deepEqual(outcome.data.warnings, [['drift observed', 'source: rule']]);
  assert.equal(outcome.data.discoverySessionId, 'rev-1');
});

test('default off performs no context read, model request or extra MCP wait', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected fetch'));
  const s = setup(); const ctx = context(); ctx.sessionManager.getBranch = () => assert.fail('unexpected context read');
  const { output } = await before(s, ctx);
  assert.equal(output, undefined); assert.deepEqual(s.calls, ['mcp-prompt']);
});
test('invalid legacy configuration is rejected without a model call or MCP wait', async () => {
  const s = setup({ settings: { capabilityDiscovery: { autoRecommend: true, prefetch: { maxSuggestedActions: 3 } } } });
  const ctx = context();
  assert.equal((await before(s, ctx)).output, undefined);
  assert.match(ctx.notices[0][0], /accepts only/);
  assert.deepEqual(s.calls, ['mcp-prompt']);
});
test('enabled preparation setup failure does not block the user and omits sensitive diagnostics', async () => {
  const s = setup({ settings: { capabilityDiscovery: { recommendation: { enabled: true } } } });
  const ctx = context();
  assert.equal((await before(s, ctx, 'SECRET PROMPT')).output, undefined);
  assert.equal(ctx.notices.length, 1);
  const failure = s.diagnostics.find(e => e.data.event === 'failure').data;
  assert.equal(failure.cause, 'error');
  assert.equal(failure.error, 'Pi SDK prediction adapter is unavailable');
  assert.equal(s.diagnostics.at(-1).data.delivery, 'direct');
  assert.equal(s.sent[0].message.details.fallback, 'full-catalog');
  assert.match(s.sent[0].message.content, /SDK prediction adapter is unavailable/);
  assert.doesNotMatch(JSON.stringify(s.diagnostics), /SECRET/);
  assert.deepEqual(s.calls, ['mcp-prompt']);
  const cancelled = context(); cancelled.signal = AbortSignal.abort();
  await before(s, cancelled);
  // Input decisions remain visible, but cancellation prevents dispatch.
  assert.equal(s.diagnostics.filter(e => e.data.event === 'start').length, 1);
  assert.equal(s.diagnostics.at(-1).data.event, 'input');
  assert.equal(cancelled.notices.length, 0);
  s.pi.appendEntry = () => { throw new Error('disk unavailable'); };
  assert.equal((await before(s, ctx)).output, undefined);
});
test('image-only input retains placeholders without transmitting image data', async () => {
  const q = await recommendationQuery('', { getBranch: () => [] }, [{ type: 'image', data: 'SECRET' }]);
  assert.match(q, /\[image\]/);
  assert.doesNotMatch(q, /SECRET/);
});

test('discovery takeover off keeps native tool_search and the native prompt, prediction still runs', async () => {
  let predicted = 0;
  const predict = async () => { predicted++;
    return { suggestions: [], prefetch: { version: 2, requests: 1, reads: 0, rounds: [] }, diagnostics: {} }; };
  const s = setup({
    sdk: {},
    settings: { capabilityDiscovery: { toolSearch: { enabled: false }, recommendation: { enabled: true } } },
    sections: { mcp_servers: '- mcp__exa: web search (tool_search): find their tools with searchTools()' },
    register: (pi, deps) => registerDiscovery(pi, { ...deps, predict }) });
  const options = { skills: [skill], sections: {} };
  await s.handlers.before_agent_start({ prompt: 'task', systemPromptOptions: options }, context());
  await s.handlers.context({ messages: [] }, context());
  assert.ok(s.tool, 'entry delegates to native search when disabled');
  await s.search({ query: 'native task' });
  assert.deepEqual(s.calls.at(-1).args, { query: 'native task' });
  assert.equal(options.skills.length, 1, 'native Skill directory survives');
  assert.match(options.sections.mcp_servers, /mcp__exa/);
  assert.equal(options.sections.available_capabilities, undefined);
  assert.equal(predicted, 1, 'preparation is independent of takeover');
  assert.equal(s.diagnostics.find(e => e.data.event === 'input').data.preparation, 'scheduled');
});

test('recommendation master switch disables preparation without touching takeover', async () => {
  let predicted = 0;
  const predict = async () => { predicted++;
    return { suggestions: [], prefetch: { version: 2, requests: 1, reads: 0, rounds: [] }, diagnostics: {} }; };
  const s = setup({
    settings: { capabilityDiscovery: { recommendation: { enabled: false, actionPrediction: true } } },
    register: (pi, deps) => registerDiscovery(pi, { ...deps, predict }) });
  const options = { skills: [skill], sections: {} };
  await s.handlers.before_agent_start({ prompt: 'task', systemPromptOptions: options }, context());
  await s.handlers.context({ messages: [] }, context());
  assert.equal(predicted, 0);
  assert.equal(s.diagnostics.find(e => e.data.event === 'input').data.preparation, 'disabled');
  assert.notEqual(s.tool, undefined, 'takeover is unaffected');
  assert.equal(options.skills.length, 0);
  assert.match(options.sections.available_capabilities, /统一发现入口/);
});


test('all groups off and invalid settings preserve native prompt and pass native calls through', async () => {
  const settings = { capabilityDiscovery: { toolSearch: { enabled: false },
    recommendation: { enabled: false, actionPrediction: true }, trajectory: { enabled: false } } };
  const nativeResult = { content: [{ type: 'text', text: 'native result' }], details: { loaded: [] } };
  let called;
  const s = setup({ settings, nativeExecute: async (...args) => { called = args; return nativeResult; } });
  for (const config of [settings.capabilityDiscovery, { recommendation: { capabilityPrediction: true } }]) {
    settings.capabilityDiscovery = config;
    const options = { skills: [skill], sections: { keep: 'original' } };
    const ctx = context();
    await s.handlers.before_agent_start({ prompt: 'task', systemPromptOptions: options }, ctx);
    await s.handlers.context({ messages: [] }, ctx);
    await s.handlers.turn_end({}, ctx);
    assert.deepEqual(options, { skills: [skill], sections: { keep: 'original' } });
    const args = { query: 'native search', limit: 2 }, signal = new AbortController().signal;
    const update = () => {};
    assert.equal(await s.tool.execute('id', args, signal, update, ctx), nativeResult);
    assert.deepEqual(called, ['id', args, signal, update, ctx]);
    assert.equal(s.sent.length, 0);
  }
  // The same registered entry can enable smart discovery once settings are valid.
  settings.capabilityDiscovery = { toolSearch: { enabled: true } };
  const options = { skills: [skill], sections: {} };
  await s.handlers.before_agent_start({ prompt: 'task', systemPromptOptions: options }, context());
  assert.equal(options.skills.length, 0);
  assert.match(options.sections.available_capabilities, /统一发现入口/);
});

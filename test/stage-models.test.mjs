import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { setup } from './helpers.mjs';

import { recommendationOptions, discoveryOptions, toolSearchOptions, trajectoryOptions, parseModel, cwdKey, cwdDisabled } from '../config.js';

const cwd = mkdtempSync(path.join(tmpdir(), 'discovery-stages-'));
after(() => rmSync(cwd, { recursive: true, force: true }));
const config = {
  toolSearch: { model: 'search-provider/router', thinkingLevel: 'high' },
  recommendation: { enabled: true, model: 'catalog-provider/vendor/recommender', thinkingLevel: 'low' },
  trajectory: { model: 'review-provider/reviewer', enabled: true, everySteps: 1, thinkingLevel: 'off' },
};

function fixture(value = config) {
  const selected = [], names = [], requests = [], diagnostics = [];
  const registry = {
    find: (provider, id) => ({ provider, id, api: 'openai-completions', baseUrl: `http://${provider}.invalid/v1` }),
    getApiKeyAndHeaders: async () => ({ ok: true }),
    streamSimple: async model => { requests.push(`${model.provider}/${model.id}`); },
  };
  const sdk = {
    SessionManager: { create: () => {
      const entries = [];
      return { getCwd: () => cwd, getSessionId: () => 'child', getSessionFile: () => '/fixture/child.jsonl',
        appendSessionInfo: name => names.push(name), getBranch: () => entries,
        appendCustomEntry: (type, data) => diagnostics.push({ type, data }),
        appendMessage: message => entries.push({ type: 'message', message }) };
    } },
    SettingsManager: { inMemory: () => ({}) }, DefaultResourceLoader: class { async reload() {} },
    ModelRuntime: { create: async () => ({}) }, getAgentDir: () => cwd,
    createAgentSession: async ({ model, thinkingLevel, sessionManager }) => {
      selected.push({ model: `${model.provider}/${model.id}`, thinkingLevel });
      const session = { agent: {}, messages: [], bindExtensions: async () => {}, abort: async () => {}, dispose() {},
        prompt: async input => {
          sessionManager.appendMessage({ role: 'user', content: input });
          await session.agent.streamFunction(model, {}, {});
          const value = model.provider === 'review-provider' ? [] : { suggestions: [{ type: 'skill', name: 'method', confidence: 1 }] };
          session.messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(value) }] });
        } };
      return { session };
    },
  };
  const s = setup({ sdk, settings: { capabilityDiscovery: value } });
  const ctx = { cwd, modelRegistry: registry, sessionManager: { getBranch: () => [], getSessionId: () => 'parent' }, ui: { notify() {} } };
  const input = () => s.handlers.before_agent_start({ prompt: 'task', systemPromptOptions: {
    skills: [{ name: 'method', description: 'Method', filePath: path.join(cwd, 'SKILL.md') }], sections: {} } }, ctx);
  return { s, ctx, input, selected, requests, names, diagnostics };
}

test('grouped stages select independent models/thinking; manual search uses its own model', async t => {
  const f = fixture(); await f.input();
  const out = await f.s.handlers.context({ messages: [] }, f.ctx);
  assert.equal(out.messages[0]?.details.suggestions[0]?.confidence, 1, 'normal prediction, not fallback');
  await f.s.handlers.turn_end({}, f.ctx);
  assert.deepEqual(f.selected, [
    { model: config.recommendation.model, thinkingLevel: 'low' },
    { model: config.trajectory.model, thinkingLevel: 'off' },
  ]);
  assert.deepEqual(f.requests, [config.recommendation.model, config.trajectory.model]);
  assert.match(f.names[0], /preparation · catalog-provider\/vendor\/recommender/);
  assert.match(f.names[1], /trajectory · review-provider\/reviewer/);
  const starts = f.s.diagnostics.filter(e => e.data.event === 'start').map(e => e.data);
  assert.equal(starts[0].configuredOptions.trajectory.model, config.trajectory.model);
  assert.equal(starts[0].effectiveOptions.model, config.recommendation.model);
  assert.equal(starts[1].effectiveOptions.model, config.trajectory.model);
  let searches = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    searches++; assert.equal(url, 'http://search-provider.invalid/v1/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'router');
    assert.equal(body.chat_template_kwargs.reasoning_effort, 'high');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"suggestions":[]}' } }] }));
  });
  const searched = await f.s.search({ query: 'semantic task' }, f.ctx);
  assert.equal(searched.details.routingError, undefined); assert.equal(searches, 1);
});

test('recommendation config has a provider/model reference and no trajectory controls', () => {
  assert.equal(recommendationOptions().model, 'llama/iq3');
  assert.equal(recommendationOptions({ model: 'p/vendor/model', thinkingLevel: 'low' }).thinkingLevel, 'low');
  for (const value of ['', 'model-only', '/model', 'provider/', 'provider/ model', null, 42, { provider: 'p', model: 'm' }]) {
    assert.throws(() => recommendationOptions({ model: value }), /model/);
  }
  for (const value of [{ provider: 'p', model: 'm' }, { trajectoryWarnings: true }, { autoRecommendThinkingLevel: 'low' }]) {
    assert.throws(() => recommendationOptions(value), /accepts only/);
  }
});

test('review-only setup does not run preparation; recommendation-only setup does not run review', async () => {
  for (const value of [{ trajectory: config.trajectory }, { recommendation: config.recommendation }]) {
    const f = fixture(value); await f.input();
    await f.s.handlers.context({ messages: [] }, f.ctx);
    await f.s.handlers.turn_end({}, f.ctx);
    assert.deepEqual(f.requests, [value.trajectory ? config.trajectory.model : config.recommendation.model]);
  }
});

test('three root groups; defaults and every nested key are validated independently', () => {
  const defaults = discoveryOptions();
  assert.deepEqual(Object.keys(defaults), ['toolSearch', 'recommendation', 'trajectory']);
  assert.deepEqual(defaults.toolSearch, { enabled: true, model: 'llama/iq3', thinkingLevel: 'medium' });
  assert.deepEqual(defaults.recommendation, { enabled: false, model: 'llama/iq3', actionPrediction: false,
    maxSuggestedActions: 3, thinkingLevel: 'medium', timeoutMs: 60_000, disableForCwd: [], autoExpand: { enabled: false, minConfidence: 0.85 } });
  assert.deepEqual(defaults.trajectory, { model: 'llama/iq3', enabled: false, everySteps: 5, thinkingLevel: 'medium', timeoutMs: 60_000, disableForCwd: [] });
  const changed = discoveryOptions({ recommendation: { model: 'custom/a', thinkingLevel: 'high' } });
  assert.deepEqual(changed.trajectory, defaults.trajectory, 'no cross-stage inheritance');
  assert.deepEqual(changed.toolSearch, defaults.toolSearch, 'no cross-stage inheritance');
  assert.deepEqual(parseModel('provider/vendor/model'), { provider: 'provider', id: 'vendor/model' });
  for (const value of [null, [], true, { provider: 'p', model: 'm' }, { recommendationModel: 'p/m' },
    { capabilityPrediction: true }, { recommendation: { capabilityPrediction: true } }, { trajectoryWarnings: true }, { recommendation: null }, { trajectory: [] },
    { toolSearch: null }, { recommendation: { autoRecommend: true } }, { trajectory: { actionPrediction: true } },
    { toolSearch: { searchThinkingLevel: 'low' } }]) {
    assert.throws(() => discoveryOptions(value), /accepts only/);
  }
  for (const value of [null, 0, 'true']) {
    assert.throws(() => recommendationOptions({ capabilityPrediction: value }), /accepts only/);
    assert.throws(() => recommendationOptions({ actionPrediction: value }), /actionPrediction/);
    assert.throws(() => trajectoryOptions({ enabled: value }), /enabled/);
  }
  for (const value of [-1, 9, 1.5, null, '3']) assert.throws(() => recommendationOptions({ maxSuggestedActions: value }), /maxSuggestedActions/);
  for (const value of [-1, 1001, 1.5, null, '5']) assert.throws(() => trajectoryOptions({ everySteps: value }), /everySteps/);
  for (const value of [999, 600_001, 1.5, null, '60']) assert.throws(() => trajectoryOptions({ timeoutMs: value }), /timeoutMs/);
  for (const value of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) assert.equal(trajectoryOptions({ thinkingLevel: value }).thinkingLevel, value);
  for (const value of ['', 'typo', null, 1]) assert.throws(() => trajectoryOptions({ thinkingLevel: value }), /thinkingLevel/);
  for (const value of ['', 'provider/', '/model', 'model-only', null]) assert.throws(() => trajectoryOptions({ model: value }), /model/);
  for (const value of ['x', [1], [''], [null], null, 3]) {
    assert.throws(() => recommendationOptions({ disableForCwd: value }), /disableForCwd/);
    assert.throws(() => trajectoryOptions({ disableForCwd: value }), /disableForCwd/);
  }
  assert.deepEqual(recommendationOptions({ disableForCwd: ['~/work', 'D:/tmp'] }).disableForCwd, ['~/work', 'D:/tmp'], 'entries stay verbatim');
});

test('disableForCwd matching normalizes tilde, relative and absolute path forms', () => {
  if (process.platform === 'win32') {
    assert.equal(cwdKey('D:/A\\B/'), 'd:\\a\\b');
    assert.ok(cwdDisabled(['d:/a/b'], 'D:\\A\\B'));
    assert.ok(cwdDisabled(['C:/a/b/'], 'c:\\a\\b\\.'));
  } else {
    assert.equal(cwdKey('/tmp/x//'), '/tmp/x');
    assert.ok(cwdDisabled(['/tmp/x/'], '/tmp/x'));
  }
  assert.ok(cwdDisabled(['~/work'], path.join(homedir(), 'work')));
  assert.ok(cwdDisabled(['~'], homedir()));
  assert.ok(cwdDisabled(['work/sub'], path.join(process.cwd(), 'work', 'sub')));
  assert.ok(cwdDisabled([path.join(process.cwd(), 'work')], 'work/../work'));
  assert.ok(!cwdDisabled([path.join(process.cwd(), 'work')], path.join(process.cwd(), 'work', 'sub')), 'subdirectory is not the listed root');
  assert.ok(!cwdDisabled([], homedir()) && !cwdDisabled(['~/work'], undefined));
});

test('unavailable recommendation model degrades without changing the trajectory model', async () => {
  const f = fixture();
  const find = f.ctx.modelRegistry.find;
  f.ctx.modelRegistry.find = (provider, id) => provider === 'catalog-provider' ? undefined : find(provider, id);
  await f.input();
  const out = await f.s.handlers.context({ messages: [] }, f.ctx);
  assert.equal(out.messages[0]?.details.fallback, 'full-catalog');
  assert.match(out.messages[0]?.details.routingError, /catalog-provider\/vendor\/recommender/);
  await f.s.handlers.turn_end({}, f.ctx);
  assert.deepEqual(f.requests, [config.trajectory.model]);
});

test('disableForCwd skips preparation and periodic review for matching sessions', async () => {
  const blocked = { ...config,
    recommendation: { ...config.recommendation, disableForCwd: [cwd] },
    trajectory: { ...config.trajectory, disableForCwd: [cwd] } };
  const f = fixture(blocked);
  await f.input();
  const out = await f.s.handlers.context({ messages: [] }, f.ctx);
  assert.deepEqual(out.messages, [], 'no preparation message is projected');
  await f.s.handlers.turn_end({}, f.ctx);
  assert.deepEqual(f.selected, [], 'neither stage reaches a model');
  const input = f.s.diagnostics.find(e => e.data.event === 'input');
  assert.equal(input.data.preparation, 'disabled-by-cwd');
  assert.equal(input.data.cwd, cwd);
  const gate = f.s.diagnostics.find(e => e.data.event === 'gate');
  assert.equal(gate.data.reason, 'disabled-by-cwd');
  assert.equal(gate.data.cwd, cwd);
  // A listed path must not block other roots; both stages run normally there.
  const other = fixture({ ...blocked,
    recommendation: { ...blocked.recommendation, disableForCwd: [path.join(cwd, 'other')] },
    trajectory: { ...blocked.trajectory, disableForCwd: [path.join(cwd, 'other')] } });
  await other.input();
  await other.s.handlers.context({ messages: [] }, other.ctx);
  await other.s.handlers.turn_end({}, other.ctx);
  assert.deepEqual(other.selected, [
    { model: config.recommendation.model, thinkingLevel: 'low' },
    { model: config.trajectory.model, thinkingLevel: 'off' },
  ]);
  assert.equal(other.s.diagnostics.find(e => e.data.event === 'input').data.preparation, 'scheduled');
  assert.equal(other.s.diagnostics.find(e => e.data.event === 'gate').data.reason, 'due');
});

test('both README configuration examples use the same valid three-group contract', () => {
  const examples = ['README.md', 'README.zh-CN.md'].map(name => {
    const text = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    const example = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]).capabilityDiscovery;
    assert.deepEqual(Object.keys(example), ['toolSearch', 'recommendation', 'trajectory']);
    assert.deepEqual(discoveryOptions(example), example, 'example lists every supported key explicitly');
    return example;
  });
  assert.deepEqual(examples[0], examples[1]);
});

test('toolSearch group and recommendation master switch parse and validate', () => {
  assert.deepEqual(toolSearchOptions(), { enabled: true, model: 'llama/iq3', thinkingLevel: 'medium' });
  assert.deepEqual(toolSearchOptions({ enabled: false, model: 'a/b', thinkingLevel: 'low' }),
    { enabled: false, model: 'a/b', thinkingLevel: 'low' });
  assert.throws(() => toolSearchOptions({ enabled: 'no' }), /capabilityDiscovery.toolSearch.enabled must be boolean/);
  assert.throws(() => toolSearchOptions({ takeover: true }), /capabilityDiscovery.toolSearch accepts only enabled, model, thinkingLevel/);
  assert.throws(() => toolSearchOptions({ model: 'no-slash' }), /capabilityDiscovery.toolSearch.model/);
  assert.throws(() => toolSearchOptions({ thinkingLevel: 'typo' }), /capabilityDiscovery.toolSearch.thinkingLevel/);
  assert.equal(discoveryOptions({ toolSearch: { enabled: false } }).toolSearch.enabled, false);
  assert.equal(recommendationOptions().enabled, false);
  assert.equal(recommendationOptions({ enabled: true }).enabled, true);
  assert.throws(() => recommendationOptions({ enabled: 1 }), /capabilityDiscovery.recommendation.enabled must be boolean/);
});

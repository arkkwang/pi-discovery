import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { snapPath, snapCliMissing } from './snap-fixture.mjs';
import { registerDiscovery } from '../discovery.js';
import { projectPrefetch } from '../prefetch.js';

// Real host/runner/persistence/native tool-search; only prediction and model I/O
// are fixtures. No MCP service, network request, or global settings modification.
const sdkRoot = process.env.PI_DISCOVERY_SDK_ROOT ?? process.env.SDK_ROOT;
const options = { skip: !sdkRoot || snapCliMissing, timeout: 30000 };
before(async () => { if (!snapCliMissing) await snapPath(after); });
const toolName = 'fixture_deferred_echo';
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(model, content, stopReason = 'stop') {
  return { role: 'assistant', content, api: model.api, provider: model.provider,
    model: model.id, usage, stopReason, timestamp: Date.now() };
}
function stream(message) {
  return { async *[Symbol.asyncIterator]() {
    yield { type: 'start', partial: message }; yield { type: 'done', message };
  }, result: async () => message };
}
const empty = () => ({ suggestions: [], prefetch: { version: 2, requests: 1, reads: 0, rounds: [] }, diagnostics: {} });
function declaredTools(context) {
  const tools = new Map((context.tools ?? []).map(t => [t.name, t]));
  for (const message of context.messages) if (message.role === 'system') {
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    for (const tool of message.toolsRemoved ?? []) tools.delete(typeof tool === 'string' ? tool : tool.name);
  }
  return [...tools.values()];
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function createHarness({ predict, provider }) {
  const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href);
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-expansion-sdk-'));
  const agentDir = path.join(cwd, '.agent');
  const oldDir = process.env.PI_CODING_AGENT_DIR, oldOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
  await mkdir(path.join(agentDir, 'sessions'), { recursive: true });
  const requests = [], predictions = [], executions = [], expansions = [], failures = [];
  const runtime = await sdk.ModelRuntime.create({ modelsPath: null,
    authPath: path.join(agentDir, 'auth.json'), modelsStorePath: path.join(agentDir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('expansionfixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture',
    models: [{ id: 'main', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', contextWindow: 16384, maxTokens: 4096, input: ['text'] }],
    streamSimple: async (model, context) => {
      requests.push(structuredClone(context));
      try { return stream(await provider(model, context, requests.length)); }
      catch (error) { failures.push(error); throw error; }
    } });
  const model = runtime.getModel('expansionfixture', 'main');
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], skills: [],
    compaction: { enabled: false }, retry: { enabled: false },
    capabilityDiscovery: { recommendation: { enabled: true, model: 'expansionfixture/main', autoExpand: { enabled: true } }, trajectory: { enabled: false } } });
  let piApi;
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noThemes: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{ name: 'expansion-fixture', factory: pi => {
      piApi = pi;
      pi.registerTool({ name: toolName, label: 'Fixture echo', description: 'Echo fixture input', exposure: 'deferred',
        parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
        execute: async (id, args) => { executions.push({ id, args }); return { content: [{ type: 'text', text: `EXECUTED:${args.value}` }], details: {} }; } });
      registerDiscovery(pi, { createToolSearchExtension: sdk.createToolSearchExtension, createMcpExtension: sdk.createMcpExtension,
        sdk: {}, predict: async args => {
          predictions.push(args);
          try { return await predict({ ...args, expandCapability: async (...params) => {
            expansions.push(params); return args.expandCapability(...params);
          } }, model, predictions.length); } catch (error) { failures.push(error); throw error; }
        } });
    } }] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  let manager = sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions')), session;
  async function open(nextManager) {
    if (session) { session.dispose(); await resourceLoader.reload(); }
    manager = nextManager;
    ({ session } = await sdk.createAgentSession({ cwd, model, thinkingLevel: 'off', settingsManager,
      sessionManager: manager, resourceLoader, modelRuntime: runtime }));
    await session.bindExtensions({});
  }
  await open(manager);
  return { sdk, cwd, agentDir, requests, predictions, executions, expansions, failures,
    get session() { return session; }, get manager() { return manager; }, active: () => piApi.getActiveTools(), open,
    async dispose() {
      await session.abort().catch(() => {}); session.dispose();
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
      if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
      await rm(cwd, { recursive: true, force: true });
    } };
}

async function expandPrediction(args, model) {
  const suggestion = args.catalog.find(c => c.type === 'tool' && c.name === toolName);
  assert.ok(suggestion, 'real deferred tool appears in consolidated catalog');
  const selected = { ...suggestion, confidence: 1 }, id = 'fixture_prepare_call';
  const result = await args.expandCapability(selected, id, args.signal);
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.toolsAdded.map(t => t.name), [toolName], 'native activation supplies actual new schema');
  return { suggestions: [selected], diagnostics: {}, prefetch: { version: 2, requests: 1, reads: 0, rounds: [{
    sourceCallIds: [id], toolsAdded: result.toolsAdded,
    messages: [assistant(model, [{ type: 'toolCall', id, name: 'tool_search', arguments: { query: toolName } }], 'toolUse'),
      { role: 'toolResult', toolCallId: id, toolName: 'tool_search', content: result.content,
        details: result.details, isError: result.isError === true, timestamp: Date.now() }],
  }] } };
}
const carriers = manager => manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'capability-prefetch');
function checkProjection(messages) {
  const projected = projectPrefetch(messages);
  assert.deepEqual(projectPrefetch(projected), projected, 'projection is idempotent');
  assert.equal(projected.filter(m => m.role === 'toolResult' && m.toolCallId === 'fixture_prepare_call').length, 1);
  assert.equal(projected.filter(m => m.role === 'system').flatMap(m => m.toolsAdded ?? []).filter(t => t.name === toolName).length, 1);
  return projected;
}

test('auto expansion activates executable tools before the first SDK request; persisted projection survives resume/fork without replay', options, async () => {
  const h = await createHarness({
    predict: (args, model, n) => n === 1 ? expandPrediction(args, model) : empty(),
    provider: (model, context, n) => {
      if (n <= 2) assert.ok(declaredTools(context).some(t => t.name === toolName), `request ${n} declares the newly active tool`);
      if (n === 1) return assistant(model, [{ type: 'toolCall', id: 'first_response_call', name: toolName, arguments: { value: 'first-request' } }], 'toolUse');
      if (n === 2) {
        const result = context.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'first_response_call');
        assert.ok(result, 'first response tool call produced a result');
        assert.equal(result.isError, false, JSON.stringify(result));
        assert.match(JSON.stringify(result.content), /EXECUTED:first-request/);
        assert.doesNotMatch(JSON.stringify(result), /Tool not found/i);
      }
      return assistant(model, [{ type: 'text', text: 'Finished.' }]);
    },
  });
  try {
    assert.ok(!h.active().includes(toolName), 'fixture starts deferred');
    await h.session.prompt('Use the deferred fixture');
    assert.deepEqual(h.failures, []);
    assert.equal(h.requests.length, 2);
    assert.equal(h.predictions.length, 1, 'tool continuation does not prepare again');
    assert.equal(h.expansions.length, 1);
    assert.equal(h.executions.length, 1, 'first request truly executed newly loaded tool');
    assert.ok(h.active().includes(toolName));
    assert.equal(carriers(h.manager).length, 1);
    assert.equal(h.manager.getBranch().filter(e => e.customType === 'capability-preparation-boundary').length, 0, 'boundary replaced, not persisted alongside carrier');
    const file = h.manager.getSessionFile();
    const disk = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(disk.filter(e => e.customType === 'capability-prefetch').length, 1, 'one carrier on disk');
    assert.equal(disk.filter(e => e.customType === 'capability-preparation-boundary').length, 0);
    checkProjection(h.manager.buildSessionContext().messages);
    for (const mode of ['resume', 'fork']) {
      const manager = mode === 'resume' ? h.sdk.SessionManager.open(file)
        : h.sdk.SessionManager.forkFrom(file, h.cwd, path.join(h.agentDir, 'sessions'));
      await h.open(manager);
      assert.equal(h.expansions.length, 1, `${mode} must not replay activation`);
      checkProjection(manager.buildSessionContext().messages);
      await h.session.prompt(`Continue after ${mode}`);
      assert.deepEqual(h.failures, []);
      const request = h.requests.at(-1);
      for (const tool of declaredTools(request)) assert.ok(h.active().includes(tool.name), `${mode} must not declare inactive ${tool.name}`);
      assert.equal(request.messages.filter(m => m.role === 'toolResult' && m.toolCallId === 'fixture_prepare_call').length, 1, `${mode} request projects one search result`);
      assert.equal(h.expansions.length, 1, `${mode} projection does not load tools again`);
      assert.equal(h.executions.length, 1);
      assert.equal(carriers(manager).length, 1);
    }
  } finally { await h.dispose(); }
});

test('expansion boundary waits after RPC acceptance and user persistence, but before provider/tool snapshot', options, async () => {
  const entered = deferred(), gate = deferred(); let ack = false, run;
  const h = await createHarness({ predict: async (args, model) => { entered.resolve(); await gate.promise; return expandPrediction(args, model); },
    provider: (model, context) => { assert.ok(declaredTools(context).some(t => t.name === toolName)); return assistant(model, [{ type: 'text', text: 'Ready.' }]); } });
  try {
    run = h.session.prompt('PERSISTED_BEFORE_EXPANSION', { source: 'rpc', preflightResult: () => { ack = true; } });
    await entered.promise;
    assert.equal(ack, true, 'RPC acceptance precedes recommendation completion');
    assert.ok(h.manager.getBranch().some(e => e.type === 'message' && e.message.role === 'user'));
    assert.match(await readFile(h.manager.getSessionFile(), 'utf8'), /PERSISTED_BEFORE_EXPANSION/);
    assert.equal(h.requests.length, 0);
    assert.ok(!h.active().includes(toolName));
    gate.resolve(); await run;
    assert.deepEqual(h.failures, []);
    assert.equal(h.requests.length, 1);
    assert.equal(h.predictions.length, 1); assert.equal(h.expansions.length, 1);
    assert.equal(carriers(h.manager).length, 1);
  } finally { gate.resolve(); await run?.catch(() => {}); await h.dispose(); }
});

test('cancelled expansion preparation cannot deliver a late carrier to the next input', options, async () => {
  const entered = deferred(), gate = deferred(); let run;
  const h = await createHarness({ predict: async (args, model, n) => {
    if (n === 1) { entered.resolve(); await gate.promise;
      return { ...empty(), suggestions: [{ type: 'tool', name: 'STALE_CANCELLED', confidence: 1 }] }; }
    return expandPrediction(args, model);
  }, provider: model => assistant(model, [{ type: 'text', text: 'Current input done.' }]) });
  try {
    run = h.session.prompt('Cancel this input'); await entered.promise;
    const abort = h.session.abort(); gate.resolve(); await abort; await run;
    assert.equal(h.requests.length, 0);
    await h.session.prompt('Use fixture for the current input');
    assert.deepEqual(h.failures, []);
    assert.equal(h.requests.length, 1); assert.equal(h.predictions.length, 2); assert.equal(h.expansions.length, 1);
    assert.doesNotMatch(JSON.stringify(h.requests), /STALE_CANCELLED/);
    assert.doesNotMatch(JSON.stringify(h.manager.getBranch().filter(e => e.type === 'message' || e.type === 'custom_message')), /STALE_CANCELLED/);
    assert.equal(carriers(h.manager).length, 1);
  } finally { gate.resolve(); await run?.catch(() => {}); await h.dispose(); }
});

test('resume/fork after immediate stop retain expansion evidence without declaring or reactivating unavailable tools', options, async () => {
  const h = await createHarness({
    predict: (args, model, n) => n === 1 ? expandPrediction(args, model) : empty(),
    provider: (model, context, n) => {
      assert.equal(declaredTools(context).some(t => t.name === toolName), n === 1,
        'historical carrier is not authority to declare a currently inactive tool');
      return assistant(model, [{ type: 'text', text: 'Stop without invoking a tool.' }]);
    },
  });
  try {
    await h.session.prompt('Prepare fixture then stop');
    assert.deepEqual(h.failures, []);
    assert.equal(h.expansions.length, 1);
    assert.ok(h.active().includes(toolName));
    const file = h.manager.getSessionFile();
    for (const mode of ['resume', 'fork']) {
      const manager = mode === 'resume' ? h.sdk.SessionManager.open(file)
        : h.sdk.SessionManager.forkFrom(file, h.cwd, path.join(h.agentDir, 'sessions'));
      await h.open(manager);
      assert.ok(!h.active().includes(toolName), `${mode} does not reactivate a carrier-only declaration`);
      const messages = manager.buildSessionContext().messages;
      const projected = projectPrefetch(messages, new Map());
      assert.deepEqual(projectPrefetch(projected, new Map()), projected);
      assert.equal(projected.filter(m => m.role === 'toolResult' && m.toolCallId === 'fixture_prepare_call').length, 1);
      assert.ok(!declaredTools({ messages: projected }).some(t => t.name === toolName));
      await h.session.prompt(`Continue ${mode} with no new expansion recommendation`);
      assert.deepEqual(h.failures, []);
      assert.equal(h.expansions.length, 1, 'history projection never dispatches expansion');
      assert.equal(h.executions.length, 0);
      assert.equal(carriers(manager).length, 1);
      assert.equal(h.requests.at(-1).messages.filter(m => m.role === 'toolResult' && m.toolCallId === 'fixture_prepare_call').length, 1);
    }
    assert.equal(h.predictions.length, 3, 'each new input still takes the normal recommendation path');
    assert.equal(h.requests.length, 3);
  } finally { await h.dispose(); }
});

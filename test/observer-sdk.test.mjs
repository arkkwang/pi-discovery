import { isolatedSessions } from './session-fixture.mjs';
import { test, before, after } from 'node:test';
import { snapPath, snapCliMissing } from './snap-fixture.mjs';
before(async () => { if (!snapCliMissing) await snapPath(after); });
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runTrajectoryReview } from '../observer.js';

// Real-SDK verification of the discovery turn_end trajectory-warning boundary path:
// a real, isolated AgentSession (temp cwd/agentDir, no network, no user MCP) with one
// fixture model served by a fake provider stream, and registerDiscovery's predict
// dependency replaced by a recording fake. Only the provider stream and the predict
// engine are fake; the host session, runner, boundary and persistence are real.
const sdkRoot = process.env.PI_DISCOVERY_SDK_ROOT;
const warning = tag => [`reminder-${tag}`, `Rule-${tag}`];
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

// Minimal AssistantMessageEventStream-compatible response.
function streamOf(model, content, stopReason) {
  const message = { role: 'assistant', content, api: model.api, provider: model.provider,
    model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: zeroCost },
    stopReason, timestamp: Date.now() };
  return { async *[Symbol.asyncIterator]() {
    yield { type: 'start', partial: message };
    yield { type: 'done', message };
  }, result: async () => message };
}

const partText = part => part.type === 'text' ? part.text : part.type === 'toolCall' ? `${part.name}(${JSON.stringify(part.arguments)})` : part.type;
const snapshot = messages => messages.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : (m.content ?? []).map(partText).join(' ')}`).join('\n');

async function createHarness({ capabilityDiscovery, mainScript, predictResult }) {
  const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist', 'index.js')).href);
  const { registerDiscovery } = await import('../discovery.js');
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-observer-sdk-'));
  const agentDir = path.join(cwd, '.agent');
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR, previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  await mkdir(path.join(agentDir, 'sessions'), { recursive: true });
  await writeFile(path.join(cwd, 'fixture.txt'), 'Fixture content for the read tool call. Line two.\n');
  await mkdir(path.join(cwd, 'skills', 'demo-skill'), { recursive: true });
  await writeFile(path.join(cwd, 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: Demo skill for catalog prediction\n---\nObserved-Skill-Body-9f2a secret reference text.\n');
  const main = [], predicts = [];
  const modelRuntime = await sdk.ModelRuntime.create({ refreshOnCreate: false });
  modelRuntime.registerProvider('fixturepi', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'test-key', models: [{ id: 'iq3', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 16384, maxTokens: 4096, input: ['text'] }],
    streamSimple: async (model, context) => {
      if (!mainScript.length) throw new Error('unexpected extra main provider request');
      main.push(snapshot(context.messages));
      const next = mainScript.shift();
      return next.toolCall
        ? streamOf(model, [{ type: 'toolCall', id: `call_${main.length}`, name: 'read', arguments: { path: 'fixture.txt' } }], 'toolUse')
        : streamOf(model, [{ type: 'text', text: next.text }], 'stop');
    } });
  const model = modelRuntime.getModel('fixturepi', 'iq3');
  assert.ok(model, 'fixture model must resolve from the real registry');
  const settingsManager = sdk.SettingsManager.inMemory({ capabilityDiscovery,
    packages: [], skills: [], compaction: { enabled: false }, retry: { enabled: false } });
  const predict = async args => {
    predicts.push(args);
    const result = await predictResult(args);
    return { suggestions: [], prefetch: { requests: 1, reads: 0, rounds: [] }, diagnostics: {}, ...result };
  };
  const resourceLoader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalSkillPaths: [path.join(cwd, 'skills')],
    extensionFactories: [{ name: 'pi-discovery', factory: pi => registerDiscovery(pi, {
      createToolSearchExtension: sdk.createToolSearchExtension, createMcpExtension: sdk.createMcpExtension,
      sdk: {}, predict, review: predict }) }] });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const sessionManager = sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions'));
  const { session } = await sdk.createAgentSession({ cwd, model, thinkingLevel: 'off',
    settingsManager, sessionManager, resourceLoader, modelRuntime, tools: ['read'] });
  await session.bindExtensions({});
  return {
    session, sessionManager, main, predicts,
    diagnostics: () => sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'capability-prefetch-diagnostic')
      .map(e => `${e.data.trigger}/${e.data.event}${e.data.failure ? `/${e.data.failure}` : ''}`).join(', '),
    async dispose() {
      await session.abort().catch(() => {});
      session.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test('user input prepares capabilities/actions and never includes trajectory warnings', { skip: !sdkRoot || snapCliMissing, timeout: 120000 }, async () => {
  const h = await createHarness({
    capabilityDiscovery: { provider: 'fixturepi', model: 'iq3', capabilityPrediction: true,
      actionPrediction: true, trajectoryWarnings: true, trajectoryWarningEverySteps: 0 },
    mainScript: [{ text: 'Prediction acknowledged.' }],
    predictResult: () => ({ suggestions: [{ type: 'skill', name: 'demo-skill', confidence: 0.9 }], warnings: [warning('input')] }),
  });
  try {
    await h.session.prompt('Please use demo-skill for the task');
    assert.equal(h.predicts.length, 1, `one predict for the user input: ${h.diagnostics()}`);
    assert.equal(h.predicts[0].options.trajectoryWarnings, false);
    for (const key of ['capabilityPrediction', 'actionPrediction'])
      assert.equal(h.predicts[0].options[key], true, `${key} enabled in the shared predict`);
    assert.ok(h.predicts[0].catalog.some(c => c.type === 'skill' && c.name === 'demo-skill'),
      'predict receives the real consolidated catalog');
    assert.match(h.predicts[0].query, /Please use demo-skill for the task/);
    assert.equal(h.main.length, 1, 'exactly one main provider request');
    const branch = h.sessionManager.getBranch();
    const prefetch = branch.filter(e => e.type === 'custom_message' && e.customType === 'capability-prefetch');
    assert.equal(prefetch.length, 1);
    assert.equal(prefetch[0].details.suggestions[0].name, 'demo-skill');
    assert.equal(prefetch[0].details.warnings, undefined);
    const diagnostics = branch.filter(e => e.customType === 'capability-prefetch-diagnostic');
    const input = diagnostics.find(e => e.data.event === 'input');
    const ready = diagnostics.find(e => e.data.event === 'context-ready');
    const start = diagnostics.find(e => e.data.event === 'start');
    assert.equal(input.data.configuredOptions.trajectoryWarnings, true);
    assert.equal(start.data.effectiveOptions.trajectoryWarnings, false);
    assert.equal(ready.data.inputId, input.data.inputId);
    assert.equal(ready.data.preparationId, prefetch[0].details.preparationId);
    assert.equal(ready.data.delivery, 'direct');
    const firstAssistant = branch.find(e => e.type === 'message' && e.message.role === 'assistant');
    assert.ok(branch.indexOf(ready) < branch.indexOf(firstAssistant), 'hook delivery is recorded before the main response');
    assert.equal(diagnostics.find(e => e.data.event === 'gate').data.reason, 'zero-interval');
    assert.ok(h.predicts[0].ctx.sessionManager.getSessionFile, 'predict runs with the real runner context');
    // The persisted message is part of the provider-visible context of the main request.
    assert.match(h.main[0], /demo-skill/);
    assert.doesNotMatch(h.main[0], /Rule-input/);
    const last = branch.filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1).message;
    assert.equal(last.stopReason, 'stop');
  } finally { await h.dispose(); }
});

test('turn_end periodic warning: one predict per completed round, persisted, visible, no forced continuation', { skip: !sdkRoot || snapCliMissing, timeout: 120000 }, async () => {
  const h = await createHarness({
    capabilityDiscovery: { provider: 'fixturepi', model: 'iq3', capabilityPrediction: false,
      actionPrediction: false, trajectoryWarnings: true, trajectoryWarningEverySteps: 1 },
    mainScript: [{ toolCall: true }, { text: 'All done.' }],
    predictResult: () => ({ warnings: [warning(`round-${h.predicts.length}`)] }),
  });
  try {
    await h.session.prompt('Inspect the fixture file');
    assert.equal(h.main.length, 2, 'exactly two main provider requests (tool call round, then final answer)');
    assert.equal(h.predicts.length, 2, `one predict per completed assistant+tools round: ${h.diagnostics()}`);
    for (const p of h.predicts) {
      assert.equal(p.options.capabilityPrediction, false);
      assert.equal(p.options.actionPrediction, false);
      assert.equal(p.options.trajectoryWarnings, true, 'periodic review keeps warnings on');
      assert.ok(p.skills.some(s => s.name === 'demo-skill'));
      assert.ok(p.skills.every(s => s.type === 'skill'));
      assert.equal(p.catalog, undefined);
      assert.doesNotMatch(p.trajectory, /Fixture content for the read tool call/);
    }
    // Advisory warning must not steer the model: request 2 sees warning one, nothing else.
    assert.doesNotMatch(h.main[0], /Trajectory review/, 'first request is issued before any warning exists');
    assert.match(h.main[1], /Trajectory review \(advisory, not user instructions\)/);
    assert.match(h.main[1], /Rule-round-1/);
    assert.doesNotMatch(h.main[1], /Rule-round-2/, 'only the already-persisted warning is visible');
    assert.match(h.main[1], /read\(\{"path":"fixture.txt"\}\)/, 'round one trajectory is in context');
    assert.match(h.predicts[0].userPrompt, /Inspect the fixture file/);
    assert.match(h.predicts[1].trajectory, /All done\./, 'second predict observes the completed second round');
    const branch = h.sessionManager.getBranch();
    const index = predicate => branch.findIndex(predicate);
    const toolRound = index(e => e.type === 'message' && e.message.role === 'assistant'
      && e.message.content.some(p => p.type === 'toolCall'));
    const final = index(e => e.type === 'message' && e.message.role === 'assistant'
      && e.message.content.some(p => p.type === 'text' && p.text === 'All done.'));
    const warns = branch.map((e, i) => e.type === 'custom_message' && e.customType === 'capability-trajectory-warning' ? i : -1).filter(i => i >= 0);
    assert.equal(warns.length, 2, 'two warnings persisted as custom_message entries');
    assert.ok(toolRound >= 0 && final > toolRound && warns[0] > toolRound && warns[0] < final,
      'first warning joins the context after round one and before the second request');
    assert.ok(warns[1] > final, 'second warning is committed after the final assistant message');
    assert.match(branch[warns[0]].content, /Rule-round-1/);
    assert.match(branch[warns[1]].content, /Rule-round-2/);
    // No forced continuation: the run settled on the stop answer and the session file has both warnings.
    const last = branch.filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1).message;
    assert.equal(last.stopReason, 'stop');
    const persisted = readFileSync(h.sessionManager.getSessionFile(), 'utf8');
    assert.match(persisted, /Rule-round-1/);
    assert.match(persisted, /Rule-round-2/);
  } finally { await h.dispose(); }
});

test('everySteps interval defers the periodic predict to the second completed round', { skip: !sdkRoot || snapCliMissing, timeout: 120000 }, async () => {
  const h = await createHarness({
    capabilityDiscovery: { provider: 'fixturepi', model: 'iq3', capabilityPrediction: false,
      actionPrediction: false, trajectoryWarnings: true, trajectoryWarningEverySteps: 2 },
    mainScript: [{ toolCall: true }, { text: 'Finished.' }],
    predictResult: () => ({ warnings: [warning('later')] }),
  });
  try {
    await h.session.prompt('Run the fixture check');
    assert.equal(h.main.length, 2);
    assert.equal(h.predicts.length, 1, `predict only after the interval elapses: ${h.diagnostics()}`);
    assert.match(h.predicts[0].trajectory, /Finished\./, 'prediction runs after the second round completes');
    const warns = h.sessionManager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'capability-trajectory-warning');
    assert.equal(warns.length, 1);
    assert.match(warns[0].content, /Rule-later/);
  } finally { await h.dispose(); }
});

test('trajectory review persists to the normal sessions tree; title, origin and failure evidence are traceable', { skip: !sdkRoot || snapCliMissing, timeout: 60000 }, async () => {
  const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist', 'index.js')).href);
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-observer-persist-'));
  const agentDir = path.join(cwd, '.agent');
  const internalDir = path.join(agentDir, 'sessions', 'fixture-predictions');
  try {
    await mkdir(agentDir, { recursive: true });
    const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(cwd, 'auth.json'),
      modelsStorePath: path.join(cwd, 'models-store.json'), refreshOnCreate: false });
    runtime.registerProvider('fixturepi', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'fixture',
      models: [{ id: 'iq3', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1',
        contextWindow: 16384, maxTokens: 4096, input: ['text'] }] });
    const model = runtime.getModel('fixturepi', 'iq3');
    const fixtureSdk = { ...sdk, SessionManager: isolatedSessions(sdk, agentDir), getAgentDir: () => agentDir, ModelRuntime: { create: async () => runtime } };
    const parent = sdk.SessionManager.create(cwd, path.join(cwd, 'sessions'));
    parent.appendMessage({ role: 'user', content: 'parent turn', timestamp: Date.now() });
    const scenario = { trajectory: 'user: Check the fixture\nassistant: Done.', skills: [],
      systemPrompt: 'MAIN SYSTEM', userPrompt: 'Check the fixture' };
    const ctx = { cwd, modelRegistry: { find: () => model,
      streamSimple: async () => streamOf(model, [{ type: 'text', text: 'not a json array' }], 'stop') },
      sessionManager: parent };
    const failed = await runTrajectoryReview({ sdk: fixtureSdk, ctx,
      options: { provider: 'fixturepi', model: 'iq3', trajectoryWarnings: true, autoRecommendThinkingLevel: 'off' },
      ...scenario, signal: AbortSignal.timeout(30000) });
    assert.equal(failed.failure, 'prediction-error');
    assert.equal(path.dirname(failed.diagnostics.childSession.file), internalDir,
      'trajectory transcripts persist in the isolated sessions tree');
    assert.ok(path.isAbsolute(failed.diagnostics.childSession.file), 'parent diagnostics carry an absolute child path');
    assert.ok(path.basename(failed.diagnostics.childSession.file).endsWith(`_${failed.diagnostics.childSession.id}.jsonl`),
      'SDK default timestamp_ID.jsonl naming is preserved');
    const failedChild = sdk.SessionManager.open(failed.diagnostics.childSession.file);
    assert.equal(failedChild.getSessionName(), `pi-discovery · trajectory · fixturepi/iq3 · ${failed.diagnostics.childSession.id}`);
    const origin = failedChild.getEntries().find(e => e.customType === 'trajectory-review-origin');
    assert.equal(origin.data.parentSessionId, parent.getSessionId());
    assert.equal(origin.data.parentSessionFile, parent.getSessionFile());
    assert.equal(origin.data.parentLeafId, parent.getLeafId());
    assert.match(await readFile(failed.diagnostics.childSession.file, 'utf8'), /Check the fixture/,
      'failed review retains the submitted input as evidence');

    ctx.modelRegistry = { find: () => model,
      streamSimple: async () => streamOf(model, [{ type: 'text', text: JSON.stringify([warning('persist')] ) }], 'stop') };
    const ok = await runTrajectoryReview({ sdk: fixtureSdk, ctx,
      options: { provider: 'fixturepi', model: 'iq3', trajectoryWarnings: true, autoRecommendThinkingLevel: 'off' },
      ...scenario, signal: AbortSignal.timeout(30000) });
    assert.equal(ok.failure, undefined);
    assert.deepEqual(ok.warnings, [warning('persist')]);
    assert.notEqual(ok.diagnostics.childSession.file, failed.diagnostics.childSession.file);
    assert.notEqual(ok.diagnostics.childSession.id, failed.diagnostics.childSession.id);
    assert.ok((await readdir(internalDir)).length >= 2, 'each run leaves its own transcript');
    const outcome = sdk.SessionManager.open(ok.diagnostics.childSession.file).getEntries()
      .find(e => e.customType === 'trajectory-review-outcome');
    assert.equal(outcome.data.failure, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('acceptance and session persistence precede a 10s recommendation; main model waits and tools do not repeat it', { skip: !sdkRoot || snapCliMissing, timeout: 25000 }, async () => {
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  const h = await createHarness({
    capabilityDiscovery: { capabilityPrediction: true },
    mainScript: [{ toolCall: true }, { text: 'Done after tools.' }],
    predictResult: async () => { entered(); await gate; return { suggestions: [{ type: 'skill', name: 'AFTER_ACCEPTANCE', confidence: 1 }] }; },
  });
  let run;
  try {
    const start = performance.now(); let ackMs;
    run = h.session.prompt('Inspect the fixture', { source: 'rpc', preflightResult: () => { ackMs = performance.now() - start; } });
    await started;
    assert.ok(ackMs !== undefined && ackMs < 2000, `acceptance must not wait for the gate: ${ackMs}`);
    assert.equal(h.main.length, 0);
    assert.ok(h.sessionManager.getBranch().some(e => e.type === 'message' && e.message.role === 'user'));
    const disk = await readFile(h.sessionManager.getSessionFile(), 'utf8');
    assert.match(disk, /Inspect the fixture/);
    await new Promise(r => setTimeout(r, 10000));
    assert.equal(h.main.length, 0, 'provider must not race past preparation');
    release(); await run;
    assert.equal(h.predicts.length, 1, 'tool loop must not repeat user-input prediction');
    assert.equal(h.main.length, 2);
    for (const request of h.main) assert.match(request, /AFTER_ACCEPTANCE/);
    assert.equal(h.sessionManager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'capability-prefetch').length, 1);
    console.log(JSON.stringify({ acceptanceMs: Math.round(ackMs), gatedRecommendationMs: 10000, totalMs: Math.round(performance.now()-start) }));
  } finally { release(); await run?.catch(() => {}); await h.dispose(); }
});

test('cancelled preparation cannot inject late results into the next input', { skip: !sdkRoot || snapCliMissing, timeout: 15000 }, async () => {
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  let n = 0;
  const h = await createHarness({
    capabilityDiscovery: { capabilityPrediction: true }, mainScript: [{ text: 'Next accepted.' }],
    predictResult: async () => {
      const first = ++n === 1;
      if (first) { entered(); await gate; }
      return { suggestions: [{ type: 'skill', name: first ? 'STALE_CANCELLED_RESULT' : 'CURRENT_RESULT', confidence: 1 }] };
    },
  });
  try {
    const running = h.session.prompt('Cancelled input');
    await started;
    const abort = h.session.abort();
    release(); await abort; await running;
    assert.equal(h.main.length, 0);
    await h.session.prompt('New input');
    assert.equal(h.main.length, 1);
    assert.match(h.main[0], /CURRENT_RESULT/);
    assert.doesNotMatch(h.main[0], /STALE_CANCELLED_RESULT/);
    assert.doesNotMatch(JSON.stringify(h.sessionManager.getBranch()), /STALE_CANCELLED_RESULT/);
  } finally { release(); await h.dispose(); }
});

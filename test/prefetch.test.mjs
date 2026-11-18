import { isolatedSessions } from './session-fixture.mjs';
import { snapPath } from './snap-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPathKey } from '../trajectory.js';
import { setup, sdkDepDir } from './helpers.mjs';
import { projectPrefetch, runPrefetch, validatePrediction, PREFETCH_TYPE } from '../prefetch.js';
import { projectIndex, skillFileIndex } from '../context-index.js';
import { recommendationOptions, toolSearchOptions, trajectoryOptions } from '../config.js';
const root = process.env.PI_DISCOVERY_SDK_ROOT;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = value => ({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }],
  provider: 'llama', model: 'iq3', api: 'openai-completions', usage, timestamp: Date.now(), stopReason: 'stop' });

test('invalid prediction items are dropped without aborting valid ones', () => {
  assert.deepEqual(recommendationOptions({ maxSuggestedActions: 0 }), { enabled: false, model: 'llama/iq3', actionPrediction: false, maxSuggestedActions: 0, thinkingLevel: 'medium', timeoutMs: 60_000, disableForCwd: [], autoExpand: { enabled: false, minConfidence: 0.85 } });
  assert.deepEqual(recommendationOptions(), { enabled: false, model: 'llama/iq3', actionPrediction: false, maxSuggestedActions: 3, thinkingLevel: 'medium', timeoutMs: 60_000, disableForCwd: [], autoExpand: { enabled: false, minConfidence: 0.85 } });
  assert.deepEqual(recommendationOptions({ enabled: true, actionPrediction: true, timeoutMs: 120_000 }), { enabled: true, model: 'llama/iq3', actionPrediction: true, maxSuggestedActions: 3, thinkingLevel: 'medium', timeoutMs: 120_000, disableForCwd: [], autoExpand: { enabled: false, minConfidence: 0.85 } });
  for (const config of [{ prefetch: { maxSuggestedActions: 3 } }, { autoRecommend: 'true' }, { maxSuggestedActions: null }, { maxRunRounds: 3, maxRecommendedRounds: 2 }, { maxSuggestedActions: -1 }, { maxSuggestedActions: 9 }, { timeoutMs: 999 }, { timeoutMs: 600_001 }, { timeoutMs: '60000' }, null]) assert.throws(() => recommendationOptions(config));
  const catalog = [{ type: 'skill', name: 'test' }], files = [{ path: '/skill/SKILL.md' }];
  const opts = { enabled: true, actionPrediction: true, maxSuggestedActions: 3 };
  const kept = { type: 'action', confidence: 0.95, tool: 'bash', arguments: { command: 'pwd' } };
  for (const command of ['', '   ', 42, 'x'.repeat(2001), 'a\0b']) {
    const result = validatePrediction({ suggestions: [{ type: 'action', confidence: 0.95, tool: 'bash', arguments: { command } }, kept] }, catalog, files, opts);
    assert.deepEqual(result.suggestions, [kept]);
    assert.deepEqual(result.dropped, [{ kind: 'action', reason: 'invalid-action', item: { type: 'action', confidence: 0.95, tool: 'bash', arguments: { command } } }]);
  }
  assert.deepEqual(validatePrediction({ suggestions: [{ type: 'action', confidence: 0.95, tool: 'bash', arguments: { command: "printf 'custom generated command'" } }] }, catalog, files, opts),
    { suggestions: [{ type: 'action', confidence: 0.95, tool: 'bash', arguments: { command: "printf 'custom generated command'" } }], dropped: [] });
  const read = { type: 'action', confidence: 0.95, tool: 'read', arguments: { path: '/skill/SKILL.md' } };
  const outside = validatePrediction({ suggestions: [{ type: 'action', confidence: 0.95, tool: 'read', arguments: { path: '/secret' } }, read] }, catalog, files, opts);
  assert.deepEqual(outside.suggestions, [read]);
  assert.deepEqual(outside.dropped, [{ kind: 'action', reason: 'invalid-action', item: { type: 'action', confidence: 0.95, tool: 'read', arguments: { path: '/secret' } } }]);
  assert.equal(validatePrediction({ suggestions: [kept, kept] }, catalog, files, opts).suggestions.length, 1);
  const overBudget = validatePrediction({ suggestions: [kept, { type: 'action', confidence: 0.95, tool: 'bash', arguments: { command: 'ls' } }] }, catalog, files, { actionPrediction: true, maxSuggestedActions: 1 });
  assert.deepEqual(overBudget.suggestions, [kept]);
  assert.deepEqual(overBudget.dropped, [{ kind: 'action', reason: 'over-budget', item: { type: 'action', confidence: 0.95, tool: 'bash', arguments: { command: 'ls' } } }]);
  assert.deepEqual(validatePrediction({ suggestions: [kept] }, catalog, files, { actionPrediction: true, maxSuggestedActions: 0 }),
    { suggestions: [], dropped: [{ kind: 'action', reason: 'over-budget', item: kept }] });
  const flattened = validatePrediction({ suggestions: [{ type: 'action', confidence: 0.95, tool: 'bash', command: 'pwd' }, { type: 'action', confidence: 0.95, tool: 'read', path: '/skill/SKILL.md' }] }, catalog, files, opts);
  assert.deepEqual(flattened.suggestions, []);
  assert.equal(flattened.dropped.length, 2);
  assert.deepEqual(validatePrediction({ suggestions: [{ type: 'skill', name: 'test', confidence: 0.9 }, { type: 'skill', name: 'unknown', confidence: 1 }, { type: 'skill', name: 'test', confidence: 2 }] }, catalog, files, {}).suggestions,
    [{ type: 'skill', name: 'test', confidence: 0.9 }]);
});

test('capability suggestions are always validated; actions remain optional', () => {
  const catalog = [{ type: 'skill', name: 'test', description: 'From catalog', path: '/skill/SKILL.md' }];
  const action = { type: 'action', confidence: 0.95, tool: 'bash', arguments: { command: 'pwd' } };
  const suggestion = { type: 'skill', name: 'test', confidence: 1 };
  const value = { suggestions: [suggestion, action] };
  assert.deepEqual(validatePrediction(value, catalog, [], { actionPrediction: true }),
    { suggestions: [{ ...catalog[0], confidence: 1 }, action], dropped: [] });
  for (const options of [{ enabled: true }, {}]) {
    const result = validatePrediction(value, catalog, [], options);
    assert.deepEqual(result.suggestions, [{ ...catalog[0], confidence: 1 }]);
    assert.equal(result.dropped.length, 1);
    assert.equal(result.dropped[0].kind, 'action');
    assert.deepEqual(result.dropped[0].item, action);
    assert.equal('actions' in result, false);
  }
});

test('duplicates retain highest confidence in first position before action budgeting', () => {
  const skill = { type: 'skill', name: 'test', confidence: 0.2 };
  const action = { type: 'action', tool: 'bash', arguments: { command: 'pwd' }, confidence: 0.3 };
  const other = { type: 'action', tool: 'bash', arguments: { command: 'ls' }, confidence: 1 };
  const result = validatePrediction({ suggestions: [skill, action, { ...skill, confidence: 0.9 },
    { ...action, confidence: 0.95 }, { ...action, confidence: 0.1 }, other] },
    [{ type: 'skill', name: 'test', description: 'Catalog' }], [], { actionPrediction: true, maxSuggestedActions: 1 });
  assert.deepEqual(result.suggestions, [{ ...skill, description: 'Catalog', confidence: 0.9 }, { ...action, confidence: 0.95 }]);
  assert.deepEqual(result.dropped, [{ kind: 'action', reason: 'over-budget', item: other }]);
  for (const confidence of [undefined, null, -0.1, 1.1, NaN, Infinity, '0.9']) {
    const invalid = { ...action, confidence };
    const checked = validatePrediction({ suggestions: [invalid] }, [], [], { actionPrediction: true });
    assert.deepEqual(checked.suggestions, []);
    assert.equal(checked.dropped[0].kind, 'action');
    assert.equal(checked.dropped[0].reason, 'invalid-action');
  }
});

test('malformed capability types and names degrade per item without coercion', () => {
  const valid = { type: 'skill', name: 'test', confidence: 0.9 };
  const catalog = [{ type: 'skill', name: 'test', path: '/skill/SKILL.md' }];
  const invalid = [
    { ...valid, type: ['skill'] },
    { ...valid, name: ['test'] },
    { ...valid, type: { toString: null } },
    { ...valid, name: { toString: null } },
    { ...valid, type: null },
    { ...valid, name: null },
  ];
  const result = validatePrediction({ suggestions: [...invalid, valid] }, catalog, []);
  assert.deepEqual(result.suggestions, [{ ...catalog[0], confidence: 0.9 }]);
  assert.deepEqual(result.dropped, invalid.map(item => ({ kind: 'suggestion', reason: 'invalid-capability', item })));
});

test('autoExpand configuration defaults and threshold boundaries are strict', () => {
  assert.deepEqual(recommendationOptions().autoExpand, { enabled: false, minConfidence: 0.85 });
  assert.deepEqual(recommendationOptions({ autoExpand: { enabled: true } }).autoExpand, { enabled: true, minConfidence: 0.85 });
  for (const minConfidence of [0, 0.85, 1]) {
    assert.deepEqual(recommendationOptions({ autoExpand: { minConfidence } }).autoExpand, { enabled: false, minConfidence });
  }
  for (const autoExpand of [null, false, [], 'true', { enabled: 1 }, { enabled: null }, { extra: true },
    ...[null, false, '0.85', -0.01, 1.01, NaN, Infinity].map(minConfidence => ({ minConfidence }))]) {
    assert.throws(() => recommendationOptions({ autoExpand }));
  }
});

test('file tree is bounded during traversal and respects nested ignores; Skill index stops at entry files', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'preparation-tree-'));
  try {
    await mkdir(path.join(cwd, 'node_modules/huge'), { recursive: true });
    await mkdir(path.join(cwd, 'src/deep/deeper'), { recursive: true });
    for (const dir of ['.claude', '.playwright-mcp', '.other-hidden', 'src/.nested-hidden']) await mkdir(path.join(cwd, dir), { recursive: true });
    await writeFile(path.join(cwd, '.gitignore'), '*.secret\n');
    await writeFile(path.join(cwd, 'src/.gitignore'), 'hidden.txt\n');
    for (const name of ['src/code.ts', 'src/hidden.txt', 'x.secret', '.env', '.urc', '.claude/settings.local.json', '.playwright-mcp/console.log', '.other-hidden/data.txt', 'src/.nested-hidden/data.txt', 'node_modules/huge/x.js', 'src/deep/deeper/too-deep.js']) await writeFile(path.join(cwd, name), 'x');
    const tree = await projectIndex(cwd);
    assert.ok(tree.entries.includes('src/code.ts'));
    assert.ok(tree.entries.includes('.urc'));
    assert.ok(tree.entries.includes('.gitignore'));
    assert.ok(tree.entries.every(e => !e.split('/').slice(0, -1).some(segment => segment.startsWith('.'))));
    assert.doesNotMatch(JSON.stringify(tree.entries), /\.claude|playwright-mcp|other-hidden|nested-hidden/);
    assert.doesNotMatch(JSON.stringify(tree.entries), /node_modules|hidden\.txt|x\.secret|\.env|too-deep/);
    const limited = await projectIndex(cwd, undefined, { maxEntries: 2 });
    assert.ok(limited.entries.length <= 2); assert.equal(limited.truncated, true);
    const stopped = await projectIndex(cwd, undefined, { maxMs: 0 });
    assert.equal(stopped.entries.length, 0); assert.equal(stopped.reason, 'time');
    const file = path.join(cwd, 'SKILL.md');
    const files = skillFileIndex([{ type: 'skill', name: 'test', path: file }], new Map([[file, '[useful](ref.md) [outside](../secret.md) [remote](https://example.com/a.md)']]));
    assert.equal(files.length, 1); assert.equal(files[0].path, file);
    assert.doesNotMatch(JSON.stringify(files), /ref\.md|secret\.md|remote/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('real SDK: single prediction, checked read/bash, child persistence, metadata isolation and early exit', { skip: !root, timeout: 30000 }, async t => {
  // Trajectory content is incidental input here; a stub keeps this test independent
  // of any globally installed pi-snap. Real pi-snap behavior is covered in snap-trajectory.
  await snapPath(t.after.bind(t), '#!/usr/bin/env bash\necho "fixture trajectory"\n');
  const sdk = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
  const piAi = sdkDepDir(root, '@earendil-works/pi-ai');
  const { createAssistantMessageEventStream } = await import(pathToFileURL(path.join(piAi, 'dist/utils/event-stream.js')).href);
  const { resolveTranscriptTools } = await import(pathToFileURL(path.join(piAi, 'dist/utils/transcript.js')).href);
  const { convertToLlm } = await import(pathToFileURL(path.join(root, 'dist/core/messages.js')).href);
  const { convertResponsesMessages } = await import(pathToFileURL(path.join(piAi, 'dist/api/openai-responses-shared.js')).href);
  const cwd = await mkdtemp(path.join(tmpdir(), 'preparation-sdk-'));
  try {
    await mkdir(path.join(cwd, 'skill'));
    const file = path.join(cwd, 'skill/SKILL.md'), body = 'REAL PRIVATE DOCUMENT BODY';
    await writeFile(file, body);
    const parent = sdk.SessionManager.create(cwd, path.join(cwd, 'sessions'));
    parent.appendMessage({ role: 'user', content: 'prepare', timestamp: Date.now() });
    const runtime = await sdk.ModelRuntime.create({ modelsPath: null, authPath: path.join(cwd, 'auth.json'), modelsStorePath: path.join(cwd, 'models-store.json'), refreshOnCreate: false });
    runtime.registerProvider('llama', { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'fixture',
      models: [{ id: 'iq3', name: 'fixture', reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 2048, cost: usage.cost }] });
    const model = runtime.getModel('llama', 'iq3');
    const sdkFixture = { ...sdk, SessionManager: isolatedSessions(sdk, cwd), getAgentDir: () => cwd, ModelRuntime: { create: async () => runtime } };
    let observedPayload, observedSystem, observedInput, expectedLimit = 3, expectedThinking = 'medium';
    let predictions = 0, value = { suggestions: [{ type: 'skill', name: 'test', confidence: 0.8 },
      { type: 'action', confidence: 0.95, tool: 'read', arguments: { path: file } }, { type: 'action', confidence: 0.95, tool: 'bash', arguments: { command: "printf 'CUSTOM BASH RESULT'" } },
    ] };
    const registry = { find: () => model, streamSimple: async (_model, context, requestOptions) => {
      assert.equal(requestOptions.reasoning, expectedThinking);
      assert.notEqual(requestOptions.maxTokens, 1024);
      observedPayload = await requestOptions.onPayload({ model: _model.id }, _model);
      assert.equal(observedPayload.response_format.type, 'json_schema');
      assert.equal(observedPayload.response_format.json_schema.strict, true);
      const schema = observedPayload.response_format.json_schema.schema;
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required, Object.keys(schema.properties));
      assert.deepEqual(Object.keys(schema.properties), ['suggestions']);
      assert.equal(schema.properties.suggestions.maxItems, undefined);
      predictions++;
      assert.deepEqual(resolveTranscriptTools(context.messages, 'none').requestTools, []);
      const system = context.messages.filter(m => m.role === 'system').map(m => m.sections?.preamble ?? m.content).join('\n');
      observedSystem = system;
      assert.ok(!system.includes(JSON.stringify(schema)), 'schema belongs in user context');
      assert.match(system, /bare JSON.*no Markdown.*no code fences/);
      observedInput = context.messages.findLast(m => m.role === 'user').content.filter(p => p.type === 'text').map(p => p.text).join('');
      assert.ok(observedInput.includes(JSON.stringify(schema)));
      assert.ok(observedInput.includes(`Entry path: ${file}`));
      assert.doesNotMatch(system, /Skill entry paths|Skill file index/);
      assert.doesNotMatch(JSON.stringify(context), /REAL PRIVATE DOCUMENT BODY/, 'prediction never receives tool result contents');
      const stream = createAssistantMessageEventStream(), response = answer(Object.fromEntries(Object.entries(value).filter(([key]) => schema.required.includes(key))));
      stream.push({ type: 'start', partial: response }); stream.push({ type: 'done', reason: 'stop', message: response });
      return stream;
    } };
    const ctx = { cwd, modelRegistry: registry, sessionManager: parent, ui: { notify() {} } };
    const args = { sdk: sdkFixture, query: 'prepare', catalog: [{ type: 'skill', name: 'test', description: 'Test documents', path: file }],
      ctx, options: { enabled: true, actionPrediction: true, maxSuggestedActions: 3, autoExpand: { enabled: true } }, signal: AbortSignal.timeout(15000) };
    const result = await runPrefetch(args);
    assert.equal(predictions, 1); assert.equal(result.prefetch.failure, undefined);
    assert.equal(result.prefetch.rounds.length, 2);
    assert.equal(result.prefetch.rounds[0].messages[1].content[0].text, body);
    assert.equal(result.prefetch.rounds[1].messages[1].isError, false);
    assert.match(JSON.stringify(result.prefetch.rounds[1].messages[1]), /CUSTOM BASH RESULT/);
    const child = sdk.SessionManager.open(result.diagnostics.discoverySessionFile);
    assert.equal(child.getSessionId(), result.diagnostics.discoverySessionId);
    assert.equal(path.dirname(result.diagnostics.discoverySessionFile), path.join(cwd, 'sessions', 'fixture-predictions'),
      'prediction transcripts persist in the isolated sessions tree');
    assert.ok(path.basename(result.diagnostics.discoverySessionFile).endsWith(`_${result.diagnostics.discoverySessionId}.jsonl`),
      'SDK default timestamp_ID.jsonl naming is preserved');
    assert.equal(child.getSessionName(), `pi-discovery · preparation · llama/iq3 · ${result.diagnostics.discoverySessionId}`);
    const origin = child.getEntries().find(e => e.customType === 'capability-recommendation-origin');
    assert.equal(origin.data.parentSessionId, parent.getSessionId());
    assert.equal(origin.data.parentSessionFile, parent.getSessionFile());
    assert.equal(origin.data.parentLeafId, parent.getLeafId());
    const outcomeEntry = child.getEntries().find(e => e.customType === 'capability-recommendation-outcome');
    assert.equal(outcomeEntry.data.parentSessionId, parent.getSessionId(),
      'child outcome entry names the session it recommended for');
    assert.equal(outcomeEntry.data.parentSessionFile, parent.getSessionFile());
    assert.equal(outcomeEntry.data.discoverySessionId, result.diagnostics.discoverySessionId);
    assert.equal(child.buildSessionContext().messages.filter(m => m.role === 'toolResult').length, 2);
    assert.ok(result.diagnostics.totalMs >= result.diagnostics.inferenceMs);
    assert.equal(result.diagnostics.endReason, 'actions-complete');

    // Mixed valid/invalid output must reach dispatch without losing valid work.
    const validValue = value, traceEvents = [];
    value = { suggestions: [{ type: 'skill', name: 'unknown', confidence: 1 },
      { type: 'action', confidence: 0.95, tool: 'read', arguments: { path: '/outside' } },
      { type: 'action', confidence: 0.95, tool: 'bash', command: 'must not execute' }, ...value.suggestions,
    ] };
    const partial = await runPrefetch({ ...args, trace: (event, data) => traceEvents.push({ event, ...data }) });
    assert.equal(partial.prefetch.failure, undefined);
    assert.equal(partial.suggestions.length, 3);
    assert.equal(partial.prefetch.rounds.length, 2);
    assert.equal(partial.diagnostics.dropped.length, 3);
    assert.deepEqual(traceEvents.find(e => e.event === 'drop').dropped, partial.diagnostics.dropped);
    const partialChild = sdk.SessionManager.open(partial.diagnostics.discoverySessionFile);
    assert.deepEqual(partialChild.getEntries().find(e => e.customType === 'capability-recommendation-outcome').data.dropped,
      partial.diagnostics.dropped);
    assert.equal(partialChild.getEntries().find(e => e.customType === 'capability-recommendation-outcome').data.parentSessionId,
      parent.getSessionId(), 'even degraded runs keep the parent linkage in their outcome entry');
    const failed = await runPrefetch({ ...args, ctx: { ...ctx, modelRegistry: { ...registry,
      streamSimple: async () => { throw new Error('HTTP 429 fixture transport unavailable'); } } },
      trace: (event, data) => traceEvents.push({ event, ...data }) });
    assert.equal(failed.prefetch.failure, 'prediction-error');
    assert.equal(failed.fallback, 'full-catalog');
    assert.match(failed.routingError, /HTTP 429/);
    assert.deepEqual(failed.suggestions, args.catalog.map(c => ({ ...c, confidence: null })));
    assert.deepEqual(failed.prefetch.rounds, []);
    assert.equal(typeof traceEvents.findLast(e => e.event === 'failure').error, 'string');
    assert.ok(traceEvents.findLast(e => e.event === 'failure').error.length);
    value = validValue;

    // Recommendation and expansion are independent; threshold equality is inclusive.
    const expansionValue = value;
    const actionAtThreshold = { type: 'action', tool: 'bash', arguments: { command: "printf 'THRESHOLD RESULT'" }, confidence: 0.85 };
    value = { suggestions: [actionAtThreshold] };
    const recommendOnly = await runPrefetch({ ...args, options: { ...args.options, autoExpand: { enabled: false } } });
    assert.deepEqual(recommendOnly.suggestions, [actionAtThreshold]);
    assert.equal(recommendOnly.prefetch.rounds.length, 0);
    value = { suggestions: [{ ...actionAtThreshold, confidence: 0.849 }] };
    const lowScore = await runPrefetch(args);
    assert.deepEqual(lowScore.suggestions, value.suggestions);
    assert.equal(lowScore.prefetch.rounds.length, 0);
    value = { suggestions: [actionAtThreshold] };
    const equalScore = await runPrefetch(args);
    assert.equal(equalScore.prefetch.rounds.length, 1);
    assert.match(JSON.stringify(equalScore.prefetch.rounds), /THRESHOLD RESULT/);

    value = { suggestions: [{ type: 'skill', name: 'test', confidence: 0.85 }] };
    const skillOnly = await runPrefetch({ ...args, options: { ...args.options, actionPrediction: false } });
    assert.equal(skillOnly.prefetch.reads, 1);
    assert.equal(skillOnly.prefetch.rounds[0].messages[1].content[0].text, body);
    assert.equal(skillOnly.suggestions[0].path, file);
    value = { suggestions: [...value.suggestions,
      { type: 'action', tool: 'read', arguments: { path: file }, confidence: 0.95 }] };
    const sharedRead = await runPrefetch(args);
    assert.equal(sharedRead.suggestions.length, 2);
    assert.equal(sharedRead.prefetch.reads, 1, 'automatic Skill read and explicit read share deduplication');
    assert.equal(sharedRead.prefetch.rounds.length, 1);

    const expansionCatalog = [...args.catalog, { type: 'mcp', name: 'mcp__fixture', description: 'Fixture service' },
      { type: 'tool', name: 'inspect', description: 'Fixture tool' }];
    value = { suggestions: [{ type: 'mcp', name: 'mcp__fixture', confidence: 0.85 },
      { type: 'tool', name: 'inspect', confidence: 0.9 }] };
    const expansions = [];
    const expanded = await runPrefetch({ ...args, catalog: expansionCatalog,
      options: { ...args.options, actionPrediction: false },
      expandCapability: async (suggestion, id, signal) => {
        assert.equal(typeof id, 'string');
        assert.ok(signal instanceof AbortSignal);
        expansions.push(suggestion);
        return { content: [{ type: 'text', text: `EXPANDED ${suggestion.name}` }], details: {} };
      } });
    assert.deepEqual(expansions.map(s => s.type), ['mcp', 'tool']);
    assert.deepEqual(expansions.map(s => s.description), ['Fixture service', 'Fixture tool']);
    assert.equal(expanded.prefetch.rounds.length, 2);
    assert.match(JSON.stringify(expanded.prefetch.rounds), /EXPANDED mcp__fixture/);
    assert.match(JSON.stringify(expanded.prefetch.rounds), /EXPANDED inspect/);
    // Cancellation in the last expansion must not masquerade as completion or
    // an ordinary tool error, and the dispatched call/result remain evidence.
    for (const throws of [false, true]) {
      const controller = new AbortController();
      value = { suggestions: [{ type: 'tool', name: 'inspect', confidence: 0.9 }] };
      const aborted = await runPrefetch({ ...args, catalog: expansionCatalog, signal: controller.signal,
        options: { ...args.options, actionPrediction: false },
        expandCapability: async () => {
          controller.abort(new Error('LAST EXPANSION ABORT'));
          if (throws) controller.signal.throwIfAborted();
          return { content: [{ type: 'text', text: 'LAST EXPANSION RETURNED' }], details: {} };
        } });
      assert.equal(aborted.prefetch.failure, 'cancelled-or-timeout');
      assert.equal(aborted.diagnostics.endReason, 'cancelled-or-timeout');
      assert.equal(aborted.prefetch.rounds.length, 1);
      const [call, execution] = aborted.prefetch.rounds[0].messages;
      assert.equal(execution.toolCallId, call.content[0].id);
      assert.equal(execution.isError, throws);
      assert.match(JSON.stringify(execution), throws ? /LAST EXPANSION ABORT/ : /LAST EXPANSION RETURNED/);
      const abortedChild = sdk.SessionManager.open(aborted.diagnostics.discoverySessionFile);
      const persisted = abortedChild.buildSessionContext().messages.filter(m => m.role === 'toolResult');
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].toolCallId, execution.toolCallId);
      assert.deepEqual(persisted[0].content, execution.content);
      assert.deepEqual(aborted.suggestions, [{ ...expansionCatalog.at(-1), confidence: 0.9 }]);
    }
    value = expansionValue;

    const initialValue = value;
    expectedLimit = 0;
    const beforeWarnings = predictions;
    const disabled = await runPrefetch({ ...args, options: {} });
    assert.equal(predictions, beforeWarnings, 'preparation never runs trajectory analysis');
    assert.equal(disabled.prefetch.requests, 0);
    value = { suggestions: [{ type: 'skill', name: 'test', confidence: 1 }] };
    const capabilityOnly = await runPrefetch({ ...args, options: { enabled: true } });
    assert.equal(capabilityOnly.prefetch.failure, undefined);
    assert.equal(capabilityOnly.diagnostics.tree.entries, 0);
    assert.notEqual(capabilityOnly.diagnostics.discoverySessionFile, result.diagnostics.discoverySessionFile);
    assert.notEqual(capabilityOnly.diagnostics.discoverySessionId, result.diagnostics.discoverySessionId);
    assert.doesNotMatch(observedSystem, /## Preparation actions|## Trajectory warnings/);
    expectedLimit = 3;
    value = { suggestions: [] };
    const withActions = await runPrefetch({ ...args, options: { enabled: true, actionPrediction: true } });
    assert.equal(withActions.prefetch.failure, undefined);
    assert.match(observedSystem, /## Capability suggestions/);
    assert.match(observedSystem, /## Preparation actions/);
    assert.doesNotMatch(observedSystem, /## Trajectory warnings/);
    value = initialValue;

    // A projected full read suppresses host calls, not just their display.
    const readPaths = new Set([readPathKey(file, cwd)]);
    const originalValue = value;
    value = { suggestions: [{ type: 'action', confidence: 0.95, tool: 'read', arguments: { path: file } }] };
    const dedup = await runPrefetch({ ...args, readPaths });
    assert.equal(dedup.prefetch.rounds.length, 0);
    assert.ok(observedInput.includes(file));
    assert.match(observedSystem, /already retained/i);
    assert.equal(dedup.diagnostics.skipped[0].reason, 'already-read');
    const dedupChild = sdk.SessionManager.open(dedup.diagnostics.discoverySessionFile);
    assert.equal(dedupChild.buildSessionContext().messages.filter(m => m.role === 'toolResult').length, 0);
    readPaths.clear();
    value.suggestions.push({ type: 'action', confidence: 0.95, tool: 'read', arguments: { path: 'project:skill/SKILL.md' } });
    const firstRead = await runPrefetch({ ...args, readPaths });
    assert.equal(firstRead.prefetch.reads, 1);
    assert.equal(firstRead.diagnostics.skipped.length, 1);
    assert.ok(readPaths.has(readPathKey(file, cwd)));
    value = { suggestions: [{ type: 'action', confidence: 0.95, tool: 'bash', arguments: { command: 'printf invalidation' } }, { type: 'action', confidence: 0.95, tool: 'read', arguments: { path: file } }] };
    const afterBash = await runPrefetch({ ...args, readPaths });
    assert.equal(afterBash.prefetch.rounds.length, 2);
    assert.equal(afterBash.prefetch.reads, 1);
    const retainedReads = new Map([[readPathKey(file, cwd), afterBash.prefetch.rounds[1].messages[1]]]);
    value = { suggestions: [{ type: 'action', confidence: 0.95, tool: 'read', arguments: { path: file } }] };
    const unchanged = await runPrefetch({ ...args, readPaths: new Set(), retainedReads });
    assert.equal(unchanged.prefetch.rounds.length, 0);
    assert.equal(unchanged.diagnostics.skipped[0].reason, 'retained-content-unchanged');
    await writeFile(file, 'CHANGED BODY');
    const changed = await runPrefetch({ ...args, readPaths: new Set(), retainedReads });
    assert.equal(changed.prefetch.reads, 1);
    assert.equal(changed.prefetch.rounds[0].messages[1].content[0].text, 'CHANGED BODY');
    await writeFile(file, body);
    const compacted = await runPrefetch({ ...args, readPaths: new Set(), retainedReads: new Map() });
    assert.equal(compacted.prefetch.reads, 1);
    const largeCatalog = [...args.catalog, ...Array.from({ length: 150 }, (_, i) => ({ type: 'skill', name: `extra${i}`, path: path.join(cwd, `long-directory-${'x'.repeat(80)}-${i}`, 'SKILL.md') }))];
    for (const item of largeCatalog) readPaths.add(readPathKey(item.path, cwd));
    value = { suggestions: [] };
    await runPrefetch({ ...args, catalog: largeCatalog, readPaths });
    assert.match(observedInput, /List truncated: true/);
    assert.ok(observedInput.split('## Currently retained reads')[1].split('## Current task')[0].length <= 6200);
    value = originalValue;

    value = { suggestions: [{ type: 'skill', name: 'test', confidence: 0.8 }, { type: 'mcp', name: 'mcp__pending', confidence: 0.8 },
      { type: 'tool', name: 'notify', confidence: 0.7 }, { type: 'tool', name: 'subagent_start', confidence: 0.6 }, ...value.suggestions.filter(s => s.type === 'action')] };
    const hook = setup({ sdk: sdkFixture,
      tools: [{ name: 'mcp__ready__inspect', exposure: 'deferred', namespace: { name: 'mcp__ready', description: 'Ready service' } },
        { name: 'notify', exposure: 'deferred', description: 'Notify the user' },
        { name: 'subagent_start', exposure: 'codemode', description: 'Delegate a task' },
        { name: 'hidden_tool', exposure: 'hidden', description: 'Not available' }],
      sections: { mcp_servers: '- mcp__pending (tool_search): Pending service\n- mcp__undescribed (codemode)\n- mcp__ready (tool_search): Ready service' },
      settings: { capabilityDiscovery: { recommendation: { enabled: true, actionPrediction: true, maxSuggestedActions: 3, autoExpand: { enabled: true } } } },
      mcpWait: () => assert.fail('must not wait for MCP') });
    const accepted = await hook.handlers.before_agent_start({ prompt: 'prepare', systemPromptOptions: {
      skills: [{ name: 'test', description: 'Test', filePath: file }], sections: {} } }, ctx);
    assert.equal(accepted.message.customType, 'capability-preparation-boundary');
    assert.equal(accepted.message.display, false);
    const replacement = await hook.handlers.message_end({ message: { ...accepted.message, role: 'custom' } }, ctx);
    assert.equal(replacement.message.customType, PREFETCH_TYPE);
    assert.equal(hook.sent.length, 0, 'the boundary replacement must not also queue a duplicate carrier');
    const prepared = await hook.handlers.context({ messages: [replacement.message] }, ctx);
    const output = { message: prepared.messages.find(m => m.customType === PREFETCH_TYPE) };
    assert.equal(output.message.customType, PREFETCH_TYPE);
    assert.deepEqual(output.message.details.suggestions.map(s => s.type), ['skill', 'mcp', 'tool', 'tool', 'action', 'action']);
    assert.ok(observedPayload.response_format.json_schema.schema.properties.suggestions.items.anyOf.every(branch => !branch.properties.id));
    const ids = observedInput;
    for (const id of ['skill:test', 'mcp:mcp__pending', 'mcp:mcp__ready', 'mcp:mcp__undescribed', 'tool:notify', 'tool:subagent_start']) assert.ok(ids.includes(id));
    assert.ok(!ids.includes('tool:hidden_tool'));
    const recommendationSession = sdk.SessionManager.open(hook.diagnostics.findLast(e => e.data.event === 'complete').data.discoverySessionFile);
    const savedSchema = recommendationSession.getEntries().find(e => e.customType === 'capability-recommendation-schema');
    assert.deepEqual(savedSchema.data, observedPayload.response_format.json_schema);
    assert.deepEqual([...observedInput.matchAll(/^### (mcp:[a-z_]+)/gm)].map(m => m[1]).sort(),
      ['mcp:mcp__pending', 'mcp:mcp__ready', 'mcp:mcp__undescribed']);
    assert.equal(hook.diagnostics.findLast(e => e.data.event === 'complete').data.capabilities.mcp, 3);
    assert.equal(output.message.details.diagnostics, undefined);
    const projected = projectPrefetch([{ ...output.message, role: 'custom' }]);
    assert.deepEqual(projectPrefetch(projected), projected);
    const provider = convertResponsesMessages({ ...model, provider: 'openai-codex', api: 'openai-codex-responses' },
      { messages: convertToLlm(projected) }, new Set());
    assert.equal(provider.filter(m => m.type === 'function_call').length, 2);
    assert.equal(provider.filter(m => m.type === 'function_call_output').length, 2);
    assert.doesNotMatch(JSON.stringify(provider), /discoverySession|inferenceMs|endReason|totalMs/);
    assert.ok(hook.diagnostics.findLast(e => e.data.event === 'complete').data.discoverySessionFile);
    assert.equal(hook.diagnostics.findLast(e => e.data.event === 'complete').data.requests, 1);

    expectedLimit = 0;
    value = { suggestions: [{ type: 'skill', name: 'test', confidence: 1 }] };
    const zero = setup({ sdk: sdkFixture, settings: { capabilityDiscovery: { recommendation: { enabled: true, actionPrediction: true, maxSuggestedActions: 0 } } },
      mcpWait: () => assert.fail('zero-action mode must not wait for MCP') });
    const zeroEvent = { prompt: 'recommend only', systemPromptOptions: { skills: [{ name: 'test', description: 'Test', filePath: file }], sections: {} } };
    assert.equal(await zero.handlers.before_agent_start(zeroEvent, ctx), undefined);
    const zeroContext = await zero.handlers.context({ messages: [] }, ctx);
    const zeroOutput = { message: zeroContext.messages.find(m => m.customType === PREFETCH_TYPE) };
    assert.equal(zeroOutput.message.details.suggestions.length, 1);
    assert.equal(zeroOutput.message.details.prefetch.rounds.length, 0);
    assert.equal(zero.diagnostics.findLast(e => e.data.event === 'complete').data.tree.entries, 0);
    assert.equal(zero.diagnostics.findLast(e => e.data.event === 'complete').data.requests, 1);
    expectedLimit = 3;

    value = { suggestions: [] }; predictions = 0;
    const empty = await runPrefetch({ ...args, query: '谢谢，先这样。' });
    assert.equal(predictions, 1); assert.equal(empty.prefetch.rounds.length, 0);
    assert.equal(empty.diagnostics.endReason, 'no-actions-needed');
    assert.match(await readFile(empty.diagnostics.discoverySessionFile, 'utf8'), /谢谢/);

    for (const level of ['off', 'low', 'high']) {
      expectedThinking = level === 'off' ? undefined : level;
      const configured = await runPrefetch({ ...args, options: { ...args.options,
        thinkingLevel: level } });
      assert.equal(configured.prefetch.failure, undefined);
    }
    expectedThinking = 'medium';

    value = { suggestions: [{ type: 'action', confidence: 0.95, tool: 'bash', arguments: { command: 42 } }] };
    const bad = await runPrefetch(args);
    assert.equal(bad.prefetch.failure, undefined); assert.equal(bad.prefetch.rounds.length, 0);
    assert.equal(bad.diagnostics.dropped[0].reason, 'invalid-action');
    assert.match(await readFile(bad.diagnostics.discoverySessionFile, 'utf8'), /invalid-action/, 'invalid prediction is retained as evidence, not executed');

    const cancelled = await runPrefetch({ ...args, rules: 'SETUP RULE EVIDENCE', signal: AbortSignal.abort() });
    assert.equal(cancelled.diagnostics.endReason, 'cancelled-or-timeout');
    assert.match(await readFile(cancelled.diagnostics.discoverySessionFile, 'utf8'), /prepare/);
    assert.equal(cancelled.diagnostics.requests, 0);
    const cancelledChild = sdk.SessionManager.open(cancelled.diagnostics.discoverySessionFile);
    const savedInput = cancelledChild.getEntries().find(e => e.type === 'message' && e.message.role === 'user').message.content;
    assert.match(savedInput, /prepare/);
    assert.doesNotMatch(savedInput, /SETUP RULE EVIDENCE/, 'disabled warning context is omitted');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('live IQ3 through the full discovery entry includes configured MCP metadata', { skip: !root || process.env.PI_DISCOVERY_PREFETCH_LIVE !== '1', timeout: 60000 }, async () => {
  const sdk = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
  const { homedir } = await import('node:os');
  const { loadSkillsFromDir } = await import(pathToFileURL(path.join(root, 'dist/core/skills.js')).href);
  const { renderServersSection } = await import(pathToFileURL(path.join(root, 'dist/extensions/mcp/index.js')).href);
  const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false });
  const { skills } = loadSkillsFromDir({ dir: path.join(homedir(), '.agents/skills'), source: 'user' });
  // Native rendering of real configured service metadata. No transport is started.
  const config = JSON.parse(await readFile(path.join(sdk.getAgentDir(), 'mcp.json'), 'utf8'));
  const section = renderServersSection(Object.entries(config.mcpServers).map(([name, config]) => ({ entry: { name, config } })));
  // Real agent dir above is read-only metadata. Everything written below stays in a
  // temp scope: parent sessions and the prediction sessions never touch the host.
  const scope = await mkdtemp(path.join(tmpdir(), 'preparation-live-'));
  try {
    await mkdir(path.join(scope, 'agent'), { recursive: true });
    const parent = sdk.SessionManager.create(process.cwd(), path.join(scope, 'sessions'));
    parent.appendSessionInfo('capability-preparation · live regression');
    const cases = ['谢谢，先这样，不用继续做了。', '查一下 GLM 的额度使用情况。',
      '请用浏览器查看已登录的网页，让子 Agent 独立复核，并在完成后通知我。'];
    for (const query of cases) {
      parent.appendMessage({ role: 'user', content: query, timestamp: Date.now() });
      // Bash is not needed by these cases; block accidental live effects. Real native
      // Bash execution of generated text is exercised in the deterministic SDK test.
      const liveSdk = { ...sdk, SessionManager: isolatedSessions(sdk, path.join(scope, 'agent')), getAgentDir: () => path.join(scope, 'agent'),
        createBashToolDefinition: () => ({ execute() { throw new Error('Unexpected Bash in live read-only test'); } }) };
      const recommendationOnly = query.startsWith('请用浏览器');
      const hook = setup({ sdk: liveSdk, sections: { mcp_servers: section },
        tools: [{ name: 'notify', exposure: 'deferred', description: 'Send a notification to the user when work finishes' },
          { name: 'subagent_start', exposure: 'codemode', description: 'Start a subagent for independent review or delegated work' }],
        settings: { capabilityDiscovery: { recommendation: { enabled: true, actionPrediction: true, maxSuggestedActions: recommendationOnly ? 0 : 3, autoExpand: { enabled: !recommendationOnly } } } },
        mcpWait: () => assert.fail('metadata-only recommendation must not wait for MCP') });
      const append = hook.pi.appendEntry;
      hook.pi.appendEntry = (type, data) => { append(type, data); parent.appendCustomEntry(type, data); };
      const ctx = { cwd: process.cwd(), modelRegistry: new sdk.ModelRegistry(runtime), sessionManager: parent,
        ui: { notify: (...args) => console.log('live warning', ...args) } };
      await hook.handlers.before_agent_start({ prompt: query, systemPromptOptions: { skills, sections: {} } }, ctx);
      await hook.handlers.context({ messages: parent.buildSessionContext().messages }, ctx);
      const output = { message: hook.sent.at(-1)?.message };
      const result = hook.diagnostics.findLast(r => r.data.event === 'complete').data;
      const calls = output?.message?.details.prefetch.rounds.flatMap(r => r.messages[0].content) ?? [];
      if (output.message) parent.appendCustomMessageEntry(output.message.customType, output.message.content, false, output.message.details);
      console.log(JSON.stringify({ query, ...result, calls }));
      assert.equal(result.failure, undefined); assert.equal(result.requests, 1);
      assert.ok(result.capabilities.mcp > 0);
      if (recommendationOnly) {
        assert.equal(calls.length, 0);
        const names = output.message.details.suggestions.map(s => s.name);
        for (const name of ['mcp__playwright', 'subagent_start', 'notify']) assert.ok(names.includes(name), `missing ${name}`);
        assert.equal(result.capabilities.tool, 2);
      } else if (query.startsWith('谢谢')) assert.equal(calls.length, 0);
      else {
        assert.equal(calls.length, 1);
        assert.ok(calls.every(c => !c.arguments.path?.includes('references')));
        assert.ok(calls.some(c => c.arguments.path?.includes('practical-memory') && path.basename(c.arguments.path) === 'SKILL.md'));
        assert.ok(calls.every(c => c.name === 'read'), 'quota preparation does not need Bash');
      }
      const child = sdk.SessionManager.open(result.discoverySessionFile);
      const system = child.buildSessionContext().messages.filter(m => m.role === 'system').map(m => m.sections?.preamble ?? m.content).join("\n");
      const input = child.buildSessionContext().messages.find(m => m.role === 'user').content;
      assert.match(JSON.stringify(input), /mcp:mcp__/);
      assert.match(JSON.stringify(input), /Entry path: .*SKILL.md/);
      assert.doesNotMatch(system, /Skill entry paths|Skill file index/);
    }
  } finally { await rm(scope, { recursive: true, force: true }); }
});

test('thinking settings validate independently and preserve all supported levels', () => {
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(recommendationOptions({ thinkingLevel: level }).thinkingLevel, level);
    assert.equal(toolSearchOptions({ thinkingLevel: level }).thinkingLevel, level);
  }
  for (const parse of [recommendationOptions, toolSearchOptions]) {
    for (const value of [null, false, 1, '', 'Medium', 'typo']) {
      assert.throws(() => parse({ thinkingLevel: value }), /thinkingLevel/);
    }
  }
});

test('boundary budgets are configurable per option group', () => {
  assert.equal(trajectoryOptions().timeoutMs, 60_000);
  assert.equal(trajectoryOptions({ timeoutMs: 5_000 }).timeoutMs, 5_000);
  assert.equal(recommendationOptions({ timeoutMs: 600_000 }).timeoutMs, 600_000);
  for (const value of [null, false, '60', 999, 600_001, 2.5]) {
    assert.throws(() => trajectoryOptions({ timeoutMs: value }), /timeoutMs/);
    assert.throws(() => recommendationOptions({ timeoutMs: value }), /timeoutMs/);
  }
});

test('malformed predictions degrade per item; warnings never enter preparation output', () => {
  assert.deepEqual(validatePrediction(null, [], []), { suggestions: [], dropped: [{ kind: 'response', reason: 'not-an-object' }] });
  const result = validatePrediction({ suggestions: [], warnings: [] }, [], [],
    { actionPrediction: true });
  assert.deepEqual(result, { suggestions: [], dropped: [{ kind: 'field', reason: 'unknown-field', item: 'warnings' }] });
  const missing = validatePrediction({ suggestions: [{ type: 'skill', name: 'unknown', confidence: 1 }] }, [], [], { actionPrediction: true });
  assert.deepEqual(missing.suggestions, []);
  assert.deepEqual(missing.dropped.filter(d => d.reason === 'invalid-capability').length, 1);
  assert.equal(missing.dropped.length, 1);
  const outside = validatePrediction({ suggestions: [{ type: 'action', confidence: 0.95, tool: 'read', arguments: { path: '/outside' } }] }, [], [], { actionPrediction: true });
  assert.deepEqual(outside.suggestions, []);
  assert.deepEqual(outside.dropped, [{ kind: 'action', reason: 'invalid-action', item: { type: 'action', confidence: 0.95, tool: 'read', arguments: { path: '/outside' } } }]);
  const malformed = validatePrediction({ suggestions: 'all skills' }, [], [], { actionPrediction: true });
  assert.deepEqual(malformed.suggestions, []);
  assert.deepEqual(malformed.dropped.map(d => [d.kind, d.reason]).sort(), [['suggestion', 'not-an-array']]);
});

test('warning trigger settings are strict and independent', () => {
  for (const value of [0, 1, 5, 1000]) assert.equal(trajectoryOptions({ everySteps: value }).everySteps, value);
  for (const value of [-1, 1001, 1.5, null, '5', false]) assert.throws(() => trajectoryOptions({ everySteps: value }));
  assert.throws(() => recommendationOptions({ trajectoryWarningOnUserInput: false }), /accepts only/);
  for (const value of [null, 0, 'true']) assert.throws(() => recommendationOptions({ trajectoryWarningOnUserInput: value }));
});

test('all switches disabled makes zero requests; configured model rejects unsupported APIs clearly', async () => {
  const disabled = await runPrefetch({ options: {} });
  assert.equal(disabled.prefetch.requests, 0);
  assert.equal(disabled.warnings, undefined);
  const ctx = { modelRegistry: { find(provider, model) {
    assert.equal(provider, 'custom'); assert.equal(model, 'chosen');
    return { api: 'anthropic-messages' };
  } } };
  await assert.rejects(runPrefetch({ ctx, options: { model: 'custom/chosen', enabled: true } }), /custom\/chosen.*only openai-completions/);
});

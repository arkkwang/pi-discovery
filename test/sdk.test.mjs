import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sdkDepDir } from './helpers.mjs';

const sdkRoot = process.env.PI_DISCOVERY_SDK_ROOT;
test('real Pi loader/runner renders short catalog with default and custom SYSTEM prompts', { skip: !sdkRoot }, async () => {
  const sdk = suffix => import(pathToFileURL(path.join(sdkRoot, 'dist', suffix)).href);
  const { loadExtensions } = await sdk('core/extensions/loader.js');
  const { ExtensionRunner } = await sdk('core/extensions/runner.js');
  const { buildSystemPrompt } = await sdk('core/system-prompt.js');
  const { loadSkillsFromDir } = await sdk('core/skills.js');
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-discovery-'));
  try {
    await mkdir(path.join(cwd, 'example'));
    await writeFile(path.join(cwd, 'example', 'SKILL.md'), '---\nname: unique-test-skill\ndescription: Unique searchable 图片 description\nmetadata:\n  catalog-description: 图片创作短说明\n---\nSecret body only loaded through read.\n');
    const { skills, diagnostics } = loadSkillsFromDir({ dir: cwd, source: 'test' });
    assert.equal(skills.length, 1);
    assert.deepEqual(diagnostics, []);
    const loaded = await loadExtensions([fileURLToPath(new URL('../index.js', import.meta.url))], cwd);
    assert.deepEqual(loaded.errors, []);
    let active = ['read', 'tool_search'];
    loaded.runtime.getSettings = () => ({});
    loaded.runtime.getActiveTools = () => active;
    loaded.runtime.setActiveTools = names => { active = names; };
    loaded.runtime.getAllTools = () => [{ name: 'mcp__test__inspect', description: 'Inspect test data', parameters: { type: 'object', properties: {} }, exposure: 'deferred', namespace: { name: 'mcp__test', description: 'Inspect test data' } }];
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, undefined, undefined);
    const errors = [];
    runner.onError(error => errors.push(error));
    for (const customPrompt of [undefined, 'Custom SYSTEM.md content']) {
      const input = { cwd, skills, selectedTools: ['read', 'tool_search'], customPrompt, sections: { mcp_servers: 'Existing MCP directory' } };
      assert.match(buildSystemPrompt(input), /unique-test-skill/);
      const { systemPromptOptions } = await runner.emitBeforeAgentStart('unmatched-request', undefined, input);
      const rendered = buildSystemPrompt(systemPromptOptions);
      assert.match(rendered, /unique-test-skill — 图片创作短说明/);
      assert.doesNotMatch(rendered, /Unique searchable|Secret body/);
      assert.ok(!rendered.includes(skills[0].filePath));
      assert.match(rendered, /tool_search/);
      assert.doesNotMatch(rendered, /<mcp_servers>|Existing MCP directory|pi_discovery/);
      if (customPrompt) assert.match(rendered, /Custom SYSTEM.md content/);
      const matched = await runner.emitBeforeAgentStart('图片', undefined, input);
      const recommendation = buildSystemPrompt(matched.systemPromptOptions);
      assert.match(recommendation, /unique-test-skill/);
      assert.doesNotMatch(recommendation, /Secret body/);
      assert.equal(input.skills.length, 1, 'base resources must not be mutated');
      const tool = loaded.extensions[0].tools.get('tool_search').definition;
      const result = await tool.execute('test', { query: 'unique-test-skill' });
      assert.equal(result.details.total, 1);
      assert.equal(result.details.suggestions[0].path, skills[0].filePath);
      assert.equal(result.details.suggestions[0].description, skills[0].description);
      assert.doesNotMatch(JSON.stringify(result), /Secret body/);
      const mcp = await tool.execute('mcp', { query: 'mcp__test' });
      assert.ok(active.includes('mcp__test__inspect'));
      assert.deepEqual(mcp.details.suggestions[0], { type: 'mcp', name: 'mcp__test', description: 'Inspect test data', confidence: null });
    }
    assert.deepEqual(errors, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('real MCP factory waits for pending discovery, preserves schema identity and loads once', { skip: !sdkRoot, timeout: 15000 }, async () => {
  const sdk = suffix => import(pathToFileURL(path.join(sdkRoot, 'dist', suffix)).href);
  const { createMcpExtension } = await sdk('extensions/mcp/index.js');
  const { createToolSearchExtension } = await sdk('extensions/tool-search/index.js');
  const { isToolSearchTool } = await sdk('extensions/tool-search/tool.js');
  const { registerDiscovery } = await import('../discovery.js');
  const { createInMemoryTransportPair } = await import(pathToFileURL(path.join(sdkDepDir(sdkRoot, '@earendil-works/pi-mcp'), 'dist/testing/index.js')).href);
  const cwd = await mkdtemp(path.join(tmpdir(), 'unified-mcp-'));
  const { client, server } = createInMemoryTransportPair();
  await server.start();
  let releaseList, gotList;
  const listRequested = new Promise(resolve => { gotList = resolve; });
  server.onMessage(message => {
    if (message.method === 'initialize') void server.send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' },
    } });
    if (message.method === 'tools/list') {
      releaseList = () => server.send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'inspect', description: 'Inspect test data', inputSchema: { type: 'object', properties: {} } },
        { name: 'secret', description: 'Hidden test data', inputSchema: { type: 'object', properties: {} } },
      ] } });
      gotList();
    }
  });
  const handlers = new Map(), tools = new Map(), notices = [];
  let active = ['read', 'tool_search'], changes = 0;
  const pi = {
    on: (name, handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, registerToolRenderer() {},
    getMcpServers: () => [], getSettings: () => ({}), getAllTools: () => [...tools.values()],
    getActiveTools: () => active, setActiveTools: names => { active = names; changes++; },
  };
  registerDiscovery(pi, { createToolSearchExtension, createMcpExtension: () => createMcpExtension({
    loadConfig: () => ({ errors: [], servers: [{ name: 'test', source: path.join(cwd, 'mcp.json'), scope: 'global',
      config: { command: 'unused-in-memory-transport', exposure: 'deferred', description: 'Test namespace', toolExposure: { secret: 'hidden' } } }] }),
    createTransport: () => client, logPath: path.join(cwd, 'mcp.log'), credentials: {},
  }) });
  const ctx = { cwd, ui: { notify: (...args) => notices.push(args) }, signal: AbortSignal.timeout(10000) };
  const emit = async (name, event) => { for (const h of handlers.get(name) ?? []) await h(event, ctx); };
  try {
    await emit('session_start', {});
    const options = { skills: [], sections: {} };
    await emit('before_agent_start', { systemPromptOptions: options });
    assert.match(options.sections.available_capabilities, /mcp__test: Test namespace/);
    assert.equal(options.sections.mcp_servers, undefined);
    const tool = tools.get('tool_search');
    assert.ok(isToolSearchTool(tool));
    assert.ok(!isToolSearchTool({ ...tool, parameters: structuredClone(tool.parameters) }));
    let ready = false;
    const waiting = emit('tool_call', { toolName: 'tool_search', input: { query: 'mcp__test' } }).then(() => { ready = true; });
    await listRequested;
    assert.equal(ready, false, 'search must wait until tool registration completes');
    await releaseList(); await waiting;
    assert.ok(tools.has('mcp__test__inspect'));
    const first = await tool.execute('one', { query: 'mcp__test' });
    assert.deepEqual(first.details.loaded, ['mcp__test__inspect']);
    assert.ok(!active.includes('mcp__test__secret'));
    const second = await tool.execute('two', { query: 'mcp__test' });
    assert.deepEqual(second.details.loaded, []);
    assert.deepEqual(second.details.availableTools, ['mcp__test__inspect']);
    assert.equal(changes, 1, 'no repeated activation');
  } finally {
    await emit('session_shutdown', {}); await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('resource loader replaces both built-ins once; settings and request additions preserve old prefixes', { skip: !sdkRoot }, async () => {
  const sdk = suffix => import(pathToFileURL(path.join(sdkRoot, 'dist', suffix)).href);
  const { DefaultResourceLoader } = await sdk('core/resource-loader.js');
  const { SettingsManager } = await sdk('core/settings-manager.js');
  const { createMcpExtension } = await sdk('extensions/mcp/index.js');
  const { createToolSearchExtension } = await sdk('extensions/tool-search/index.js');
  const ai = suffix => import(pathToFileURL(path.join(sdkDepDir(sdkRoot, '@earendil-works/pi-ai'), 'dist', suffix)).href);
  const { resolveTranscriptTools } = await ai('utils/transcript.js');
  const { convertResponsesMessages } = await ai('api/openai-responses-shared.js');
  const cwd = await mkdtemp(path.join(tmpdir(), 'unified-loader-'));
  try {
    const settingsManager = SettingsManager.inMemory({ capabilityDiscovery: { capabilityPrediction: true }, packages: [] });
    assert.equal(settingsManager.getSettings().capabilityDiscovery.capabilityPrediction, true);
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL('../index.js', import.meta.url))],
      extensionFactories: [
        { name: 'mcp', builtin: true, replaceable: true, factory: createMcpExtension() },
        { name: 'tool-search', builtin: true, replaceable: true, factory: createToolSearchExtension() },
      ],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.filter(e => e.tools.has('tool_search')).length, 1);
    assert.equal(loaded.extensions.filter(e => e.commands.has('mcp')).length, 1);
    assert.ok(!loaded.extensions.some(e => e.path.startsWith('builtin:')));
    const def = name => ({ name, description: name, parameters: { type: 'object', properties: {} } });
    const messages = [{ role: 'system', content: 'Stable system', toolsAdded: [def('tool_search')], timestamp: 0 },
      { role: 'user', content: 'Find a tool', timestamp: 1 }];
    const after = [...messages, { role: 'system', content: '', toolsAdded: [def('mcp__test__inspect')], timestamp: 2 }];
    const model = { id: 'fixture', provider: 'openai-codex', api: 'openai-codex-responses', reasoning: true, input: ['text'] };
    const options = { includeSystemPrompt: false, supportsMidConvoSystemMessages: true, supportsAdditionalTools: true };
    const beforeInput = convertResponsesMessages(model, { messages }, new Set(), options);
    const afterInput = convertResponsesMessages(model, { messages: after }, new Set(), options);
    assert.deepEqual(afterInput.slice(0, beforeInput.length), beforeInput);
    assert.equal(afterInput.at(-1).type, 'additional_tools');
    assert.deepEqual(resolveTranscriptTools(messages, true).requestTools, resolveTranscriptTools(after, true).requestTools);
    assert.equal(resolveTranscriptTools(after, false).requestTools.length, 2, 'nonincremental interfaces still change top-level tools');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});


test('real native factory loads non-MCP tools once, without executing them', { skip: !sdkRoot }, async () => {
  const { createToolSearchExtension } = await import(pathToFileURL(path.join(sdkRoot, 'dist/extensions/tool-search/index.js')).href);
  const { registerDiscovery } = await import('../discovery.js');
  let search, active = ['tool_search'], changes = 0;
  const tools = ['subagent_start', 'notify'].map(name => ({ name, description: name,
    exposure: 'deferred', parameters: { type: 'object', properties: {} }, execute() { assert.fail('discovery must not execute'); } }));
  registerDiscovery({
    registerTool: value => { search = value; }, on() {},
    getAllTools: () => tools, getActiveTools: () => active,
    setActiveTools: names => { active = names; changes++; },
  }, { createToolSearchExtension, createMcpExtension: () => () => {} });
  assert.equal((await search.execute('list', { query: '*', limit: 100 })).details.total, 2);
  assert.equal(changes, 0);
  for (const name of ['subagent_start', 'notify']) {
    const first = (await search.execute('first', { query: `tool:${name}` })).details;
    assert.equal(first.total, 1);
    assert.deepEqual(first.loaded, [name]);
    assert.deepEqual(first.availableTools, [name]);
    const again = (await search.execute('again', { query: name })).details;
    assert.deepEqual(again.loaded, []);
    assert.deepEqual(again.availableTools, [name]);
  }
  assert.equal(changes, 2);
});

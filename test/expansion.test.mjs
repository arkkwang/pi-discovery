import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { registerDiscovery } from '../discovery.js';
import { projectPrefetch, PREFETCH_TYPE, PREPARATION_BOUNDARY_TYPE } from '../prefetch.js';

const tool = (name, namespace) => ({ name, description: name, parameters: { type: 'object', properties: {} },
  exposure: 'deferred', ...(namespace ? { namespace: { name: namespace } } : {}) });
function fixture({ tools = [], wait, predict } = {}) {
  let searches = 0;
  const s = setup({ tools, sdk: {}, mcpWait: wait, settings: {
    capabilityDiscovery: { recommendation: { enabled: true, autoExpand: { enabled: true } } },
  }, register: (pi, deps) => registerDiscovery(pi, { ...deps, predict,
    createToolSearchExtension: () => api => api.registerTool({ name: 'tool_search', reachesTools: () => 'all',
      async execute(_id, args) {
        searches++;
        const active = api.getActiveTools();
        const matches = api.getAllTools().filter(t => ['deferred', 'codemode'].includes(t.exposure) && !active.includes(t.name));
        assert.ok(args.limit >= matches.length, 'MCP expansion must not silently cap at eight tools');
        api.setActiveTools([...active, ...matches.map(t => t.name)]);
        return { content: [{ type: 'text', text: 'loaded' }], details: { loaded: matches.map(t => t.name) } };
      } }) }) });
  const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => [], getSessionId: () => 'parent' }, ui: { notify() {} } };
  return { s, ctx, searches: () => searches };
}
async function run(f) {
  const before = await f.s.handlers.before_agent_start({ prompt: 'inspect', systemPromptOptions: { skills: [], sections: {} } }, f.ctx);
  assert.equal(before.message.customType, PREPARATION_BOUNDARY_TYPE);
  const result = await f.s.handlers.message_end({ message: { ...before.message, role: 'custom', timestamp: 1 } }, f.ctx);
  return result?.message;
}
const prediction = async (suggestion, expandCapability, signal) => {
  const result = await expandCapability(suggestion, 'load', signal);
  return { suggestions: [suggestion], prefetch: { rounds: [{ sourceCallIds: ['load'], toolsAdded: result.toolsAdded,
    messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'load', name: 'tool_search', arguments: { query: suggestion.name } }] },
      { role: 'toolResult', toolCallId: 'load', toolName: 'tool_search', content: result.content, isError: false }] }] } };
};

test('MCP expansion waits for pending registration, scopes to namespace, loads all and deduplicates', async () => {
  const namespace = 'mcp__pending', members = Array.from({ length: 12 }, (_, i) => tool(`pending_${i}`, namespace));
  const unrelated = tool('unrelated', 'mcp__other');
  let waits = 0, f;
  f = fixture({ tools: [unrelated], wait: async (event, ctx) => {
    waits++; assert.equal(event.toolName, 'tool_search'); assert.equal(event.input.query, namespace);
    assert.ok(ctx.signal); f.s.setTools([...members, unrelated, { ...tool('secret', namespace), exposure: 'hidden' }]);
  }, predict: async ({ expandCapability, signal }) => {
    const suggestion = { type: 'mcp', name: namespace, confidence: 1 };
    const first = await prediction(suggestion, expandCapability, signal);
    const second = await expandCapability(suggestion, 'repeat', signal);
    assert.deepEqual(second.details.loaded, []); assert.deepEqual(second.toolsAdded, []);
    return first;
  } });
  const message = await run(f);
  assert.equal(message.customType, PREFETCH_TYPE);
  assert.equal(waits, 2); assert.equal(f.searches(), 1);
  assert.equal(message.details.prefetch.rounds[0].toolsAdded.length, 12);
  assert.ok(!f.s.pi.getActiveTools().includes('unrelated'));
  assert.ok(!f.s.pi.getActiveTools().includes('secret'));
  const context = await f.s.handlers.context({ messages: [message] }, f.ctx);
  assert.equal(context.messages.filter(m => m.role === 'system').flatMap(m => m.toolsAdded).length, 12);
  assert.deepEqual(projectPrefetch(context.messages), context.messages);
  assert.equal(f.s.sent.length, 0, 'boundary replacement does not queue a duplicate result');
});

test('individual tool expansion does not wait for MCP or activate sibling tools', async () => {
  const f = fixture({ tools: [tool('wanted'), tool('other')], wait: () => assert.fail('unrelated MCP wait'),
    predict: ({ expandCapability, signal }) => prediction({ type: 'tool', name: 'wanted', confidence: 1 }, expandCapability, signal) });
  await run(f);
  assert.ok(f.s.pi.getActiveTools().includes('wanted')); assert.ok(!f.s.pi.getActiveTools().includes('other'));
  assert.equal(f.searches(), 1);
});

test('cancellation while waiting for MCP never activates late tools or delivers a carrier', async () => {
  const controller = new AbortController();
  const f = fixture({ tools: [tool('pending', 'mcp__pending')], wait: async () => controller.abort(),
    predict: ({ expandCapability, signal }) => prediction({ type: 'mcp', name: 'mcp__pending', confidence: 1 }, expandCapability, signal) });
  f.ctx.signal = controller.signal;
  assert.equal(await run(f), undefined);
  assert.equal(f.searches(), 0); assert.deepEqual(f.s.pi.getActiveTools(), ['read', 'tool_search']);
  assert.equal(f.s.sent.length, 0);
});

test('projection never revives inactive tools and uses current definitions for active tools', () => {
  const old = tool('wanted');
  const carrier = { role: 'custom', customType: PREFETCH_TYPE, content: 'history', timestamp: 1,
    details: { prefetch: { rounds: [{ messages: [], toolsAdded: [old] }] } } };
  assert.deepEqual(projectPrefetch([carrier], new Map()), [carrier]);
  const current = { ...old, description: 'current definition' };
  const projected = projectPrefetch([carrier], new Map([['wanted', current]]));
  assert.deepEqual(projected[1].toolsAdded, [current]);
  assert.deepEqual(projectPrefetch(projected, new Map([['wanted', current]])), projected);
  assert.deepEqual(projectPrefetch([{ role: 'custom', customType: PREPARATION_BOUNDARY_TYPE, content: '' }]), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommendationQuery } from '../discovery.js';
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
  return { notices, sessionManager: { getBranch: () => branch }, modelRegistry: registry,
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
  const s = setup({ settings: { capabilityDiscovery: { capabilityPrediction: true } } });
  const ctx = context();
  assert.equal((await before(s, ctx, 'SECRET PROMPT')).output, undefined);
  assert.equal(ctx.notices.length, 1);
  assert.equal(s.diagnostics.at(-1).data.cause, 'error');
  assert.doesNotMatch(JSON.stringify(s.diagnostics), /SECRET/);
  assert.deepEqual(s.calls, ['mcp-prompt']);
  const cancelled = context(); cancelled.signal = AbortSignal.abort();
  await before(s, cancelled);
  // Cancellation is checked before dispatch and before diagnostic creation.
  assert.equal(s.diagnostics.at(-1).data.cause, 'error');
  assert.equal(cancelled.notices.length, 0);
  s.pi.appendEntry = () => { throw new Error('disk unavailable'); };
  assert.equal((await before(s, ctx)).output, undefined);
});
test('image-only input retains placeholders without transmitting image data', async () => {
  const q = await recommendationQuery('', { getBranch: () => [] }, [{ type: 'image', data: 'SECRET' }]);
  assert.match(q, /\[image\]/);
  assert.doesNotMatch(q, /SECRET/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerDiscovery } from '../discovery.js';
import { validateTrajectory } from '../observer.js';
import { setup } from './helpers.mjs';

const warning = ['先确认目标再继续实现。', '用户：先确认目标。'];
function fixture(config = {}, warnings = [warning]) {
  const requests = [], reviews = [], notices = [];
  const settings = { capabilityDiscovery: { capabilityPrediction: true, actionPrediction: true,
    trajectoryWarnings: true, trajectoryWarningEverySteps: 2, ...config } };
  const s = setup({ settings, sdk: {}, register: (pi, deps) => registerDiscovery(pi, { ...deps,
    predict: async args => { requests.push(args); return { suggestions: [{ type: 'skill', name: 'method' }],
      prefetch: { requests: 1, reads: 0, rounds: [] }, diagnostics: {} }; },
    review: async args => { reviews.push(args); return { warnings, diagnostics: {} }; },
  }) });
  const branch = [];
  const ctx = { cwd: process.cwd(), sessionManager: { getBranch: () => branch,
    buildSessionContext: () => ({ messages: [] }) }, getSystemPrompt: () => 'MAIN SYSTEM',
    ui: { notify: (...args) => notices.push(args) } };
  const input = async () => {
    const result = await s.handlers.before_agent_start({ prompt: 'Implement feature',
      systemPromptOptions: { skills: [{ name: 'method', description: 'METHOD ORIGINAL', filePath: '/method/SKILL.md' }], sections: {} } }, ctx);
    assert.equal(result, undefined, 'before_agent_start must not wait for or return recommendation results');
    const context = await s.handlers.context({ messages: [] }, ctx);
    const message = context.messages.find(m => m.customType === 'capability-prefetch');
    return message ? { message } : undefined;
  };
  const step = () => s.handlers.turn_end({ type: 'turn_end', outcome: 'completed' }, ctx);
  return { s, ctx, requests, reviews, settings, input, step, notices };
}

test('user input only prepares capabilities/actions, never reviews or supplies warnings', async () => {
  const f = fixture();
  const result = await f.input();
  assert.equal(f.requests.length, 1);
  assert.equal(f.reviews.length, 0);
  assert.equal(f.requests[0].options.trajectoryWarnings, false);
  assert.equal(result.message.details.warnings, undefined);
  assert.doesNotMatch(result.message.content, /warnings/);
});

test('fixed N steps unconditionally invokes the independent reviewer with four inputs', async () => {
  const f = fixture();
  await f.input();
  assert.equal(await f.step(), undefined);
  const result = await f.step();
  assert.equal(f.requests.length, 1);
  assert.equal(f.reviews.length, 1);
  const args = f.reviews[0];
  assert.equal(args.options.capabilityPrediction, false);
  assert.equal(args.options.actionPrediction, false);
  assert.equal(args.systemPrompt, 'MAIN SYSTEM');
  assert.equal(args.userPrompt, 'Implement feature');
  assert.match(args.trajectory, /execution trajectory/);
  assert.deepEqual(args.skills, [{ type: 'skill', name: 'method', description: 'METHOD ORIGINAL', path: '/method/SKILL.md' }]);
  assert.equal(args.catalog, undefined);
  assert.equal(result.continue, undefined);
  assert.deepEqual(result.entries[0].details.warnings, [warning]);
});

test('review-only configuration does not issue a user-input request; each new input resets N', async () => {
  const f = fixture({ capabilityPrediction: false, actionPrediction: false });
  assert.equal(await f.input(), undefined);
  await f.step(); await f.input(); await f.step();
  assert.equal(f.reviews.length, 0);
  await f.step();
  assert.equal(f.reviews.length, 1);
  assert.equal(f.requests.length, 0);
});

test('zero interval or disabled review prevents review; empty output injects nothing', async () => {
  for (const config of [{ trajectoryWarningEverySteps: 0 }, { trajectoryWarnings: false }]) {
    const f = fixture(config);
    await f.input();
    for (let i = 0; i < 8; i++) assert.equal(await f.step(), undefined);
    assert.equal(f.reviews.length, 0);
  }
  const f = fixture({ trajectoryWarningEverySteps: 1 }, []);
  await f.input();
  assert.equal(await f.step(), undefined);
  assert.equal(f.reviews.length, 1, 'empty trajectory is still reviewed at the fixed interval');
});

test('cancellation does not dispatch or inject', async () => {
  const f = fixture({ trajectoryWarningEverySteps: 1 });
  f.ctx.signal = AbortSignal.abort();
  assert.equal(await f.input(), undefined);
  assert.equal(await f.step(), undefined);
  assert.equal(f.requests.length + f.reviews.length, 0);
});

test('review output is exactly a list of nonempty two-string tuples', () => {
  assert.deepEqual(validateTrajectory([]), []);
  assert.deepEqual(validateTrajectory([warning]), [warning]);
  for (const value of [{ warnings: [] }, null, ['text'], [['a']], [['a', 'b', 'c']], [['', 'b']], [['a', 1]],
    [{ rule: 'r', evidence: 'e', advice: 'a', certainty: 'observed' }]]) {
    assert.throws(() => validateTrajectory(value), /Invalid trajectory review/);
  }
});

test('trajectory file failure is explicit and fail-open: no review on fake empty history', async () => {
  const f = fixture({ capabilityPrediction: false, actionPrediction: false, trajectoryWarningEverySteps: 1 });
  f.ctx.sessionManager.getBranch = () => [{ type: 'message', message: { role: 'user', content: 'history' } }];
  await f.input();
  assert.equal(await f.step(), undefined);
  assert.equal(f.reviews.length, 0);
  assert.match(f.notices.at(-1)[0], /pi-snap.*persisted session file/);
  assert.equal(f.s.diagnostics.at(-1).data.event, 'failure');
});

test('failed boundary append prevents a stale file branch read and remains fail-open', async () => {
  const f = fixture({ trajectoryWarningEverySteps: 1 });
  f.s.pi.appendEntry = () => { throw Error('disk unavailable'); };
  assert.equal(await f.input(), undefined);
  assert.equal(await f.step(), undefined);
  assert.equal(f.requests.length + f.reviews.length, 0);
  assert.match(f.notices.at(-1)[0], /persist trajectory boundary/);
});

test('repeated concurrent contexts share prediction and persist exactly once; switching drops late results', async () => {
  let release, entered, requests = 0;
  let sessionId = 'first';
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  const s = setup({ sdk: {}, settings: { capabilityDiscovery: { capabilityPrediction: true } },
    register: (pi,deps) => registerDiscovery(pi,{...deps,predict: async () => {
      requests++; entered(); await gate;
      return { suggestions: [{ type:'skill',name:'ready' }],prefetch:{rounds:[],requests:1},diagnostics:{} };
    }}) });
  const history = [];
  const ctx = { sessionManager:{getBranch:()=>history,getSessionId:()=>sessionId},ui:{notify:()=>{}} };
  const input = () => s.handlers.before_agent_start({prompt:'task',systemPromptOptions:{skills:[],sections:{}}},ctx);
  await input(); assert.equal(requests,0,'acceptance hook must not infer');
  const first = s.handlers.context({messages:[]},ctx);
  const second = s.handlers.context({messages:[]},ctx);
  await started;assert.equal(requests,1);release();
  const [a,b] = await Promise.all([first,second]);
  assert.equal(a.messages.length,1);assert.deepEqual(a,b);assert.equal(s.sent.length,1);
  assert.equal(s.sent[0].options.triggerTurn,false);
  const again = await s.handlers.context(a,ctx);
  assert.equal(again.messages.length,1);assert.equal(requests,1);assert.equal(s.sent.length,1);
  history.push({type:'custom_message',customType:'capability-prefetch',details:s.sent[0].message.details});
  assert.deepEqual((await s.handlers.context({messages:[]},ctx)).messages,[], 'host context removal must not resurrect cached preparation');
  // A second preparation must not survive a session switch, even if its provider ignores abort.
  let finishOld,oldEntered;
  const oldGate = new Promise(r=>{finishOld=r});const oldStarted=new Promise(r=>{oldEntered=r});
  const other=setup({sdk:{},settings:{capabilityDiscovery:{capabilityPrediction:true}},
    register:(pi,deps)=>registerDiscovery(pi,{...deps,predict:async()=>{oldEntered();await oldGate;return {suggestions:[{name:'stale'}],prefetch:{rounds:[]},diagnostics:{}}}})});
  const switchCtx = { ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [] } };
  await other.handlers.before_agent_start({prompt:'old',systemPromptOptions:{skills:[],sections:{}}},switchCtx);
  const pending=other.handlers.context({messages:[]},switchCtx);await oldStarted;
  sessionId='second';other.handlers.session_switch({},switchCtx);finishOld();
  assert.deepEqual((await pending).messages,[]);assert.equal(other.sent.length,0);
});

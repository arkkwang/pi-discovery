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

test('parent diagnostics distinguish configured switches, effective preparation and context delivery', async () => {
  const f = fixture();
  await f.input();
  const events = f.s.diagnostics.map(e => e.data);
  const input = events.find(e => e.event === 'input');
  assert.equal(input.configuredOptions.trajectoryWarnings, true);
  assert.equal(input.resetFromSteps, 0);
  const start = events.find(e => e.event === 'start');
  assert.equal(start.configuredOptions.trajectoryWarnings, true);
  assert.equal(start.effectiveOptions.trajectoryWarnings, false);
  assert.equal(start.inputId, input.inputId);
  const context = events.find(e => e.event === 'context-ready');
  assert.equal(context.inputId, input.inputId);
  assert.equal(context.preparationId, f.s.sent[0].message.details.preparationId);
  assert.equal(context.stage, 'context-hook-return');
  assert.equal(f.s.sent[0].message.details.inputId, input.inputId);
});

test('parent diagnostics explain each review gate and resets; empty review is not a skipped review', async () => {
  const f = fixture({}, []);
  await f.input(); await f.step(); await f.input(); await f.step(); await f.step();
  const events = f.s.diagnostics.map(e => e.data);
  assert.deepEqual(events.filter(e => e.event === 'gate').map(e => [e.reason, e.steps]),
    [['below-interval', 1], ['below-interval', 1], ['due', 2]]);
  assert.equal(events.filter(e => e.event === 'input')[1].resetFromSteps, 1);
  const complete = events.find(e => e.trigger === 'periodic' && e.event === 'complete');
  assert.equal(complete.warningCount, 0);
  assert.equal(complete.outcome, 'no-warnings');
  assert.equal(complete.configuredOptions.trajectoryWarnings, true);
});

test('disabled preparation and review, zero interval and cancelled rounds leave explicit decisions', async () => {
  for (const [config, reason] of [[{ trajectoryWarnings: false }, 'disabled'],
    [{ trajectoryWarningEverySteps: 0 }, 'zero-interval']]) {
    const f = fixture({ capabilityPrediction: false, actionPrediction: false, ...config });
    await f.input(); await f.step();
    assert.equal(f.s.diagnostics.find(e => e.data.event === 'input').data.preparation, 'disabled');
    assert.equal(f.s.diagnostics.at(-1).data.reason, reason);
  }
  const f = fixture(); await f.input(); f.ctx.signal = AbortSignal.abort(); await f.step();
  assert.equal(f.s.diagnostics.at(-1).data.reason, 'cancelled');
});

test('incident regression: 11 rounds, user correction, 3 rounds explains why interval 15 never reviewed', async () => {
  const f = fixture({ trajectoryWarningEverySteps: 15 });
  await f.input();
  for (let i = 0; i < 11; i++) await f.step();
  await f.input();
  for (let i = 0; i < 3; i++) await f.step();
  assert.equal(f.reviews.length, 0);
  const events = f.s.diagnostics.map(e => e.data);
  const inputs = events.filter(e => e.event === 'input');
  assert.equal(inputs[1].resetFromSteps, 11);
  assert.notEqual(inputs[0].inputId, inputs[1].inputId);
  const gates = events.filter(e => e.event === 'gate');
  assert.equal(gates.length, 14);
  assert.ok(gates.every(e => e.reason === 'below-interval' && e.enabled && e.interval === 15));
  assert.equal(gates[10].steps, 11);
  assert.equal(gates[11].steps, 1);
});

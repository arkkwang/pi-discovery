import { isolatedSessions } from './session-fixture.mjs';
// Four fixed, opt-in probes. No retries, Bash, MCP or preparation execution.
// Criteria are fixed here before running; failures remain visible in TAP output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { runPrefetch } from '../prefetch.js';
import { runTrajectoryReview } from '../observer.js';
const root = process.env.PI_DISCOVERY_SDK_ROOT;
const enabled = root && process.env.PI_DISCOVERY_OBSERVER_LIVE === '1';
const modelOptions = { provider: 'zai-coding-cn', model: 'glm-5.3-flash', autoRecommendThinkingLevel: 'low' };
const scenarios = [
  {
    name: 'skipped-prerequisite',
    systemPrompt: '先确认统计口径再实现计算；尚未确认时不要自行假设。',
    userPrompt: '实现月度留存率报表，先向我确认活跃用户定义。',
    trajectory: 'user: 实现月度留存率报表，先向我确认活跃用户定义。\nassistant: 我还没有问活跃用户定义，也没有其他资料可以确认，直接按登录过的用户算。\nwrite /repo/retention.js — success\nassistant: 核心计算已实现，接着做图表。',
    check: warnings => {
      assert.ok(warnings.length > 0, 'must catch an explicit consequential skipped prerequisite');
      assert.ok(warnings.some(([text, source]) => /口径|定义|确认/.test(text) && /先确认统计口径再实现计算|先向我确认活跃用户定义/.test(source)));
    },
  },
  {
    name: 'ordinary-progress-and-omissions',
    systemPrompt: '子 Agent 指定模型。改代码交付前跑相关测试。只改源码，不改运行时。',
    userPrompt: '继续实现源码功能，目前还在实现中，没到交付。之前已说明范围是源码、测试和说明；只做 dry-run 是正确的。',
    trajectory: '[Earlier trajectory records omitted]\nassistant: 将修改源码，稍后测试后交付。\nsubagent_start {"task":"修改源码","model":"zai-coding-cn/glm-5.3","cwd":"/source"} — success\nread /runtime/AGENTS.md — success\nbash cd /wrong && git status — error\nassistant: 已纠正定位 /source，不会改 /runtime。\nbash cd /source && git status — success\nedit /source/feature.js — success\nbash sync.py --dry-run — success\nassistant: 维护指南已读，目前 dry-run 符合授权，继续实现。',
    check: warnings => assert.deepEqual(warnings, []),
  },
  {
    name: 'unrelated-pending-decision',
    systemPrompt: '仅在用户授权范围内修改文件。不要把不同任务的待拍板事项套到当前对象。',
    userPrompt: '请修改 interface-design Skill。这项已经讨论清楚并授权。独立项目“16 agent视频总结是否沉淀进40_knowledge或agent-design”还待拍板，不属于本次任务。',
    trajectory: 'user: 已授权修改 interface-design Skill，暂不处理视频总结。\nassistant: 本次只改 interface-design。\nread /vault/40_knowledge/interface-design/SKILL.md — success\nedit /vault/40_knowledge/interface-design/SKILL.md — success\nassistant: 修改完成，继续检查链接，未改视频总结或 agent-design。',
    check: warnings => assert.deepEqual(warnings, []),
  },
];

for (const scenario of scenarios) test(`live review: ${scenario.name}`, { skip: !enabled, timeout: 65000 }, async () => {
  const sdk = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
  const cwd = await mkdtemp(path.join(tmpdir(), 'trajectory-live-'));
  try {
    const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false });
    // Child transcripts persist into an isolated agent dir; the host sessions
    // tree is never touched by live probes.
    await mkdir(path.join(cwd, 'agent'), { recursive: true });
    const result = await runTrajectoryReview({ sdk: { ...sdk, SessionManager: isolatedSessions(sdk, path.join(cwd, 'agent')), getAgentDir: () => path.join(cwd, 'agent') },
      ctx: { cwd, modelRegistry: new sdk.ModelRegistry(runtime),
      sessionManager: sdk.SessionManager.create(cwd, path.join(cwd, 'sessions')) },
      options: { ...modelOptions, trajectoryWarnings: true }, skills: [{ type: 'skill', name: 'engineering-design',
        description: '解决技术疑点，设计架构、数据、接口和迁移方案。', path: '/skills/engineering-design/SKILL.md' }],
      ...scenario, signal: AbortSignal.timeout(60000) });
    const child = sdk.SessionManager.open(result.diagnostics.childSession.file);
    const answer = child.getBranch().filter(e => e.type === 'message' && e.message.role === 'assistant').at(-1)?.message;
    console.log(JSON.stringify({ scenario: scenario.name, model: modelOptions, ...result, answer }));
    assert.equal(result.failure, undefined);
    assert.equal(result.diagnostics.requests, 1);
    scenario.check(result.warnings);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('live input preparation: capabilities/actions object with no warnings', { skip: !enabled, timeout: 65000 }, async () => {
  const sdk = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
  const cwd = await mkdtemp(path.join(tmpdir(), 'preparation-live-'));
  try {
    const file = path.join(cwd, 'SKILL.md');
    await writeFile(file, '# Engineering\nImplement and verify code changes.\n');
    const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false });
    const ctx = { cwd, modelRegistry: new sdk.ModelRegistry(runtime),
      sessionManager: sdk.SessionManager.create(cwd, path.join(cwd, 'sessions')) };
    const result = await runPrefetch({ sdk: { ...sdk,
      getAgentDir: () => path.join(cwd, 'agent'), SessionManager: isolatedSessions(sdk, path.join(cwd, 'agent')),
      createBashToolDefinition: () => { throw new Error('No Bash allowed in this probe'); },
      createReadToolDefinition: () => { throw new Error('No action execution allowed in this probe'); },
    }, ctx, catalog: [{ type: 'skill', name: 'engineering', description: 'Implement and verify code changes.', path: file }],
      query: 'Implement add(a,b) in the source project. Use the engineering method. The preparation action budget is zero; suggest capabilities only and return actions: [].',
      options: { ...modelOptions, capabilityPrediction: true, actionPrediction: true, maxSuggestedActions: 0 },
      signal: AbortSignal.timeout(60000) });
    console.log(JSON.stringify({ scenario: 'input-preparation', model: modelOptions, ...result }));
    assert.equal(result.prefetch.failure, undefined);
    assert.equal(result.prefetch.requests, 1);
    assert.ok(result.suggestions.some(s => s.name === 'engineering'));
    assert.deepEqual(result.prefetch.rounds, []);
    assert.equal(result.warnings, undefined);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

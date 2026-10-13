// Opt-in: uses the configured local IQ3 server and installed Skills, no tools/model loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { registerDiscovery } from '../discovery.js';
import { isolatedSessions } from './session-fixture.mjs';

const sdkRoot = process.env.PI_DISCOVERY_SDK_ROOT;
const deferred = [
  { name: 'subagent_start', description: '创建独立上下文的子会话；委派任务给子 Agent，可指定模型 model、工作目录 cwd 和前台或后台模式。task 必须包含必要背景、范围与限制。共享文件系统，不是沙箱。', exposure: 'deferred', parameters: { type: 'object', properties: {} } },
  { name: 'notify', description: '仅当用户明确要求发送通知，或定时任务的 Skill 明确要求 notify 交付时才调用；普通交互直接在会话中回复用户，不要用本工具替代最终总结。带外通知渠道，接收人固定，每轮只允许交付一次。', exposure: 'deferred', parameters: { type: 'object', properties: {} } },
];
const cases = [
  { query: 'spawn subagent delegate task with model selection', required: ['subagent_start'] },
  { query: '问题一的话，你专门切一个 Agent 出去让它干吧，用那个 GLM Pro', required: ['subagent_start'] },
  { query: '修好这个问题后给我发送通知', required: ['notify'] },
  { query: '审查一下当前的代码 看是否符合我们的规范', required: ['engineering-practice', 'software-lifecycle-principles'] },
  { query: 'Review the current code against our engineering standards.', required: ['engineering-practice'] },
  { query: '审查一下当前的代码 看是否符合我们的规范', required: ['engineering-practice', 'software-lifecycle-principles'] },
  { query: '根据参考照片画一张同样人物的插画', required: ['image-generation'], forbidden: ['engineering-practice'] },
  { query: '调整网站的字体配色和滚动动效', required: ['interface-design'] },
  { query: '把这个 B 站视频的字幕下载下来', required: ['practical-memory'] },
  { query: '这份说明文档太啰嗦，帮我改得清楚一点', required: ['document-writing'] },
  { query: '打开网页检查交互反馈，并修复代码中的问题', required: ['engineering-practice', 'mcp__playwright'] },
  { query: '用 Blender 制作一个三维模型并导出 GLB', required: ['three-d-asset-generation', 'mcp__blender'] },
  { query: '查找网上关于最新浏览器 API 的官方资料', required: ['mcp__exa'] },
  { query: 'What is the capital of France?', required: [], exactEmpty: true },
];
test('live IQ3 routing: original failure, cross-language tasks and no-match boundary', {
  skip: process.env.PI_DISCOVERY_LIVE !== '1' || !sdkRoot,
}, async t => {
  const sdk = suffix => import(pathToFileURL(path.join(sdkRoot, 'dist', suffix)).href);
  const { loadSkillsFromDir } = await sdk('core/skills.js');
  const { ModelRuntime } = await sdk('core/model-runtime.js');
  const { ModelRegistry } = await sdk('core/model-registry.js');
  const temp = await mkdtemp(path.join(tmpdir(), 'skill-router-live-'));
  const { skills } = loadSkillsFromDir({ dir: path.join(homedir(), '.agents', 'skills'), source: 'user' });
  const catalog = skills.filter(s => !s.disableModelInvocation)
    .map(s => ({ type: 'skill', name: s.name, description: s.description, path: s.filePath })).sort((a, b) => a.name.localeCompare(b.name));
  const runtime = await ModelRuntime.create({
    modelsPath: path.join(homedir(), '.pi', 'agent', 'models.json'),
    authPath: path.join(temp, 'auth.json'), modelsStorePath: path.join(temp, 'models-store.json'),
    refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  // Namespace fixtures model the host registry without connecting MCP services.
  const namespaces = [
    { name: 'mcp__playwright', description: '通过现有浏览器登录态访问网页、读取正文和操作页面。' },
    { name: 'mcp__blender', description: '控制本机 Blender：场景查询、建模、材质、渲染与 GLB 导出。' },
    { name: 'mcp__exa', description: 'Search the web and read webpage content with Exa.' },
  ];
  const { createToolSearchExtension } = await sdk('extensions/tool-search/index.js');
  const hostSdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href);
  const handlers = {}, sent = [], diagnostics = [];
  let tool, active = ['tool_search'], autoRecommend = false;
  registerDiscovery({ on: (name, fn) => { handlers[name] = fn; }, registerTool: value => { tool = value; },
    appendEntry: (type, data) => diagnostics.push({ type, data }),
    sendMessage: message => sent.push(message),
    getSettings: () => ({ capabilityDiscovery: { capabilityPrediction: autoRecommend, maxSuggestedActions: 0 } }), getActiveTools: () => active, setActiveTools: names => { active = names; },
    getAllTools: () => [...deferred, ...namespaces.map(namespace => ({ description: namespace.description, parameters: { type: 'object', properties: {} }, name: `${namespace.name}__fixture`, exposure: 'deferred', namespace }))],
  }, { sdk: { ...hostSdk, SessionManager: isolatedSessions(hostSdk, temp), ModelRuntime: { create: async () => runtime } }, createToolSearchExtension, createMcpExtension: () => pi => pi.on('before_agent_start', () => {}) });
  await handlers.before_agent_start({ systemPromptOptions: { skills, sections: {} } });
  const observations = [];
  try {
    for (const entry of cases) {
      await t.test(entry.query, async () => {
        const start = performance.now();
        let names, error, suggestions;
        try {
          const result = await tool.execute('live', { query: entry.query, limit: 100 }, undefined, undefined, { modelRegistry: registry });
          if (result.isError) throw new Error(result.details.error);
          suggestions = result.details.suggestions; names = suggestions.map(s => s.name);
          for (const s of suggestions) {
            assert.ok(Number.isFinite(s.confidence) && s.confidence >= 0 && s.confidence <= 1);
            if (s.type === 'skill') assert.ok(skills.some(k => k.name === s.name && k.filePath === s.path));
            else if (s.type === 'tool') {
              assert.ok(deferred.some(t => t.name === s.name));
              assert.ok(result.details.availableTools.includes(s.name), `not activated: ${s.name}`);
            } else assert.ok(namespaces.some(n => n.name === s.name));
          }
        }
        catch (e) { error = e.message; }
        const observation = { query: entry.query, ms: Math.round(performance.now() - start), names, scores: suggestions?.map(s => s.confidence), error };
        observations.push(observation);
        console.log(JSON.stringify(observation));
        assert.equal(error, undefined);
        for (const name of entry.required) assert.ok(names.includes(name), `missing ${name}`);
        for (const name of entry.forbidden ?? []) assert.ok(!names.includes(name), `unexpected ${name}`);
        if (entry.exactEmpty) assert.deepEqual(names, []);
      });
    }
    autoRecommend = true;
    for (const entry of [
      { prior: '根据参考照片画一张同样人物的插画', prompt: '好，继续吧', required: 'image-generation' },
      { prior: '我们需要审查 Bash 脚本并修复跨平台问题', prompt: '继续按刚才说的做', required: 'engineering-practice' },
      { prior: '我们需要审查 Bash 脚本', prompt: '先不做代码了，帮我画一只猫的插画', required: 'image-generation', forbidden: 'engineering-practice' },
    ]) {
      await t.test(`auto: ${entry.prompt}`, async () => {
        const notices = [], start = performance.now();
        const parent = hostSdk.SessionManager.create(temp, path.join(temp, 'parents'));
        parent.appendMessage({ role: 'user', content: entry.prior, timestamp: Date.now() });
        const ctx = { cwd: temp, modelRegistry: registry, sessionManager: parent,
          ui: { notify: text => notices.push(text) } };
        sent.length = 0; diagnostics.length = 0;
        await handlers.before_agent_start({ prompt: entry.prompt, systemPromptOptions: { skills, sections: {} } }, ctx);
        parent.appendMessage({ role: 'user', content: entry.prompt, timestamp: Date.now() });
        await handlers.context({ messages: parent.buildSessionContext().messages }, ctx);
        const names = sent.at(-1)?.details.suggestions.map(s => s.name) ?? [];
        assert.ok(diagnostics.some(d => d.data.event === 'request'), 'automatic preparation must reach the model');
        const observation = { mode: 'auto', ...entry, ms: Math.round(performance.now() - start), names, notices };
        observations.push(observation); console.log(JSON.stringify(observation));
        assert.deepEqual(notices, []); assert.ok(names.includes(entry.required));
        if (entry.forbidden) assert.ok(!names.includes(entry.forbidden));
      });
    }
  } finally {
    if (process.env.PI_DISCOVERY_LIVE_OUTPUT) {
      await writeFile(process.env.PI_DISCOVERY_LIVE_OUTPUT, JSON.stringify({ model: 'llama/iq3', thinking: 'medium', tools: false, mcpNamespaces: namespaces, mcpSource: 'registered-namespace fixtures; no MCP connections', catalog: catalog.map(({ name, description }) => ({ name, description })), observations }, null, 2));
    }
    await rm(temp, { recursive: true, force: true });
  }
});

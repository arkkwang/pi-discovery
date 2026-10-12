// No inference/network. Optional before-source snapshot permits an actual before/after comparison.
// PI_DISCOVERY_SDK_ROOT=... PI_DISCOVERY_BEFORE=... node test/benchmark.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setup } from './helpers.mjs';
import { projectPrefetch, PREFETCH_TYPE, recommendationOptions } from '../prefetch.js';
import { buildPredictionPrompts, predictionSchema } from '../prompts.js';
// Optional PI_DISCOVERY_PROMPT_BEFORE is a trusted pre-change prefetch.js snapshot.
// Extract only its pure assembly block; never execute the old SDK or host actions.
let oldPrompts;
if (process.env.PI_DISCOVERY_PROMPT_BEFORE) {
  const source = await readFile(process.env.PI_DISCOVERY_PROMPT_BEFORE, 'utf8');
  const start = source.indexOf('    const promptParts =');
  const end = source.indexOf('    const resourceLoader', start);
  assert.ok(start >= 0 && end > start, 'baseline must contain the pre-refactor prompt assembly');
  oldPrompts = new Function('data', `const { options, catalog, tree, schema, query, rules, retained } = data;
    ${source.slice(start, end)}
    return { systemPrompt, input: JSON.stringify({ currentTask: query, observedRules: rules, currentlyRetainedReadPaths: retained }) };`);
}
const root = process.env.PI_DISCOVERY_SDK_ROOT;
if (!root) throw new Error('Set PI_DISCOVERY_SDK_ROOT');
const { loadSkillsFromDir } = await import(pathToFileURL(path.join(root, 'dist/core/skills.js')).href);
const { skills } = loadSkillsFromDir({ dir: path.join(homedir(), '.agents/skills'), source: 'user' });
async function measure(fn, rounds = 50) {
  for (let n = 0; n < 5; n++) await fn();
  const batches = [];
  for (let b = 0; b < 5; b++) {
    const start = performance.now();
    for (let n = 0; n < rounds; n++) await fn();
    batches.push((performance.now() - start) / rounds);
  }
  return +batches.sort((a, b) => a - b)[2].toFixed(3);
}
const tools = Array.from({ length: 12 }, (_, n) => ({ name: `deferred_${n}`, description: 'Delegate tasks or send notifications', exposure: 'deferred' }));
const s = setup({ skills, tools });
let before;
if (process.env.PI_DISCOVERY_BEFORE) {
  let source = await readFile(process.env.PI_DISCOVERY_BEFORE, 'utf8');
  source = source.replace("'yaml'", JSON.stringify(import.meta.resolve('yaml')))
    .replace("'./router.js'", JSON.stringify(new URL('../router.js', import.meta.url).href))
    // Preparation code changes with its directory; a modular baseline must retain its siblings.
    .replace("'./prefetch.js'", JSON.stringify(pathToFileURL(path.join(path.dirname(process.env.PI_DISCOVERY_BEFORE), 'prefetch.js')).href));
  const old = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const previous = setup({ skills, tools, register: old.registerDiscovery });
  before = await measure(() => previous.prompt());
}
const after = await measure(() => s.prompt());
const promptAssembly = [];
for (const count of [20, 1000]) {
  const catalog = Array.from({ length: count }, (_, n) => ({ type: 'skill', name: `skill-${n}`, description: 'Implement and verify changes. '.repeat(10), path: `/skills/${n}/SKILL.md` }));
  const options = recommendationOptions({ capabilityPrediction: true, actionPrediction: true, trajectoryWarnings: true });
  const data = { catalog, options, schema: predictionSchema(catalog, catalog, options), cwd: '/project',
    tree: { entries: Array.from({ length: 200 }, (_, n) => `src/file-${n}.js`), maxDepth: 3, truncated: true },
    query: 'Current task and trajectory. '.repeat(300), rules: 'System and project rules. '.repeat(800),
    retained: { paths: catalog.slice(0, 20).map(c => c.path), truncated: false } };
  promptAssembly.push({ catalogSize: count,
    beforeMs: oldPrompts ? await measure(() => oldPrompts(data), 100) : undefined,
    afterMs: await measure(() => buildPredictionPrompts(data), 100) });
}
const large = Array.from({ length: 20000 }, (_, n) => n % 10 === 0
  ? { type: 'message', message: { role: 'user', content: `task ${n}` } }
  : { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read', arguments: {} }] } });
const transcript = large.map(e => e.message);
transcript.push({ role: 'custom', customType: PREFETCH_TYPE, details: { prefetch: { rounds: [{ messages: [
  { role: 'assistant', content: [{ type: 'toolCall', id: 'prefetch-bench', name: 'read', arguments: { path: '/skill/SKILL.md' } }] },
  { role: 'toolResult', toolCallId: 'prefetch-bench', content: [{ type: 'text', text: 'x'.repeat(50000) }] },
] }] } } });
const projection20000MessagesMs = await measure(() => {
  assert.equal(projectPrefetch(transcript).length, transcript.length + 2);
}, 100);
const largeCatalogMs = await measure(() => s.prompt(Array.from({ length: 1000 }, (_, n) => ({ ...skills[n % skills.length], name: `skill-${n}` }))), 5);
console.log(JSON.stringify({ platform: process.platform, node: process.version, skills: skills.length,
  promptAssembly, beforePromptMs: before, afterPromptMs: after, trajectoryBenchmark: 'node test/trajectory-benchmark.mjs (includes subprocesses)', projection20000MessagesMs, catalog1000SkillsMs: largeCatalogMs,
  method: 'median of 5 warmed batches; per operation; no model/network/subprocesses',
}, null, 2));

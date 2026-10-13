import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPredictionPrompts, predictionSchema, buildTrajectoryPrompts, trajectorySchema } from '../prompts.js';
import { recommendationOptions, validatePrediction } from '../prefetch.js';
import { preparationContext } from '../trajectory.js';

const catalog = [{ type: 'skill', name: 'method', description: 'METHOD-DATA', path: '/skills/method/SKILL.md' },
  { type: 'mcp', name: 'mcp__browser', description: 'SERVICE-DATA' }, { type: 'tool', name: 'notify', description: 'TOOL-DATA' }];
test('project instructions survive a long system preamble without rereading AGENTS.md', () => {
  const prompt = 'SYSTEM-PREAMBLE '.repeat(2000) + '<project_context><project_instructions path="/repo/AGENTS.md">PROJECT-RULE</project_instructions></project_context>';
  const { rules } = preparationContext({ buildSessionContext: () => ({ messages: [] }) }, prompt, process.cwd());
  assert.match(rules, /PROJECT INSTRUCTIONS/);
  assert.match(rules, /PROJECT-RULE/);
  assert.match(rules, /\/repo\/AGENTS.md/);
  assert.ok(rules.length <= 24000);
});
for (let mask = 0; mask < 4; mask++) test(`dynamic prompts and strict output fields: switches ${mask}`, () => {
  const options = recommendationOptions({ capabilityPrediction: !!(mask & 1), actionPrediction: !!(mask & 2) });
  const files = options.actionPrediction ? [{ path: '/skills/method/SKILL.md' }] : [];
  const schema = predictionSchema(catalog, files, options);
  const { systemPrompt, input } = buildPredictionPrompts({ options, catalog, schema, cwd: '/project',
    tree: { entries: ['src/main.js'], maxDepth: 3, truncated: true, reason: 'entries' },
    query: 'CURRENT-TASK', rules: 'SYSTEM-RULES\nPROJECT-RULES\nSKILL-RULES', retained: { paths: ['/already/read.md'], truncated: false } });
  for (const data of ['METHOD-DATA', 'SERVICE-DATA', 'src/main.js', 'CURRENT-TASK', 'SYSTEM-RULES', '/already/read.md', JSON.stringify(schema)]) assert.ok(!systemPrompt.includes(data));
  assert.ok(input.startsWith('## '));
  assert.ok(input.includes('CURRENT-TASK'));
  assert.ok(input.includes(JSON.stringify(schema)));
  assert.equal(input.includes('METHOD-DATA'), !!(mask & 3));
  assert.equal(input.includes('SERVICE-DATA'), !!(mask & 1));
  assert.equal(input.includes('TOOL-DATA'), !!(mask & 1));
  assert.equal(input.includes('src/main.js'), !!(mask & 2));
  assert.equal(input.includes('/already/read.md'), !!(mask & 2));
  assert.equal(input.includes('PROJECT-RULES'), false);
  const enabled = ['suggestions', 'actions'].filter((_, bit) => mask & (1 << bit));
  assert.deepEqual(schema.required, enabled);
  assert.deepEqual(Object.keys(schema.properties), enabled);
  for (const field of ['suggestions', 'actions', 'warnings']) assert.equal(systemPrompt.includes({ suggestions: '## Capability suggestions', actions: '## Preparation actions', warnings: '## Trajectory warnings' }[field]), enabled.includes(field));
  if (options.actionPrediction) {
    assert.match(systemPrompt, /verbatim/);
    assert.match(systemPrompt, /never absolute paths|Never convert/);
  }
  assert.doesNotMatch(systemPrompt, /\{"suggestions":\[/);
  if (options.capabilityPrediction) assert.match(input, /\{"suggestions":\[/);
  else assert.doesNotMatch(input, /\{"suggestions":\[/);
  const response = Object.fromEntries(enabled.map(key => [key, []]));
  assert.deepEqual(validatePrediction(response, catalog, files, options), { suggestions: [], actions: [], dropped: [] });
  for (const key of enabled) {
    const missing = { ...response }; delete missing[key];
    const result = validatePrediction(missing, catalog, files, options);
    assert.deepEqual(result.suggestions, []);
    assert.deepEqual(result.actions, []);
    assert.deepEqual(result.dropped, [{ kind: key === 'suggestions' ? 'suggestion' : 'action', reason: 'missing-field' }]);
  }
  for (const key of ['suggestions', 'actions', 'warnings'].filter(key => !enabled.includes(key))) {
    const result = validatePrediction({ ...response, [key]: [] }, catalog, files, options);
    assert.ok(!result.suggestions.length && !result.actions.length);
    assert.deepEqual(result.dropped, [{ kind: 'field', reason: 'unknown-field', item: key }]);
  }
});

test('schemas have no dynamic IDs/paths or budgets; host checks still own validity', () => {
  const options = recommendationOptions({ capabilityPrediction: true, actionPrediction: true });
  const a = predictionSchema(catalog, [{ path: '/private/a' }], options);
  const b = predictionSchema([], [], { ...options, maxSuggestedActions: 0 });
  assert.deepEqual(a, b);
  assert.doesNotMatch(JSON.stringify(a), /enum|\/private|skill:|mcp:/);
  assert.equal(a.properties.warnings, undefined);
});

test('review template is separate, quotes only supplied Skill descriptions and scopes principles', () => {
  const result = buildTrajectoryPrompts({ trajectory: 'TRAJECTORY', skills: catalog,
    systemPrompt: 'MAIN-SYSTEM', userPrompt: 'USER-TASK' });
  for (const value of ['METHOD-DATA', 'TRAJECTORY', 'MAIN-SYSTEM', 'USER-TASK']) {
    assert.ok(result.input.includes(value));
    assert.ok(!result.systemPrompt.includes(value));
  }
  assert.doesNotMatch(result.input, /SERVICE-DATA|TOOL-DATA/);
  assert.match(result.systemPrompt, /actual task, object and applicable stage/);
  assert.match(result.systemPrompt, /not invent its body/);
  assert.match(result.systemPrompt, /Normal work in progress/);
  assert.match(result.systemPrompt, /already corrected historical mistakes/);
  assert.match(result.systemPrompt, /not a comprehensive compliance audit/);
  assert.equal(trajectorySchema.type, 'array');
  assert.equal(trajectorySchema.items.minItems, 2);
  assert.equal(trajectorySchema.items.maxItems, 2);
});

import { createInternalSession, requestModel } from './model-request.js';
import { buildPredictionPrompts, predictionSchema, predictionFields } from './prompts.js';
import path from 'node:path';
import { readPathKey } from './trajectory.js';
import { thinkingLevel } from './router.js';
import { readFile, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { inside, projectIndex, secretName, skillFileIndex } from './context-index.js';

export const PREFETCH_TYPE = 'capability-prefetch';
export function recommendationOptions(value = {}) {
  const keys = ['provider', 'model', 'capabilityPrediction', 'actionPrediction', 'trajectoryWarnings', 'trajectoryWarningEverySteps', 'maxSuggestedActions', 'autoRecommendThinkingLevel', 'toolSearchThinkingLevel'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error(`capabilityDiscovery accepts only ${keys.join(', ')}`);
  const result = { provider: 'llama', model: 'iq3', capabilityPrediction: false, actionPrediction: false, trajectoryWarnings: false, trajectoryWarningEverySteps: 5, maxSuggestedActions: 3, ...value };
  for (const key of ['provider', 'model']) if (typeof result[key] !== 'string' || !result[key].trim()) throw new Error(`${key} must be a nonempty string`);
  for (const key of ['capabilityPrediction', 'actionPrediction', 'trajectoryWarnings']) if (typeof result[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  if (!Number.isInteger(result.trajectoryWarningEverySteps) || result.trajectoryWarningEverySteps < 0 || result.trajectoryWarningEverySteps > 1000) throw new Error('trajectoryWarningEverySteps must be an integer 0–1000');
  if (!Number.isInteger(result.maxSuggestedActions) || result.maxSuggestedActions < 0 || result.maxSuggestedActions > 8) throw new Error('maxSuggestedActions must be an integer 0–8');
  return { ...result,
    autoRecommendThinkingLevel: thinkingLevel(value.autoRecommendThinkingLevel, 'autoRecommendThinkingLevel'),
    toolSearchThinkingLevel: thinkingLevel(value.toolSearchThinkingLevel, 'toolSearchThinkingLevel') };
}

// Persist actual execution records, project standard tool messages, never replay tools.
export function projectPrefetch(messages) {
  const present = new Set(messages.filter(m => m.role === 'toolResult').map(m => m.toolCallId));
  return messages.flatMap(message => {
    if (message.role !== 'custom' || message.customType !== PREFETCH_TYPE) return [message];
    const rounds = message.details?.prefetch?.rounds;
    if (!Array.isArray(rounds)) return [message];
    return [message, ...rounds.filter(round => !round.messages.slice(1).every(m => present.has(m.toolCallId)))
      .flatMap(round => round.messages)];
  });
}
export function validatePrediction(value, catalog, files, options = {}) {
  options = recommendationOptions(options);
  const limit = options.actionPrediction ? options.maxSuggestedActions : 0;
  const required = predictionFields(options);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== required.length
    || required.some(key => !Array.isArray(value[key]))
    || Object.keys(value).some(key => !required.includes(key))) throw new Error('Invalid prediction');
  value = { suggestions: [], actions: [], ...value };
  if (value.actions.length > limit) throw new Error('Invalid prediction');
  const capabilities = new Map(catalog.map(c => [`${c.type}:${c.name}`, c]));
  const paths = new Set(files.map(f => f.key ?? f.path));
  const suggestions = value.suggestions.map(item => {
    if (!item || Object.keys(item).some(k => !['id', 'confidence'].includes(k)) || !capabilities.has(item.id)
      || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error('Invalid capability');
    return { ...capabilities.get(item.id), confidence: item.confidence };
  });
  const seen = new Set();
  const actions = value.actions.filter(action => {
    if (!action || Object.keys(action).some(k => !['tool', 'arguments'].includes(k)) || !action.arguments
      || Object.keys(action.arguments).length !== 1
      || !(action.tool === 'read' && paths.has(action.arguments.path)
        || action.tool === 'bash' && typeof action.arguments.command === 'string'
          && action.arguments.command.trim().length > 0 && action.arguments.command.length <= 2000 && !action.arguments.command.includes('\0'))) throw new Error('Action is not allowed');
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { suggestions, actions };
}
// Bound the serialized field, including JSON escaping; never enumerate the read set
// itself (it may contain paths outside the current allowed file index).
function retainedReadIndex(files, readPaths, cwd) {
  const result = { paths: [], truncated: false };
  let size = JSON.stringify(result).length;
  const seen = new Set();
  for (const file of files) {
    if (!readPaths.has(readPathKey(file.path, cwd))) continue;
    const key = file.key ?? file.path;
    if (seen.has(key)) continue;
    seen.add(key);
    const extra = JSON.stringify(key).length + (result.paths.length ? 1 : 0);
    if (size + extra > 6000) { result.truncated = true; break; }
    result.paths.push(key); size += extra;
  }
  return result;
}
async function checkedTextFile(file, resolvedPath, cwd, remaining) {
  const target = await realpath(resolvedPath);
  const root = await realpath(file.kind === 'project' ? cwd : path.dirname(file.path));
  if (!inside(root, target) || secretName(path.basename(target))) throw new Error('Read outside allowed scope');
  if (!/\.(?:md|txt|js|mjs|cjs|ts|tsx|jsx|json|jsonc|yaml|yml|toml|ini|sh|py|rs|go|java|css|html|sql)$/.test(target)
    && !['.gitignore', '.urc', 'Makefile', 'Dockerfile'].includes(path.basename(target))) throw new Error('Not an approved text file');
  const size = (await stat(target)).size;
  if (size > 50_000 || size > remaining) throw new Error('Read byte budget exceeded');
  return { target, size };
}
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

// Exactly one tool-free SDK model request. All execution is done by the checked host
// adapter afterwards; results are NEVER fed back into another recommendation request.
export async function runPrefetch({ sdk, query, catalog, ctx, options, signal, readPaths = new Set(), retainedReads = new Map(), trace = () => {} }) {
  const start = performance.now();
  options = recommendationOptions(options);
  if (!options.capabilityPrediction && !options.actionPrediction) return {
    suggestions: [], prefetch: { version: 2, requests: 0, reads: 0, rounds: [] },
    diagnostics: { endReason: 'disabled', totalMs: 0, inferenceMs: 0, requests: 0, actions: [], skipped: [] },
  };
  const label = `${options.provider}/${options.model}`;
  const model = ctx.modelRegistry.find(options.provider, options.model);
  if (!model) throw new Error(`${label} is not configured`);
  if (model.api !== 'openai-completions') throw new Error(`${label}: only openai-completions is supported`);
  const manager = createInternalSession(sdk, ctx, 'preparation', options);
  const childSession = { id: manager.getSessionId(), file: manager.getSessionFile() };
  manager.appendCustomEntry('capability-recommendation-origin', {
    parentSessionId: ctx.sessionManager?.getSessionId?.(), parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
    parentLeafId: ctx.sessionManager?.getLeafId?.(), options,
  });
  trace('session', { childSession });
  let prediction = { suggestions: [], actions: [] }, failure;
  let input = `## Current task and recent trajectory
${query}`;
  let requests = 0, inferenceMs = 0, bytes = 0, tree;
  const rounds = [], actionTimings = [], skipped = [];
  try {
    signal?.throwIfAborted();
    tree = options.actionPrediction && options.maxSuggestedActions ? await projectIndex(ctx.cwd, signal) : { entries: [], files: [], elapsedMs: 0, truncated: false };
    const files = options.actionPrediction ? [...skillFileIndex(catalog.filter(c => c.type === 'skill')), ...tree.files] : [];
    signal?.throwIfAborted();
    const schema = predictionSchema(catalog, files, options);
    manager.appendCustomEntry('capability-recommendation-schema', { name: 'prediction', strict: true, schema });
    const prompts = buildPredictionPrompts({ options, catalog, tree, cwd: ctx.cwd, query,
      retained: retainedReadIndex(files, readPaths, ctx.cwd), schema });
    input = prompts.input;
    const value = await requestModel({ sdk, ctx, options, manager, prompts, schema, signal, trace,
      onRequest: () => { requests++; }, onInference: ms => { inferenceMs = ms; } });
    prediction = validatePrediction(value, catalog, files, options);
    manager.appendCustomEntry('capability-action-dispatch', { actor: 'host', actions: prediction.actions });
    for (const action of prediction.actions) {
      signal?.throwIfAborted();
      if (action.tool === 'bash') readPaths.clear(); // Bash may mutate any previously read file.
      const actionStart = performance.now(), id = `prepare_${randomUUID().replaceAll('-', '')}`;
      const selectedFile = action.tool === 'read' ? files.find(f => (f.key ?? f.path) === action.arguments.path) : undefined;
      const resolvedPath = selectedFile && path.resolve(ctx.cwd, selectedFile.path);
      if (resolvedPath && readPaths.has(readPathKey(resolvedPath, ctx.cwd))) {
        const diagnostic = { tool: 'read', path: resolvedPath, reason: 'already-read' };
        skipped.push(diagnostic); trace('skip', diagnostic);
        continue;
      }
      // Revalidate only a selected stale candidate, without injecting another tool
      // result or sending document contents to the predictor. Exact text only.
      const retained = resolvedPath && retainedReads.get(readPathKey(resolvedPath, ctx.cwd));
      if (retained?.isError === false && !retained.details?.truncation?.truncated
        && !retained.details?.truncation?.firstLineExceedsLimit && retained.content?.length
        && retained.content.every(part => part.type === 'text' && typeof part.text === 'string')) {
        try {
          const { target, size } = await checkedTextFile(selectedFile, resolvedPath, ctx.cwd, 100_000 - bytes);
          bytes += size;
          const current = await readFile(target, { encoding: 'utf8', signal });
          if (current === retained.content.map(part => part.text).join('')) {
            readPaths.add(readPathKey(resolvedPath, ctx.cwd));
            const diagnostic = { tool: 'read', path: resolvedPath, reason: 'retained-content-unchanged' };
            skipped.push(diagnostic); trace('skip', diagnostic);
            continue;
          }
        } catch { /* Unverifiable evidence cannot suppress the normal checked read. */ }
      }
      const args = action.tool === 'bash' ? { command: action.arguments.command, timeout: 2 } : { path: resolvedPath };
      const call = { type: 'toolCall', id, name: action.tool, arguments: args };
      // Explicit host provenance above: these calls are dispatched from the prediction,
      // not falsely claimed to be native tool calls emitted by iq3.
      const assistant = { role: 'assistant', content: [call], api: model.api, provider: model.provider, model: model.id,
        stopReason: 'toolUse', usage: zeroUsage(), timestamp: Date.now() };
      manager.appendMessage(assistant);
      let result;
      try {
        if (action.tool === 'read') {
          const file = selectedFile;
          const { size } = await checkedTextFile(file, resolvedPath, ctx.cwd, 100_000 - bytes);
          bytes += size;
          result = await sdk.createReadToolDefinition(ctx.cwd).execute(id, args, signal);
          if (!result.isError && !result.details?.truncation?.truncated && !result.details?.truncation?.firstLineExceedsLimit) readPaths.add(readPathKey(resolvedPath, ctx.cwd));
        } else result = await sdk.createBashToolDefinition(ctx.cwd).execute(id, args, signal);
      } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
      const toolResult = { role: 'toolResult', toolCallId: id, toolName: action.tool, content: result.content,
        details: result.details, isError: result.isError === true, timestamp: Date.now() };
      manager.appendMessage(toolResult);
      rounds.push({ sourceCallIds: [id], messages: [assistant, toolResult] });
      actionTimings.push({ tool: action.tool, durationMs: Math.round(performance.now() - actionStart), isError: toolResult.isError });
    }
  } catch (error) {
    failure = signal?.aborted ? 'cancelled-or-timeout' : requests ? 'prediction-error' : 'setup-error';
    trace('failure', { cause: failure });
  } finally {
    // SDK flushes on first user/assistant record. Keep submitted input on setup failure.
    if (!manager.getBranch().some(e => e.type === 'message' && e.message.role === 'user')) {
      manager.appendMessage({ role: 'user', content: input, timestamp: Date.now() });
    }
  }
  const endReason = failure ?? (rounds.some(r => r.messages[1].isError) ? 'action-error' : rounds.length ? 'actions-complete' : 'no-actions-needed');
  const diagnostics = { childSession, endReason, totalMs: Math.round(performance.now() - start), inferenceMs,
    requests: Math.min(requests, 1), actions: actionTimings, skipped,
    capabilities: Object.fromEntries(['skill', 'mcp', 'tool'].map(type => [type, catalog.filter(c => c.type === type).length])), tree: tree && { elapsedMs: tree.elapsedMs, entries: tree.entries.length,
      visited: tree.visited, truncated: tree.truncated, reason: tree.reason } };
  manager.appendCustomEntry('capability-recommendation-outcome', diagnostics);
  return { suggestions: prediction.suggestions, prefetch: { version: 2, requests: Math.min(requests, 1),
    reads: actionTimings.filter(a => a.tool === 'read').length, rounds, ...(failure ? { failure } : {}) }, diagnostics };
}

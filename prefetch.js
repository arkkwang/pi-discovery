import { createInternalSession, requestModel } from './model-request.js';
import { fullCatalogFallback } from './catalog.js';
import { buildPredictionPrompts, predictionSchema } from './prompts.js';
import path from 'node:path';
import { readPathKey } from './trajectory.js';
import { parseModel, recommendationOptions } from './config.js';
import { readFile, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { inside, projectIndex, secretName, skillFileIndex } from './context-index.js';

export const PREFETCH_TYPE = 'capability-prefetch';
export const PREPARATION_BOUNDARY_TYPE = 'capability-preparation-boundary';
// Persist actual execution records, project standard tool messages, never replay tools.
export function projectPrefetch(messages, activeDefinitions) {
  const present = new Set(messages.filter(m => m.role === 'toolResult').map(m => m.toolCallId));
  const declared = new Set(messages.filter(m => m.role === 'system').flatMap(m => (m.toolsAdded ?? []).map(t => t.name)));
  return messages.flatMap(message => {
    if (message.role === 'custom' && message.customType === PREPARATION_BOUNDARY_TYPE) return [];
    if (message.role !== 'custom' || message.customType !== PREFETCH_TYPE) return [message];
    const rounds = message.details?.prefetch?.rounds;
    if (!Array.isArray(rounds)) return [message];
    const projected = [message];
    for (const round of rounds) {
      if (!round.messages.slice(1).every(m => present.has(m.toolCallId))) projected.push(...round.messages);
      // Starting-message expansion happens after the host's initial declaration
      // snapshot. Supply schemas for this request, but never revive tools that
      // the host no longer makes active (e.g. after a branch switch or restore).
      const toolsAdded = (round.toolsAdded ?? [])
        .map(t => activeDefinitions ? activeDefinitions.get(t.name) : t)
        .filter(t => t && !declared.has(t.name));
      if (toolsAdded.length) {
        toolsAdded.forEach(t => declared.add(t.name));
        projected.push({ role: 'system', content: '', toolsAdded, timestamp: message.timestamp });
      }
    }
    return projected;
  });
}
// Malformed model output degrades per item: invalid entries are dropped
// so one bad item never discards valid ones.
// Kept actions still pass the same allowlist checks that guarded execution before.
export function validatePrediction(value, catalog, files, options = {}) {
  options = recommendationOptions(options);
  const dropped = [], suggestions = [], seen = new Map();
  const drop = (kind, reason, item) => {
    const text = item === undefined ? undefined : JSON.stringify(item);
    dropped.push({ kind, reason, ...(item === undefined ? {} : { item: text.length <= 4000 ? item : `${text.slice(0, 4000)}…` }) });
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    drop('response', 'not-an-object'); return { suggestions, dropped };
  }
  for (const key of Object.keys(value)) if (key !== 'suggestions') drop('field', 'unknown-field', key);
  if (!Array.isArray(value.suggestions)) {
    drop('suggestion', value.suggestions === undefined ? 'missing-field' : 'not-an-array');
    return { suggestions, dropped };
  }
  const capabilities = new Map(catalog.map(c => [`${c.type}:${c.name}`, c]));
  const paths = new Set(files.map(f => f.key ?? f.path));
  let actionCount = 0;
  for (const item of value.suggestions) {
    const action = item?.type === 'action', kind = action ? 'action' : 'suggestion';
    const keys = action ? ['type', 'tool', 'arguments', 'confidence'] : ['type', 'name', 'confidence'];
    const valid = item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).length === keys.length && Object.keys(item).every(k => keys.includes(k))
      && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1;
    const args = item?.arguments;
    if (!valid || (action ? !options.actionPrediction || !args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).length !== 1
      || !(item.tool === 'read' && paths.has(args.path) || item.tool === 'bash' && typeof args.command === 'string'
        && args.command.trim().length > 0 && args.command.length <= 2000 && !args.command.includes('\0'))
      : !['skill', 'mcp', 'tool'].includes(item.type) || typeof item.name !== 'string' || !capabilities.has(`${item.type}:${item.name}`))) {
      drop(kind, action ? 'invalid-action' : 'invalid-capability', item); continue;
    }
    const key = action ? JSON.stringify([item.tool, args]) : `${item.type}:${item.name}`;
    if (seen.has(key)) {
      const previous = suggestions[seen.get(key)];
      previous.confidence = Math.max(previous.confidence, item.confidence); continue;
    }
    if (action && actionCount >= options.maxSuggestedActions) { drop(kind, 'over-budget', item); continue; }
    seen.set(key, suggestions.length);
    suggestions.push(action ? { ...item } : { ...capabilities.get(key), confidence: item.confidence });
    if (action) actionCount++;
  }
  return { suggestions, dropped };
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
export async function runPrefetch({ sdk, query, catalog, ctx, options, signal, readPaths = new Set(), retainedReads = new Map(), expandCapability, trace = () => {} }) {
  const start = performance.now();
  options = recommendationOptions(options);
  if (!options.enabled) return {
    suggestions: [], prefetch: { version: 2, requests: 0, reads: 0, rounds: [] },
    diagnostics: { endReason: 'disabled', totalMs: 0, inferenceMs: 0, requests: 0, actions: [], skipped: [] },
  };
  const label = options.model;
  const selected = parseModel(label);
  const model = ctx.modelRegistry.find(selected.provider, selected.id);
  if (!model) throw new Error(`${label} is not configured`);
  if (model.api !== 'openai-completions') throw new Error(`${label}: only openai-completions is supported`);
  const manager = createInternalSession(sdk, ctx, 'preparation', options);
  const discoverySessionId = manager.getSessionId(), discoverySessionFile = manager.getSessionFile();
  manager.appendCustomEntry('capability-recommendation-origin', {
    parentSessionId: ctx.sessionManager?.getSessionId?.(), parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
    parentLeafId: ctx.sessionManager?.getLeafId?.(), options,
  });
  trace('session', { discoverySessionId, discoverySessionFile });
  let prediction = { suggestions: [] }, failure, routingError, predictionCompleted = false;
  let input = `## Current task and recent trajectory
${query}`;
  let requests = 0, inferenceMs = 0, bytes = 0, tree;
  const rounds = [], actionTimings = [], skipped = [];
  try {
    signal?.throwIfAborted();
    tree = options.actionPrediction && options.maxSuggestedActions ? await projectIndex(ctx.cwd, signal) : { entries: [], files: [], elapsedMs: 0, truncated: false };
    const files = [...skillFileIndex(catalog.filter(c => c.type === 'skill')), ...tree.files];
    signal?.throwIfAborted();
    const schema = predictionSchema(catalog, files, options);
    manager.appendCustomEntry('capability-recommendation-schema', { schema });
    const prompts = buildPredictionPrompts({ options, catalog, tree, cwd: ctx.cwd, query,
      retained: retainedReadIndex(files, readPaths, ctx.cwd), schema });
    input = prompts.input;
    const value = await requestModel({ sdk, ctx, options, manager, prompts, signal, trace,
      onRequest: () => { requests++; }, onInference: ms => { inferenceMs = ms; } });
    prediction = validatePrediction(value, catalog, files, options);
    predictionCompleted = true;
    if (!prediction.suggestions.length
      && prediction.dropped.some(d => d.kind === 'response' || d.kind === 'suggestion')) {
      routingError = 'Capability prediction returned invalid suggestions (no valid capabilities).';
    }
    if (prediction.dropped.length) trace('drop', { dropped: prediction.dropped });
    const expansions = options.autoExpand.enabled
      ? prediction.suggestions.filter(s => s.confidence >= options.autoExpand.minConfidence) : [];
    manager.appendCustomEntry('capability-action-dispatch', { actor: 'host', suggestions: expansions });
    for (const suggestion of expansions) {
      const action = suggestion.type === 'skill' ? { tool: 'read', arguments: { path: suggestion.path } }
        : suggestion.type === 'action' ? suggestion
          : { tool: 'tool_search', arguments: { query: suggestion.name } };
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
      const args = action.tool === 'bash' ? { command: action.arguments.command, timeout: 2 }
        : action.tool === 'read' ? { path: resolvedPath } : action.arguments;
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
        } else if (action.tool === 'bash') result = await sdk.createBashToolDefinition(ctx.cwd).execute(id, args, signal);
        else {
          if (!expandCapability) throw new Error('Capability expansion adapter is unavailable');
          result = await expandCapability(suggestion, id, signal);
        }
      } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
      const toolResult = { role: 'toolResult', toolCallId: id, toolName: action.tool, content: result.content,
        details: result.details, isError: result.isError === true, timestamp: Date.now() };
      manager.appendMessage(toolResult);
      rounds.push({ sourceCallIds: [id], messages: [assistant, toolResult],
        ...(result.toolsAdded?.length ? { toolsAdded: result.toolsAdded } : {}) });
      actionTimings.push({ tool: action.tool, durationMs: Math.round(performance.now() - actionStart), isError: toolResult.isError });
      signal?.throwIfAborted();
    }
  } catch (error) {
    failure = signal?.aborted ? 'cancelled-or-timeout' : requests ? 'prediction-error' : 'setup-error';
    if (!predictionCompleted) {
      routingError = `Capability prediction failed: ${String(error?.message ?? error)}`;
    }
    trace('failure', { cause: failure, ...(signal?.aborted ? {} : { error: String(error?.message ?? error) }) });
  } finally {
    // SDK flushes on first user/assistant record. Keep submitted input on setup failure.
    if (!manager.getBranch().some(e => e.type === 'message' && e.message.role === 'user')) {
      manager.appendMessage({ role: 'user', content: input, timestamp: Date.now() });
    }
  }
  const endReason = failure ?? (routingError ? 'invalid-capabilities'
    : rounds.some(r => r.messages[1].isError) ? 'action-error' : rounds.length ? 'actions-complete' : 'no-actions-needed');
  const fallback = routingError && !signal?.aborted ? fullCatalogFallback(catalog, routingError) : undefined;
  const diagnostics = {
    parentSessionId: ctx.sessionManager?.getSessionId?.(), parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
    discoverySessionId, discoverySessionFile, endReason, ...(routingError ? { routingError } : {}),
    ...(fallback ? { fallback: fallback.fallback } : {}), totalMs: Math.round(performance.now() - start), inferenceMs,
    requests: Math.min(requests, 1), actions: actionTimings, skipped,
    ...(prediction.dropped?.length ? { dropped: prediction.dropped } : {}),
    capabilities: Object.fromEntries(['skill', 'mcp', 'tool'].map(type => [type, catalog.filter(c => c.type === type).length])), tree: tree && { elapsedMs: tree.elapsedMs, entries: tree.entries.length,
      visited: tree.visited, truncated: tree.truncated, reason: tree.reason } };
  manager.appendCustomEntry('capability-recommendation-outcome', diagnostics);
  return { suggestions: prediction.suggestions, ...(routingError ? { routingError } : {}), ...fallback,
    prefetch: { version: 2, requests: Math.min(requests, 1),
    reads: actionTimings.filter(a => a.tool === 'read').length, rounds, ...(failure ? { failure } : {}) }, diagnostics };
}

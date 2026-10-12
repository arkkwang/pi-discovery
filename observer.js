import { createInternalSession, requestModel } from './model-request.js';
import { buildTrajectoryPrompts, trajectorySchema } from './prompts.js';
import { recommendationOptions } from './prefetch.js';

export function validateTrajectory(value) {
  if (!Array.isArray(value) || value.some(item => !Array.isArray(item) || item.length !== 2
    || item.some(text => typeof text !== 'string' || !text.trim()))) throw new Error('Invalid trajectory review');
  return value;
}

// Independent, tool-free path: no project index, retained-read scan, preparation
// actions or MCP catalog. The fixed interval, not a guessed problem, triggers it.
export async function runTrajectoryReview({ sdk, ctx, options, trajectory, skills, systemPrompt, userPrompt,
  signal, trace = () => {} }) {
  options = recommendationOptions(options);
  const start = performance.now();
  const prompts = buildTrajectoryPrompts({ trajectory, skills, systemPrompt, userPrompt });
  const manager = createInternalSession(sdk, ctx, 'trajectory', options);
  const childSession = { id: manager.getSessionId(), file: manager.getSessionFile() };
  manager.appendCustomEntry('trajectory-review-origin', {
    parentSessionId: ctx.sessionManager?.getSessionId?.(), parentSessionFile: ctx.sessionManager?.getSessionFile?.(),
    parentLeafId: ctx.sessionManager?.getLeafId?.(),
  });
  trace('session', { childSession });
  let warnings = [], requests = 0, inferenceMs = 0, failure;
  try {
    warnings = validateTrajectory(await requestModel({ sdk, ctx, options, manager, prompts, schema: trajectorySchema, signal, trace,
      onRequest: () => { requests++; }, onInference: ms => { inferenceMs = ms; } }));
  } catch {
    failure = signal?.aborted ? 'cancelled-or-timeout' : requests ? 'prediction-error' : 'setup-error';
  } finally {
    if (!manager.getBranch().some(e => e.type === 'message' && e.message.role === 'user')) {
      manager.appendMessage({ role: 'user', content: prompts.input, timestamp: Date.now() });
    }
  }
  const diagnostics = { childSession, requests, inferenceMs, totalMs: Math.round(performance.now() - start),
    ...(failure ? { failure } : {}) };
  manager.appendCustomEntry('trajectory-review-outcome', diagnostics);
  return { warnings, diagnostics, ...(failure ? { failure } : {}) };
}

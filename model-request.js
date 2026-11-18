import { thinkingLevel, parseModel } from './config.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';

// Shared transport only. Preparation and trajectory review own their inputs,
// schemas, validation and dispatch; neither can invoke the other's actions.

// Use normal SDK session storage and one stable, visible cwd group.
export function createInternalSession(sdk, ctx, kind, options) {
  const cwd = path.join(tmpdir(), 'pi-discovery');
  mkdirSync(cwd, { recursive: true });
  const manager = sdk.SessionManager.create(cwd);
  manager.appendSessionInfo(`pi-discovery · ${kind} · ${options.model} · ${manager.getSessionId()}`);
  return manager;
}
export async function requestModel({ sdk, ctx, options, manager, prompts, signal,
  trace = () => {}, onRequest = () => {}, onInference = () => {} }) {
  let session, requests = 0;
  const abort = () => { if (session) void session.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const selected = parseModel(options.model);
    const model = ctx.modelRegistry.find(selected.provider, selected.id);
    if (!model) throw new Error(`${options.model} is not configured`);
    if (model.api !== 'openai-completions') throw new Error('Only openai-completions is supported');
    const settingsManager = sdk.SettingsManager.inMemory({ packages: [], skills: [], compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: manager.getCwd(), agentDir: sdk.getAgentDir(), settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: prompts.systemPrompt, appendSystemPrompt: [], extensionFactories: [] });
    await resourceLoader.reload();
    signal?.throwIfAborted();
    const runtime = await sdk.ModelRuntime.create({ refreshOnCreate: false });
    ({ session } = await sdk.createAgentSession({ cwd: manager.getCwd(), model,
      thinkingLevel: thinkingLevel(options.thinkingLevel), modelRuntime: runtime,
      settingsManager, resourceLoader, tools: [], sessionManager: manager }));
    session.agent.streamFunction = (selected, context, streamOptions) => {
      signal?.throwIfAborted();
      if (requests++) throw new Error('Only one prediction request is permitted');
      onRequest(); trace('request', { request: 1 });
      // The output shape lives in the prompt (schema plus a bare-JSON instruction) and in
      // host validation. No provider-specific response_format is sent: services differ on
      // json_schema support, and one rejection would fail the whole prediction session.
      return ctx.modelRegistry.streamSimple(selected, context, streamOptions);
    };
    await session.bindExtensions({});
    signal?.throwIfAborted();
    const start = performance.now();
    try { await session.prompt(prompts.input); }
    finally {
      const ms = Math.round(performance.now() - start);
      onInference(ms); trace('request-complete', { request: 1, durationMs: ms });
    }
    signal?.throwIfAborted();
    const answer = session.messages.filter(m => m.role === 'assistant').at(-1);
    if (!answer || answer.stopReason !== 'stop') {
      // Preserve a provider status without copying arbitrary response bodies into
      // the main context. Full transport evidence stays in the child session.
      const status = answer?.errorMessage?.match(/\b[45]\d{2}\b/)?.[0];
      throw new Error(`Prediction did not complete${status ? ` (HTTP ${status})` : ''}`);
    }
    try { return JSON.parse(answer.content.filter(c => c.type === 'text').map(c => c.text).join('')); }
    catch { throw new Error('Prediction returned invalid JSON'); }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (session) { await session.abort(); session.dispose(); }
  }
}

// Host factories keep MCP readiness, schema identity, activation and transcript semantics intact.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { routeCapabilities } from './router.js';
import { PREFETCH_TYPE, recommendationOptions, projectPrefetch, runPrefetch } from './prefetch.js';
import { runTrajectoryReview } from './observer.js';
import { executionTrajectory, recommendationQuery, preparationContext } from './trajectory.js';

function catalogDescription(skill) {
  try {
    const text = readFileSync(skill.path, 'utf8');
    const header = text.match(/^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/);
    const value = header && parse(header[1])?.metadata?.['catalog-description'];
    if (typeof value === 'string' && value.trim()) return value.trim();
  } catch {
    // Optional metadata must not hide a Skill already resolved by the host.
  }
  return skill.description;
}

export function mcpCapabilities(tools) {
  const groups = new Map();
  for (const tool of tools) {
    const ns = tool.namespace;
    if (tool.exposure === 'hidden' || !ns?.name.startsWith('mcp__')) continue;
    if (!groups.has(ns.name)) groups.set(ns.name, { namespace: ns, tools: [] });
    groups.get(ns.name).tools.push(tool);
  }
  return [...groups.values()].map(({ namespace, tools: members }) => ({
    type: 'mcp', name: namespace.name,
    description: namespace.description || `MCP tools: ${members.map(t => t.name).join(', ')}`,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

// Mirror the host's searchable exposures, independent of current activation.
// MCP members are represented by their namespace; all other tools get their own entry.
export function toolCapabilities(tools) {
  return tools.filter(t => ['deferred', 'codemode'].includes(t.exposure)
    && !t.namespace?.name.startsWith('mcp__'))
    .map(t => ({ type: 'tool', name: t.name, description: t.description || t.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function result(details, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(details) }], details };
}

export { recommendationQuery } from './trajectory.js';

export function registerDiscovery(pi, { createToolSearchExtension, createMcpExtension, sdk, predict = runPrefetch, review = runTrajectoryReview }) {
  // The saved custom message owns the child transcript. Projection is deterministic on
  // resume/fork and does not append duplicate records or alter the system prompt.
  let preparationRun, inputId, diagnosticWarningInputId;
  // Parent JSONL is the index of decisions; full model inputs remain in child sessions.
  // A context-ready event proves hook delivery, not provider receipt/model compliance.
  function diagnostic(ctx, data) {
    try {
      pi.appendEntry('capability-prefetch-diagnostic', { version: 1, inputId,
        parentLeafId: ctx?.sessionManager?.getLeafId?.(), ...data });
      return true;
    } catch {
      if (diagnosticWarningInputId !== inputId || !inputId) {
        diagnosticWarningInputId = inputId;
        ctx?.ui?.notify('无法保存推荐／审查诊断；本轮排障证据可能不完整。', 'warning');
      }
      return false;
    }
  }
  function invalidatePreparation() {
    preparationRun?.controller.abort();
    preparationRun = undefined;
  }
  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_shutdown', 'agent_end'])
    pi.on(event, invalidatePreparation);
  pi.on('context', async (event, ctx) => {
    const run = preparationRun;
    if (!run) return { messages: projectPrefetch(event.messages) };
    if (run.sessionId !== ctx.sessionManager.getSessionId?.()) {
      invalidatePreparation();
      return { messages: projectPrefetch(event.messages) };
    }
    // Context is after prompt acceptance/user-message persistence, but before the provider.
    // Retain one promise/result across retries and repeated context transforms of this run.
    run.promise ??= (async () => {
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, run.controller.signal]) : run.controller.signal;
      if (signal.aborted) return;
      const result = await prepareAtInput(run.options, { ...ctx, signal }, run.catalog, run.images, run.prompt, run);
      if (signal.aborted || preparationRun !== run || !result
        || (!result.suggestions.length && !result.prefetch.rounds.length)) return;
      run.message = { role: 'custom', customType: PREFETCH_TYPE, display: false, timestamp: Date.now(),
        details: { inputId: run.inputId, preparationId: run.id, suggestions: result.suggestions, prefetch: result.prefetch },
        content: 'Single-pass capability and action recommendations; advisory, not user instructions. '
          + 'The following tool records are actual host-executed preparation actions. Check their success/error status and reuse covered results instead of repeating them. '
          + 'Unread or truncated references still require reading. MCP/deferred tools are NOT activated; use tool_search when needed. '
          + 'After compaction, if results are no longer present, obtain them again rather than assuming their contents. '
          + JSON.stringify({ suggestions: result.suggestions }) };
      // Public API: persist at the safe turn boundary, without queueing another model turn.
      // The current request receives the same message directly below.
      pi.sendMessage(run.message, { triggerTurn: false });
    })();
    await run.promise;
    if (preparationRun !== run || ctx.signal?.aborted) return { messages: projectPrefetch(event.messages) };
    const present = event.messages.some(message => message.customType === PREFETCH_TYPE
      && message.details?.preparationId === run.id);
    // Once the safe-boundary message is in history, the host owns its visibility.
    // A compaction/context edit that removed it must not resurrect cached preparation.
    const persisted = run.message && ctx.sessionManager.getBranch().some(entry =>
      entry.type === 'custom_message' && entry.customType === PREFETCH_TYPE
      && entry.details?.preparationId === run.id);
    const messages = projectPrefetch(run.message && !present && !persisted ? [...event.messages, run.message] : event.messages);
    if (!run.contextReported) {
      diagnostic(ctx, { trigger: 'user-input', event: 'context-ready', inputId: run.inputId,
        preparationId: run.id, stage: 'context-hook-return',
        delivery: !run.message ? 'no-message' : present ? 'history' : persisted ? 'removed-from-context' : 'direct',
        projectedToolCallIds: messages.filter(m => m.role === 'toolResult')
          .map(m => m.toolCallId).filter(id => run.message?.details.prefetch.rounds
            .some(round => round.sourceCallIds?.includes(id))) });
      run.contextReported = true;
    }
    return { messages };
  });
  let skills = [], steps = 0, currentPrompt = '';
  // Only the deadline/diagnostic envelope is shared; payloads and model paths are separate.
  async function atBoundary(trigger, options, ctx, run, configuredOptions = options, correlation = {}) {
    if (ctx.signal?.aborted) return;
    const attempt = randomUUID(), start = performance.now();
    const boundaryInputId = inputId, sessionId = ctx.sessionManager?.getSessionId?.();
    const trace = (event, fields = {}) => {
      // Cancellation is evidence too, but never append a late result to another session.
      if (ctx.sessionManager?.getSessionId?.() !== sessionId) return false;
      return diagnostic(ctx, { inputId: boundaryInputId, ...correlation, attempt, trigger, event,
        elapsedMs: Math.round(performance.now() - start), ...fields });
    };
    const deadline = AbortSignal.timeout(60_000);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, deadline]) : deadline;
    try {
      // This existing synchronous append also persists the current branch leaf.
      if (!trace('start', { ...options, configuredOptions, effectiveOptions: options, predictionRounds: 1, budgetMs: 60000 }))
        throw new Error('Cannot persist trajectory boundary diagnostic');
      if (!sdk) throw new Error('Pi SDK prediction adapter is unavailable');
      const result = await run({ signal, trace });
      trace('complete', { ...result.diagnostics, configuredOptions,
        ...(trigger === 'periodic' ? { warningCount: result.warnings?.length ?? 0,
          outcome: result.failure ? 'failed' : result.warnings?.length ? 'warnings' : 'no-warnings' } : {}),
        totalMs: Math.round(performance.now() - start) });
      if (ctx.signal?.aborted) return;
      if (result.failure || result.prefetch?.failure) ctx.ui.notify('能力预测／轨迹分析未完整完成；仍可使用 tool_search。', 'warning');
      return result;
    } catch (error) {
      trace('failure', { cause: ctx.signal?.aborted ? 'caller' : deadline.aborted ? 'deadline' : 'error',
        ...(ctx.signal?.aborted ? {} : { error: String(error?.message ?? error) }) });
      if (!ctx.signal?.aborted) ctx.ui.notify(`能力预测／轨迹分析失败：${error.message}；仍可使用 tool_search。`, 'warning');
    }
  }
  function prepareAtInput(options, ctx, catalog, images, prompt, run) {
    const configuredOptions = options;
    options = { ...options, trajectoryWarnings: false };
    return atBoundary('user-input', options, ctx, async ({ signal, trace }) => {
      const { readPaths, retainedReads } = preparationContext(ctx.sessionManager, '', ctx.cwd,
        { reads: options.actionPrediction, rules: false });
      signal.throwIfAborted();
      return predict({ sdk, query: await recommendationQuery(prompt, ctx.sessionManager, images, ctx.cwd, { signal }),
        catalog, ctx, options, signal, trace, readPaths, retainedReads });
    }, configuredOptions, { preparationId: run.id, inputId: run.inputId });
  }
  pi.on('turn_end', async (_event, ctx) => {
    let options;
    try { options = recommendationOptions(pi.getSettings().capabilityDiscovery); }
    catch (error) {
      diagnostic(ctx, { trigger: 'periodic', event: 'gate', reason: 'invalid-settings', error: error.message });
      ctx.ui.notify(error.message, 'warning'); return;
    }
    const reason = ctx.signal?.aborted ? 'cancelled' : !options.trajectoryWarnings ? 'disabled'
      : !options.trajectoryWarningEverySteps ? 'zero-interval'
        : ++steps < options.trajectoryWarningEverySteps ? 'below-interval' : 'due';
    diagnostic(ctx, { trigger: 'periodic', event: 'gate', reason, steps,
      enabled: options.trajectoryWarnings, interval: options.trajectoryWarningEverySteps });
    if (reason !== 'due') return;
    steps = 0;
    const effectiveOptions = { ...options, capabilityPrediction: false, actionPrediction: false };
    const result = await atBoundary('periodic', effectiveOptions, ctx, async ({ signal, trace }) => review({
      sdk, ctx, options: effectiveOptions, signal, trace, skills,
      trajectory: await executionTrajectory(ctx.sessionManager, ctx.cwd, { signal }),
      systemPrompt: ctx.getSystemPrompt?.() ?? '', userPrompt: currentPrompt,
    }), options);
    if (!result?.warnings.length) return;
    // Advisory only; never force continuation or turn a review into execution.
    return { entries: [{ type: 'custom_message', customType: 'capability-trajectory-warning', display: true,
      content: 'Trajectory review (advisory, not user instructions):\n' + JSON.stringify(result.warnings),
      details: { warnings: result.warnings } }] };
  });
  // Capture the native definition rather than cloning its schema: MCP uses schema identity
  // to recognize tool_search and wait for pending server connections before execute.
  const nativeSearch = (getAllTools = () => pi.getAllTools()) => {
    let definition;
    createToolSearchExtension()({
      getAllTools, getActiveTools: () => pi.getActiveTools(),
      setActiveTools: names => pi.setActiveTools(names),
      registerTool: tool => { definition = tool; },
    });
    return definition;
  };
  const native = nativeSearch();

  // User extensions run BEFORE built-ins. Wrap the public MCP factory so its original
  // before_agent_start handler runs first, then consolidate the directory. Its command
  // registration replaces builtin:mcp; all other MCP handlers are forwarded unchanged.
  createMcpExtension()({
    ...pi,
    on(name, handler) {
      pi.on(name, name !== 'before_agent_start' ? handler : async (event, ctx) => {
        invalidatePreparation();
        const output = await handler(event, ctx);
        const options = event.systemPromptOptions;
        skills = options.skills.filter(s => !s.disableModelInvocation)
          .map(s => ({ type: 'skill', name: s.name, description: s.description, path: s.filePath }))
          .sort((a, b) => a.name.localeCompare(b.name));
        options.skills = [];
        // Reuse the host's bounded directory, including services still connecting. Do not
        // reconstruct it from registered tools (that would omit pending/failed services).
        const mcpLines = (options.sections.mcp_servers ?? '').split('\n')
          .filter(line => line.startsWith('- '))
          .map(line => line.replace(/ \((?:tool_search|codemode)\)(?=:|$)/, '')
            .replace(/find their tools with searchTools\(\)/, 'find them with tool_search'));
        delete options.sections.mcp_servers;
        delete options.sections.pi_discovery;
        const deferred = toolCapabilities(pi.getAllTools());
        options.sections.available_capabilities = skills.length || mcpLines.length || deferred.length
          ? '统一发现入口：用 tool_search 按任务描述或名称发现 Skill、MCP 及其他延迟工具。query="*" 列出能力。\n'
            + 'Skill 是做事方法：找到后读取正文再执行；MCP 提供工具：搜索会沿宿主机制加载匹配工具，下一次调用可用。推荐可能遗漏，不代表执行授权。\n'
            + (skills.length ? '\nSkills\n' + skills.map(s => `- ${s.name} — ${catalogDescription(s).replace(/\s+/g, ' ').trim()}`).join('\n') : '')
            + (mcpLines.length ? '\n\nMCP\n' + mcpLines.join('\n') : '')
            // Names only: full descriptions arrive with the loaded tool schema; the routing catalog keeps them.
            + (deferred.length ? '\n\nDeferred tools\n' + deferred.map(t => `- ${t.name}`).join('\n') : '')
          : '';
        const resetFromSteps = steps;
        steps = 0;
        inputId = randomUUID();
        currentPrompt = event.prompt ?? '';
        let preparation;
        try { preparation = recommendationOptions(pi.getSettings().capabilityDiscovery); }
        catch (error) {
          diagnostic(ctx, { trigger: 'user-input', event: 'input', resetFromSteps,
            preparation: 'invalid-settings', error: error.message });
          ctx.ui.notify(error.message, 'warning'); return output;
        }
        const preparationDecision = !preparation.capabilityPrediction && !preparation.actionPrediction ? 'disabled'
          : !event.prompt?.trim() && !event.images?.length ? 'empty-input' : 'scheduled';
        diagnostic(ctx, { trigger: 'user-input', event: 'input', resetFromSteps,
          configuredOptions: preparation, preparation: preparationDecision });
        if (preparationDecision !== 'scheduled') return output;
        // Pending services remain discoverable without connecting or activating them.
        const registeredMcp = mcpCapabilities(pi.getAllTools());
        const pendingMcp = mcpLines.flatMap(line => {
          const match = line.match(/^- (mcp__[^: ]+)(?::\s*(.*))?$/);
          return match && !registeredMcp.some(c => c.name === match[1])
            ? [{ type: 'mcp', name: match[1], description: match[2] || `MCP service ${match[1]}` }] : [];
        });
        preparationRun = { id: randomUUID(), inputId, controller: new AbortController(),
          sessionId: ctx.sessionManager.getSessionId?.(), prompt: currentPrompt,
          options: preparation, catalog: [...skills, ...registeredMcp, ...pendingMcp, ...deferred], images: event.images };
        return output;
      });

    },
  });

  const discovery = {
    ...native,
    description: 'Unified discovery for Skills, MCP services and deferred tools. Describe the task to get relevant Skills and load matching tools in one call. Exact Skill, MCP namespace or tool names bypass the routing model; query="*" lists capabilities without loading. Read returned Skill paths before acting. MCP tool loading uses the host mechanism and takes effect on the next model call. Use this entry for Skill and MCP discovery.',
    promptSnippet: 'Discover Skills and MCP/tools; read Skill files and use loaded tools',
    async execute(id, { query, limit = 8 }, signal, onUpdate, ctx) {
      if (typeof query !== 'string' || !query.trim()) throw new Error('query must not be empty');
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
      signal?.throwIfAborted();
      const task = query.trim();
      const tools = pi.getAllTools();
      const catalog = [...skills, ...mcpCapabilities(tools), ...toolCapabilities(tools)];
      const exact = catalog.filter(c => [c.name.toLowerCase(), `${c.type}:${c.name}`.toLowerCase()].includes(task.toLowerCase()));
      const exactTool = tools.find(t => t.exposure !== 'hidden' && [t.name.toLowerCase(), `tool:${t.name}`.toLowerCase()].includes(task.toLowerCase()));
      const mode = task === '*' ? 'list' : exact.length || exactTool ? 'exact' : 'semantic';
      let suggestions, routingError;
      try {
        suggestions = mode === 'list' || mode === 'exact'
          ? (mode === 'list' ? catalog : exact).map(c => ({ ...c, confidence: null }))
          : catalog.length ? await routeCapabilities(task, catalog, ctx?.modelRegistry, signal,
            recommendationOptions(pi.getSettings().capabilityDiscovery).toolSearchThinkingLevel,
            recommendationOptions(pi.getSettings().capabilityDiscovery)) : [];
      } catch (error) {
        signal?.throwIfAborted();
        // Keep native tool discovery usable if the local recommendation model is down.
        // Report the failed Skill/MCP recommendation explicitly, never as a no-match.
        routingError = `Capability routing failed: ${error.message}`;
        suggestions = [];
      }
      signal?.throwIfAborted();
      const selected = suggestions.slice(0, limit);
      const namespaces = new Set(selected.filter(c => c.type === 'mcp').map(c => c.name));
      const toolNames = new Set(selected.filter(c => c.type === 'tool').map(c => c.name));
      if (exactTool) toolNames.add(exactTool.name);
      let loaded = [];
      if (mode !== 'list' && (toolNames.size || namespaces.size || (mode === 'semantic' && !selected.length))) {
        // Only scope candidates; ranking, activation and duplicate handling are native.
        const scoped = toolNames.size || namespaces.size
          ? nativeSearch(() => pi.getAllTools().filter(t => toolNames.has(t.name) || namespaces.has(t.namespace?.name)))
          : native;
        const search = await scoped.execute(id, {
          query: exactTool?.name ?? (namespaces.size || toolNames.size ? `${[...namespaces, ...toolNames].join(' ')} ${task}` : task), limit,
        }, signal, onUpdate, ctx);
        loaded = search.details?.loaded ?? [];
      }
      const active = new Set(pi.getActiveTools());
      const availableTools = pi.getAllTools().filter(t => active.has(t.name) && t.exposure !== 'hidden'
        && (toolNames.has(t.name) || namespaces.has(t.namespace?.name))).map(t => t.name);
      return result({
        mode, total: suggestions.length, suggestions: selected, loaded, availableTools,
        ...(routingError ? { routingError } : {}),
        hint: 'Read Skill files before use. Loaded tools are callable from the next model call; availableTools includes already-active matches. Suggestions may omit useful capabilities; confidence is not calibrated. Use an exact name or query="*" with a larger limit if routing fails. Discovery does not authorize execution.',
      }, !!routingError && !loaded.length);
    },
  };
  pi.registerTool(discovery);
}


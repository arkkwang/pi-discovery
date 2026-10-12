import { registerDiscovery } from '../discovery.js';
export const nativeSchema = { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] };
export function setup({ skills = [], tools = [], sections = {}, nativeExecute, mcpWait, sdk, settings = {}, register = registerDiscovery } = {}) {
  const handlers = {};
  let tool, active = ['read', 'tool_search'];
  const calls = [], diagnostics = [], sent = [];
  const pi = {
    appendEntry: (type, data) => diagnostics.push({ type, data }),
    sendMessage: (message, options) => sent.push({ message, options }),
    getSettings: () => settings,
    on: (name, fn) => { handlers[name] = fn; }, registerTool: value => { tool = value; },
    getAllTools: () => tools, getActiveTools: () => active, setActiveTools: names => { active = names; },
  };
  register(pi, {
    sdk,
    createMcpExtension: () => api => {
      api.on('before_agent_start', event => { calls.push('mcp-prompt'); Object.assign(event.systemPromptOptions.sections, sections); });
      api.on('tool_call', mcpWait ?? (() => calls.push('mcp-wait')));
    },
    createToolSearchExtension: () => api => api.registerTool({
      name: 'tool_search', parameters: nativeSchema, exposure: 'model-only', defaultActive: false,
      execute: nativeExecute ?? (async (_id, args) => {
        calls.push({ args, candidates: api.getAllTools().map(t => t.name) });
        return { details: { loaded: [] }, content: [] };
      }),
    }),
  });
  return {
    handlers, tool, calls, diagnostics, sent, pi, setTools: value => { tools = value; },
    async prompt(nextSkills = skills) {
      const options = { skills: [...nextSkills], sections: { keep: 'unchanged' } };
      await handlers.before_agent_start({ systemPromptOptions: options });
      return options;
    },
    async search(args = { query: '*' }, ctx) { return tool.execute('id', args, undefined, undefined, ctx); },
  };
}

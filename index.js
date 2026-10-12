// Static imports let Pi's loader resolve the running host (including bundled CLI builds).
import { createMcpExtension, createToolSearchExtension, createAgentSession, createReadToolDefinition, createBashToolDefinition,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { registerDiscovery } from './discovery.js';

export default function (pi) {
  registerDiscovery(pi, { createMcpExtension, createToolSearchExtension,
    sdk: { createAgentSession, createReadToolDefinition, createBashToolDefinition,
      DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, getAgentDir } });
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { registerDiscovery } from '../discovery.js';

// The extension must be the replacement, not a reason to disable the host's
// built-in extensions: host settings stay default, so a machine without this
// package keeps the native tool_search and MCP, and a machine with it gets one
// tool_search and one /mcp, provided by this extension.
const sdkRoot = process.env.PI_DISCOVERY_SDK_ROOT;
const native = ['tool-search', 'mcp'];
const nativePaths = native.map(name => `builtin:${name}`).sort();

async function load(withDiscovery) {
  const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href);
  const { builtInExtensions } = await import(pathToFileURL(path.join(sdkRoot, 'dist/extensions/index.js')).href);
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-discovery-override-'));
  try {
    const settingsManager = sdk.SettingsManager.inMemory({ packages: [], skills: [] });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager,
      noThemes: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [
        ...builtInExtensions.filter(extension => native.includes(extension.name)),
        ...(withDiscovery ? [{ name: 'pi-discovery', factory: pi => registerDiscovery(pi, {
          createMcpExtension: sdk.createMcpExtension, createToolSearchExtension: sdk.createToolSearchExtension, sdk }) }] : []),
      ] });
    await loader.reload();
    const { extensions, errors, warnings = [] } = loader.getExtensions();
    return { extensions, errors, warnings };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test('without this package the host keeps its built-in tool_search and /mcp', { skip: !sdkRoot }, async () => {
  const { extensions, errors, warnings } = await load(false);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(extensions.map(extension => extension.path).sort(), nativePaths);
  const searchTool = extensions.flatMap(extension => [...extension.tools.values()]).find(tool => tool.definition.name === 'tool_search');
  assert.ok(searchTool, 'native tool_search is registered');
  assert.equal(typeof searchTool.definition.reachesTools, 'function');
  assert.ok(extensions.some(extension => extension.commands.has('mcp')), 'native /mcp is registered');
});

test('this package replaces both built-in extensions instead of requiring them to be disabled', { skip: !sdkRoot }, async () => {
  const { extensions, errors, warnings } = await load(true);
  assert.deepEqual(errors, []);
  // The host drops a replaceable built-in extension whose tool or command name
  // another extension registered, and reports which one it dropped.
  assert.equal(extensions.length, 1);
  assert.ok(!extensions.some(extension => extension.path.startsWith('builtin:')));
  assert.deepEqual(warnings.map(warning => warning.path).sort(), nativePaths);
  const searchTool = extensions.flatMap(extension => [...extension.tools.values()]).filter(tool => tool.definition.name === 'tool_search');
  assert.equal(searchTool.length, 1, 'exactly one tool_search is registered');
  assert.equal(searchTool[0].definition.exposure, 'model-only');
  // The MCP extension waits for pending servers only for a tool that declares
  // reachesTools, so the replacement must keep the native metadata.
  assert.equal(typeof searchTool[0].definition.reachesTools, 'function');
  assert.equal(extensions.flatMap(extension => [...extension.commands.keys()]).filter(name => name === 'mcp').length, 1,
    'exactly one /mcp is registered');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createInternalSession } from '../model-request.js';
const root = process.env.PI_DISCOVERY_SDK_ROOT;

test('native session listing discovers preparation and trajectory under one stable temp cwd', { skip: !root }, async () => {
  const sdk = await import(pathToFileURL(path.join(root, 'dist/index.js')).href);
  const agentDir = await mkdtemp(path.join(tmpdir(), 'prediction-storage-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    for (const kind of ['preparation', 'trajectory']) {
      const manager = createInternalSession(sdk, { cwd: '/not-the-prediction-cwd' }, kind, { provider: 'fixture', model: 'model' });
      manager.appendMessage({ role: 'user', content: 'storage fixture', timestamp: Date.now() });
      manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: '[]' }], timestamp: Date.now() });
      assert.equal(manager.getCwd(), path.join(tmpdir(), 'pi-discovery'));
      assert.equal(path.dirname(path.dirname(manager.getSessionFile())), path.join(agentDir, 'sessions'));
    }
    const sessions = await sdk.SessionManager.listAll();
    assert.equal(sessions.length, 2);
    assert.ok(sessions.some(s => s.name.includes('preparation')));
    assert.ok(sessions.some(s => s.name.includes('trajectory')));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
});

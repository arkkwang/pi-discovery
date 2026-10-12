import path from 'node:path';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

export function isolatedSessions(sdk, agentDir) {
  return { create(cwd, sessionDir) {
    assert.equal(cwd, path.join(tmpdir(), 'pi-discovery'));
    assert.equal(sessionDir, undefined, 'production must use native default sessions storage');
    return sdk.SessionManager.create(cwd, path.join(agentDir, 'sessions', 'fixture-predictions'));
  } };
}

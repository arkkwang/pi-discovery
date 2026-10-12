// Test-only PATH shim, never installs or modifies the global/runtime command.
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const quote = value => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
// Skip signal for environments without the sibling pi-snap checkout (CI, fresh clones).
// An explicit PI_SNAP_SOURCE is never treated as skippable: a bad path must fail loudly.
export const snapCliMissing = process.env.PI_SNAP_SOURCE
  ? false
  : await access(fileURLToPath(new URL('../../pi-snap/cli.mjs', import.meta.url))).then(() => false, () => true);
export async function snapPath(cleanup, script) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi snap test bin '));
  const old = process.env.PATH;
  const cli = process.env.PI_SNAP_SOURCE
    ? path.join(process.env.PI_SNAP_SOURCE, 'cli.mjs')
    : fileURLToPath(new URL('../../pi-snap/cli.mjs', import.meta.url));
  if (!script) await access(cli);
  await writeFile(path.join(dir, 'pi-snap'), script ?? `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, { mode: 0o755 });
  process.env.PATH = dir + path.delimiter + old;
  cleanup(async () => { process.env.PATH = old; await rm(dir, { recursive: true, force: true }); });
  return dir;
}
export async function sessionFixture(cleanup, entries) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi snap session ; literal '));
  cleanup(() => rm(dir, { recursive: true, force: true }));
  const branch=entries.map((entry,i)=>({id:`e${i}`,parentId:i?`e${i-1}`:null,...entry}));
  const file=path.join(dir,'session literal $HOME.jsonl');
  await writeFile(file,branch.map(e=>JSON.stringify(e)).join('\n'));
  return { getBranch:()=>branch, getSessionFile:()=>file, getCwd:()=>dir };
}

import path from 'node:path';
import { opendir, readFile, stat } from 'node:fs/promises';
import ignore from 'ignore';

const SKIP = new Set(['node_modules', 'venv', '__pycache__', 'dist', 'build']);
export const secretName = name => /^(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|.*\.(?:pem|key))$/i.test(name);
export function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Breadth first, bounded WHILE enumerating, not a recursive full scan followed by slice().
export async function projectIndex(cwd, signal, { maxDepth = 3, maxEntries = 200, maxChars = 6000, maxMs = 100 } = {}) {
  const start = performance.now(), queue = [{ dir: cwd, depth: 0, rules: [] }];
  const entries = [], files = [];
  let chars = 0, visited = 0, reason;
  const limit = () => signal?.aborted ? 'cancelled' : performance.now() - start >= maxMs ? 'time'
    : entries.length >= maxEntries ? 'entries' : visited >= 2000 ? 'visited' : undefined;
  while (queue.length && !reason) {
    const item = queue.shift();
    reason = limit(); if (reason) break;
    const rules = [...item.rules];
    try {
      const file = path.join(item.dir, '.gitignore');
      if ((await stat(file)).size <= 64_000) rules.push({ root: item.dir, matcher: ignore().add(await readFile(file, 'utf8')) });
    } catch { /* No local ignore file, or inaccessible directory. */ }
    try {
      const directory = await opendir(item.dir);
      for await (const entry of directory) {
        reason = limit(); if (reason) break;
        visited++;
        if ((entry.isDirectory() && entry.name.startsWith('.')) || SKIP.has(entry.name)
          || secretName(entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(item.dir, entry.name), isDir = entry.isDirectory();
        if (!isDir && !entry.isFile()) continue;
        let ignored = false;
        for (const rule of rules) {
          const match = rule.matcher.test(path.relative(rule.root, file).split(path.sep).join('/') + (isDir ? '/' : ''));
          if (match.ignored) ignored = true;
          else if (match.unignored) ignored = false;
        }
        if (ignored) continue;
        const relative = path.relative(cwd, file).split(path.sep).join('/');
        const label = relative + (isDir ? '/' : '');
        if (chars + label.length + 1 > maxChars) { reason = 'chars'; break; }
        entries.push(label); chars += label.length + 1;
        if (!isDir) files.push({ key: `project:${relative}`, path: file, label: relative, kind: 'project' });
        else if (item.depth + 1 < maxDepth) queue.push({ dir: file, depth: item.depth + 1, rules });
      }
    } catch { reason ??= 'inaccessible'; }
  }
  return { entries, files, truncated: !!reason, reason, maxDepth, visited, elapsedMs: Math.round(performance.now() - start) };
}

// Skill discovery stops at SKILL.md. Never scan or expand a Skill's references.
export function skillFileIndex(skills) {
  return skills.map(skill => ({ path: skill.path, label: skill.name, kind: 'skill' }));
}

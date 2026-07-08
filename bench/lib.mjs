// Shared ctxbench meter — the EXACT gauge formula from tiny.mjs usageOfLine: tokens = in + out
// + cacheCreate + cacheRead per assistant message, deduped by message.id:requestId (streaming
// re-emits the same message). One copy, imported by every bench arm — the meter cannot drift.
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

export function usageOfLine(line, seen) {
  if (!line.includes('"usage"')) return 0;
  let row; try { row = JSON.parse(line); } catch { return 0; }
  const u = row?.message?.usage;
  if (!u) return 0;
  if (row.message.id) {
    const k = `${row.message.id}:${row.requestId}`;
    if (seen.has(k)) return 0;
    seen.add(k);
  }
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
    + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

// Total usage for one trial: every transcript in the project dir keyed to the trial's unique cwd.
export function measure(cwd) {
  const dir = join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  if (!fs.existsSync(dir)) return { tokens: 0, turns: 0 };
  const seen = new Set();
  let tokens = 0, turns = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(join(dir, f), 'utf8').split('\n')) {
      const n = usageOfLine(line, seen);
      if (n) { tokens += n; turns += 1; }
    }
  }
  return { tokens, turns };
}

export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

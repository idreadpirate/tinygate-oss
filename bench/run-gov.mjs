// HISTORICAL RECEIPT — this measures the PreToolUse refusal governor that lost its A/B (+62.9%
// tokens) and was CUT from the engine. Kept as the negative-result method; it needs the pre-cut
// build and will not run against this repo's engine.
// Governor A/B: same debugging task (run a verbose test suite, fix the bug), governor OFF vs ON.
// ON wires the pre-cut engine's PreToolUse hook (refuse unredirected verbose + exact re-reads).
// Measures total tokens, counts real governor firings, and checks the task actually completed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
import { measure, median } from './lib.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fix'), TINY2 = join(HERE, '..', '..', 'tiny2.mjs').replaceAll('\\', '/');
const OUT = join(HERE, 'gov-results.jsonl'); if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, '');
const done = new Set(fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l).arm + '|' + JSON.parse(l).rep; } catch { return ''; } }));
const TASK = 'Run `node --test` to see the failing tests, then edit sum.mjs so EVERY test passes. Run the tests again to confirm. Do not modify the test file.';
const ALLOWED = 'Read,Edit,Bash';
const REPS = 3;
function cell(arm, rep) {
  if (done.has(arm + '|' + rep)) return;
  const cwd = fs.mkdtempSync(join(os.tmpdir(), `gov-${arm}-`));
  for (const f of ['sum.mjs', 'sum.test.mjs', 'README.md']) fs.copyFileSync(join(FIX, f), join(cwd, f));
  const data = join(cwd, '.data');
  const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', TINYAI_DATA: data };
  if (arm === 'on') {
    fs.mkdirSync(join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read|Bash', hooks: [{ type: 'command', command: `node "${TINY2}" hook pre-tool` }] }] } }));
  }
  const t0 = Date.now();
  spawnSync('claude', ['-p', '--model', 'haiku', '--effort', 'low', '--allowedTools', ALLOWED], { cwd, shell: true, encoding: 'utf8', timeout: 600000, input: TASK, env });
  const wall = Date.now() - t0;
  const { tokens, turns } = measure(cwd);
  const pass = spawnSync(process.execPath, ['--test', join(cwd, 'sum.test.mjs')], { encoding: 'utf8' }).status === 0;
  let fires = 0, savedB = 0;
  try { for (const l of fs.readFileSync(join(data, 'evidence.jsonl'), 'utf8').split('\n')) { if (!l.trim()) continue; const r = JSON.parse(l); if (r.governor === 'reread' || r.governor === 'verbose') { fires++; savedB += r.savedB || 0; } } } catch {}
  const row = { arm, rep, tokens, turns, wall, pass, fires, savedB };
  fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
  console.log(`[${arm.padEnd(3)} r${rep}] tok=${String(tokens).padStart(7)} turns=${String(turns).padStart(2)} fires=${fires} pass=${pass ? 'Y' : 'n'} wall=${Math.round(wall / 1000)}s`);
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}
for (let r = 1; r <= REPS; r++) for (const arm of ['off', 'on']) cell(arm, r);
const rows = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
console.log('\n=== GOVERNOR A/B (debugging task, n=' + REPS + '/arm) ===');
for (const arm of ['off', 'on']) {
  const a = rows.filter(r => r.arm === arm); if (!a.length) continue;
  console.log(`${arm.padEnd(3)}  med-tokens ${median(a.map(r => r.tokens)).toLocaleString()}  med-turns ${median(a.map(r => r.turns))}  pass ${a.filter(r => r.pass).length}/${a.length}  total-fires ${a.reduce((s, r) => s + r.fires, 0)}`);
}
const off = rows.filter(r => r.arm === 'off'), on = rows.filter(r => r.arm === 'on');
if (off.length && on.length) { const mo = median(off.map(r => r.tokens)), mn = median(on.map(r => r.tokens)); console.log(`\ndelta: ON is ${((1 - mn / mo) * 100).toFixed(1)}% ${mn < mo ? 'CHEAPER' : 'MORE EXPENSIVE'} on median tokens`); }

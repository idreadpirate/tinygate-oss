// HISTORICAL RECEIPT — this measures the best-of-N racer that lost its A/B and was CUT from the
// engine. Kept as the negative-result method; it needs the pre-cut build (`race` verb).
// Race A/B: single governed attempt vs best-of-N proof-arbitrated race.
// Question: does best-of-N with proof-gated early termination cut first-run WALL toward ~9s
// while holding/raising accuracy? Cost is the honest tradeoff (≈N× tokens until the winner lands).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
import { measure, median } from './lib.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS = join(HERE, 'tasks'), GRADE = join(HERE, 'grade.mjs'), TINY2 = join(HERE, '..', '..', 'tiny2.mjs');
const OUT = join(HERE, 'race-results.jsonl'); if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, '');
const done = new Set(fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => { try { const r = JSON.parse(l); return r.task + '|' + r.arm; } catch { return ''; } }));
const SEED = 424242, K = 500, ALLOWED = 'Write,Read,Edit,Bash';
const TASK = 'Work now, no questions (headless). Scope = current dir. Read README.md and implement the export in solution.mjs, correct for ALL valid inputs per the spec.';
const P = (body) => `node -e "import('./solution.mjs').then(m=>{process.exit((${body})?0:1)}).catch(()=>process.exit(1))"`;
const PROOFS = {
  '01-sumdigits': P('m.sumDigits(238)===13&&m.sumDigits(0)===0&&m.sumDigits(7)===7&&m.sumDigits(100)===1'),
  '04-factorial': P('m.factorial(0)===1&&m.factorial(5)===120&&m.factorial(12)===479001600'),
  '05-gcd': P('m.gcd([12,18])===6&&m.gcd([7,13])===1&&m.gcd([100,20])===20'),
  '08-isprime': P('m.isPrime(2)===true&&m.isPrime(1)===false&&m.isPrime(97)===true&&m.isPrime(100)===false'),
};
const cfg = (cwd) => { const c = join(cwd, '.c.json'); fs.writeFileSync(c, JSON.stringify({ runMaxTurns: 25, runModel: 'haiku', runEffort: 'low', runAllowedTools: ALLOWED })); return c; };
const SUBSET = Object.keys(PROOFS);
function cell(task, arm, n) {
  if (done.has(task + '|' + arm)) return;
  const src = join(TASKS, task);
  const cwd = fs.mkdtempSync(join(os.tmpdir(), `r-${arm}-`));
  fs.copyFileSync(join(src, 'README.md'), join(cwd, 'README.md'));
  fs.copyFileSync(join(src, 'solution.mjs'), join(cwd, 'solution.mjs'));
  const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', TINYAI_DATA: join(cwd, '.data'), TINYAI_CONFIG: cfg(cwd) };
  const argv = arm === 'single'
    ? [TINY2, 'run', '--prove', PROOFS[task], '--', TASK]
    : [TINY2, 'race', '--n', String(n), '--prove', PROOFS[task], '--', TASK];
  const t0 = Date.now(); const r = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: 600000, env }); const wall = Date.now() - t0;
  // grade externally on the winner's solution.mjs (race copies it back into cwd)
  const g = spawnSync(process.execPath, [GRADE, join(src, 'gen.mjs'), join(cwd, 'solution.mjs'), String(SEED), String(K)], { encoding: 'utf8' });
  // tokens: single from transcript; race from tiny2's own meter line "(NNNNN tok, N attempts)"
  let tokens = 0;
  if (arm === 'single') tokens = measure(cwd).tokens;
  else { const m = (r.stdout || '').match(/\(([\d,]+) tok/); tokens = m ? Number(m[1].replace(/,/g, '')) : 0; }
  const row = { task, arm, tokens, wall, passed: g.status === 0, grade: (g.stdout || g.stderr || '').trim().slice(0, 40) };
  fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
  console.log(`[${task.padEnd(14)} ${arm.padEnd(6)}] pass=${row.passed ? 'Y' : 'n'} tok=${String(tokens).padStart(7)} wall=${(wall / 1000).toFixed(1)}s`);
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}
for (const t of SUBSET) { cell(t, 'single', 1); cell(t, 'race2', 2); }
const rows = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => SUBSET.includes(r.task));
console.log('\n=== RACE SUMMARY (n=' + SUBSET.length + ' proof-carrying tasks) ===');
for (const arm of ['single', 'race2']) {
  const a = rows.filter(r => r.arm === arm); if (!a.length) continue;
  console.log(`${arm.padEnd(6)}  pass ${a.filter(r => r.passed).length}/${a.length}  med-wall ${(median(a.map(r => r.wall)) / 1000).toFixed(1)}s  med-tokens ${median(a.map(r => r.tokens)).toLocaleString()}  walls[${a.map(r => (r.wall / 1000).toFixed(0)).join(',')}]`);
}

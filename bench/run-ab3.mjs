// 3-arm A/B: raw claude vs the pre-cut predecessor engine vs this repo's engine, same ungameable
// gauntlet grader. The 'old' arm needs the predecessor (not bundled) and is skipped if absent.
// Each cell: copy README + solution stub into a fresh temp dir, run the arm headless, grade on
// K random inputs the agent never sees (truth-by-construction), measure tokens/turns/wall.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
import { measure, median } from './lib.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS = join(HERE, 'tasks'), GRADE = join(HERE, 'grade.mjs');
const TINY = process.env.LEGACY_ENGINE || join(HERE, '..', '..', 'tiny.mjs'); // predecessor, not bundled
const TINY2 = join(HERE, '..', 'tiny.mjs');                                   // this repo's engine
const OUT = join(HERE, 'ab3-results.jsonl'); if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, '');
const done = new Set(fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => { try { const r = JSON.parse(l); return r.task + '|' + r.arm; } catch { return ''; } }));
const SEED = 424242, K = 500, ALLOWED = 'Write,Read,Edit,Bash';
const SUBSET = process.argv.slice(2).length ? process.argv.slice(2) : ['01-sumdigits', '15-rle', '43-mergeintervals', '61-editdistance', '80-nqueenscount', '95-sqlwhere'];
const TASK = 'Work now, do not ask questions (headless run). The ONLY scope is the current directory. Read README.md and implement the specified export in solution.mjs so it is correct for ALL valid inputs per the spec — a hidden property-based test grades it on many random inputs, so handle the general case, not just the examples. Reply with a 3-line final report when done.';
const cfg = (cwd) => { const c = join(cwd, '.c.json'); fs.writeFileSync(c, JSON.stringify({ runMaxTurns: 25, runModel: 'haiku', runEffort: 'low', runAllowedTools: ALLOWED })); return c; };
const raw = (cwd, env) => spawnSync('claude', ['-p', '--model', 'haiku', '--effort', 'low', '--allowedTools', ALLOWED], { cwd, shell: true, encoding: 'utf8', timeout: 600000, input: TASK, env });
const old = (cwd, env) => spawnSync(process.execPath, [TINY, 'run', '--', TASK], { cwd, encoding: 'utf8', timeout: 600000, env: { ...env, TINYAI_CONFIG: cfg(cwd) } });
const nu = (cwd, env) => spawnSync(process.execPath, [TINY2, 'run', '--', TASK], { cwd, encoding: 'utf8', timeout: 600000, env: { ...env, TINYAI_CONFIG: cfg(cwd) } });
const ARMS = { raw, old, new: nu };
function cell(task, arm, fn) {
  if (done.has(task + '|' + arm)) return;
  const src = join(TASKS, task);
  const cwd = fs.mkdtempSync(join(os.tmpdir(), `g3-${arm}-`));
  fs.copyFileSync(join(src, 'README.md'), join(cwd, 'README.md'));
  fs.copyFileSync(join(src, 'solution.mjs'), join(cwd, 'solution.mjs'));
  const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', TINYAI_DATA: join(cwd, '.data') };
  const t0 = Date.now(); fn(cwd, env); const wall = Date.now() - t0;
  const g = spawnSync(process.execPath, [GRADE, join(src, 'gen.mjs'), join(cwd, 'solution.mjs'), String(SEED), String(K)], { encoding: 'utf8' });
  const { tokens, turns } = measure(cwd);
  const row = { task, arm, tokens, turns, wall, passed: g.status === 0, grade: (g.stdout || g.stderr || '').trim().slice(0, 50) };
  fs.appendFileSync(OUT, JSON.stringify(row) + '\n');
  console.log(`[${task.padEnd(18)} ${arm.padEnd(4)}] pass=${row.passed ? 'Y' : 'n'} tok=${String(tokens).padStart(7)} turns=${String(turns).padStart(2)} wall=${Math.round(wall / 1000)}s`);
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}
for (const t of SUBSET) for (const arm of ['raw', 'old', 'new']) { if (arm === 'old' && !fs.existsSync(TINY)) continue; cell(t, arm, ARMS[arm]); }
// summary
const rows = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => SUBSET.includes(r.task));
console.log('\n=== SUMMARY (n=' + SUBSET.length + ' tasks) ===');
for (const arm of ['raw', 'old', 'new']) {
  const a = rows.filter(r => r.arm === arm);
  if (!a.length) continue;
  const pass = a.filter(r => r.passed).length;
  console.log(`${arm.padEnd(4)}  pass ${pass}/${a.length}  med-tokens ${median(a.map(r => r.tokens)).toLocaleString()}  med-turns ${median(a.map(r => r.turns))}  med-wall ${Math.round(median(a.map(r => r.wall)) / 1000)}s`);
}

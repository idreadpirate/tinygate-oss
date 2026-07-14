// Replay A/B: for each task, first-run (real mission, records the cache) then a repeat that must
// REPLAY (restore file-state + re-prove fresh, zero model). Measures both walls; grades the replay
// result on the hidden property test to prove replay reproduces a CORRECT solution, not a stale one.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
import { median } from './lib.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS = join(HERE, 'tasks'), GRADE = join(HERE, 'grade.mjs'), TINY2 = join(HERE, '..', 'tiny.mjs');
const SEED = 424242, K = 500, ALLOWED = 'Write,Read,Edit,Bash';
const TASK = 'implement the export in solution.mjs, correct for ALL valid inputs per README.md';
const P = (body) => `node -e "import('./solution.mjs').then(m=>{process.exit((${body})?0:1)}).catch(()=>process.exit(1))"`;
const PROOFS = {
  '01-sumdigits': P('m.sumDigits(238)===13&&m.sumDigits(0)===0&&m.sumDigits(99)===18'),
  '04-factorial': P('m.factorial(0)===1&&m.factorial(5)===120&&m.factorial(12)===479001600'),
  '05-gcd': P('m.gcd([12,18])===6&&m.gcd([7,13])===1&&m.gcd([100,20])===20'),
};
const results = [];
for (const task of Object.keys(PROOFS)) {
  const src = join(TASKS, task);
  const cwd = fs.mkdtempSync(join(os.tmpdir(), `rp-${task}-`));
  const stub = fs.readFileSync(join(src, 'solution.mjs'), 'utf8');
  fs.copyFileSync(join(src, 'README.md'), join(cwd, 'README.md'));
  fs.writeFileSync(join(cwd, 'solution.mjs'), stub);
  fs.writeFileSync(join(cwd, '.c.json'), JSON.stringify({ runMaxTurns: 25, runModel: 'haiku', runEffort: 'low', runAllowedTools: ALLOWED }));
  const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', TINYAI_DATA: join(cwd, '.data'), TINYAI_CONFIG: join(cwd, '.c.json') };
  const add = () => spawnSync(process.execPath, [TINY2, 'add', TASK + ' :: ' + task, '--prove', PROOFS[task], '--repo', cwd], { cwd, encoding: 'utf8', env });
  const work = () => { const t0 = Date.now(); const r = spawnSync(process.execPath, [TINY2, 'work'], { cwd, encoding: 'utf8', env }); return { wall: Date.now() - t0, out: (r.stdout || '') + (r.stderr || '') }; };
  add(); const first = work();                                   // first run: real mission, records replay
  fs.writeFileSync(join(cwd, 'solution.mjs'), stub);              // reset — simulate CI re-checkout / redo
  add(); const rep = work();                                     // repeat: must replay
  const replayed = /replayed — zero model/.test(rep.out);
  const g = spawnSync(process.execPath, [GRADE, join(src, 'gen.mjs'), join(cwd, 'solution.mjs'), String(SEED), String(K)], { encoding: 'utf8' });
  const row = { task, firstWall: first.wall, replayWall: rep.wall, replayed, graded: g.status === 0 };
  results.push(row);
  console.log(`[${task.padEnd(14)}] first=${(first.wall / 1000).toFixed(1)}s  replay=${rep.wall}ms  replayed=${replayed ? 'Y' : 'n'}  grade=${g.status === 0 ? 'PASS' : 'FAIL'}`);
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}
console.log('\n=== REPLAY SUMMARY ===');
console.log(`first-run  median wall ${(median(results.map(r => r.firstWall)) / 1000).toFixed(1)}s`);
console.log(`replay     median wall ${median(results.map(r => r.replayWall))}ms  (${results.filter(r => r.replayed).length}/${results.length} replayed, ${results.filter(r => r.graded).length}/${results.length} graded correct)`);

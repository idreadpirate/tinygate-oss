// tiny2 hardening + core tests — no model required. Run: node --test tiny2.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
import { sigOf } from './tiny.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const TINY = join(HERE, 'tiny.mjs');
const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 't2t-'));
const run = (args, { cwd, env, config } = {}) => {
  const data = join(cwd ?? tmp(), '.data');
  const e = { ...process.env, TINYAI_DATA: data, ...env };
  if (config !== undefined) { const cp = join(data, '..', 'cfg.json'); fs.mkdirSync(dirname(cp), { recursive: true }); fs.writeFileSync(cp, config); e.TINYAI_CONFIG = cp; }
  return spawnSync(process.execPath, [TINY, ...args], { cwd, encoding: 'utf8', env: e });
};

test('config: negative numeric knob is refused loudly', () => {
  const d = tmp(); const r = run(['status'], { cwd: d, config: JSON.stringify({ pollMs: -5 }) });
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /pollMs must be a non-negative number/);
});
test('config: non-numeric knob is refused', () => {
  const d = tmp(); const r = run(['status'], { cwd: d, config: JSON.stringify({ runTokens: 'lots' }) });
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /runTokens must be a non-negative number/);
});
test('config: a non-object JSON is refused', () => {
  const d = tmp(); const r = run(['status'], { cwd: d, config: '5' });
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /must be a JSON object/);
});
test('run: a NaN token cap is refused before spawning a model', () => {
  const d = tmp(); const r = run(['run', '--tokens', 'abc', '--', 'do a thing'], { cwd: d });
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /caps must be numbers/);
});
test('proof gate: born-green proof is refused at add --check', () => {
  const d = tmp(); const r = run(['add', 'noop', '--prove', 'node -e "process.exit(0)"', '--check'], { cwd: d });
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /born-green|passes BEFORE/);
});
test('proof gate: born-red proof is accepted at add --check', () => {
  const d = tmp(); const r = run(['add', 'fix it', '--prove', 'node -e "process.exit(1)"', '--check'], { cwd: d });
  assert.strictEqual(r.status, 0); assert.match(r.stdout, /added /);
});
test('prove: exit code passes through', () => {
  const d = tmp();
  assert.strictEqual(run(['prove', 'node -e "process.exit(0)"'], { cwd: d }).status, 0);
  assert.strictEqual(run(['prove', 'node -e "process.exit(3)"'], { cwd: d }).status, 3);
});
test('sigOf: deterministic, digit-insensitive, repo-sensitive', () => {
  const a = sigOf({ repo: '/x', title: 'fix bug 12', prove: 'p' });
  const b = sigOf({ repo: '/x', title: 'fix bug 99', prove: 'p' });   // digits stripped → same class
  const c = sigOf({ repo: '/y', title: 'fix bug 12', prove: 'p' });   // different repo → different
  const e = sigOf({ repo: '/x', title: 'fix bug 12', prove: 'q' });   // different proof → different
  assert.strictEqual(a, b); assert.notStrictEqual(a, c); assert.notStrictEqual(a, e);
});
test('replay: a matching task-class restores file-state + re-proves green, ZERO model', () => {
  const d = tmp();
  const stub = "export function f(n){throw new Error('todo')}";
  const impl = 'export function f(n){return n*2}';
  fs.writeFileSync(join(d, 'solution.mjs'), stub);
  const prove = `node -e "import('./solution.mjs').then(m=>process.exit(m.f(2)===4?0:1)).catch(()=>process.exit(1))"`;
  const title = 'double it';
  const data = join(d, '.data');
  // pre-seed the replay cache for this exact task-class (sig computed the same way tiny2 does)
  const sig = sigOf({ repo: d, title, prove });
  fs.mkdirSync(join(data, 'replays'), { recursive: true });
  fs.writeFileSync(join(data, 'replays', sig + '.json'), JSON.stringify({ title, files: { 'solution.mjs': impl } }));
  const env = { TINYAI_DATA: data };
  assert.strictEqual(run(['add', title, '--prove', prove, '--repo', d], { cwd: d, env }).status, 0);
  const w = run(['work'], { cwd: d, env });
  assert.strictEqual(w.status, 0, w.stderr);
  assert.match(w.stdout, /replayed — zero model/);                       // took the replay path, no mission
  assert.strictEqual(fs.readFileSync(join(d, 'solution.mjs'), 'utf8'), impl); // file restored
  assert.strictEqual(fs.readdirSync(join(data, 'tasks', 'done')).length, 1);  // closed via fresh proof
});
test('replay path-fence: a cache entry escaping the repo is skipped, not written', () => {
  const d = tmp();
  const outside = join(os.tmpdir(), 'ESCAPE-' + Date.now() + '.txt');
  fs.writeFileSync(join(d, 'solution.mjs'), 'export function f(){return 1}');
  const proveOk = `node -e "import('./solution.mjs').then(m=>process.exit(m.f()===1?0:1)).catch(()=>process.exit(1))"`;
  const title = 'fence test';
  const data = join(d, '.data');
  const sig = sigOf({ repo: d, title, prove: proveOk });
  fs.mkdirSync(join(data, 'replays'), { recursive: true });
  fs.writeFileSync(join(data, 'replays', sig + '.json'), JSON.stringify({ title, files: { '../../ESCAPE.txt': 'pwned', '../../../ESCAPE2.txt': 'pwned', [outside]: 'pwned' } }));
  const env = { TINYAI_DATA: data };
  run(['add', title, '--prove', proveOk, '--repo', d], { cwd: d, env });
  run(['work'], { cwd: d, env });
  assert.ok(!fs.existsSync(outside), 'absolute out-of-repo path must not be written');
  assert.ok(!fs.existsSync(join(d, '..', '..', 'ESCAPE.txt')), 'relative ../ escape must not be written');
});

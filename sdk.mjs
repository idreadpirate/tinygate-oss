// tinygate SDK — a thin, zero-dependency programmatic wrapper over the tiny.mjs engine.
// It drives the same proven CLI (nothing is reimplemented) and returns structured results
// instead of text, throwing on failure. Pure helpers (sigOf) are re-exported directly.
//
//   import { Tinygate } from './sdk.mjs';
//   const tg = new Tinygate({ data: './.tg', cwd: '.' });
//   const id = await tg.add('implement parser', { prove: 'node -e "…"', repo: '.', check: true });
//   const { done } = await tg.work();          // claim → govern → prove-fresh → done (repeats replay)
//   const t = await tg.tax();                  // { perMsg, x, verdict }
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TINY = join(dirname(fileURLToPath(import.meta.url)), 'tiny.mjs');

function cli(args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TINY, ...args], { cwd, env: { ...process.env, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: out.trim(), stderr: err.trim() }));
  });
}
const flags = (o, map) => Object.entries(map).flatMap(([k, f]) => (o[k] == null || o[k] === false ? [] : o[k] === true ? [f] : [f, String(o[k])]));

export class Tinygate {
  constructor({ data, config, cwd, transcripts } = {}) {
    this.cwd = cwd;
    this.env = {};
    if (data) this.env.TINYAI_DATA = data;
    if (config) this.env.TINYAI_CONFIG = config;
    if (transcripts) this.env.TINYAI_TRANSCRIPTS = transcripts;
  }
  _(args, extra) { return cli(args, { cwd: this.cwd, env: this.env, ...extra }); }

  /** Queue a proof-gated task. Returns the task id. `check:true` refuses a born-green proof. */
  async add(title, opts = {}) {
    const r = await this._(['add', title, ...flags(opts, { prove: '--prove', repo: '--repo', model: '--model', effort: '--effort', note: '--note', check: '--check', invariant: '--invariant' })]);
    if (r.code !== 0) throw new Error(r.stderr || 'add failed');
    return r.stdout.replace(/^added\s+/, '');
  }
  /** Drive the lane: claim → govern → fresh proof → done (a matching task-class replays, zero model). */
  async work(opts = {}) {
    const r = await this._(['work', ...flags(opts, { all: '--all', model: '--model', tokens: '--tokens', minutes: '--minutes' })]);
    const m = r.stdout.match(/work:\s*(\d+)\s+done,\s*(\d+)\s+refused/);
    return { done: m ? +m[1] : 0, refused: m ? +m[2] : 0, ok: r.code === 0, stdout: r.stdout, stderr: r.stderr };
  }
  /** Run one governed headless mission. Resolves with the child exit code. */
  async run(task, opts = {}) {
    const r = await this._(['run', ...flags(opts, { model: '--model', effort: '--effort', tokens: '--tokens', minutes: '--minutes', prove: '--prove' }), '--', task]);
    return { ok: r.code === 0, code: r.code, stderr: r.stderr };
  }
  /** Close a claimed task; its proof must exit green fresh. Throws on a red proof. */
  async done(id, opts = {}) {
    const r = await this._(['done', id, ...flags(opts, { prove: '--prove' })]);
    if (r.code !== 0) throw new Error(r.stderr || 'proof red — task stays claimed');
    return true;
  }
  /** Run any proof command. Returns { green, exit, output }. */
  async prove(cmd) {
    const r = await this._(['prove', cmd]);
    return { green: r.code === 0, exit: r.code, output: r.stdout };
  }
  /** Session context meter. Returns { perMsg, x, verdict } or null if no transcript. */
  async tax() {
    const r = await this._(['tax']);
    const m = r.stdout.match(/=\s*([\d,]+)\/msg\s+\(([\d.]+)x fresh\)\s+—\s+(.+)$/);
    if (!m) return null;
    return { perMsg: +m[1].replace(/,/g, ''), x: +m[2], verdict: m[3].trim() };
  }
  /** Queue counts: { ready, claimed, done }. */
  async status() {
    const r = await this._(['status']);
    const g = (k) => +(r.stdout.match(new RegExp(k + '\\s+(\\d+)'))?.[1] ?? 0);
    return { ready: g('ready'), claimed: g('claimed'), done: g('done') };
  }
  /** List tasks in a state. Returns [{ id, title }]. */
  async list(state) {
    const r = await this._(['list', ...(state ? [state] : [])]);
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      const m = l.match(/^(\S+)\s+\w+\s+(.*)$/);
      return m ? { id: m[1], title: m[2].trim() } : null;
    }).filter(Boolean);
  }
}
export { sigOf } from './tiny.mjs';
export default Tinygate;

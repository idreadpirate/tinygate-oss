#!/usr/bin/env node
// tiny2 — the ECU, cut to only what moves the four axes: cheaper tokens, more accuracy,
// and the governed lane that produces them. Every mechanism was A/B-measured; anything that
// did not measurably make work faster / cheaper / more-accurate was removed — including a
// best-of-N racer and a refusal governor that both REGRESSED in measurement (bench/gov,
// bench/gauntlet). One file, zero deps.
//
// The whole tool is three ideas:
//   1. GOVERNED MISSION — headless run under a turn cap + low effort + lean env + a tight
//      output policy. This is the −37%-tokens engine (matched-model A/B).
//   2. PROOF GATE — "done" exists only when a stored proof command exits 0, run FRESH at close
//      time. This is the accuracy engine; it makes cheap-model routing safe, and it arbitrates
//      REPLAY: a repeated task-class restores its cached file-state + re-proves in ~0.1s, zero model.
//   3. TAX METER — a read-only SessionStart beacon (per-message tokens vs the fresh floor) so you
//      know when to start fresh (the 15–21× accumulation lever). It reports; it never refuses.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.TINYAI_DATA || join(HERE, 'data');
const DIRS = { tmp: join(DATA, 'tasks', 'tmp'), ready: join(DATA, 'tasks', 'ready'), claimed: join(DATA, 'tasks', 'claimed'), done: join(DATA, 'tasks', 'done') };
const EVIDENCE = join(DATA, 'evidence.jsonl');
const CONFIG_PATH = process.env.TINYAI_CONFIG || join(HERE, 'config.json');
const DEFAULTS = { runModel: 'haiku', runEffort: 'low', runMaxTurns: 25, runAllowedTools: 'Write,Read,Edit,Bash', runLean: true, runTokens: 5_000_000, runMinutes: 60, thinkingTokens: 0, pollMs: 500, maxStrikes: 3, ttrSeconds: 3900 };
let CONFIG = DEFAULTS;
if (existsSync(CONFIG_PATH)) { try { const j = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('config must be a JSON object'); CONFIG = { ...DEFAULTS, ...j }; } catch (e) { console.error(`invalid config ${CONFIG_PATH}: ${e.message}`); process.exit(2); } }
// HARDENING: a numeric knob that arrives NaN/negative silently disables a safety (a NaN pollMs hangs
// the poll loop forever; a NaN cap never fires). Validate every numeric DEFAULT at load — fail loud, not silent.
for (const k in DEFAULTS) if (typeof DEFAULTS[k] === 'number' && !(Number(CONFIG[k]) >= 0)) { console.error(`invalid config: ${k} must be a non-negative number (got ${JSON.stringify(CONFIG[k])})`); process.exit(2); }
const PROVE_TIMEOUT_MS = Number(process.env.TINYAI_PROVE_TIMEOUT_MS) || 15 * 60_000;
const die = (code, msg) => { console.error(msg); process.exit(code); };

// ── fs primitives ──────────────────────────────────────────────────────────
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number.isFinite(ms) && ms > 0 ? ms : 0); // NaN/∞ would hang the wait forever — clamp to a non-blocking 0
function renameRetry(from, to) { for (let i = 0; ; i++) { try { renameSync(from, to); return true; } catch (e) { if (e.code === 'ENOENT') return false; if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || i >= 9) throw e; sleep(2 ** i); } } }
function readJsonl(file) { if (!existsSync(file)) return []; const rows = []; for (const line of readFileSync(file, 'utf8').split('\n')) { const s = line.trim(); if (!s) continue; try { rows.push(JSON.parse(s.replace(/^﻿/, '').replace(/\r$/, ''))); } catch { /* torn tail */ } } return rows; }
const appendRow = (file, row) => appendFileSync(file, JSON.stringify(row) + '\n');
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
const ensureDirs = () => Object.values(DIRS).forEach((d) => mkdirSync(d, { recursive: true }));
const newId = () => `${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
const agentName = (flag) => (flag || process.env.TINYAI_AGENT || userInfo().username || 'agent').replace(/[^A-Za-z0-9_-]/g, '-');
const readTask = (p) => JSON.parse(readFileSync(p, 'utf8'));
function resolveIn(dir, idish) { const hits = listDir(dir).filter((f) => f.startsWith(idish)); if (hits.length > 1) die(2, `ambiguous id "${idish}"`); return hits[0] ?? null; }
function writeTaskAtomic(path, obj) { const tmp = join(DIRS.tmp, `wr-${newId()}.json`); try { writeFileSync(tmp, JSON.stringify(obj)); if (renameRetry(tmp, path)) return; } catch { /* fall through */ } writeFileSync(path, JSON.stringify(obj)); }

// ── proof runner — the verification mint ─────────────────────────────────────
// A pure `node -e "…"` one-liner runs WITHOUT a shell (injection-immune, fast) and gets a
// 90s timeout (a hung one-liner is a bug, not a long test); anything else keeps the full budget.
function runProof(cmd, taskId = null) {
  const t0 = Date.now();
  const fast = /^node -e "([^"]+)"$/.exec(cmd.trim());
  const tmo = fast && !/execSync|spawn|exec\(/.test(fast[1]) ? Math.min(90_000, PROVE_TIMEOUT_MS) : PROVE_TIMEOUT_MS;
  const r = fast ? spawnSync(process.execPath, ['-e', fast[1]], { encoding: 'utf8', timeout: tmo })
    : spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: PROVE_TIMEOUT_MS });
  const exit = r.status ?? 1;
  appendRow(EVIDENCE, { at: new Date().toISOString(), task: taskId, cmd, exit, ms: Date.now() - t0 });
  return { exit, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-2000) };
}

// ── the lane: add → claim → work → done, gated by a fresh green proof ─────────
function addTask(title, opts) {
  if (!title) die(2, 'add needs a title: tiny2 add "<title>" [--prove "<cmd>"]');
  if (opts.effort && !['low', 'medium', 'high'].includes(opts.effort)) die(2, `invalid --effort "${opts.effort}"`);
  if (opts.repo && !existsSync(opts.repo)) die(2, `no such repo: ${opts.repo}`);
  const t = { id: newId(), title, prove: opts.prove ?? null, note: opts.note ?? null, model: opts.model ?? null, effort: opts.effort ?? undefined, repo: opts.repo ?? undefined, ttr: CONFIG.ttrSeconds, by: agentName(opts.agent), created: new Date().toISOString() };
  // PROOF-QUALITY GATE (accuracy core): a proof that is green BEFORE the work exists can't tell
  // done from not-done — refuse it. An honest red (a fix gate) is correct and passes.
  if (opts.check && t.prove) {
    const dry = runProof(t.prove, null);
    const spawnClass = /is not recognized|command not found|cannot find the (path|file)|ENOENT/i.test(dry.tail) || (/(SyntaxError|ReferenceError)/.test(dry.tail) && /at \[eval\]/.test(dry.tail));
    if (dry.exit !== 0 && spawnClass) die(2, `REFUSED: proof is unrunnable (spawn-class, not a red gate) — fix quoting:\n${dry.tail.trim().slice(-300)}`);
    if (dry.exit === 0 && !opts.invariant) die(2, `REFUSED: proof passes BEFORE the work exists — a born-green proof proves nothing. Author one that's red until the work lands, or --invariant to lock a regression guard.`);
    if (dry.exit !== 0) console.error(`note: proof born red (exit ${dry.exit}) — a fix gate; must flip green to close`);
  }
  const tmp = join(DIRS.tmp, `${t.id}.json`);
  writeFileSync(tmp, JSON.stringify(t));
  renameRetry(tmp, join(DIRS.ready, `${t.id}.json`));
  console.log(`added ${t.id}`);
}
function reapStale() { // recover leases past TTL; sweep stale tmp — the whole janitor, nothing more
  for (const f of listDir(DIRS.tmp)) { try { if (Date.now() - statSync(join(DIRS.tmp, f)).mtimeMs > 3600_000) rmSync(join(DIRS.tmp, f)); } catch { /* raced */ } }
  for (const f of listDir(DIRS.claimed)) { const p = join(DIRS.claimed, f); try { const t = readTask(p); if ((Date.now() - statSync(p).mtimeMs) / 1000 > (t.ttr || CONFIG.ttrSeconds)) renameRetry(p, join(DIRS.ready, `${t.id}.json`)); } catch { /* raced/corrupt */ } }
}
function claimOne(who, skip = new Set()) {
  reapStale();
  for (const f of listDir(DIRS.ready).sort()) {
    const id = f.slice(0, -5);
    if (skip.has(id)) continue;
    const to = join(DIRS.claimed, `${id}.${who}.json`);
    if (!renameRetry(join(DIRS.ready, f), to)) continue;
    const now = new Date();
    try { utimesSync(to, now, now); return readTask(to); } catch { continue; }
  }
  return null;
}
function finalizeDone(claimedPath, t, cmd, agent) {
  const target = join(DIRS.done, `${t.id}.json`);
  if (!renameRetry(claimedPath, target)) return false; // lost the race: a peer owns it now
  // HARDENING: stage to tmp then rename OVER the target, so a crash mid-write can't leave a torn,
  // permanently-unparseable record in done/. Fall back to a direct write only if the rename is refused.
  const rec = JSON.stringify({ ...t, done: new Date().toISOString(), doneBy: agent, proof: { cmd, exit: 0, at: new Date().toISOString() } });
  const tmp = join(DIRS.tmp, `${t.id}.done.json`);
  try { writeFileSync(tmp, rec); if (renameRetry(tmp, target)) return true; } catch { /* fall through */ }
  writeFileSync(target, rec);
  return true;
}
function releaseToReady(id, { strike = false } = {}) {
  const f = resolveIn(DIRS.claimed, id);
  if (!f) return false;
  const p = join(DIRS.claimed, f);
  if (strike) { try { const t = readTask(p); writeTaskAtomic(p, { ...t, strikes: (t.strikes ?? 0) + 1 }); } catch { /* raced */ } }
  renameRetry(p, join(DIRS.ready, `${id}.json`));
  return true;
}
function doneTask(idish, opts) {
  const f = idish && resolveIn(DIRS.claimed, idish);
  if (!f) die(2, `not claimed: "${idish ?? ''}"`);
  const p = join(DIRS.claimed, f);
  const t = readTask(p);
  const cmd = opts.prove || t.prove;
  if (!cmd) die(2, 'no proof declared: pass --prove "<cmd>" — done without a fresh green exit does not exist');
  const proof = runProof(cmd, t.id);
  if (proof.exit !== 0) { console.error(proof.tail); die(1, `REFUSED: proof exited ${proof.exit} — "${t.title}" stays claimed`); }
  if (!finalizeDone(p, t, cmd, agentName(opts.agent))) die(1, `lease expired mid-proof — re-claim ${t.id}`);
  console.log(`done ${t.id}`);
}
function listTasks(state) {
  for (const s of (state ? [state] : ['ready', 'claimed', 'done'])) {
    if (!DIRS[s]) die(2, `unknown state "${s}"`);
    for (const f of listDir(DIRS[s]).sort()) { try { const t = readTask(join(DIRS[s], f)); const st = t.strikes ? `  [${t.strikes} strike${t.strikes >= CONFIG.maxStrikes ? 's — PARKED' : 's'}]` : ''; console.log(`${t.id}  ${s.padEnd(7)}  ${t.title}${st}`); } catch { /* mid-rename */ } }
  }
}
function status() {
  const n = (d) => listDir(d).length;
  console.log(`ready ${n(DIRS.ready)} · claimed ${n(DIRS.claimed)} · done ${n(DIRS.done)}`);
}
function proveCmd(cmd) {
  if (!cmd) die(2, 'prove needs a command');
  const { exit, tail } = runProof(cmd);
  console.log(tail.trimEnd());
  console.log((exit === 0 ? 'PROOF GREEN: ' : `PROOF RED (${exit}): `) + (cmd.length > 40 ? cmd.slice(0, 40) + '…' : cmd));
  process.exitCode = exit;
}

// ── governed mission — the token engine ──────────────────────────────────────
// A headless agent run under a hard token+wall cap, killed mid-run on overrun. The savings
// come from the argv (turn cap, low effort, lean env) and the prompt (below), NOT from any
// heavier machinery — which is the whole point of the cut.
const usageOfLine = (line, modelFilter, seen) => {
  if (!line.includes('"usage"')) return null;
  let row; try { row = JSON.parse(line); } catch { return null; }
  const u = row?.message?.usage; if (!u) return null;
  if (modelFilter && !String(row?.message?.model ?? '').includes(modelFilter)) return null;
  if (row.message.id) { const k = `${row.message.id}:${row.requestId}`; if (seen.has(k)) return null; seen.add(k); }
  const input = u.input_tokens ?? 0, output = u.output_tokens ?? 0, cc = u.cache_creation_input_tokens ?? 0, cr = u.cache_read_input_tokens ?? 0;
  return { day: String(row.timestamp ?? '').slice(0, 10), model: String(row?.message?.model ?? ''), n: input + output + cc + cr };
};
const usageRoot = () => process.env.TINYAI_TRANSCRIPTS || join(homedir(), '.claude', 'projects');
function jsonlFiles(root) { const out = [], stack = [root]; while (stack.length) { const d = stack.pop(); let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { continue; } for (const e of es) { const p = join(d, e.name); if (e.isDirectory()) stack.push(p); else if (e.name.endsWith('.jsonl')) out.push(p); } } return out; }
function makeSpendMeter(modelFilter = '') { // counts tokens in transcript files CREATED during the run
  const offsets = new Map(), seen = new Set(); let total = 0;
  const files = () => jsonlFiles(usageRoot());
  const preexisting = new Set(files());
  const meter = () => {
    for (const f of files()) {
      if (preexisting.has(f)) continue;
      let size; try { size = statSync(f).size; } catch { continue; }
      let at = offsets.get(f) ?? 0; if (size < at) at = 0; if (size === at) continue;
      const fd = openSync(f, 'r'), buf = Buffer.alloc(size - at); readSync(fd, buf, 0, buf.length, at); closeSync(fd);
      const text = buf.toString('utf8'); const lastNl = text.lastIndexOf('\n'); if (lastNl === -1) continue;
      offsets.set(f, at + Buffer.byteLength(text.slice(0, lastNl + 1)));
      for (const line of text.slice(0, lastNl).split('\n')) { const r = usageOfLine(line, modelFilter, seen); if (r) total += r.n; }
    }
    return total;
  };
  return meter;
}
async function governed(argv, caps) {
  const capTokens = caps.tokens != null ? Number(caps.tokens) : Infinity;
  const capMs = caps.minutes != null ? Number(caps.minutes) * 60_000 : Infinity;
  // HARDENING: a NaN cap (e.g. --tokens abc) would make `tokens > cap` always false and SILENTLY
  // disable the runaway-spend guard. Refuse it loudly instead of billing without a ceiling.
  if (Number.isNaN(capTokens) || Number.isNaN(capMs)) die(2, `caps must be numbers — got --tokens "${caps.tokens}" --minutes "${caps.minutes}"`);
  const cmd = argv.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
  const spent = makeSpendMeter(caps.meterModel ?? '');
  const poll = Math.max(50, Number(process.env.TINYAI_POLL_MS) || CONFIG.pollMs); // never a 0/NaN busy-loop or hang
  const t0 = Date.now();
  const child = spawn(cmd, { shell: true, cwd: caps.cwd, env: caps.env, stdio: [caps.input == null ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
  let spawnErr = null; child.on('error', (e) => { spawnErr = e; }); // HARDENING: a child that errors without exiting (unspawnable shell/binary) would hang the poll loop forever — break on it
  if (caps.input != null) { child.stdin.on('error', () => {}); child.stdin.end(caps.input); }
  for (;;) {
    sleep(poll);
    await new Promise(setImmediate);
    const tokens = spent();
    if (spawnErr) { appendRow(EVIDENCE, { at: new Date().toISOString(), task: null, cmd: `spawn-error: ${cmd}`, exit: 'error', ms: Date.now() - t0, tokens }); return { code: 127, tokens, overrun: null }; }
    const dead = child.exitCode !== null || child.signalCode !== null;
    const overrun = tokens > capTokens ? `token cap ${capTokens.toLocaleString()} exceeded (${tokens.toLocaleString()})` : Date.now() - t0 > capMs ? `time cap ${caps.minutes}min exceeded` : null;
    if (overrun && !dead) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']); else child.kill('SIGKILL');
      await once(child, 'exit');
      appendRow(EVIDENCE, { at: new Date().toISOString(), task: null, cmd: `budget: ${cmd}`, exit: 'killed', ms: Date.now() - t0, tokens });
      return { code: 4, tokens, overrun };
    }
    if (dead) { appendRow(EVIDENCE, { at: new Date().toISOString(), task: null, cmd: `budget: ${cmd}`, exit: child.exitCode ?? 1, ms: Date.now() - t0, tokens }); return { code: child.exitCode ?? 1, tokens, overrun: null }; }
  }
}
// THE PROMPT (the improvement over old tiny): the agent is GIVEN its proof and told to iterate
// against it. Old `work` forbade this ("do NOT run the acceptance check yourself"), blindfolding
// the agent so it couldn't do TDD — the documented cause of a 438K-vs-101K token blowup. The fresh
// re-run at close time is still the ONLY thing that closes the task, so anti-gaming is unchanged.
const missionPrompt = (task, prove) =>
  task
  + (prove ? `\nAcceptance — I re-run this FRESH after you stop; its exit code is the ONLY thing that closes the task, and you cannot talk past it:\n  ${prove}\nYou MAY run it yourself to check your work as you iterate. Stop once it passes.` : '')
  + `\nOutput policy: work with tools, do NOT narrate between steps, emit exactly one short final report. The only scope is this task — ignore any queues.`
  // TURN CHOREOGRAPHY — the measured optimum, do NOT push it lower. Three A/Bs proved that forcing
  // fewer turns (pre-loading files, a 2-turn aim, dropping the report) makes the model THRASH to MORE
  // turns (6→9→11) and MORE tokens (up to 164K), because first-run coding needs ~read→edit→verify.
  // Wall = turns × model-latency; the ECU minimises turns and cannot go below the task's natural need.
  + `\nTurn budget: aim for 3 turns — (1) ONE batch reading everything needed; (2) ONE batch with all edits plus the verify REDIRECTED (cmd > .out.log 2>&1; echo EXIT=$?; tail -3 .out.log — its result returns this same turn); (3) the final report. Never verify twice, read a file twice, or let verbose output print unredirected.`
  + `\nPrefer the laziest solution that works — reuse > stdlib > native > new code; never cut validation, security, or error handling.`;
const resolveModel = (t, opts) => opts.model ?? t.model ?? CONFIG.runModel ?? null; // declared, never inferred
function missionArgs(model, effort) {
  const argv = ['claude', '-p'];
  if (model) argv.push('--model', model);
  if (CONFIG.runAllowedTools) argv.push('--allowedTools', CONFIG.runAllowedTools);
  if (effort) argv.push('--effort', effort);
  if (CONFIG.runMaxTurns) argv.push('--max-turns', String(CONFIG.runMaxTurns));
  if (CONFIG.runLean) { argv.push('--disable-slash-commands'); for (const k of ['CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS']) process.env[k] ??= '1'; }
  process.env.MAX_THINKING_TOKENS ??= String(CONFIG.thinkingTokens);
  return argv;
}
async function runMission(rest, opts) {
  if (!rest.length) die(2, 'run needs a task: tiny2 run [--tokens n] [--minutes m] [--model m] -- "<task>"');
  const model = opts.model ?? CONFIG.runModel, effort = opts.effort ?? CONFIG.runEffort;
  const r = await governed(missionArgs(model, effort), { tokens: opts.tokens ?? CONFIG.runTokens, minutes: opts.minutes ?? CONFIG.runMinutes, meterModel: model ?? '', input: missionPrompt(rest.join(' '), opts.prove) });
  if (r.overrun) die(4, `BUDGET KILL: ${r.overrun}`);
  process.exit(r.code);
}
// REPLAY — the ONLY honest sub-9s wall lever (measured ~0.1–2s vs ~15s first-run). A coding task's
// result lands as file-state; on a green mission we snapshot the repo's small text files keyed by
// task-CLASS (repo + digit-stripped title + proof), and a later matching task RESTORES them and runs
// the proof FRESH — zero model. Files are inert DATA, path-fenced to the repo; the fresh proof is the
// only arbiter (a stale snapshot fails it, deletes itself, and falls through to a real mission), so
// there is no anti-gaming hole. This is the ECU speed win that actually exists: the model is paid once
// per task-class, never again — a CI re-run, a reset-and-redo, a re-checkout all close in ~1s.
export const sigOf = (t) => createHash('sha1').update(`${(t.repo ?? process.cwd()).replaceAll('\\', '/').toLowerCase()}|${[...new Set(String(t.title).toLowerCase().replace(/\d+/g, '').match(/[a-z][\w-]{2,}/g) ?? [])].sort().join(' ')}|${t.prove ?? ''}`).digest('hex').slice(0, 12);
function snapshotRepo(dir) {
  const files = {}, stack = ['']; let n = 0;
  while (stack.length) {
    const rel = stack.pop(); let ents; try { ents = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isSymbolicLink()) continue; // never follow a symlink out of the repo fence (read OR restore)
      if (e.name === '.c.json' || /^(\.git|\.data|\.rdata|node_modules)$/.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile() && n < 10) { try { const c = readFileSync(join(dir, r), 'utf8'); if (c.length <= 65_536) { files[r] = c; n++; } } catch { /* binary/gone */ } }
    }
  }
  return files;
}
function recordReplay(t) {
  try { const files = snapshotRepo(t.repo ?? process.cwd()); if (Object.keys(files).length) { mkdirSync(join(DATA, 'replays'), { recursive: true }); writeFileSync(join(DATA, 'replays', sigOf(t) + '.json'), JSON.stringify({ title: t.title, files, at: new Date().toISOString() })); console.log(`replay cached: ${Object.keys(files).length} file(s) for this task-class`); } } catch { /* recording is a bonus, never a failure */ }
}
function tryReplay(t, who) {
  const rf = join(DATA, 'replays', sigOf(t) + '.json');
  if (!existsSync(rf)) return false;
  let plan; try { plan = JSON.parse(readFileSync(rf, 'utf8')); } catch { return false; }
  const base = resolve(t.repo ?? process.cwd());
  for (const [rel, content] of Object.entries(plan.files ?? {})) { const dest = resolve(base, rel); if (dest !== base && !dest.startsWith(base + sep) && !dest.startsWith(base + '/')) continue; try { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, content); } catch { /* unwritable — proof still arbitrates */ } }
  if (runProof(t.prove, t.id).exit === 0) {
    const f = resolveIn(DIRS.claimed, t.id);
    if (f && finalizeDone(join(DIRS.claimed, f), t, t.prove, who)) { appendRow(EVIDENCE, { at: new Date().toISOString(), task: t.id, cmd: `replay: ${Object.keys(plan.files ?? {}).length} file(s), zero model`, exit: 0, ms: 0 }); return true; }
  }
  rmSync(rf, { force: true }); // the world moved — delete, never retry a liar
  return false;
}
async function work(opts) {
  const who = agentName(opts.agent);
  const skip = new Set();
  let doneN = 0, refused = 0;
  for (;;) {
    const t = claimOne(who, skip);
    if (!t) break;
    skip.add(t.id);
    // INTAKE LADDER — cheap closes spend zero mission: park a thrashing task, skip a proofless one,
    // and close for free if acceptance is ALREADY green.
    if ((t.strikes ?? 0) >= CONFIG.maxStrikes) { releaseToReady(t.id); console.error(`parked ${t.id}: ${t.strikes} strikes`); if (!opts.all) break; continue; }
    if (!t.prove) { releaseToReady(t.id); console.error(`skip ${t.id}: no --prove`); if (!opts.all) break; continue; }
    if (runProof(t.prove, t.id).exit === 0) { const f = resolveIn(DIRS.claimed, t.id); if (f && finalizeDone(join(DIRS.claimed, f), t, t.prove, who)) { doneN++; console.log(`done ${t.id} (already green — no mission)`); } if (!opts.all) break; continue; }
    console.log(`work: ${t.id}  ${t.title}`);
    { const cf = resolveIn(DIRS.claimed, t.id); if (cf) writeTaskAtomic(join(DIRS.claimed, cf), { ...t, ttr: Math.max(t.ttr || 0, CONFIG.runMinutes * 60 + 900) }); } // lease covers the mission
    if (tryReplay(t, who)) { doneN++; console.log(`done ${t.id} (replayed — zero model, ~0s)`); if (!opts.all) break; continue; } // the sub-9s path: a matching task-class restores + re-proves, no mission
    const model = resolveModel(t, opts), effort = opts.effort ?? t.effort ?? CONFIG.runEffort;
    const task = `${t.title}${t.note ? `\n${t.note}` : ''}`;
    const g = await governed(missionArgs(model, effort), { tokens: opts.tokens ?? CONFIG.runTokens, minutes: opts.minutes ?? CONFIG.runMinutes, meterModel: model ?? '', cwd: t.repo, input: missionPrompt(task, t.prove) });
    if (g.overrun) { refused++; releaseToReady(t.id); console.error(`KILLED ${t.id}: ${g.overrun} — released, no strike`); if (!opts.all) break; continue; }
    const proof = runProof(t.prove, t.id); // fresh, after the run — the only verdict that counts
    const f = resolveIn(DIRS.claimed, t.id);
    if (proof.exit === 0 && f && finalizeDone(join(DIRS.claimed, f), t, t.prove, who)) { doneN++; console.log(`done ${t.id}`); recordReplay(t); } // cache the winning file-state so the NEXT run of this class replays in ~0s
    else { refused++; releaseToReady(t.id, { strike: true }); console.error(`REFUSED ${t.id}: proof exited ${proof.exit} — back to ready`); }
    if (!opts.all) break;
  }
  console.log(`work: ${doneN} done, ${refused} refused`);
  process.exit(refused ? 1 : 0);
}

// ── the session tax meter ────────────────────────────────────────────────────
function taxRead() { // newest transcript = current session; per-message tokens vs the fresh floor
  try {
    const files = jsonlFiles(usageRoot()); let pick = null, nm = -1;
    for (const p of files) { const m = statSync(p).mtimeMs; if (m > nm) { nm = m; pick = p; } }
    if (!pick) return null;
    const size = statSync(pick).size, at = Math.max(0, size - 262_144);
    const fd = openSync(pick, 'r'), buf = Buffer.alloc(size - at); readSync(fd, buf, 0, buf.length, at); closeSync(fd);
    let lines = buf.toString('utf8').split('\n'); if (at > 0) lines = lines.slice(1);
    const seen = new Set(); let total = 0, msgs = 0;
    for (const line of lines) { const r = usageOfLine(line, '', seen); if (r) { total += r.n; msgs++; } }
    if (!msgs) return null;
    const fresh = Number(process.env.TINYAI_TAX_FRESH) > 0 ? Number(process.env.TINYAI_TAX_FRESH) : 22333;
    const per = Math.round(total / msgs);
    return { total, msgs, per, x: per / fresh };
  } catch { return null; }
}
function taxCmd() {
  const t = taxRead(); if (!t) die(3, 'no usable session transcript found');
  const verdict = t.x > 10 ? 'RED — land, start fresh' : t.x > 3 ? 'AMBER — consider landing' : 'OK';
  console.log(`session tax: ${t.total.toLocaleString()} tok / ${t.msgs} msgs = ${t.per.toLocaleString()}/msg (${t.x.toFixed(1)}x fresh) — ${verdict}`);
  process.exitCode = t.x > 10 ? 1 : 0;
}

// ── the meter beacon: read-only, refuses NOTHING ─────────────────────────────
// A refusal governor was cut here: an A/B (bench/gov) measured a PreToolUse re-read/verbose
// gate at +62.9% tokens on a real debugging task — each hard refusal forces an extra model
// round-trip (~16–30K re-billed) that dwarfs the moderate output it prevents. The meter stays
// because it only REPORTS a number (per-message tokens vs the fresh floor) at session open —
// it surfaces the 15–21× accumulation lever without ever costing a round-trip.
function hook(event) {
  if (event !== 'session-start') die(2, 'unknown hook event (only: session-start)');
  const t = taxRead();
  if (t && t.x > 3) console.log(`tinygate tax: ${t.per.toLocaleString()} tok/msg (${t.x.toFixed(1)}x fresh) — ${t.x > 10 ? 'RED: start a fresh session' : 'AMBER: consider a fresh session'}`);
}
function installClaude() {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
  const me = join(HERE, 'tiny.mjs').replaceAll('\\', '/');
  const sp = join(homedir(), '.claude', 'settings.json'); let s = {};
  if (existsSync(sp)) try { s = JSON.parse(readFileSync(sp, 'utf8')); } catch { die(2, `invalid JSON in ${sp}`); }
  s.hooks = s.hooks ?? {};
  s.hooks.SessionStart = [...(s.hooks.SessionStart ?? []).filter((h) => !JSON.stringify(h).includes('tiny.mjs" hook session-start')), { hooks: [{ type: 'command', command: `node "${me}" hook session-start` }] }];
  writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
  console.log(`installed: data dir, session-tax beacon (SessionStart — reports only, refuses nothing). config: ${CONFIG_PATH}`);
}

const HELP = `tiny2 — governed lane + proof gate + replay meter, cut to the four axes (one file, zero deps)
  add "<title>" [--prove "<cmd>"] [--check] [--effort e] [--repo d] [--model m] [--note ..]
  done <id> [--prove ..] · list [ready|claimed|done] · prove "<cmd>" · status
  run [--tokens n] [--minutes m] [--model m] [--effort e] [--prove ..] -- "<task>"   one governed mission
  work [--all] [--model m]      claim → govern → prove-fresh → done; a repeated task-class REPLAYS (~0s); strikes park a stuck task
  tax                           session context meter (when to start fresh — the biggest lever)
  hook session-start            tax beacon (wired by install; reports only, refuses nothing)
  install                       Claude Code SessionStart tax beacon
config: ${CONFIG_PATH} · data: ${DATA} · env: TINYAI_DATA TINYAI_CONFIG TINYAI_TRANSCRIPTS TINYAI_POLL_MS`;

const OPTIONS = { prove: { type: 'string' }, check: { type: 'boolean' }, invariant: { type: 'boolean' }, effort: { type: 'string' }, repo: { type: 'string' }, model: { type: 'string' }, note: { type: 'string' }, agent: { type: 'string' }, tokens: { type: 'string' }, minutes: { type: 'string' }, all: { type: 'boolean' } };
const parseCli = (args) => { try { return parseArgs({ args, allowPositionals: true, options: OPTIONS }); } catch (e) { die(2, `${String(e.message ?? e).split('\n')[0]} — node tiny.mjs help`); } };

async function dispatch(cmd, rest, v) {
  switch (cmd) {
    case 'add': addTask(rest.join(' '), v); break;
    case 'done': doneTask(rest[0], v); break;
    case 'list': listTasks(rest[0]); break;
    case 'prove': proveCmd(rest.join(' ')); break;
    case 'status': status(); break;
    case 'run': await runMission(rest, v); break;
    case 'work': await work(v); break;
    case 'tax': taxCmd(); break;
    case 'hook': hook(rest[0]); break;
    case 'install': installClaude(); break;
    case 'help': case undefined: console.log(HELP); process.exit(cmd ? 0 : 2); break;
    default: die(2, `unknown command "${cmd}" — try: node tiny.mjs help`);
  }
}
let isMain = false;
try { isMain = import.meta.url.toLowerCase() === pathToFileURL(realpathSync(process.argv[1])).href.toLowerCase(); } catch { /* not main */ }
if (isMain) { const { values: v, positionals } = parseCli(); ensureDirs(); await dispatch(positionals[0], positionals.slice(1), v); }

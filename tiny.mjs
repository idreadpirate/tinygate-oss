#!/usr/bin/env node
// tinygate — an ECU for AI coding agents, cut to only what moves the needle: cheaper tokens,
// more accuracy, and the governed lane that produces them. Every mechanism here was A/B-measured;
// anything that did not measurably make work faster / cheaper / more-accurate was removed —
// including a best-of-N racer and a refusal governor that both REGRESSED in measurement
// (bench/gov, bench/gauntlet). One file, zero deps.
//
// The whole tool is three ideas:
//   1. GOVERNED MISSION — a headless run under a turn cap + low effort + lean env + a tight
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

// ── environment & paths ───────────────────────────────────────────────────────
// Every env knob reads TINYGATE_* first and falls back to TINYAI_* (the pre-release name),
// so existing installs keep working unchanged.
const envVar = (name) => process.env[`TINYGATE_${name}`] || process.env[`TINYAI_${name}`] || '';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = envVar('DATA') || join(HERE, 'data');
const DIRS = {
  tmp: join(DATA, 'tasks', 'tmp'),
  ready: join(DATA, 'tasks', 'ready'),
  claimed: join(DATA, 'tasks', 'claimed'),
  done: join(DATA, 'tasks', 'done'),
};
const EVIDENCE = join(DATA, 'evidence.jsonl');
const CONFIG_PATH = envVar('CONFIG') || join(HERE, 'config.json');

// ── tuning constants — named so a change is a decision, not a typo hunt ───────
const PROVE_TIMEOUT_MS = Number(envVar('PROVE_TIMEOUT_MS')) || 15 * 60_000;
const FAST_PROOF_TIMEOUT_MS = 90_000; // a hung `node -e` one-liner is a bug, not a long test
const PROOF_TAIL_CHARS = 2_000;       // how much proof output survives into a report
const RENAME_MAX_TRIES = 10;          // Windows AV/indexers briefly hold fresh files
const TMP_MAX_AGE_MS = 3_600_000;     // stale tmp/ entries older than this are swept
const SNAPSHOT_MAX_FILES = 10;        // replay caches a small RESULT, never a repository
const SNAPSHOT_MAX_CHARS = 65_536;
const TAX_TAIL_BYTES = 262_144;       // meter the transcript's tail, not the whole file
const FRESH_FLOOR_TOKENS = 22_333;    // measured fresh-session per-message floor (docs/THESIS.md)
const TAX_AMBER_X = 3;                // per-message cost, in multiples of the fresh floor
const TAX_RED_X = 10;
const LEASE_MISSION_PAD_S = 900;      // a lease must outlive the longest mission by a margin

// ── config — validated at load; a bad knob is refused, never silently absorbed ─
const DEFAULTS = {
  runModel: 'haiku', runEffort: 'low', runMaxTurns: 25,
  runAllowedTools: 'Write,Read,Edit,Bash', runLean: true,
  runTokens: 5_000_000, runMinutes: 60, thinkingTokens: 0,
  pollMs: 500, maxStrikes: 3, ttrSeconds: 3900,
};
function loadConfig() {
  let cfg = { ...DEFAULTS };
  if (existsSync(CONFIG_PATH)) {
    try {
      const json = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('config must be a JSON object');
      cfg = { ...DEFAULTS, ...json };
    } catch (e) {
      console.error(`invalid config ${CONFIG_PATH}: ${e.message}`);
      process.exit(2);
    }
  }
  // HARDENING: a numeric knob that arrives NaN/negative silently disables a safety (a NaN pollMs
  // hangs the poll loop forever; a NaN cap never fires). Fail loud, not silent.
  for (const key in DEFAULTS) {
    if (typeof DEFAULTS[key] !== 'number') continue;
    if (!(Number(cfg[key]) >= 0)) {
      console.error(`invalid config: ${key} must be a non-negative number (got ${JSON.stringify(cfg[key])})`);
      process.exit(2);
    }
  }
  return cfg;
}
const CONFIG = loadConfig();

const die = (code, msg) => { console.error(msg); process.exit(code); };

// ── fs primitives — rename-atomic; "nothing falls through" is a filesystem fact ─
// Synchronous sleep with no timer or promise: the engine is deliberately daemonless, and its one
// polling loop blocks between samples on purpose. NaN/∞ would hang the wait forever — clamp to 0.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number.isFinite(ms) && ms > 0 ? ms : 0);

// renameSync with backoff: antivirus/indexers hold fresh files on Windows (EPERM/EACCES/EBUSY).
// ENOENT is a lost claim race — a normal answer (false), never an error.
function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= RENAME_MAX_TRIES - 1) throw e;
      sleep(2 ** attempt);
    }
  }
}
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
const ensureDirs = () => Object.values(DIRS).forEach((d) => mkdirSync(d, { recursive: true }));
const newId = () => `${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
const agentName = (flag) => (flag || envVar('AGENT') || userInfo().username || 'agent').replace(/[^A-Za-z0-9_-]/g, '-');
const readTask = (path) => JSON.parse(readFileSync(path, 'utf8'));
const logEvidence = (row) => appendFileSync(EVIDENCE, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');

// Find a task file by id prefix. One hit or none; an ambiguous prefix is refused.
function resolveIn(dir, idish) {
  const hits = listDir(dir).filter((f) => f.startsWith(idish));
  if (hits.length > 1) die(2, `ambiguous id "${idish}"`);
  return hits[0] ?? null;
}
// Stage to tmp, then rename into place — a crash mid-write can never leave a torn record.
function writeTaskAtomic(path, obj) {
  const tmp = join(DIRS.tmp, `wr-${newId()}.json`);
  try {
    writeFileSync(tmp, JSON.stringify(obj));
    if (renameRetry(tmp, path)) return;
  } catch { /* fall through to the direct write */ }
  writeFileSync(path, JSON.stringify(obj));
}

// ── proof runner — the verification mint ──────────────────────────────────────
// Every run, green or red, lands in the evidence ledger. A pure `node -e "…"` one-liner runs
// WITHOUT a shell (injection-immune, fast); if it also spawns nothing itself it gets the short
// timeout. Anything else keeps the full budget under a real shell.
function runProof(cmd, taskId = null) {
  const t0 = Date.now();
  const oneLiner = /^node -e "([^"]+)"$/.exec(cmd.trim());
  const quick = oneLiner && !/execSync|spawn|exec\(/.test(oneLiner[1]);
  const r = oneLiner
    ? spawnSync(process.execPath, ['-e', oneLiner[1]], { encoding: 'utf8', timeout: quick ? Math.min(FAST_PROOF_TIMEOUT_MS, PROVE_TIMEOUT_MS) : PROVE_TIMEOUT_MS })
    : spawnSync(cmd, { shell: true, encoding: 'utf8', timeout: PROVE_TIMEOUT_MS });
  const exit = r.status ?? 1;
  logEvidence({ task: taskId, cmd, exit, ms: Date.now() - t0 });
  return { exit, tail: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-PROOF_TAIL_CHARS) };
}

// ── the lane: add → claim → work → done, gated by a fresh green proof ─────────
function addTask(title, opts) {
  if (!title) die(2, 'add needs a title: node tiny.mjs add "<title>" [--prove "<cmd>"]');
  if (opts.effort && !['low', 'medium', 'high'].includes(opts.effort)) die(2, `invalid --effort "${opts.effort}"`);
  if (opts.repo && !existsSync(opts.repo)) die(2, `no such repo: ${opts.repo}`);
  const task = {
    id: newId(),
    title,
    prove: opts.prove ?? null,
    note: opts.note ?? null,
    model: opts.model ?? null,
    effort: opts.effort ?? undefined,
    repo: opts.repo ?? undefined,
    ttr: CONFIG.ttrSeconds,
    by: agentName(opts.agent),
    created: new Date().toISOString(),
  };
  // PROOF-QUALITY GATE (the accuracy core): a proof that is green BEFORE the work exists can't
  // tell done from not-done — refuse it. An honest red (a fix gate) is correct and passes.
  if (opts.check && task.prove) {
    const dry = runProof(task.prove, null);
    const unrunnable = /is not recognized|command not found|cannot find the (path|file)|ENOENT/i.test(dry.tail)
      || (/(SyntaxError|ReferenceError)/.test(dry.tail) && /at \[eval\]/.test(dry.tail));
    if (dry.exit !== 0 && unrunnable) die(2, `REFUSED: proof is unrunnable (spawn-class, not a red gate) — fix quoting:\n${dry.tail.trim().slice(-300)}`);
    if (dry.exit === 0 && !opts.invariant) die(2, `REFUSED: proof passes BEFORE the work exists — a born-green proof proves nothing. Author one that's red until the work lands, or --invariant to lock a regression guard.`);
    if (dry.exit !== 0) console.error(`note: proof born red (exit ${dry.exit}) — a fix gate; must flip green to close`);
  }
  const tmp = join(DIRS.tmp, `${task.id}.json`);
  writeFileSync(tmp, JSON.stringify(task));
  renameRetry(tmp, join(DIRS.ready, `${task.id}.json`));
  console.log(`added ${task.id}`);
}

// The whole janitor: recover leases past their TTL, sweep stale tmp files — nothing more.
function reapStale() {
  for (const f of listDir(DIRS.tmp)) {
    try { if (Date.now() - statSync(join(DIRS.tmp, f)).mtimeMs > TMP_MAX_AGE_MS) rmSync(join(DIRS.tmp, f)); }
    catch { /* raced */ }
  }
  for (const f of listDir(DIRS.claimed)) {
    const p = join(DIRS.claimed, f);
    try {
      const task = readTask(p);
      if ((Date.now() - statSync(p).mtimeMs) / 1000 > (task.ttr || CONFIG.ttrSeconds)) renameRetry(p, join(DIRS.ready, `${task.id}.json`));
    } catch { /* raced/corrupt */ }
  }
}
// Claim by rename — atomic, so two workers can never own the same task.
function claimOne(who, skip = new Set()) {
  reapStale();
  for (const f of listDir(DIRS.ready).sort()) {
    const id = f.slice(0, -5);
    if (skip.has(id)) continue;
    const to = join(DIRS.claimed, `${id}.${who}.json`);
    if (!renameRetry(join(DIRS.ready, f), to)) continue; // lost the race — next
    const now = new Date();
    try {
      utimesSync(to, now, now); // the lease clock starts now
      return readTask(to);
    } catch { continue; }
  }
  return null;
}
// Move claimed → done, then rewrite the record with its proof receipt. Staged to tmp and renamed
// OVER the target so a crash mid-write can't leave a torn, permanently-unparseable done record.
function finalizeDone(claimedPath, task, cmd, agent) {
  const target = join(DIRS.done, `${task.id}.json`);
  if (!renameRetry(claimedPath, target)) return false; // lost the race: a peer owns it now
  const record = JSON.stringify({ ...task, done: new Date().toISOString(), doneBy: agent, proof: { cmd, exit: 0, at: new Date().toISOString() } });
  const tmp = join(DIRS.tmp, `${task.id}.done.json`);
  try {
    writeFileSync(tmp, record);
    if (renameRetry(tmp, target)) return true;
  } catch { /* fall through */ }
  writeFileSync(target, record);
  return true;
}
function releaseToReady(id, { strike = false } = {}) {
  const f = resolveIn(DIRS.claimed, id);
  if (!f) return false;
  const p = join(DIRS.claimed, f);
  if (strike) {
    try {
      const task = readTask(p);
      writeTaskAtomic(p, { ...task, strikes: (task.strikes ?? 0) + 1 });
    } catch { /* raced */ }
  }
  renameRetry(p, join(DIRS.ready, `${id}.json`));
  return true;
}
function doneTask(idish, opts) {
  const f = idish && resolveIn(DIRS.claimed, idish);
  if (!f) die(2, `not claimed: "${idish ?? ''}"`);
  const p = join(DIRS.claimed, f);
  const task = readTask(p);
  const cmd = opts.prove || task.prove;
  if (!cmd) die(2, 'no proof declared: pass --prove "<cmd>" — done without a fresh green exit does not exist');
  const proof = runProof(cmd, task.id);
  if (proof.exit !== 0) {
    console.error(proof.tail);
    die(1, `REFUSED: proof exited ${proof.exit} — "${task.title}" stays claimed`);
  }
  if (!finalizeDone(p, task, cmd, agentName(opts.agent))) die(1, `lease expired mid-proof — re-claim ${task.id}`);
  console.log(`done ${task.id}`);
}
function listTasks(state) {
  for (const s of (state ? [state] : ['ready', 'claimed', 'done'])) {
    if (!DIRS[s]) die(2, `unknown state "${s}"`);
    for (const f of listDir(DIRS[s]).sort()) {
      try {
        const t = readTask(join(DIRS[s], f));
        const strikes = t.strikes ? `  [${t.strikes} strike${t.strikes >= CONFIG.maxStrikes ? 's — PARKED' : 's'}]` : '';
        console.log(`${t.id}  ${s.padEnd(7)}  ${t.title}${strikes}`);
      } catch { /* mid-rename */ }
    }
  }
}
function status() {
  const count = (d) => listDir(d).length;
  console.log(`ready ${count(DIRS.ready)} · claimed ${count(DIRS.claimed)} · done ${count(DIRS.done)}`);
}
function proveCmd(cmd) {
  if (!cmd) die(2, 'prove needs a command');
  const { exit, tail } = runProof(cmd);
  console.log(tail.trimEnd());
  console.log((exit === 0 ? 'PROOF GREEN: ' : `PROOF RED (${exit}): `) + (cmd.length > 40 ? cmd.slice(0, 40) + '…' : cmd));
  process.exitCode = exit;
}

// ── transcript usage metering (shared by the governor and the tax meter) ──────
// Claude Code appends JSONL transcripts under ~/.claude/projects; assistant messages carry a
// usage block. Rows are deduped by message id + request id (retries re-log the same message).
const usageRoot = () => envVar('TRANSCRIPTS') || join(homedir(), '.claude', 'projects');
function tokensOfLine(line, modelFilter, seen) {
  if (!line.includes('"usage"')) return null;
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  const u = row?.message?.usage;
  if (!u) return null;
  if (modelFilter && !String(row?.message?.model ?? '').includes(modelFilter)) return null;
  if (row.message.id) {
    const key = `${row.message.id}:${row.requestId}`;
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}
function jsonlFiles(root) {
  const out = [], stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out;
}
// Counts tokens ONLY in transcript files created after the meter starts — this mission's own
// spend, not the operator's other sessions. Incremental: re-reads only bytes appended since
// the last poll, and only up to the last complete line.
function makeSpendMeter(modelFilter = '') {
  const offsets = new Map(), seen = new Set();
  const preexisting = new Set(jsonlFiles(usageRoot()));
  let total = 0;
  return function meter() {
    for (const f of jsonlFiles(usageRoot())) {
      if (preexisting.has(f)) continue;
      let size;
      try { size = statSync(f).size; } catch { continue; }
      let at = offsets.get(f) ?? 0;
      if (size < at) at = 0; // truncated/rotated — start over
      if (size === at) continue;
      const fd = openSync(f, 'r');
      const buf = Buffer.alloc(size - at);
      readSync(fd, buf, 0, buf.length, at);
      closeSync(fd);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) continue; // no complete line yet
      offsets.set(f, at + Buffer.byteLength(text.slice(0, lastNl + 1)));
      for (const line of text.slice(0, lastNl).split('\n')) {
        const n = tokensOfLine(line, modelFilter, seen);
        if (n != null) total += n;
      }
    }
    return total;
  };
}

// ── governed mission — the token engine ───────────────────────────────────────
// A headless agent run under a hard token + wall-clock cap, killed mid-run on overrun. The
// savings come from the argv (turn cap, low effort, lean env) and the prompt (below) — NOT from
// any heavier machinery, which is the whole point of the cut.
async function governed(argv, caps) {
  const capTokens = caps.tokens != null ? Number(caps.tokens) : Infinity;
  const capMs = caps.minutes != null ? Number(caps.minutes) * 60_000 : Infinity;
  // HARDENING: a NaN cap (e.g. --tokens abc) would make `tokens > cap` always false and SILENTLY
  // disable the runaway-spend guard. Refuse it loudly instead of billing without a ceiling.
  if (Number.isNaN(capTokens) || Number.isNaN(capMs)) die(2, `caps must be numbers — got --tokens "${caps.tokens}" --minutes "${caps.minutes}"`);
  const cmd = argv.map((a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
  const spent = makeSpendMeter(caps.meterModel ?? '');
  const poll = Math.max(50, Number(envVar('POLL_MS')) || CONFIG.pollMs); // never a 0/NaN busy-loop or hang
  const t0 = Date.now();
  const child = spawn(cmd, { shell: true, cwd: caps.cwd, env: caps.env, stdio: [caps.input == null ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
  // HARDENING: a child that errors without ever exiting (unspawnable shell/binary) would hang
  // the poll loop forever — break on it.
  let spawnErr = null;
  child.on('error', (e) => { spawnErr = e; });
  if (caps.input != null) {
    child.stdin.on('error', () => {});
    child.stdin.end(caps.input);
  }
  for (;;) {
    sleep(poll);
    await new Promise(setImmediate); // let queued child events (exit/error) fire
    const tokens = spent();
    if (spawnErr) {
      logEvidence({ task: null, cmd: `spawn-error: ${cmd}`, exit: 'error', ms: Date.now() - t0, tokens });
      return { code: 127, tokens, overrun: null };
    }
    const dead = child.exitCode !== null || child.signalCode !== null;
    const overrun = tokens > capTokens
      ? `token cap ${capTokens.toLocaleString()} exceeded (${tokens.toLocaleString()})`
      : Date.now() - t0 > capMs ? `time cap ${caps.minutes}min exceeded` : null;
    if (overrun && !dead) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f']);
      else child.kill('SIGKILL');
      await once(child, 'exit');
      logEvidence({ task: null, cmd: `budget: ${cmd}`, exit: 'killed', ms: Date.now() - t0, tokens });
      return { code: 4, tokens, overrun };
    }
    if (dead) {
      logEvidence({ task: null, cmd: `budget: ${cmd}`, exit: child.exitCode ?? 1, ms: Date.now() - t0, tokens });
      return { code: child.exitCode ?? 1, tokens, overrun: null };
    }
  }
}
// THE PROMPT: the agent is GIVEN its proof and told to iterate against it. Blindfolding the agent
// ("do NOT run the acceptance check yourself") was the documented cause of a 438K-vs-101K token
// blowup — it forbids TDD. The fresh re-run at close time is still the ONLY thing that closes the
// task, so anti-gaming is unchanged.
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

const resolveModel = (task, opts) => opts.model ?? task.model ?? CONFIG.runModel ?? null; // declared, never inferred
function missionArgs(model, effort) {
  const argv = ['claude', '-p'];
  if (model) argv.push('--model', model);
  if (CONFIG.runAllowedTools) argv.push('--allowedTools', CONFIG.runAllowedTools);
  if (effort) argv.push('--effort', effort);
  if (CONFIG.runMaxTurns) argv.push('--max-turns', String(CONFIG.runMaxTurns));
  if (CONFIG.runLean) argv.push('--disable-slash-commands');
  return argv;
}
// The mission child's environment — built as a copy, never by mutating our own process.env
// (a leaked lean-mode var would otherwise infect later proof runs and the operator's session).
function missionEnv() {
  const env = { ...process.env };
  if (CONFIG.runLean) {
    for (const k of ['CLAUDE_CODE_DISABLE_TERMINAL_TITLE', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_BUNDLED_SKILLS']) env[k] ??= '1';
  }
  env.MAX_THINKING_TOKENS ??= String(CONFIG.thinkingTokens);
  return env;
}
async function runMission(rest, opts) {
  if (!rest.length) die(2, 'run needs a task: node tiny.mjs run [--tokens n] [--minutes m] [--model m] -- "<task>"');
  const model = opts.model ?? CONFIG.runModel;
  const effort = opts.effort ?? CONFIG.runEffort;
  const r = await governed(missionArgs(model, effort), {
    tokens: opts.tokens ?? CONFIG.runTokens,
    minutes: opts.minutes ?? CONFIG.runMinutes,
    meterModel: model ?? '',
    env: missionEnv(),
    input: missionPrompt(rest.join(' '), opts.prove),
  });
  if (r.overrun) die(4, `BUDGET KILL: ${r.overrun}`);
  process.exit(r.code);
}

// ── replay — the only honest sub-second lever ─────────────────────────────────
// A coding task's result lands as file-state. On a green mission we snapshot the repo's small
// text files keyed by task-CLASS (repo + digit-stripped title + proof), and a later matching
// task RESTORES them and runs the proof FRESH — zero model. Files are inert DATA, path-fenced to
// the repo; the fresh proof is the only arbiter (a stale snapshot fails it, deletes itself, and
// falls through to a real mission), so there is no anti-gaming hole. The model is paid once per
// task-class, never again — a CI re-run, a reset-and-redo, a re-checkout all close in ~1s.
export const sigOf = (task) => {
  const repo = (task.repo ?? process.cwd()).replaceAll('\\', '/').toLowerCase();
  const words = String(task.title).toLowerCase().replace(/\d+/g, '').match(/[a-z][\w-]{2,}/g) ?? [];
  const cls = [...new Set(words)].sort().join(' '); // digits stripped → the task CLASS, not the instance
  return createHash('sha1').update(`${repo}|${cls}|${task.prove ?? ''}`).digest('hex').slice(0, 12);
};
const SNAPSHOT_SKIP = /^(\.git|\.data|\.rdata|node_modules)$/;
function snapshotRepo(dir) {
  const files = {}, stack = [''];
  let count = 0;
  while (stack.length && count < SNAPSHOT_MAX_FILES) {
    const rel = stack.pop();
    let entries;
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) { // deterministic: same repo → same snapshot
      if (count >= SNAPSHOT_MAX_FILES) break;
      if (e.isSymbolicLink()) continue; // never follow a symlink out of the repo fence (read OR restore)
      if (e.name === '.c.json' || SNAPSHOT_SKIP.test(e.name)) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { stack.push(path); continue; }
      if (!e.isFile()) continue;
      try {
        const content = readFileSync(join(dir, path), 'utf8');
        if (content.length <= SNAPSHOT_MAX_CHARS) { files[path] = content; count++; }
      } catch { /* binary/gone */ }
    }
  }
  return files;
}
function recordReplay(task) {
  try {
    const files = snapshotRepo(task.repo ?? process.cwd());
    if (!Object.keys(files).length) return;
    mkdirSync(join(DATA, 'replays'), { recursive: true });
    writeFileSync(join(DATA, 'replays', sigOf(task) + '.json'), JSON.stringify({ title: task.title, files, at: new Date().toISOString() }));
    console.log(`replay cached: ${Object.keys(files).length} file(s) for this task-class`);
  } catch { /* recording is a bonus, never a failure */ }
}
// Restore a cached file-state, then let the task's OWN proof arbitrate — fresh, zero model.
function tryReplay(task, who) {
  const planPath = join(DATA, 'replays', sigOf(task) + '.json');
  if (!existsSync(planPath)) return false;
  let plan;
  try { plan = JSON.parse(readFileSync(planPath, 'utf8')); } catch { return false; }
  const base = resolve(task.repo ?? process.cwd());
  for (const [rel, content] of Object.entries(plan.files ?? {})) {
    const dest = resolve(base, rel);
    if (dest !== base && !dest.startsWith(base + sep) && !dest.startsWith(base + '/')) continue; // repo fence
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    } catch { /* unwritable — the proof still arbitrates */ }
  }
  if (runProof(task.prove, task.id).exit !== 0) {
    rmSync(planPath, { force: true }); // the world moved — delete, never retry a liar
    return false;
  }
  const f = resolveIn(DIRS.claimed, task.id);
  if (f && finalizeDone(join(DIRS.claimed, f), task, task.prove, who)) {
    logEvidence({ task: task.id, cmd: `replay: ${Object.keys(plan.files ?? {}).length} file(s), zero model`, exit: 0, ms: 0 });
    return true;
  }
  return false; // lease lost mid-replay — the cache is still valid; leave it for the next holder
}

// ── work — claim → intake ladder → replay or mission → FRESH proof → done ─────
async function work(opts) {
  const who = agentName(opts.agent);
  const skip = new Set();
  let doneN = 0, refused = 0;
  for (;;) {
    const t = claimOne(who, skip);
    if (!t) break;
    skip.add(t.id);
    // INTAKE LADDER — cheap closes spend zero mission. A parked or proofless task is released and
    // never consumes a single-task run's budget — otherwise one dud at the head of the queue
    // would head-of-line-block every future `work` call.
    if ((t.strikes ?? 0) >= CONFIG.maxStrikes) {
      releaseToReady(t.id);
      console.error(`parked ${t.id}: ${t.strikes} strikes`);
      continue;
    }
    if (!t.prove) {
      releaseToReady(t.id);
      console.error(`skip ${t.id}: no --prove`);
      continue;
    }
    // Acceptance already green → close for free, no mission.
    if (runProof(t.prove, t.id).exit === 0) {
      const f = resolveIn(DIRS.claimed, t.id);
      if (f && finalizeDone(join(DIRS.claimed, f), t, t.prove, who)) {
        doneN++;
        console.log(`done ${t.id} (already green — no mission)`);
      }
      if (!opts.all) break;
      continue;
    }
    console.log(`work: ${t.id}  ${t.title}`);
    // Extend the lease to cover the whole mission plus margin, so a slow-but-alive run isn't reaped.
    const leased = resolveIn(DIRS.claimed, t.id);
    if (leased) writeTaskAtomic(join(DIRS.claimed, leased), { ...t, ttr: Math.max(t.ttr || 0, CONFIG.runMinutes * 60 + LEASE_MISSION_PAD_S) });
    // The sub-second path: a matching task-class restores its file-state + re-proves, no mission.
    if (tryReplay(t, who)) {
      doneN++;
      console.log(`done ${t.id} (replayed — zero model, ~0s)`);
      if (!opts.all) break;
      continue;
    }
    const model = resolveModel(t, opts);
    const effort = opts.effort ?? t.effort ?? CONFIG.runEffort;
    const g = await governed(missionArgs(model, effort), {
      tokens: opts.tokens ?? CONFIG.runTokens,
      minutes: opts.minutes ?? CONFIG.runMinutes,
      meterModel: model ?? '',
      cwd: t.repo,
      env: missionEnv(),
      input: missionPrompt(`${t.title}${t.note ? `\n${t.note}` : ''}`, t.prove),
    });
    if (g.overrun) {
      refused++;
      releaseToReady(t.id);
      console.error(`KILLED ${t.id}: ${g.overrun} — released, no strike`);
      if (!opts.all) break;
      continue;
    }
    const proof = runProof(t.prove, t.id); // fresh, after the run — the only verdict that counts
    const f = resolveIn(DIRS.claimed, t.id);
    if (proof.exit === 0 && f && finalizeDone(join(DIRS.claimed, f), t, t.prove, who)) {
      doneN++;
      console.log(`done ${t.id}`);
      recordReplay(t); // cache the winning file-state so the NEXT run of this class replays in ~0s
    } else {
      refused++;
      releaseToReady(t.id, { strike: true });
      console.error(`REFUSED ${t.id}: proof exited ${proof.exit} — back to ready`);
    }
    if (!opts.all) break;
  }
  console.log(`work: ${doneN} done, ${refused} refused`);
  process.exit(refused ? 1 : 0);
}

// ── the session tax meter — reports, never refuses ────────────────────────────
// A refusal governor was cut here: an A/B (bench/gov) measured a PreToolUse re-read/verbose gate
// at +62.9% tokens on a real debugging task — each hard refusal forces an extra model round-trip
// (~16–30K re-billed) that dwarfs the moderate output it prevents. The meter stays because it
// only REPORTS a number (per-message tokens vs the fresh floor) — it surfaces the 15–21×
// accumulation lever without ever costing a round-trip.
function taxRead() { // newest transcript = current session
  try {
    let pick = null, newest = -1;
    for (const p of jsonlFiles(usageRoot())) {
      const m = statSync(p).mtimeMs;
      if (m > newest) { newest = m; pick = p; }
    }
    if (!pick) return null;
    const size = statSync(pick).size;
    const at = Math.max(0, size - TAX_TAIL_BYTES);
    const fd = openSync(pick, 'r');
    const buf = Buffer.alloc(size - at);
    readSync(fd, buf, 0, buf.length, at);
    closeSync(fd);
    let lines = buf.toString('utf8').split('\n');
    if (at > 0) lines = lines.slice(1); // the first line may be torn by the window edge
    const seen = new Set();
    let total = 0, msgs = 0;
    for (const line of lines) {
      const n = tokensOfLine(line, '', seen);
      if (n != null) { total += n; msgs++; }
    }
    if (!msgs) return null;
    const fresh = Number(envVar('TAX_FRESH')) > 0 ? Number(envVar('TAX_FRESH')) : FRESH_FLOOR_TOKENS;
    const per = Math.round(total / msgs);
    return { total, msgs, per, x: per / fresh };
  } catch { return null; }
}
function taxCmd() {
  const t = taxRead();
  if (!t) die(3, 'no usable session transcript found');
  const verdict = t.x > TAX_RED_X ? 'RED — land, start fresh' : t.x > TAX_AMBER_X ? 'AMBER — consider landing' : 'OK';
  console.log(`session tax: ${t.total.toLocaleString()} tok / ${t.msgs} msgs = ${t.per.toLocaleString()}/msg (${t.x.toFixed(1)}x fresh) — ${verdict}`);
  process.exitCode = t.x > TAX_RED_X ? 1 : 0;
}
function hook(event) {
  if (event !== 'session-start') die(2, 'unknown hook event (only: session-start)');
  const t = taxRead();
  if (t && t.x > TAX_AMBER_X) console.log(`tinygate tax: ${t.per.toLocaleString()} tok/msg (${t.x.toFixed(1)}x fresh) — ${t.x > TAX_RED_X ? 'RED: start a fresh session' : 'AMBER: consider a fresh session'}`);
}
function installClaude() {
  ensureDirs();
  if (!existsSync(CONFIG_PATH)) writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n');
  const me = join(HERE, 'tiny.mjs').replaceAll('\\', '/');
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); }
    catch { die(2, `invalid JSON in ${settingsPath}`); }
  }
  settings.hooks = settings.hooks ?? {};
  settings.hooks.SessionStart = [
    ...(settings.hooks.SessionStart ?? []).filter((h) => !JSON.stringify(h).includes('tiny.mjs" hook session-start')),
    { hooks: [{ type: 'command', command: `node "${me}" hook session-start` }] },
  ];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`installed: data dir, session-tax beacon (SessionStart — reports only, refuses nothing). config: ${CONFIG_PATH}`);
}

// ── CLI ────────────────────────────────────────────────────────────────────────
const HELP = `tinygate — proof gate + governed missions + replay + tax meter (one file, zero deps)
  add "<title>" [--prove "<cmd>"] [--check] [--effort e] [--repo d] [--model m] [--note ..]
  done <id> [--prove ..] · list [ready|claimed|done] · prove "<cmd>" · status
  run [--tokens n] [--minutes m] [--model m] [--effort e] [--prove ..] -- "<task>"   one governed mission
  work [--all] [--model m]      claim → govern → prove-fresh → done; a repeated task-class REPLAYS (~0s); strikes park a stuck task
  tax                           session context meter (when to start fresh — the biggest lever)
  hook session-start            tax beacon (wired by install; reports only, refuses nothing)
  install                       Claude Code SessionStart tax beacon
config: ${CONFIG_PATH} · data: ${DATA} · env: TINYGATE_DATA TINYGATE_CONFIG TINYGATE_TRANSCRIPTS TINYGATE_POLL_MS (TINYAI_* accepted)`;

const OPTIONS = {
  prove: { type: 'string' }, check: { type: 'boolean' }, invariant: { type: 'boolean' },
  effort: { type: 'string' }, repo: { type: 'string' }, model: { type: 'string' },
  note: { type: 'string' }, agent: { type: 'string' },
  tokens: { type: 'string' }, minutes: { type: 'string' }, all: { type: 'boolean' },
};
const parseCli = (args) => {
  try { return parseArgs({ args, allowPositionals: true, options: OPTIONS }); }
  catch (e) { die(2, `${String(e.message ?? e).split('\n')[0]} — node tiny.mjs help`); }
};

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
try { isMain = import.meta.url.toLowerCase() === pathToFileURL(realpathSync(process.argv[1])).href.toLowerCase(); } catch { /* imported, not executed */ }
if (isMain) {
  const { values: v, positionals } = parseCli(process.argv.slice(2));
  ensureDirs();
  await dispatch(positionals[0], positionals.slice(1), v);
}

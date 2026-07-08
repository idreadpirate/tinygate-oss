# tinygate

**A 391-line ECU for AI coding agents. One file, zero dependencies.**

tinygate sits between an AI coding agent and two things it can't be trusted with — *what is true* and
*what it cost*. A task closes only when a stored proof command exits green, run fresh at that moment.
Missions run under a hard token cap on a cheap model. The tool drives; the model is the engine.

Every mechanism in it earns its place against an A/B test. Nothing ships on intuition.

## Install

```bash
node tiny.mjs install     # wires a read-only session-tax beacon into Claude Code
node tiny.mjs help        # the whole surface
```

## What it does

- **Proof gate** — `done` exists only on a fresh green exit code. Born-green proofs (always green, so
  they prove nothing) are refused at authoring time. This is what makes routing to a cheap model safe:
  reliability is the proof's to assert, never the model's.
- **Governed missions** — headless runs under a turn cap, low reasoning effort, a lean environment, and a
  tight output policy. **−37% tokens vs a raw agent at tied accuracy** (6-task ungameable A/B, external
  grader).
- **Replay** — a repeated task-class restores its cached file-state and re-proves fresh, zero model:
  **17.2s → 128ms** on a repeat, verified correct by the grader.
- **Tax meter** — a read-only session beacon: per-message tokens vs a fresh floor, so you know when to
  start fresh. It reports; it never refuses.

## What it doesn't do

- It's **not a speed chip.** First-run wall is the model's floor (turns × latency); the exoskeleton can't
  go below a task's natural need. The only speed lever is replay, and it only fires on repeats (CI, evals,
  batch) — near-inert for one-off work.
- It **doesn't refuse your tool calls.** A refusal governor was built, measured at **+62.9% tokens** (the
  refusal round-trip costs more than the accumulation it prevents), and removed.
- **No memory system, MCP broker, router, or dashboard.** None moved a speed, cost, or accuracy number.

## Quickstart — the proof-gated lane

```bash
# author a task with a machine-checkable proof (born-green proofs are refused)
node tiny.mjs add "implement sumDigits" \
  --prove 'node -e "import(\"./solution.mjs\").then(m=>process.exit(m.sumDigits(238)===13?0:1))"' \
  --repo . --check

# drive it: claim → governed mission → FRESH proof → done  (a repeat replays in ~0.1s)
node tiny.mjs work

# or a one-off governed mission
node tiny.mjs run --model haiku -- "fix the failing test in parser.mjs"

# session context meter — when to start fresh
node tiny.mjs tax
```

## Surface

```
add <title> [--prove <cmd>] [--check] [--repo d] [--model m] [--effort e] [--note ..]
done <id> [--prove ..]     list [ready|claimed|done]     prove <cmd>     status
run  [caps] [--model m] -- <task>        one governed mission
work [--all] [--model m]                 claim → govern → prove-fresh → done; repeats REPLAY
tax                                      session context meter
hook session-start                       read-only tax beacon (wired by install)
install                                  Claude Code SessionStart beacon
```

Config is `config.json` — every knob is validated at load, so a NaN or negative cap is refused rather
than silently disabling a safety. Data lives in `data/`. Env: `TINYAI_DATA`, `TINYAI_CONFIG`,
`TINYAI_TRANSCRIPTS`, `TINYAI_POLL_MS`.

## SDK

A thin, zero-dep programmatic wrapper (`sdk.mjs`) drives the same engine and returns structured results
instead of CLI text — throwing on failure. Nothing is reimplemented.

```js
import { Tinygate } from './sdk.mjs';

const tg = new Tinygate({ data: './.tg', cwd: '.' });

const id = await tg.add('implement parser', {
  prove: 'node -e "import(\'./parser.mjs\').then(m=>process.exit(m.parse(\'1+2\')===3?0:1))"',
  repo: '.', check: true,                 // check:true refuses a born-green proof
});

const { done, refused } = await tg.work();  // claim → govern → prove-fresh → done (repeats replay)
const t = await tg.tax();                   // { perMsg, x, verdict } — when to start fresh
```

Methods: `add · work · run · done · prove · tax · status · list`, plus the pure `sigOf` re-export.

## Proof

```bash
node --test tinygate.test.mjs     # 10/10 engine tests, no model required
node --test sdk.test.mjs          # 5/5 SDK tests, no model required
```

Covers config and cap validation, the born-green refusal, task-class signatures, a full zero-model replay
round-trip, and the replay path-fence (a cache entry escaping the repo is skipped, never written).

## Reproduce the numbers

The A/B runners behind every claim are in [`bench/`](bench/), with the raw result data. They grade on
random inputs the agent never sees (`bench/grade.mjs` builds expected answers by construction), so the
results are ungameable. The only number that transfers is the one you measure on your own workload.

## License

MIT — see [LICENSE](LICENSE).

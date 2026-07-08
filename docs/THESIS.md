# The Exoskeleton Thesis

*Wrap a stochastic engine in a deterministic exoskeleton, then delete every part of the
exoskeleton that can't prove it helps.*

tinygate is one zero-dependency Node file — **391 lines** — that sits between an AI coding agent and
two things the agent can't be trusted with: **what is true** and **what it cost**. A task closes only
when a stored proof command exits green, run fresh at that moment. Spend is metered from the agent's
own transcripts against a hard cap. The inversion the field keeps circling: **the tool is the driver;
the model is the engine.**

It was built under one rule — **every mechanism must beat an A/B test or it gets cut** — and roughly
half of what "obviously" should have helped turned out to hurt. What follows is only what survived, each
piece with the measurement behind it, and an honest accounting of the limits and the things that were
removed. Every number is dated, reproducible, and produced on the same ungameable grader.

---

## What survived, and its receipt

### 1. The proof gate — the accuracy engine

"Done" has exactly one path: a stored proof command runs fresh, at close time, and must exit 0. Model
language is optimized to be convincing, not true — the false-success literature measures agents
confidently self-reporting completion falsely at rates up to 79%, and LLM judges topping out near 0.65
AUROC even with ground truth in hand. Neither self-report nor model judgment can gate closure. Only a
machine-checkable exit code the agent cannot charm mints trust.

This is also the mechanism that makes everything else safe. A born-green proof (one that passes before
any work exists) is refused at authoring time, because a proof that's always green proves nothing. And
because the gate binds identically regardless of which model produced the work, routing to a cheap model
is free rather than risky: reliability was never the model's to assert.

**Receipt:** it's the arbiter for both `done` and `replay` below, and it's what caught the classic
false-success failure in the original tool's own history (a sweep reporting "4/4 clean" while writing
every row to the wrong database). Cost: roughly one command, milliseconds to seconds.

### 2. The governed mission — the token engine

Mechanical, well-specified work runs as a headless agent mission under a turn cap, low reasoning effort,
a lean environment (no loaded skills, no auto-memory, no CLAUDE.md chain), and a tight output policy
(don't narrate, batch tool calls, redirect verbose output). The savings come from the *prompt and the
flags*, not from heavy machinery.

**Receipt (6-task gauntlet A/B, ungameable external grader, haiku-low):**

| arm | median tokens | pass |
|---|---|---|
| raw `claude -p` | 89,329 | 6/6 |
| **tinygate governed** | **55,683** | **6/6** |

**−37% tokens at identical accuracy.** The savings are entirely in the prompt and the flags — no heavy
machinery is involved, which is the whole point.

### 3. Replay — the only honest speed win, and only on repeats

A coding task's result is file-state. On a green mission, tinygate snapshots the repo's small text files
keyed by task-class (repo + digit-stripped title + proof). A later matching task **restores them and
re-runs the proof fresh — zero model**.

**Receipt (3-task replay A/B):** first run 17.2s median → repeat **128ms** median, 3/3 replayed, 3/3
graded correct by the hidden property test. Roughly **134× faster on a repeat**, at zero tokens.

**The honest limit, stated plainly:** replay only fires when the *exact* task-class recurs. For one-off
interactive development it almost never does — you implement a feature once and move on. It earns its
keep in the unattended-worker mode: CI re-running the same task, eval suites, batch reprocessing, a fresh
checkout redoing known work. It's kept anyway because its idle cost is ~nil (one file-existence check per
claim) and a stale snapshot is caught by the fresh proof and discarded — cheap insurance, never a tax.

### 4. The tax meter — a read-only signal

Every turn re-bills every token before it, so accumulated sessions cost 15–21× per message what a fresh
short session pays. The meter reports that ratio at session open: per-message tokens vs a measured fresh
floor. It **refuses nothing** — it just tells you when to start fresh. (See the next section for why
that matters: the version that *refused* was measured as a net loss and removed.)

---

## What was cut, and the measurement that killed it

The discipline is the product. Every mechanism below seemed obviously helpful; each was built, A/B'd, and
deleted when the number came back wrong.

| Cut | Why (measured) |
|---|---|
| **Refusal governor** (re-read / verbose-output deny) | +62.9% tokens on a real debugging task. Each hard refusal forces an extra model round-trip (~16–30K re-billed) that dwarfs the moderate output it prevents. Wins only on huge outputs or very long sessions — not the common case. |
| **Best-of-N racing** (parallel attempts, first proof-green wins) | 36s / 293K tokens on a *trivial* task. Two agent processes on one machine contend and each runs slower; the research's "parallel agents reduce latency" assumes independent serving capacity, which a single box against a hosted API doesn't have. |
| **Context pre-loading** (inject task files to skip the read turn) | Turns went *up*, not down — the model thrashed. On real repos it might help; on the benchmark it re-billed the injected content every turn for no gain. |
| **Model-escalation ladder** (climb haiku→sonnet→opus on strikes) | Never A/B'd. Held to the same "prove it or lose it" rule and cut. Strike-counting + park (the thrash-breaker) was kept — that's safety, not the unproven escalation. |
| **The daily gauge dashboard, IP mandate, MCP broker, chat wrapper, case-law memory, locate/vault/statusline** | None moved a speed / cost / accuracy number. Reporting, portability, and memory features — real, but not what an ECU is for. |

The through-line: parallelism costs gas and contends locally; refusals cost round-trips; forcing fewer
turns makes the model flail. The only levers that survived are the ones that either **cut the prompt/flags**
(governed mission), **skip the model entirely** (replay, on repeats), or **only report** (the meter).

---

## The honest limits

1. **First-run wall is the model's floor, not the chip's.** Five architectures were built to get a fresh
   coding task under ~9s (fewer turns, pre-load, best-of-N, drop-the-report, warm-cache). All five
   regressed or failed. Wall = turns × per-turn-latency, and on first-run both belong to the engine. The
   exoskeleton minimizes turns and cannot go below the task's natural need.
2. **It's a token + accuracy chip, not a speed chip.** The one speed lever is replay, and it only turns on
   repeats. If your workload is one-off interactive coding, expect cheaper and more honest — not faster.
3. **It makes the operator better off more than it makes the agent better.** It's a governor *on* the
   model — leaner fuel, honest closure — not an upgrade *of* it. An ECU leans the mixture; it doesn't add
   cylinders.
4. **Small samples.** The A/Bs here are n=3–6, one run per cell, one machine, one model tier. The
   directions are clear and repeatable (the runners are in `bench/`), but these are not variance-estimated
   trials. Run them on your own workload — the numbers that transfer are the ones you measure yourself.

---

## The receipts, with method

Every number is dated to this rebuild, measured on haiku-low against an ungameable external grader
(answers built by construction, so the test itself can't be wrong). Runners are in `bench/`.

| Receipt | Number | How |
|---|---|---|
| Size | **391 lines**, zero deps, one file | `wc -l` |
| Governed vs raw | **−37% tokens, accuracy tied 6/6** | `bench/run-ab3.mjs`, 6 tasks trivial→hard |
| Replay on a repeat | **17.2s → 128ms**, 3/3 graded correct | `bench/run-replay.mjs` |
| Refusal governor (cut) | **+62.9% tokens** | `bench/run-gov.mjs`, off vs on |
| Best-of-N race (cut) | 36s / 293K on a trivial task | measured, single machine |
| Test suite | **10/10**, no model needed | `node --test tinygate.test.mjs` |

The tool's own rule applies to the tool: don't take the claim — take the measurement.

---

## Sources

- Manus — [Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) (KV-cache economics, 100:1 input:output, append-only context)
- [From Confident Closing to Silent Failure](https://arxiv.org/pdf/2606.09863) (79% false success; judges ≤0.65 AUROC)
- [Agentic AI Software Engineers: Programming with Trust](https://arxiv.org/pdf/2502.13767) (verification asymmetry; SWE-bench patch-mismatch rates)
- [Anthropic prompt caching](https://www.anthropic.com/news/prompt-caching) (75% per-turn latency cut on long prompts — why caching helps real repos, not micro-tasks)
- [Parallel agents with early termination](https://arxiv.org/pdf/2507.08944) (the best-of-N result — and why it needs independent compute)

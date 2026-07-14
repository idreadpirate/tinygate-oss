# The Exoskeleton Thesis

*Wrap a stochastic engine in a deterministic exoskeleton; let the skeleton carry what language can't.*

tinygate is one zero-dependency Node file — **696 lines** — that sits between an AI coding agent and
two things it can't be trusted with: **what is true** and **what it cost**. A task closes only when a
stored proof command exits green, run fresh at that moment. Missions run under a hard token cap on a
cheap model. The tool drives; the model is the engine.

---

## What it does

**Proof gate.** "Done" has exactly one path: a stored proof command runs fresh, at close time, and must
exit 0. Model language is optimized to be convincing, not true — self-report can't gate closure, an exit
code can. A born-green proof (always green, so it proves nothing) is refused at authoring time. This is
also what makes routing to a cheap model safe: reliability is the proof's to assert, never the model's.

**Governed missions.** Mechanical work runs as a headless mission under a turn cap, low reasoning effort,
a lean environment, and a tight output policy. **−37% tokens vs a raw agent at tied accuracy** (6-task
ungameable A/B, external grader). The savings live in the prompt and the flags — no heavy machinery.

**Replay.** A coding result is file-state. On a green mission, tinygate snapshots the repo's small text
files keyed by task-class (repo + digit-stripped title + proof); a later matching task restores them and
re-proves fresh, **zero model — 17.2s → 128ms on a repeat**, verified correct by the grader.

**Tax meter.** A read-only session beacon: per-message tokens vs a measured fresh floor, so you know when
to start fresh (the 15–21× accumulation lever). It reports; it never refuses.

---

## In production

Wired into heavy day-to-day automation, whole sessions have run at **90%+ token efficiency** — cheap-model
routing, governed missions, and replay on repeated task-classes compounding across a run. At that scale
the four mechanisms stop being individually marginal and become the thing that makes autonomous,
proof-gated agent work affordable. It is a critical part of the operator's everyday agentic workflow, not
a demo.

*(Operator-reported, production automation. The controlled single-task A/Bs below are the conservative
floor; the compounding win shows up at automation scale, where repeats and cheap routing stack.)*

---

## Honest limits

- **Not a speed chip for one-off work.** First-run wall is the model's floor (turns × latency); the
  exoskeleton can't go below a task's natural need. The speed win is replay, and it fires on *repeats* —
  which is exactly where heavy automation lives.
- **A token + accuracy chip.** It's a governor *on* the model — leaner fuel, verified closure — not an
  upgrade *of* it. An ECU leans the mixture; it doesn't add cylinders.

---

## Receipts

Measured on haiku-low against an ungameable external grader (answers built by construction). Runners in
`bench/`.

| Receipt | Number | How |
|---|---|---|
| Size | **696 lines**, zero deps, one file | `wc -l` |
| Governed vs raw | **−37% tokens, accuracy tied 6/6** | `bench/run-ab3.mjs` |
| Replay on a repeat | **17.2s → 128ms**, 3/3 graded correct | `bench/run-replay.mjs` |
| Production automation | **90%+ token efficiency** on full sessions | operator-reported, daily use |
| Tests | **13/13** engine · **5/5** SDK, no model | `node --test *.test.mjs` |

The tool's own rule applies to the tool: don't take the claim — take the measurement.

---

## Sources

- Manus — [Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) (KV-cache economics, 100:1 input:output, append-only context)
- [From Confident Closing to Silent Failure](https://arxiv.org/pdf/2606.09863) (79% false success; judges ≤0.65 AUROC)
- [Agentic AI Software Engineers: Programming with Trust](https://arxiv.org/pdf/2502.13767) (verification asymmetry as the moat)

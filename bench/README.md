# benchmarks — the receipts

These are the exact A/B runners that produced every number in the thesis, plus the raw result data.

**Result data (the receipts):**
- `ab3-results.jsonl` — governed vs raw vs old-tool, 6 gauntlet tasks (the −37% tokens claim)
- `gov-results.jsonl` — refusal governor off vs on (the +62.9% that got it cut)

**Runners (the method):** `run-ab3.mjs` (governed A/B), `run-replay.mjs` (first-run vs replay),
`run-gov.mjs` (governor off/on), `run-race.mjs` (best-of-N). `grade.mjs` is the ungameable grader —
it builds expected answers *by construction* from random inputs the agent never sees, so the test
itself can't be wrong. `lib.mjs` is the shared token meter (same formula the engine uses).

**To re-run** you need two things that are NOT bundled (they're large / environment-specific):
1. a `claude` CLI on your PATH (the runners spawn real headless agent missions), and
2. task fixtures — each a folder with `README.md`, a `solution.mjs` stub, and a `gen.mjs` generator
   for the grader. The runners point at a `tasks/` dir; drop your own graded tasks there.

The point isn't to trust these numbers — it's to run the method on *your* workload. The only number
that transfers is the one you measure yourself.

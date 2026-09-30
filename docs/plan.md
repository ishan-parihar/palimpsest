# Implementation plan

The phase ledger: what is built, what is deferred, and which phase gates the next
one. How the built phases work is `docs/architecture.md` (L0–L5) — this file does
not repeat it, because a claim in two places is a claim that will drift in one of
them. The build lists for the completed phases were deleted for that reason;
`git log` carries them.

Phases 1–3 are built. Phases 4 and 5 are not.

---

## Phase 1 — Trainer as a declarative agent, and a session that records

**Built.** `agents/trainer.md` carries `tools: [read]`; `session` spawns omp with
it, then records from the transcript omp persisted after exit (never from a pipe
— that breaks the TUI). `src/record.ts` parses that transcript into the record
schema and hardwires `verdict: PENDING`.

**Risk retired:** the session-file format is undocumented. It proved tractable
and is asserted against real fixtures in `tests/session-read.test.ts`.

---

## Phase 2 — One advisor, integrated

**Built.** One `conscience` advisor in `WATCHDOG.yml`: `model: "@smol"` (a
string — the advisor schema drops an array), `tools: [read]`,
`maxNotesPerUpdate: 2`, and the full check battery in the shared top-level
`instructions`. The advisor is a critic, never a second trainer.

**Gate — a negative test, which is the only kind worth having here — is
DEFERRED, not passing.** Deliberately instruct the trainer to praise the user;
the gate passes when a `blocker` fires and the praise is retracted. A check that
has only ever passed is untested. The one attempt was inconclusive and the
baited form of the test is written up in `docs/advisor-gate-test.md`. **Run it
before trusting this phase.** `palimpsest doctor` asserts only the config side:
the key exists and holds exactly one entry.

**Cost:** 2 model calls per turn instead of 1. Routing the advisor to `@smol`
keeps the marginal cost low.

---

## Phase 3 — Memory-backed record

**Built, on memory-wire rather than `mnemopi`.** The gap the phase named was real
— a flat log cannot express that a claim was tested and *rejected* — but the
substrate changed under it: `mnemopi`'s first-class `veracity` field and the
whole weight/tier apparatus are gone. `src/memory.ts` is a `fetch()` client
against memory-wire, with no npm dependency.

Verdicts go in the payload in two places, because memory-wire has no `veracity`
field: a `verdict: <v>` line at the top of the content, and a `verdict:<v>` tag.
**The content line is load-bearing, not decoration** — retain dedups on a
byte-identical content hash and returns the id of the row that already holds it,
so a verdict living only in the tags would never move: settling a record from
`rejected` to `integrated` would dedup onto the existing row and that row would
keep saying `rejected`, silently. The mechanism and the "nothing is ever deleted"
property are documented once, in `docs/architecture.md` L3/L4; this line only
records *why the phase was restated*.

The flat log stays as a committed, auditable mirror. Two stores is cheaper than
losing the record to a config error. `memory.backend` stays off in omp's own
config; turning it on would add a second store omp manages itself, and it would
hand the trainer `learn` — see `docs/architecture.md` L1.

**Gate — restated, because the substrate cannot express the original.** The
original read "an `integrated` record promotes to episodic; a `rejected` record is
still retrievable with `veracity: 'false'`. Fails if rejection deletes." There is
no veracity and no episodic tier to assert against. What holds instead, and what
`tests/memory.test.ts` asserts against a real memory-wire on a scratch `--db`:

- a rejected record is retained with an id and **recalled back**, its content
  still leading with `verdict: rejected`;
- it is retrievable **by its `verdict:rejected` tag**, and invisible under a tag
  nothing carries;
- settling appends a second memory, the rejected row is untouched and still
  tagged, and re-retaining the same verdict is a no-op returning the same id;
- nothing is deleted: the bank's config carries **no `ttl_days`**, so "retained,
  never deleted" holds by construction. The "and degraded" half of the original
  wording is gone with the ladder — nothing degrades the loser automatically, so
  the `verdict:rejected` tag is the only thing telling a rejection apart from an
  acceptance at retrieval time.

That last one is the gate that matters. In the `mnemopi` implementation it was
the hard part — a working-memory trim hard-deleted unconsolidated rows after 24h.
Here it is the absence of a feature.

**Decided:** the backend is memory-wire, and memories are **project** scope — one
bank per project, derived from the session's `cwd`. Global scope is memory-wire's
`default` bank.

**Needs you:** nothing.

---

## Phase 4 — Verify consolidation actually compounds

**Premise gone; the gate restated in session terms.** The original gate was "after
N sessions, episodic memory contains claims that appear in no individual session
— i.e. synthesis happened, not just accumulation". memory-wire **removed its
consolidation ladder upstream**: promote/evict/retention had no scheduler and no
caller, so the code was deleted rather than left as decoration. There is no
episodic tier to inspect, so the original gate is not passable as written.

**Build:** nothing new. Run sessions over time and measure.

**Gate, in session terms:** the question the phase was really asking — "did my
mind actually change?" — is answerable from the sessions themselves, not from a
tier the store promotes into. After N sessions, a claim is synthesised when it
appears in **no single session transcript** and the user rules it `integrated`:
the trainer could not have retrieved it, so it came from recombination. Grade
that by hand, like `novelty`; there is no automated version, and an instrument
that grades itself is the failure mode this project exists to detect.

Until this gate passes, Phase 5 does not start.

**Needs you:** the sessions, and the grading. This is the phase where the
question "did my mind actually change" gets its first non-hand-wavy answer.

---

## Phase 5 — Write-back (deferred, gated on Phase 4)

`learn` accepts a `skill` payload and mints or enhances a managed `SKILL.md` in
the same call. Deliberately last: minting substrate before the trainer has
demonstrated novelty builds 801 affordances for a tutor.

---

## Sequencing rationale

Phase 3 depends on Phase 1: there must be a record to store. Phase 4 depends on 3
and on real usage. Phase 5 depends on Phase 4 passing. **That is the gate that
matters.** Everything before it is infrastructure whose only justification is what
Phase 4 measures.

## Cost and risk summary

| Phase | Model calls | Risk |
|---|---|---|
| 1 | unchanged | session-file parsing may be brittle — retired, asserted against fixtures |
| 2 | +1 per turn | advisor noise; mitigated by `maxNotesPerUpdate`. Negative test unrun |
| 3 | unchanged | a verdict can dedup onto the wrong row; mitigated by the verdict line in the content |
| 4 | unchanged | **the real risk: no measurable change in the user's mind** |
| 5 | unchanged | premature substrate growth |

The last row is the only one that cannot be engineered away.

## What is yours throughout

Grading every claim. `novelty` never auto-passes by design, because an instrument
that grades itself is the failure this project exists to catch. Every claim gets
ruled on as new, re-presentation, or not-my-language.

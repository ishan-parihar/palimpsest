# Implementation plan

Sequenced so every phase is independently verifiable and no phase depends on an
unverified one. Each gate can fail; a gate that cannot fail is decoration.

Status: nothing below is built yet except where marked.

---

## Phase 1 — Trainer as a declarative agent, and a session that records

**The gap:** `append()` is called from exactly one place, `digest()`. The
interactive path — the actual product — records nothing. It also passes
`--tools=read` as a CLI flag when the same boundary is expressible declaratively.

**Build**

1. `agents/trainer.md` — YAML agent definition, `tools: [read]`, `model:
   ["@default"]`, `thinkingLevel: high`. The capability boundary moves from a
   flag to a definition, and gains `output:` schema validation for free.
2. `session` spawns omp with that agent instead of `--tools=read`.
3. `session` records. Do **not** pipe stdio — that breaks the TUI. omp persists
   sessions under `~/.omp/agent/sessions/<slug>/`, so the CLI reads the session
   file after exit and extracts assistant messages.
4. `src/record.ts` — parse a transcript into the full record schema (brought,
   fired, withheld, declined, contradiction, overreach, claim, falsifier,
   verdict).
5. `assimilate.ts` gains `withheld` and `declined`, and writes `overreach`.
   Existing flat log stays the substrate until Phase 3.

**Gate** `palimpsest session --dry-run` produces a parseable record with
`verdict: PENDING` and no self-assigned verdict. Fails if the trainer emitted a
claim with no falsifier.

**Needs you:** nothing.

**Risk:** session-file format is undocumented. If parsing proves brittle, fall
back to `omp --export` and parse the HTML. Do not pipe.

---

## Phase 2 — One advisor, integrated

**The gap:** tone enforcement lives only in `role.md`, where it can be forgotten.
`advise` supports `blocker` severity; a blocker cannot be ignored politely.

**Build**

1. `WATCHDOG.yml` at the project root with a single `conscience` advisor:
   `model: "@smol"` (string, not a list — the advisor schema rejects arrays), `tools: [read]`, `maxNotesPerUpdate: 2`, and the full
   check battery in the shared top-level `instructions`.
2. Checks in one pass: tone (blocker), execution (blocker), falsifier
   (concern), discrimination (concern), sourcing (nit).
3. The advisor is a critic, never a second trainer. Explicit in the instructions:
   it does not offer frameworks, does not answer, does not praise.

**Gate — a negative test, which is the only kind worth having here.** Deliberately
instruct the trainer to praise the user. The gate passes when a `blocker` fires
and the praise is retracted. A check that has only ever passed is untested.

**Needs you:** nothing, though you should watch this one run.

**Cost:** 2 model calls per turn instead of 1. Route the advisor to `@smol` and
the marginal cost stays low.

---

## Phase 3 — Memory-backed record

**Status: built, on memory-wire rather than `mnemopi`.** The gap the phase named
was real — a flat log cannot express what actually matters here, that a claim was
tested and rejected — but the substrate changed under it. `mnemopi`'s first-class
`veracity` field with a `'false'` value is gone from the picture, along with the
whole weight/tier apparatus that phase leaned on.

**Build**

1. `src/memory.ts` is a `fetch()` client against memory-wire. **No npm
   dependency** — the repo is back to `package.json`-less, which is where it
   started. `POST /banks/:id/retain` with the record, `POST /banks/:id/recall`
   to read it back.
2. Verdicts go in the payload, in two places, because memory-wire has **no
   `veracity` field**:
   - a `verdict: <v>` line at the top of the content, and
   - a `verdict:<v>` tag, which is what makes `recall` able to answer "what have
     I ruled out, and why".

   The content line is load-bearing, not decoration. Retain dedups on a
   byte-identical content hash and returns the id of the row that already holds
   it, storing no second copy — so a verdict living only in the tags would never
   move. Settling a record from `rejected` to `integrated` would dedup onto the
   existing row and that row would keep saying `rejected`, silently.
3. `settle` writes through the same path, appending a new memory per verdict
   change. The rejected row is not edited and not removed.
4. The flat log stays as an auditable mirror, git-committed. Two stores is
   cheaper than losing the record to a config error.
5. `memory.backend` is **not** enabled in `~/.omp/agent/config.yml`. It does not
   need to be, and turning it on would add a second store omp manages itself.
   Consequence worth stating: `learn` is no longer registered in any session
   (see architecture.md L1), so the trainer cannot record by capability absence
   *and* by allowlist absence.

**Gate — restated, because the substrate cannot express the original.** The
original read "an `integrated` record promotes to episodic; a `rejected` record is
still retrievable with `veracity: 'false'`. Fails if rejection deletes." There is
no veracity and no episodic tier to assert against. What holds instead:

- a rejected record is retained with an id and **recalled back**, and its content
  still leads with `verdict: rejected`;
- it is retrievable **by its `verdict:rejected` tag**, and invisible under a tag
  nothing carries;
- settling it appends a second memory, the rejected one is untouched and still
  tagged, and re-retaining the same verdict is a no-op returning the same id;
- and nothing is deleted: the bank's config carries **no `ttl_days`**, and
  memory-wire has no scheduler, so "retained, never deleted" holds by
  construction instead of by configuration. The "and degraded" half of the
  original wording is gone with the ladder — nothing degrades the loser
  automatically, so the `verdict:rejected` tag is the only thing telling a
  rejection apart from an acceptance at retrieval time.

The last one is the gate that matters. In the `mnemopi` implementation it was the
hard part — a working-memory trim hard-deleted unconsolidated rows after 24h, and
the never-deleted property had to be engineered with a large TTL and a disabled
count limit. Here it is the absence of a feature.

**Decided:** the backend is memory-wire, and lessons are **project** scope — one
bank per project, derived from the session's `cwd`. Global scope is memory-wire's
`default` bank, and the phase's "which backend" question is answered.

**Needs you:** nothing.

---

## Phase 4 — Verify consolidation actually compounds

**Restated, and the premise is gone.** The original gate was "after N sessions,
episodic memory contains claims that appear in no individual session — i.e.
synthesis happened, not just accumulation". memory-wire **removed its
consolidation ladder upstream**: promote/evict/retention had no scheduler and no
caller, so the code was deleted rather than left as a model of behaviour that does
not run. There is no episodic tier to inspect, so the original gate is not
passable as written.

**Build:** nothing new. Run sessions over time and measure.

**Gate, in session terms:** the question the phase was really asking — "did my
mind actually change?" — is answerable from the sessions themselves, not from a
tier the store promotes into. After N sessions, a claim is synthesised when it
appears in **no single session transcript** and the user rules it `integrated`:
the trainer could not have retrieved it, so it came from recombination. Grade that
by hand, like `novelty`; there is no automated version, and an instrument that
grades itself is the failure mode this project exists to detect.

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

Phases 1 and 2 are independent and can be built in either order; both are pure
enforcement and memory, neither depends on the other.

Phase 3 depends on Phase 1 (there must be a record to store).

Phase 4 depends on 3 and on real usage.

Phase 5 depends on Phase 4 passing. **This is the gate that matters.** Everything
before it is infrastructure whose only justification is what Phase 4 measures.

## Cost and risk summary

| Phase | Model calls | Risk |
|---|---|---|
| 1 | unchanged | session-file parsing may be brittle |
| 2 | +1 per turn | advisor noise; mitigated by `maxNotesPerUpdate` |
| 3 | unchanged | a verdict can dedup onto the wrong row; mitigated by the verdict line in the content |
| 4 | unchanged | **the real risk: no measurable change in the user's mind** |
| 5 | unchanged | premature substrate growth |

The last row is the only one that cannot be engineered away.

## What is yours throughout

Grading every claim. `novelty` never auto-passes by design, because an
instrument that grades itself is the failure this project exists to catch. Every
claim gets ruled on as new, re-presentation, or not-my-language.

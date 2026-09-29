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
   `model: ["@smol"]`, `tools: [read]`, `maxNotesPerUpdate: 2`, and the full
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

**The gap:** a flat log cannot express what actually matters here — that a claim
was tested and rejected. `mnemopi` has `veracity` as a first-class field with a
`'false'` value and an `importance` weight, plus a degradation query.

**Build**

1. Enable `autolearn.enabled` and a memory backend (`mnemopi`).
2. `src/record.ts` writes through mnemopi instead of the flat log. Verdicts map
   to veracity: `integrated` → high importance; `rejected` → `veracity: 'false'`,
   **retained and degraded, never deleted**; `not-my-language` → `veracity:
   'inferred'`, low importance.
3. `settle` writes through the same path.
4. The flat log stays as an auditable mirror, git-committed. Two stores is
   cheaper than losing the record to a config error.

**Gate:** an `integrated` record promotes to episodic; a `rejected` record is
still retrievable with `veracity: 'false'`. Fails if rejection deletes.

**Needs you:** one decision — which memory backend, and whether lessons are
project or global scope. Global scope requires `mnemopi`.

---

## Phase 4 — Verify consolidation actually compounds

**The gap:** consolidation is the exponential and it is entirely unverified. It
could be plumbing that does nothing.

**Build:** nothing new. Run sessions over time and measure.

**Gate:** after N sessions, episodic memory contains claims that appear in no
individual session — i.e. synthesis happened, not just accumulation. Until this
gate passes, Phase 5 does not start.

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
| 3 | unchanged | two stores can drift; flat log is the mirror |
| 4 | unchanged | **the real risk: no measurable change in the user's mind** |
| 5 | unchanged | premature substrate growth |

The last row is the only one that cannot be engineered away.

## What is yours throughout

Grading every claim. `novelty` never auto-passes by design, because an
instrument that grades itself is the failure this project exists to catch. Every
claim gets ruled on as new, re-presentation, or not-my-language.

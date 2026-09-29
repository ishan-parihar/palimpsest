# Phase-1 findings

The acceptance gate for the digestive substrate. A claim is only accepted here if
a check could have failed it.

## Instrument history

The first three falsifier runs reported PASS on all checks. **Those results were
vacuous** and are recorded here as such, because the way they were obtained is
the more useful finding.

`--append-system-prompt` is last-wins, not additive. Proven with a two-file
repro: passing `a.md` then `b.md` returned only `FILE-BETA-MARKER`. Every
falsifier run passed `['role', 'falsify']`, so `role.md` was silently dropped and
the trainer ran with no role contract whatsoever. All three checks passed anyway,
because each one greps for a marker (`[COMMIT-POINT]`, `[CONTRADICTION]`,
`[CLAIM]`) rather than for the presence of the protocol that produces those
markers. A default coding assistant emits `[COMMIT-POINT]`-shaped text when told
to demand a read.

**Lesson recorded as a rule:** a check that greps for a token cannot detect the
absence of the instructions that produce the token. Structural absence has to be
tested structurally. All three checks now treat an empty transcript as a harness
fault, so a silent failure can never read as a pass.

The bench caught this where the falsifier could not, because bench measures
behaviour (`[TOUCH]` nodes touched, contradictions found) rather than the
presence of a marker.

## Second harness bug

The first bench run returned all zeros for every input. Two candidate causes:
CPU contention, or a missing protocol. It was the latter, twice over.

1. `bench` passed raw catalyst with no instruction to digest. `role.md`
   describes the *interactive* pose/demand/release loop and only *refers* to
   `digest.md`, so `[TOUCH]` and `[CLAIM]` were never requested.
2. CPU contention was real and independently confirmed — load average 30-62
   during a later run — but it was not the cause of the zeros. Attributing a
   code fault to the environment is the specific error this project is built to
   avoid, and it happened here anyway.

Both are fixed: `mergedTrainer()` concatenates the protocol files into one
prompt, and `bench` now issues an explicit digestion instruction.

## Verified working

Single input, `08-parser-anchored-on-metadata.md`, after the fix:

| Measure | Value |
|---|---|
| Converged to a claim | 1/1 |
| Converged to exactly one claim | 1/1 (no sprawl) |
| Contact surface | 7 nodes |
| Contradictions | 1 |
| Clusters | **unmeasured — `measure()` had a broken cluster regex, see below** |
| Wall clock | 153s under load average 30-62 |

The claim produced:

> A card is what its Tier line declares, not what its heading level suggests:
> census instruments must anchor on the invariant the producer counts (Tier
> metadata, verified against the registry's 801) rather than on presentation
> convention (H1/H2) that was never promised.

### Honest reading of that claim

**It is largely a re-presentation.** The catalyst already stated that the fix was
to anchor on Tier metadata; the claim restates it in more confident language. It
does add a transferable framing — *anchor on the invariant the producer counts,
not on a presentation convention never promised* — but the actionable content was
in the input. On the first real test, the instrument produced a polished
restatement. That is the failure mode `novelty` exists to catch, and it is
working.

**The one contradiction found is unadjudicated.** This catalyst was a genuine
defect writeup rather than settled doctrine, so a contradiction may be
legitimate. One input cannot establish a rate. The `contradiction` check only
passes on material explicitly declared settled; this was not.

## Open

- `measure()` cluster detection is broken: it reports 0 clusters on output that
  demonstrably spans multiple domains. Until fixed, `SINGLE-CLUSTER` is a
  measurement artefact and must not be read as a trainer finding.
- The 10-input run was not completed. It was replaced by a single-input
  verification of the fix, which is the load-bearing question. `omp -p` costs
  ~150s per call under load, so a 10-call run is a quiet-machine activity.
- **Novelty grading is the user's and cannot be automated.** Every claim must be
  ruled on as new, re-presentation, or not-my-language by the person whose mind
  is being trained. No count of passing checks substitutes for it.

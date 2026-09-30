# AGENTS.md

## What this repo is

A trainer for one mind. The AI poses and probes; the user digests. Anything that
moves the work from the user's head into the model's output is a regression, even
when it produces a better-looking answer.

## Rules

1. **The trainer contract is the product.** `trainer/role.md` outranks every other
   consideration here. The launcher is plumbing. Do not grow the launcher to
   solve a problem the contract should solve.
2. **Never add praise.** No "correct", "sharp", "good catch", no affirmation of
   the user's answer. The atlas names its own failure mode: *fluent use of a tool
   that no longer fits*. Praise is how that stays invisible.
3. **Commitment before disclosure.** No framework may be named before the user
   has made a substantive reply. This is enforced by the `withhold` check, and it
   is the difference between generation and recognition.
4. **A gate that cannot fail is decoration.** Any new check must be able to fail,
   and a change to `trainer/` must re-run `palimpsest falsify` before it lands.
   Deterministic string checks only — never the trainer's self-report.
5. **The verdict belongs to the user.** `user-verdict` is never set by the model.
   No scores, no levels passed, no "you are improving." A progress feeling is the
   thing this system exists to prevent.
6. **Width in, one claim out.** The ≤3 cap governs output width, not processing
   breadth. Map the whole contact surface, then converge. A surface map with three
   "and also" clauses is a failed digestion.
7. **The atlas is read-only.** `~/.agents/skills/mental-model-atlas` is developed
   and audited on its own terms. Fix it there, not here.
8. **`src/omp.ts` is the only place that spawns omp.** Every invocation keeps
   `--tools=read --no-rules --no-skills`. Capability absence is what makes the
   trainer a trainer; do not widen it without a falsifier check proving the
   widening is safe.

## Invariants the tests hold

- Atlas index matches the atlas's own counts: 801 cards, 191 / 256 / 354 by tier.
- Every tier-1 card declares at least one primitive, or it cannot propagate.
- Propagation from one seed reaches over half of tier-1 in two hops.
- Every file in `trainer/` is reachable — either appended by `src/`, or named in
  `role.md` for the trainer to read at runtime. A file in neither is dead weight
  that looks load-bearing.

## Commands

```bash
bun test                     # every assertion can fail
palimpsest falsify all       # the acceptance gate; costs 3 model calls
palimpsest atlas             # 801 cards, 33 primitives, 39 families
```

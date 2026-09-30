# What is left

State as of `5edb2f6`: 136 pass / 0 fail, tree clean, daemon live on
127.0.0.1:18899, bank holds 1 row, log holds 0 entries. Everything below is
ordered — each item unblocks the ones after it. Nothing here needs inventing;
all of it is verification, usage, or deferred-by-design work.

## 1. Advisor dispatch probe — 1 model call, agent

The negative test proved the trainer refuses affirmation twice, unassisted —
but the advisor never called its model (0 input, 0 output, one
`advisor_yielded` frame). Unknown: WATCHDOG roster failing to load vs. review
dispatch short-circuiting.

- Do: one baited rpc run with `--session-dir` at `/tmp` (drop `--no-session`),
  then read whether the roster built. Driver exists at `/tmp/negtest.ts`.
- Gate: the probe names discovery or dispatch, with frame evidence.
- Owner: agent. Cost: 1 call. Blocked by: nothing.

## 2. Advisor negative test, for real — 2–3 model calls, agent

Rerun the baited rpc once dispatch works.

- Gate: `<advisory severity="blocker">` on a pressured affirmation, plus a
  retraction — raw frames kept. Until then the gate stays decoration, as
  WATCHDOG.yml already admits.
- Owner: agent. Cost: 2–3 calls. Blocked by: item 1.

## 3. First real sessions — user

The log is 0 bytes; every loop-level guarantee is fixture-tested, none is
user-tested. Run `palimpsest`, train, close cleanly, check `state`.

- Gate: log holds entries, ledger holds the transcript, bank holds matching
  rows with verdict tags, `doctor` reconcile line passes.
- Owner: user. Cost: time and attention. Blocked by: nothing.

## 4. Novelty rulings — user, ongoing

Every claim waits on a verdict: new, re-presentation, or not-my-language.
The system is inert without rulings — that is the design, not a gap, but it
belongs on this list so it is never mistaken for automation debt.

- Gate: no PENDING older than one session. Owner: user. Blocked by: item 3.

## 5. Falsify live re-run — agent, idle box only

`withhold` and `contradiction` baselines predate the digest-key additions.
One `falsify` run on a quiet box re-pins them. Do not run above load 20 —
the last attempt exceeded 10 minutes and proved nothing.

- Gate: withhold PASS, contradiction PASS, table updated. Cost: 3 calls.

## 6. Orphan bank row — user decision, agent executes

One row (`ece95a20…`, falsify-fixture content, PENDING) exists in the bank
with no log entry behind it and no command that can reach it. Options:
(a) leave it, documented; (b) DELETE by id. It is test artifact, not
assimilation — my recommendation is (b).

- Gate: `doctor reconcile` passes with log and bank in agreement.

## 7. Phase 4 measurement — time + usage

After sessions accumulate: does later retrieval build on earlier verdicts?
The store has no ladder, so this is measured in sessions, not inspected in
tiers. No code until the question is answerable.

- Gate: a synthesis no single session contains. Owner: user + time.

## 8. Phase 5 write-back — deferred, gated on 7

Nothing learned flows back into the atlas. Deliberately last: substrate
growth before demonstrated novelty is 801 affordances for a tutor.

## 9. Content gap — atlas-side, large

616 of 801 cards have no `Digest` field; only tier-1 is wired. Propagation
covers it structurally, but T2/T3 digests are thinner than they should be.
This is the biggest known quality lever and it lives outside this repo.

## 10. Latency — structural, priced

2–5 minutes per model call; the advisor doubles per-turn cost. Fit for
deliberate practice, not for flow. No action until items 1–3 are done;
optimizing the speed of an unverified loop is waste.

## 11. One-line honesties — agent, minutes, no calls

- `src/omp.ts` header says "no extensions"; autoresearch widget frames prove
  otherwise. Roster is still `["read"]`, so the boundary holds — the comment
  should say exactly that.
- `docs/advisor-gate-test.md` deferral note should cite the dispatch probe
  (item 1) as the current question, not the tool surface (closed).

## Explicitly not on this list

- A second advisor. One runtime, one cost — decided and holding.
- mnemopi. Built, tested, deleted for cause; not to be revisited without new
  evidence.
- Scoring, levels, streaks, praise. Refused by design, enforced by blocker.
- Generated exercises. The conversation is the catalyst.

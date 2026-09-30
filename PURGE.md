# Purge report

An audit of `palimpsest` for over-engineering and redundancy, and what was
removed. **Final: `bun test` 108 pass, 0 fail, 468 assertions, 10 files** — the
same 108 tests as before the purge. No gate was deleted, skipped, or weakened.

Net: **252 lines deleted, 160 added** across 13 files, plus one new doc. Most of the deleted mass
is documentation that stated the same claim more than once; the code deletions
are small because the code was mostly already single-owner.

## Deleted

### Code

| What | Where | Why it was safe to remove |
|---|---|---|
| `readLatestSession(cwd)` | `src/session-read.ts` | **0 src callers.** A two-line wrapper over `readLatest(cwd)?.messages`; its only users were five test call sites, which now read `readLatest(x)!.messages`. Mutation M1 below proves the collapse changed no behaviour, so the wrapper held no coverage of its own. |
| local `field()` in `digest()` | `src/cli.ts` | A byte-identical copy of `src/record.ts`'s `field()` — same regex, same `trim()`. `record.ts` now exports it and `cli.ts` calls it. One regex for `[ASSIMILATION]` block fields. |
| `slug()` vs `assimilate`'s `one()` | attempted, **reverted** | See "Deliberate keeps" below — the test blocked it, so the merge was wrong. |
| `export async function all()` | `src/audit.ts` | **0 callers anywhere**, and it was the only function in the repo with no test. `falsify` composes the suite itself; the three checks it would have called are each covered directly. |
| `export` on `trainerPath()` | `src/omp.ts` | 0 importers outside its own file. |
| `export` on `markConsumed()` | `src/record-session.ts` | 0 importers outside its own file, and the ledger should have exactly one writer: marking a transcript consumed is only correct *after* the bank, empty and duplicate checks have all passed, which is `recordTranscript`'s job. |
| `export` on `latestFile()` | `src/session-read.ts` | 0 importers outside its own file; only `latestEvents()` picks the file. |

### Documentation

| What | Where | Why |
|---|---|---|
| 78-line comment header | `WATCHDOG.yml` → `docs/advisor-gate-test.md` | A config file whose first 78 lines were a procedure with no config in it. Every fact moved, plus the parts that were scattered: discovery order, the string-`model` schema trap, the one-advisor rationale. **The advisor body is byte-identical** (verified by diff; the only removed non-comment line is a blank one), and `palimpsest doctor` on the real file still reports `exactly one advisor (conscience), tools: [read]`. |
| Phase 1/2/3 build lists | `docs/plan.md` (197 → 155 lines) | Phases that are already built, with a plan-of-record. `git log` carries them. The *status*, the *risks* and the restated Phase-3 gate stayed — those are facts about what shipped, and the Phase-3 gate is not recorded anywhere else. |
| the omp auto-include restatement | `README.md` | Stated in full three times (README, `docs/architecture.md` L1, `docs/omp-notes.md`) with the same `tools/index.ts` line numbers. `docs/architecture.md` keeps the full mechanism, the code excerpt, and the residual risk; README now states the conclusion and points. `omp-notes.md` keeps its own value — the `file:line` table for the auto-include block. |

### Drift fixed (same claim, two or three places, disagreeing)

These were live contradictions, not stylistic overlaps:

- **`docs/architecture.md`'s gate table claimed a working "advisor tone" gate**
  ("the trainer praised and no blocker fired") while the advisor config said
  `GATE STATUS: DEFERRED, not passing`. The row now says DEFERRED and points at
  `docs/advisor-gate-test.md`, and a separate `advisor count` row was added for
  the check that *does* run. The same status note was added to architecture.md's
  L2 section.
- **`README.md` header said "10 clusters"**; `docs/architecture.md` and `AGENTS.md`
  both said 39 families. Verified against the real index: 801 cards, 33
  primitives, **39 families**. Fixed to 39.
- **`README.md` documented a `SINGLE-CLUSTER` pathology** that the code does not
  emit — `src/cli.ts` emits `SINGLE-FAMILY`. Fixed.
- **`README.md` numbered the roadmap wrong**: it called write-back "Phase 2" and
  always-on "Phase 3", while `docs/plan.md` calls write-back Phase 5 and has no
  Phase 3 for always-on. The README now uses plan.md's numbering, and gained the
  missing Phase 4 (verify it compounds) that the plan has and the README omitted.
- **`AGENTS.md` claimed `bun test` was "14 assertions"** — it is 468. Replaced
  with `every assertion can fail`, which is the claim that matters and cannot
  drift.

## Deliberate keeps

Each of these looked like a duplication and is not. In every case the collapse
would have changed behaviour or cost a seam the tests need.

| What | Why it stays |
|---|---|
| **`slug()` in cli.ts vs `one()` in assimilate.format** | These are not duplicates, they are **two different policies for the same field**. `slug` caps a one-shot digest's catalyst, because a whole document is a poor `## <date> · <x>` header. A session's `brought` is the user's first turn and is written whole. I moved the cap into `format()` (after proving `slice(0, 80)` and collapse-if-longer are bit-identical over 50 000 random strings) — and `tests/record.test.ts` went red, because the round trip then truncated a session's catalyst in the only committed store. The test was right, so the merge was reverted. Both sites now carry the reason inline. **This is the one place the two owners are genuinely different.** |
| **`latestEvents()` and `readLatest()`** | Two *views* of one parse, with different callers: `trace` needs the tool calls and plumbing `readLatest` drops; the recorder needs only the conversation turns. `readEvents()` stays the single JSONL parser, so the format facts are documented once. Three accessors were reduced to two. |
| **`persist()` in cli.ts, `persistRecord` in memory.ts, `append` in assimilate.ts** | Three different stores, each a distinct failure domain. `append` is the committed log and never fails; `persist` is the never-throws memory mirror (the log is the committed mirror, so a store failure must not cost the assimilation — but it is reported, because silence there is indistinguishable from a record that was never used); `persistRecord` is the HTTP client and throws, which is what makes `persist`'s try/catch the right owner of the decision to swallow. Merging them would make the log's durability depend on the store's reachability. |
| **`consumed.json` ledger *and* memory-wire dedup** | Both are load-bearing, and the ledger is deliberately keyed on `(file, sessionId)` — the transcript path — while dedup is a whole-bank content-hash comparison. Deleting the ledger would mean a re-run appended the same session twice to the append-only log *before* the store was asked, and the log is the committed mirror. The cost of keeping both is one `state/consumed.json`; the cost of dropping the ledger is a log that over-claims how many sessions ever ran. `tests/settle.test.ts` asserts the ledger guards the committed path (S9, S13, S15). |
| **`trajectory.ts` vs `audit.measure()`** | **Complementary, not overlapping.** `measure()` runs on one-shot stdout and counts markers; it cannot see a tool call or a turn boundary. `trajectory` runs on a JSONL transcript and is the only thing that can see a `toolCall` block, a `toolResult` role, or a marker split across turns. `record.ts` is also not redundant with either: it takes the *first* block of each marker and cannot see ordering, which is exactly the gap `trajectory` exists to close. Three different inputs, three different jobs, one shared parser underneath. |
| **`leakSignatures()` in audit.ts vs trajectory.ts** | Same name, deliberately not shared. `audit`'s returns 3-word prefixes (`[a-z]+ [a-z]+ [a-z]+`, length ≥ 10, must contain a space) so casual naming trips it; `trajectory`'s returns full hyphen-normalised card names, longest first, filtered to length ≥ 8 so a short name cannot fire inside a word. Merging them would weaken whichever check lost. The name collision is a readability hazard worth knowing about. |
| **Three copies of the `real()` realpath shim and two of `capture()`** across `tests/`. | Extracting a `tests/helpers.ts` saves ~25 lines and adds a module plus imports to five files. The shims are 5 and 11 lines, they are per-file scoped by accident not by design, and a shared test helper is a seam a future edit will quietly grow. Not worth a new file. |
| **`tests/session-read.test.ts`'s inline transcript builder** | Looks like it duplicates `tests/fixtures/sessions/golden-session.jsonl`, and it cannot use the fixture: the test must place the transcript in a temp bucket **under the real home** (`os.homedir()` ignores `$HOME` in Bun, so a fake home sends every lookup back to the real account and the test passes vacuously). It also carries adversarial features the committed fixtures do not: a `PRIVATE-TOOLCALL` argument, a bare `toolResult`-role turn, an older sibling session, and a sibling artifact directory. Different seam, different attacks. |
| **`tests/fixtures/catalysts/`** | Referenced by no test — consumed by the documented `palimpsest bench tests/fixtures/catalysts` in its own README. Deleting it breaks a real affordance, and its README explains why the other five phase-1 catalysts are deliberately *not* copied in (they already live in their source repos, and copies would drift). |
| **`recall()` and `listMemories()` in memory.ts** | `recall` is relevance-ranked, so a stored row you cannot match is invisible to it; `listMemories` is the custody route. `doctor` needs custody, not relevance. Different questions about the same bank. |
| **Type-only exports** (`Check`, `Flow`, `Step`, `Divergence`, `MemoryRow`, `RecallHit`, `RunOpts`, `TrainerAgent`, `DoctorOpts`, `TranscriptDeps`, `TranscriptOutcome`, `SessionEvent`…) | A named type in a public signature is documentation, not dead code. All are used in their own module's exported signatures. |

## Where the coverage went — mutation-verified, not asserted

No test file was deleted, so the question is whether the removed code's coverage
survived. Rather than argue it, I mutated:

| Mutation | Expected | Actual |
|---|---|---|
| **M1** — re-add `readLatestSession` (i.e. undo the deletion) | tests unaffected: the wrapper was a pass-through and held no coverage | **108 pass, 0 fail** ✓ |
| **M2** — re-inline `field()` locally in `record.ts` (undo the sharing) | tests unaffected: sharing changed no behaviour | **108 pass, 0 fail** ✓ |
| **M3** — break the now-shared `field()` owner | tests must fail, proving the shared owner is exercised and the dedup is not an untested pass-through | **105 pass, 3 fail** ✓ — `the [ASSIMILATION] block wins over scattered markers`, `a trainer-supplied date is validated…`, `a real date is kept verbatim…` |

M1 and M2 together establish the refactor is behaviour-preserving; M3
establishs the consolidated owner is still gated. The purge made the tests
slightly *stronger*, because the `field` regex now has one owner and breaking it
is caught by name.

## Untouched, as required

`agents/`, `trainer/`, `config/locked-down.yml`, `state/` (including
`assimilation.log`), and `tests/fixtures/` are all byte-identical to `HEAD`. In
`WATCHDOG.yml` only comment lines were removed — the advisor body diffs clean.
`src/record.ts`'s `Record` type is unchanged. `src/cli.ts`'s command cases and
usage string are unchanged. No dependency added. No daemon started, no bank
written, no live omp call made, nothing committed.

## The standard, restated

The repo now has one owner per derivation:

- **one parser** for the transcript JSONL — `session-read.readEvents`
- **one record parser** — `record.parse`, with the block-field regex shared rather
  than copied
- **one writer per store** — the committed log, the memory mirror, and the HTTP
  client, each failing (or not) on its own terms
- **one verdict writer** — `assimilate.settle`; the trainer's `user-verdict` line
  is read by nobody, in any of the three parsers

What is left that looks like duplication is mostly a **policy difference** rather
than a second implementation. `slug` is the clearest case: two owners, two
different rules, and a test that says so.

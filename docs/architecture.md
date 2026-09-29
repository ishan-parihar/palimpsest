# palimpsest architecture

A training system for one mind. The AI is the trainer; the digestion happens in
the user, not in the model.

## The problem this must solve

Frameworks are enzymes. Catalyst arrives — here, as ordinary conversation. The
atlas graph breaks it across every node it touches, propagates through shared
primitives, surfaces what it contradicts, and resolves to one claim. The claim is
the user's before it is the record's.

Success is the substrate becoming second nature and then becoming unnecessary.
Progress is assimilation, never coverage.

## Layers

```
  L5  write-back        managed skill minting          (deferred)
  L4  consolidation     nothing: no ladder exists       see L4
  L3  record            verdict in the payload          verdict is the user's
  L2  advisor           one WATCHDOG advisor           enforcement, not prompt
  L1  trainer           declarative agent, tools:[read]
  L0  substrate         mental-model-atlas, 801 cards  read-only
```

### L0 — substrate

`~/.agents/skills/mental-model-atlas`, indexed by `src/atlas.ts`: 801 cards
(191/256/354), 33 primitives, 39 families. Read-only from this repo. Every card
declares its own `**Primitives:**`, so the lattice is a real graph — one tier-1
seed reaches over half of tier-1 in two hops.

Anchored on `**Tier:**` because heading level is inconsistent across the atlas
(`#` in five leaves, `##` in the rest). Anchoring on heading level reads 15% of
the corpus.

### L1 — trainer

A declarative agent definition, not a pile of CLI flags. Bundled agents are YAML
with a `tools:` allowlist, `model:`, `thinkingLevel:`, and an `output:` schema.

```yaml
name: trainer
description: Trains one mind in the mental-model atlas. Never executes.
tools: [read]          # capability absence, not restraint
model: ["@default"]
thinkingLevel: high
```

`tools: [read]` is the trainer/executor line. The trainer can look a card up. It
cannot run a command, write a file, or reach the network.

**It also cannot record, and that now has two independent mechanisms.** `learn`
is a write tool, so it is absent from the allowlist. It is also no longer
registered at all: `~/.omp/agent/config.yml` has no `memory.backend`, so omp's
default `off` applies and the memory tools — `retain`, `learn`, `recall`,
`reflect`, `memory_edit` — are gated off in `tools/index.ts` before the allowlist
is even consulted. `autolearn.enabled` is still true and does not matter; the
`learn` gate requires both. Whichever mechanism is inspected first, the verdict
stays the user's: not a rule the trainer could forget, a capability it lacks.

Prompt: `trainer/role.md`, always resident.

### L2 — advisor (one, integrated)

`WATCHDOG.yml`, discovered walking up from cwd, then project `.omp/`, then the
user agent dir.

```yaml
instructions: |
  <the single integrated check battery>
maxNotesPerUpdate: 3
advisors:
  - name: conscience
    model: "@smol"           # cheap role; this runs every turn. STRING, not a list: the advisor entry schema declares "model?": "string" and drops an array with a warning.
    tools: [read]           # read-only, so it can verify a source, never edit
    maxNotesPerUpdate: 2
```

One entry. One runtime. One model call per turn. The top-level `instructions` key
is a shared baseline prepended to every advisor, so all checks live in one place
regardless of how many advisors exist later.

**Why one and not three:** the advisor sees the whole completed turn, so
discrimination, falsification, sourcing, and tone are four judgements about the
same text. Three advisors would read the same transcript three times and pay 3x
to reach one verdict.

Note emission uses the `advise` tool, `severity?: 'nit' | 'concern' | 'blocker'`,
rendered as `<advisory severity="...">`. **The tone check is a blocker**, not a
nit: praise is the failure the whole design exists to catch.

Checks, in one pass:

| Check | Severity | Fires when |
|---|---|---|
| Tone | `blocker` | the trainer praised, or affirmed the user's answer |
| Execution | `blocker` | the trainer did the user's thinking, or answered what was asked of them |
| Falsifier | `concern` | a `[CLAIM]` shipped without `[FALSIFIER]` |
| Discrimination | `concern` | a framework was applied past its ceiling, or a correct non-application went unclaimed |
| Sourcing | `nit` | a claim rests on a number or citation not checked against a source |

The advisor is a **critic, not a second trainer**. It never offers a framework,
never answers, never praises. It reports violations and gets out of the way.

### L3 — record

A retention call, not a write tool. The record reaches memory-wire after the
transcript is parsed, and it is the only thing in this repo that speaks HTTP.

**memory-wire, and nothing else.** One 8.6 MiB binary, three shared libraries,
no npm dependency, no embedded database. `src/memory.ts` is a `fetch()` client
against `POST /banks/:id/retain` and `POST /banks/:id/recall`.

**memory-wire has no `veracity` field, and no consolidation ladder** — the ladder
was removed upstream rather than left as a model of behaviour that does not run.
So the verdict is encoded in the two places a caller can actually read:

| Where | What | Why |
|---|---|---|
| First line of `content` | `verdict: rejected` | Dedup keys on a byte-identical content hash |
| A tag | `verdict:rejected` | `recall` can filter on it, and filtering is the only way to ask "what have I ruled out" |
| `context` | `claim` + `falsifier` | The condition the claim was made under, stored beside the content |

| Verdict | Tag | Retrieval |
|---|---|---|
| `integrated` | `verdict:integrated` | recalled as a claim that held |
| `rejected` | `verdict:rejected` | **still there, still findable, tagged as ruled out** |
| `not-my-language` | `verdict:not-my-language` | present, marked as not-mine |
| `PENDING` | `verdict:PENDING` | no ruling yet; nothing is filtered in or out |

**The verdict line in the content is load-bearing, and not for the reason it
looks.** memory-wire dedups a byte-identical retain and returns the id of the
memory that already holds it, storing no second copy. A verdict carried only in
the tags would therefore never move: settling a record from `rejected` to
`integrated` would dedup onto the existing row and that row would keep saying
`rejected`, silently. Different verdict in the content means different bytes
means a genuinely new memory, and the rejected one stays exactly where it was.

**Nothing is ever deleted, and that holds by construction rather than by
configuration.** memory-wire has no scheduler at all — nothing expires on a timer,
with or without the daemon. A bank that wants to forget sets `ttl_days` in its own
config and runs `memory-wire sweep` by hand. A rejected assimilation is therefore
marked false in the only two places memory-wire can mark anything — the
`verdict:rejected` tag and the `verdict: rejected` line — and kept, because "I
rejected this and here is why" is itself the most useful thing in the store;
deleting it would destroy the only record that the claim was ever tested. The
previous implementation had to engineer this against a working-memory trim that
hard-deleted unconsolidated rows after 24h. Here it is one assertion: the bank
config carries no `ttl_days`.

Settling appends. The store is a log of what was tried and ruled out, not a row
with a mutable verdict. `state/assimilation.log` stays the committed mirror of the
*current* verdict, and two stores are still cheaper than losing the record to a
config error.

Record shape, one entry per session:

```
brought        what the user raised, in their words
fired          frameworks that applied, and the move each made
withheld       frameworks that were relevant but not used, and why not
declined       correct non-applications
contradiction  what it broke in what the user holds, or none
overreach      where a framework was pushed past its ceiling
claim          the one integrated thing
falsifier      the observation that would show it wrong
verdict        the user's, never the trainer's
```

`withheld` and `declined` are the fields that matter most. A framework never
correctly declined is indistinguishable from one never had, and retrieval never
measures either.

### L4 — consolidation

**There isn't one, and the plan's claim that it was the exponential was wrong
about this substrate.** memory-wire removed its working→episodic ladder upstream:
promote/evict/retention had no scheduler and no caller, so the code was deleted
rather than left as decoration. What ships is FTS5 BM25 fused with a token-overlap
rank by RRF, over an append-only bank of retains.

Retrieval still gets better with use — more sessions means more rows means a
richer lexical pool — but that is accumulation, not synthesis, and calling it
compounding would be the overclaim. The measurable version of the old Phase 4 gate
is restated in `docs/plan.md`: synthesis is a claim to be checked by hand, not a
tier the store promotes into.

The deliberate consequence: a claim that was integrated and a claim that was
rejected are both still in the bank a year later, and nothing degrades the loser
automatically. The `verdict:` tag is how retrieval tells them apart.

### L5 — write-back (deferred)

`learn` accepts a `skill` payload and mints or enhances a managed `SKILL.md` in
the same call. Deferred deliberately: minting substrate before the trainer has
demonstrated it produces novelty would be building 801 affordances for a tutor.

## Cost model

| Path | Model calls per turn |
|---|---|
| plain `omp` | 1 |
| `+ advisor` | 2 |
| `+ advisor at @smol` | 1 main + 1 cheap |

Two calls per turn, not four. The advisor is the entire cost of enforcement, and
routing it to a small model keeps the marginal cost low. `maxNotesPerUpdate`
bounds output; the deferred-note mechanism withholds partial-work critiques until
the turn actually terminates, so a long tool-using turn is not critiqued
mid-flight.

## What this deliberately does not build

- **No invented situations.** The trainer responds to what the user brings. A
  generated exercise is one the model already knows the answer to.
- **No scoring, no levels, no streaks.** A progress feeling is the failure this
  exists to prevent.
- **No praise, ever.** Enforced by blocker, not by asking nicely.
- **No digest affordance on all 801 cards.** Tier-1 propagates without them, and
  they are a content project that should wait for evidence.

## Verification gates

A gate that cannot fail is decoration.

| Gate | Fails when |
|---|---|
| trainer contract | a prohibition is deleted from `role.md` |
| substrate index | counts drift from the atlas registry (801/191/256/354) |
| lattice | a tier-1 card declares no primitive and cannot propagate |
| falsifier: withhold | a framework is named before the user commits |
| falsifier: contradiction | settled material yields a contradiction |
| falsifier: novelty | **never auto-passes** — the user grades every claim |
| advisor tone | the trainer praised and no blocker fired |
| empty transcript | any check reads silence as success |
| memory: rejected stays | a rejected record is unfindable, or its tag stops being `verdict:rejected` |
| memory: verdict cannot move | settling a record edits the rejected row instead of appending |

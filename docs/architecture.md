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
  L4  consolidation     mnemopi working->episodic      L4 is the exponential
  L3  record            learn + veracity weighting     verdict is the user's
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

**It also cannot record.** `learn` is a write tool, so it is absent from the
allowlist. The trainer physically cannot write to memory. Verdicts are therefore
structurally the user's — not a rule it could forget, a capability it lacks.

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
    model: ["@smol"]        # cheap role; this runs every turn
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

`learn`, gated behind `autolearn.enabled` plus a memory backend. Not a flat log
file — a veracity-weighted store with a real degradation path.

Verdicts map onto `veracity`, which `mnemopi` already tracks as a first-class
field with values including `'false'`:

| Verdict | Effect |
|---|---|
| `integrated` | high `importance`, promoted to episodic on age |
| `rejected` | `veracity: 'false'` — retained and degraded, never deleted |
| `not-my-language` | `veracity: 'inferred'`, low `importance` |
| `PENDING` | working tier, awaiting the user |

A rejected assimilation is marked false, not removed, because "I rejected this
and here is why" is itself the most useful thing in the store. Deleting it would
destroy the only record that the claim was ever tested.

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

`mnemopi` age-gated working→episodic promotion with episode summarisation,
veracity weighting, and fact extraction. **This is the exponential**, and it is
not something to build: connected nodes process a catalyst in ways a flat list
cannot, and consolidation compounds that across sessions.

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

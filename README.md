# palimpsest

A training system for one mind. The AI is the trainer; the digestion happens in
you, not in the model.

Built on [`omp`](https://github.com/can1357/oh-my-pi) (v18.3.1) as the engine, with
[`mental-model-atlas`][atlas] as the enzyme set: 801 cards, 33 primitives, 10
clusters.

[atlas]: https://github.com/ishan-parihar/mental-model-atlas

## The idea

Frameworks are enzymes. Catalyst arrives — a document, a thread, a failure, a
decision you are sitting with. The atlas graph breaks it across every node it
touches, propagates through the shared primitives, surfaces what it contradicts
in what you already hold, and resolves to **one** claim. That claim is yours
before it is the record's.

The growth is not coverage. It is that the substrate becomes second nature and
then becomes unnecessary. Progress is assimilation, never a percentage.

## Commands

```bash
palimpsest                          # open the session (omp TUI, trainer active)
palimpsest digest <file|->          # one-shot digestion; records to the log
palimpsest falsify [check]          # run the acceptance gate
palimpsest state                    # assimilation summary
palimpsest settle <verdict>         # mark the last entry integrated|rejected|not-my-language
palimpsest atlas [query]            # search the card index
palimpsest propagate "<card>" <hops> # walk the primitive lattice
```

## The one mechanic

**Commitment before disclosure.** If you read the framework before reasoning,
you do recognition, not generation. Recognition feels exactly like possession and
is worth almost nothing. So the trainer poses, demands your read, waits, and only
then releases. It never praises: praise rewards matching the trainer's approval
instead of reality, and produces the feeling of progress without the substance.

## Architecture

```
bin/palimpsest      launcher
trainer/role.md     the contract — always resident
trainer/digest.md   digestion protocol — read at runtime
trainer/probe.md    discrimination probes — read at runtime
trainer/falsify.md  audit protocols — appended under falsify
src/atlas.ts        card index + primitive lattice
src/omp.ts          the only place that spawns omp
src/audit.ts        the falsifier
src/assimilate.ts   the record
state/              assimilation.log, committed
```

The launcher is plumbing. **The trainer contract is the product.** omp's TUI is
the interface; nothing here reimplements a chat UI.

### Why `--tools=read`

The trainer can look a card up. It cannot read a directory, run a command, write
a file, or touch the network. "Trainer, not executor" is enforced by capability
absence, not by asking the model to be restrained.

## The falsifier

This project can be killed. `palimpsest falsify` is the instrument that does it,
and the checks are deterministic string analysis over the trainer's own output,
so a trainer that wants to pass has to emit the marker and a framework name
cannot be unsaid.

| Check | Question | Baseline (2026-09-30) |
|---|---|---|
| `withhold` | Does it demand a read before naming a framework? | PASS — demanded commitment, named nothing |
| `contradiction` | Does it manufacture contradictions on settled material? | PASS — 0 found |
| `novelty` | Is the claim new, or a re-presentation? | **needs your grade** |

`novelty` is deliberately not auto-passable. An instrument that grades itself is
the failure mode this project exists to detect. It reported its own claim as a
**re-presentation** on first run, which is the correct kind of bad news.

`tests/trainer.contract.test.ts` asserts the contract still has its teeth —
delete "Never praise" from `role.md` and the build breaks. A gate that cannot
fail is decoration.

## Substrate note

The atlas is **read-only** from this repo. It is developed and audited on its own
terms; `palimpsest` consumes it. Two things worth knowing about its shape, both
found the hard way:

- Card heading level is **inconsistent** (`#` in some leaves, `##` in most). The
  indexer anchors on `**Tier:**` instead, and is asserted against the atlas's own
  counts (801 / 191 / 256 / 354) so a drift breaks the test rather than silently
  shrinking the substrate.
- Every card declares **its own `**Primitives:**`**, so the lattice is a real
  graph. Propagation from one tier-1 seed reaches over half of tier-1 in two hops.
  That density is where the exponential lives.

## Not built yet

- **Phase 2 — write-back.** Assimilation currently records; it does not mutate
  the atlas. Growth becomes compounding when a digestion can add an edge or mint
  a card, gated by `registry.py --check`.
- **Phase 3 — always-on.** Catalyst still has to be handed over. `omp --mode=rpc`
  (newline-delimited JSON over stdio, documented, verified) plus
  `set_host_tools` is the route: host-owned tools with no extension code at all.
- **Model selection.** The launcher passes flags through; a config overlay with
  `modelRoles` is the next step.
- **616 of 801 cards have no `### Digest` field.** Only tier-1 is wired, which is
  all the lattice needs to propagate.

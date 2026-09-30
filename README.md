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
palimpsest bench <dir>              # instrument test over many catalysts
palimpsest state                    # assimilation summary
palimpsest settle <verdict>         # mark the last entry integrated|rejected|not-my-language
palimpsest atlas [query]            # search the card index
palimpsest propagate "<card>" <hops> # walk the primitive lattice
palimpsest doctor                   # subsystem health, PASS/FAIL per line
palimpsest trace [file|cwd]         # tool-calling chronology, one line per event
palimpsest trajectory <file>        # golden-trajectory divergence report
```

The last three read only. `doctor` checks each subsystem independently, prints the
exact address or path it checked, mutates nothing, and exits nonzero if anything
FAILs. `trace` prints the tool calls the recorder throws away — did the trainer
reach for `read` before it spoke — with the entry index on every line so a finding
can cite one. `trajectory` compares an actual transcript against the golden
ordering and reports `EXPECTED <x> AT <position>, FOUND <y>` per divergence; a
conforming transcript prints `CONFORMS`. It is nonzero on any divergence, so it
is a gate rather than a report.

The session itself runs with the advisor **forced on**: `advisor.enabled`
defaults to false and only rpc/acp hosts inherit it, so the launcher passes
`--advisor` rather than trusting a default.

## The one mechanic

**Commitment before disclosure.** If you read the framework before reasoning,
you do recognition, not generation. Recognition feels exactly like possession and
is worth almost nothing. So the trainer poses, demands your read, waits, and only
then releases. It never praises: praise rewards matching the trainer's approval
instead of reality, and produces the feeling of progress without the substance.

## Architecture

```
bin/palimpsest      launcher
config/locked-down.yml  --config overlay; makes tools:[read] actually binding
trainer/role.md     the contract — always resident
trainer/digest.md   digestion protocol — read at runtime
trainer/probe.md    discrimination probes — read at runtime
trainer/falsify.md  audit protocols — appended under falsify
src/atlas.ts        card index + primitive lattice
src/omp.ts          the only place that spawns omp
src/audit.ts        the falsifier
src/assimilate.ts   the record
src/record.ts       transcript-to-record parser, verdict hardwired PENDING
src/session-read.ts latest-session transcript reader (JSONL, no omp import)
src/memory.ts       memory-wire client — persistRecord by bank + verdict tags
src/doctor.ts       seven subsystem checks, one PASS/FAIL line each
src/trace.ts        tool-calling chronology, entry index on every line
src/trajectory.ts   golden ordering vs an actual transcript
state/              assimilation.log, committed
```

The launcher is plumbing. **The trainer contract is the product.** omp's TUI is
the interface; nothing here reimplements a chat UI.

### Why `agents/trainer.md`

The trainer/executor line is declared, not flagged. `agents/trainer.md` carries
`tools: [read]` and `src/omp.ts` compiles it into the spawn, failing loud on
anything it cannot parse — a silently-misread allowlist would hand the trainer
a full toolset while the definition still reads like a boundary.

**The boundary is no write and no shell. It is not "no filesystem" and it is not
"off the network."** `read` reaches a local file, a directory tree, an archive, a
SQLite row, a PDF, and a **URL** — it dispatches to `fetch.ts` internally
(`tools/read.ts:80`) — plus `ssh://` and internal `://` schemes. What the
trainer cannot do is write, edit, shell out, search, or spawn a subagent: each of
those is a separate tool and none is in the allowlist. "Trainer, not executor"
is capability absence, not a request for restraint. `learn` is a write tool, so
it is absent too: the trainer cannot record, and verdicts are structurally the
user's.

**`--tools=read` alone would not have been enough, and the previous version of
this README said it was.** With an explicit tool list and no
`restrictToolNames`, omp auto-includes `manage_skill` — a write tool that creates
and deletes managed `SKILL.md` files — whenever `autolearn.enabled` is true
(`tools/index.ts:687,730-731,786-790`). `restrictToolNames` is the gate that
skips that block and omp exposes it only as an SDK option, never as a flag. So
every spawn also passes `--config config/locked-down.yml`, an overlay pinning
`autolearn.enabled: false` and `memory.backend: off`. Overlays merge over the
user's own config, so the boundary does not depend on what one machine's
`config.yml` says. `tests/launcher.test.ts` asserts the overlay and `--advisor`
are on the built argv, and names the residual risk: this is narrower than
`restrictToolNames`, and `docs/architecture.md` says exactly how.

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

### `bench` — the phase-1 instrument test

`palimpsest bench <dir>` runs one digestion per `.md` file and reports only what
can be judged **without** the user: convergence rate, claim sprawl, contact-surface
width, cluster spread, contradiction counts, and any pathologies (`NO-CLAIM`,
`SPRAWL`, `THIN`, `SINGLE-CLUSTER`). It then prints every claim for you to grade.

It computes **no novelty verdict on purpose** — an instrument that grades itself is
the failure this project exists to catch. It also does not write to
`state/assimilation.log`: a machine-run digest is an instrument run, not an
assimilation, and mixing the two would corrupt the record.

A known limit worth stating precisely: `bench` and `digest` run one-shot, so there
is no user turn between demanding a read and releasing a framework. The
load-bearing direction **is** covered — the only leak point is turn 1, where no
user reasoning exists yet, and `falsify withhold` probes exactly that.

What stays untested is the *baited* case: a user who pushes back ("just tell me
the answer") and whether the trainer holds the line. That needs a real multi-turn
exchange, which means `omp --mode=rpc` (see `docs/omp-notes.md`). Until then the
withhold property is verified for the first turn and assumed for the rest.

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

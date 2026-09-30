# palimpsest

A training system for one mind. The AI is the trainer; the digestion happens in
you, not in the model. Built on [`omp`](https://github.com/can1357/oh-my-pi) as the
engine, with [`mental-model-atlas`][atlas] as the enzyme set — **801 cards** (191
T1 / 256 T2 / 354 T3), **33 primitives**, 39 families, a real graph because every
card declares its own `**Primitives:**`.

[atlas]: https://github.com/ishan-parihar/mental-model-atlas

## The idea

Frameworks are enzymes. Catalyst arrives — a document, a thread, a failure, a
decision you are sitting with. The atlas graph breaks it across every node it
touches, propagates through the shared primitives, surfaces what it contradicts
in what you already hold, and resolves to **one** claim, which is yours first.

**The one mechanic: commitment before disclosure.** Read the framework before
reasoning and you do recognition, not generation — which feels exactly like
possession and is worth almost nothing. So the trainer poses, demands your read,
waits, then releases. It never praises: praise rewards matching the trainer's
approval instead of reality. Growth is not coverage but the substrate becoming
second nature, and then unnecessary.

## Install

```bash
git clone https://github.com/ishan-parihar/palimpsest
cd palimpsest && ./install/install.sh
```

The script detects the platform, installs Bun and omp, installs memory-wire (v0.5.0,
sha256-verified against the release's checksum), verifies the atlas, clones the
repo, starts memory-wire on an OS-assigned free loopback port with its own
database, and ends at `palimpsest doctor`. Idempotent throughout; every failure
exits nonzero. Linux `x86_64` or `aarch64` only.

| Flag | Default | What it does |
|---|---|---|
| `--install-dir <path>` | `~/.local/share/palimpsest` | where the repo is cloned |
| `--repo-url <url\|path>` | `https://github.com/ishan-parihar/palimpsest` | clone source, resolved before use |
| `--atlas-dir <path>` | `~/.agents/skills/mental-model-atlas` | atlas location |
| `--atlas-repo <url>` | *(unset, deliberately)* | clone the atlas when the dir is empty |
| `--memory-port <n>` | `0` | `0` asks the OS for a free port |
| `--memory-db <path>` | `~/.local/share/memory-wire/palimpsest.db` | this project's own store, never the shared one |
| `--bin-dir <path>` | `~/.local/bin` | where omp / mise / memory-wire are linked |
| `--bun-version <v>` | `1.4.2` | Bun version to install or accept |
| `--omp-version <v>` | `18.3.1` | omp version to install or accept, via mise |
| `--no-daemon` | off | verify everything, start nothing; the doctor gate then fails, correctly |
| `--help` | | the same list |

Three defaults are refusals, not conveniences. Where you see `OWNER` in the script source it is a literal placeholder guard; the shipped default is the real repo,
so the script stops until you pass a real `--repo-url`. The atlas is **not
published** — `github.com/ishan-parihar/mental-model-atlas` returns 404 — so there
is no default clone URL and none is invented: supply a copy at `--atlas-dir` or
pass `--atlas-repo <url>`, and either way the card count is checked at 801. The port
defaults to 0 because 8888 is memory-wire's tree-wide default, often another
process, and 18899 is this repo's author-side default; neither is assumed.

Two side effects, not hidden: the Bun installer appends to your shell rc files, and
the omp step runs `mise use -g`, which **rewrites your mise global config** to pin
omp at 18.3.1, replacing a `"latest"` entry.

```bash
source ~/.local/share/palimpsest/memory.env   # PALIMPSEST_MEMORY_ADDR, db, PATH
cd ~/.local/share/palimpsest && ./bin/palimpsest
```

`memory.env` also records how to stop this install's memory-wire. If a daemon was
already running the script will not stop it — that daemon owns the single
`serve.json` state file — and runs `memory-wire serve` itself, with its own db.

## Quickstart

```bash
./bin/palimpsest                    # train. the trainer asks; you answer.
./bin/palimpsest state               # what has been assimilated, verdicts included
./bin/palimpsest settle integrated   # rule on the last claim. this is your vote.
```

On a fresh install `palimpsest doctor` reports exactly one `FAIL`: `sessions`,
which reads a directory the first session creates. Train once and it goes green;
every other `FAIL` is real and the installer stops on it.
## Commands

```bash
palimpsest                          # open the session (omp TUI, trainer active)
palimpsest digest <file|->          # one-shot digestion; records to the log
palimpsest falsify [check]          # the gate: withhold|contradiction|novelty
palimpsest state                    # assimilation summary
palimpsest settle <verdict>         # last entry integrated|rejected|not-my-language
palimpsest atlas [query]            # search the card index
palimpsest propagate "<card>" <hops> # walk the primitive lattice
palimpsest bench <dir>              # instrument test over many catalysts
palimpsest doctor                   # 8 subsystem checks, PASS/FAIL per line
palimpsest trace [file|cwd]         # tool-calling chronology, one line per event
palimpsest trajectory <file>        # golden-trajectory divergence report
```

The last three read only and mutate nothing. `doctor` prints the exact address or path
each check looked at, so a `FAIL` is actionable without re-deriving the config;
`/health` must return exactly `ok`, not merely 200 — a foreign process answers 200 too.

## The trainer/executor line

`agents/trainer.md` carries `tools: [read]`, and `src/omp.ts` compiles that
allowlist into the spawn, failing loud on anything it cannot parse. The boundary
is **no write, no shell** — not "no filesystem", not "off the network": `read`
reaches local files, directory trees, archives, SQLite rows, PDFs and URLs. What
the trainer cannot do is write, edit, shell out, search or spawn a subagent, and
`learn` is absent, so it cannot record. Verdicts are yours.

`--tools=read` alone is not a boundary, and so was the first fix: an rpc
`get_state` probe with `--tools=read` plus an overlay closing only omp's
auto-include returned **103 tools, 99 of them state-mutating**, including
`mcp__memory_wire_memory_retain`. Three leaks, each closed and each measured:
extensions (`--no-extensions`), the user's own `~/.omp/agent/mcp.json`
(`disabledProviders`), and the device-only `write` that `tools.xdev` allocates.
The roster now measures as exactly `["read"]`, polled 14 times over 21 s so
late-arriving MCP tools cannot hide. Sessions run with the advisor **forced on**
(`advisor.enabled` defaults to false; only rpc/acp hosts inherit it) and extensions
off, because an installed plugin was handing the trainer `bash` and `write`
outside the allowlist entirely. `WATCHDOG.yml` holds exactly one advisor,
`conscience`, at `@smol`: one call per turn, a critic and never a second trainer.

## What can be falsified

`palimpsest falsify` is deterministic string analysis over the trainer's own
output, so passing means emitting the marker and a framework cannot be unsaid.
`withhold` and `contradiction` have recorded baselines; `novelty` is **never
auto-passable** — an instrument that grades itself is the failure this project
exists to detect, and it called its own claim a re-presentation on first run. The
advisor's negative test is **deferred, not passing** (`docs/advisor-gate-test.md`).

## Architecture

`docs/architecture.md` is the real document — layers L0–L5, the tool-roster
measurement, the residual risk, the cost model, and every gate with what fails it.

```
bin/palimpsest + config/locked-down.yml   launcher; the overlay makes tools:[read] binding
agents/trainer.md + trainer/role.md       the contract — declared, always resident
WATCHDOG.yml                              one advisor, five checks, one a blocker
src/omp.ts / src/atlas.ts                 the only omp spawn; card index + lattice
src/memory.ts                             memory-wire client, the only HTTP in the repo
src/doctor.ts / audit.ts / assimilate.ts  the 8 checks; the falsifier; the record
```

The launcher is plumbing; **the trainer contract is the product.**

## Proof

```bash
bun test        # 143 pass, 0 fail, 12 files
```

No dependencies, no `package.json` — Bun runs the TypeScript directly. The suite is
not decoration: `tests/launcher.test.ts` asserts the overlay, `--no-extensions` and
`--advisor` are on the built argv, so dropping any breaks the build instead of
silently handing the trainer a write tool; `tests/trainer.contract.test.ts` pins
the prohibitions in `role.md` and the atlas counts (801/191/256/354), so a drifted
substrate fails rather than shrinking.

## Not built

Ordered, with owners, in `docs/remaining.md`. Short version: nobody has run a real
session yet, so every loop-level guarantee is fixture-tested and none is
user-tested. Then synthesis over time (Phase 4), write-back into the atlas (Phase
5, gated on 4), 616 of 801 cards with no `### Digest` field, 2–5 minutes per model
call with the advisor doubling it.

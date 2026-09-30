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
                       + --no-extensions + config overlay   roster measured: [read]
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

`tools: [read]` is the trainer/executor line, and the boundary is **no write, no
shell** — not "no filesystem", not "no network":

| The trainer CAN | because |
|---|---|
| read a local file | `read` is the allowlist, and the measured roster is exactly `["read"]` |
| read a **directory** | `read` builds a tree via `buildDirectoryTree` (tools/read.ts:71) |
| read an archive, SQLite row, PDF, notebook | same tool, same path |
| **fetch a URL** | `read` dispatches to `fetch.ts` — `executeReadUrl` / `fetchReadUrl` / `parseReadUrlTarget` (tools/read.ts:80) |
| read `ssh://` and internal `://` schemes | same tool, path resolution |
| call `advise` | the advisor's own tool, in a separate runtime with `tools: [read]` (L2) |

| The trainer CANNOT | because | the line that proves it |
|---|---|---|
| write or edit a file | `write` / `edit` / `ast_edit` are not in the roster | measured `dumpTools` = `["read"]` |
| run a command | `bash` / `eval` are not in the roster | same |
| search, glob, or grep | `grep` / `glob` / `find` are not in the roster | same |
| spawn a subagent | `task` is not in the roster | same |
| record to memory | `mcp__*` servers are not discovered | `disabledProviders` in the overlay |
| mint or edit a managed skill | `autolearn.enabled: false` closes the `:730`/`:786` gate | tools/index.ts:730,786 |
| call a plugin's tool | extensions are not discovered | `main.ts:1641-1643` |
| reach a device via `write xd://<tool>` | `tools.xdev: false` | tools/index.ts:869-899 |

**`--tools=read` is not a hard boundary, and the previous version of this
document was wrong twice over.** The first error was theoretical: with an
explicit list and no `restrictToolNames`, omp *widens* the list before filtering
it. The second was worse — the mitigation for that was also insufficient, and
nobody had looked. An rpc `get_state` probe (`dumpTools`, **zero model calls**)
with `--tools=read` plus an overlay closing only the auto-include returned:

```
TOOL LIST (103): read, bash, bash_status, bash_watch, bash_write, bash_kill,
write, edit, aft_outline, aft_zoom, aft_inspect, aft_conflicts, aft_import,
aft_safety, ast_grep_search, ast_grep_replace, mcp__cloakctl_*,
mcp__memory_wire_memory_retain, mcp__sourcehound_cloakctl_*, …
                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ 99 state-mutating
```

The trainer could shell out, write files, and **record to memory-wire** — the
foundational guarantee, broken. Three independent leaks, each attributed by an
A/B pair of rpc spawns and each closed:

| Leak | Mechanism | Closed by | Measured |
|---|---|---|---|
| 1 — extensions | the installed omp-plugin registered `bash`, `write`, `edit`, `bash_*`, `aft_*` via `registerTool`, which never passes through `resolveBuiltinToolNames` — so **no `tools:` value could exclude them** | `--no-extensions` on every spawn | 103 → 2 |
| 2 — MCP | the user's own `~/.omp/agent/mcp.json` is `level: "user"`; `mcp.enableProjectConfig: false` only drops `level: "project"` (mcp/config.ts:133-134) | `mcp.enableProjectConfig: false` **plus** `disabledProviders` | 2 → 1 |
| 3 — xd:// write transport | with `tools.xdev` on (default true) and a list granting `read` but not `write`, omp allocates a **device-only `write`** so `write xd://<tool>` can dispatch mounted devices (tools/index.ts:869-899) | `tools.xdev: false` | 2 → 1 |

Leak 1 is closed by a **flag**, not a config key, because extension discovery is
not a setting. `--no-extensions` sets `options.disableExtensionDiscovery`
(`main.ts:1641-1643`), and `explicit-only` mode contributes no ambient
`extensions:`, no installed plugins, and no disk config
(`discovery/omp-extension-roots.ts:274-278`). There is no overlay equivalent, which
is why `--no-rules`/`--no-skills` were never going to be enough.

Leak 2 needed both halves. `mcp.enableProjectConfig: false` alone left **88
tools** — the project's own `.mcp.json` is empty, so the entire remainder came
from the user-level file. `disabledProviders` is a plain array setting
(`config/model-settings.ts:66`) and the overlay merges with
**array-replaces-wholesale** semantics (`config/settings.ts:3745-3761`: a
non-object override wins outright rather than unioning), so the overlay's list
wins over the user's own config rather than adding to it. `cursor` is
deliberately excluded: it is also a model `providerId`, and
`config/model-registry.ts:2097-2105` filters the model catalog by the same set,
so disabling it would drop the Cursor models and could break the trainer's own
default model. It is already inert twice over — project half by
`mcp.enableProjectConfig: false`, `~/` half because foreign user configs are
opt-in via `enabledProviders` (`capability/index.ts:51-59`, `:363-375`).

**`restrictToolNames` remains the one gate that would make all of this
unnecessary** — it also sets `enableMCP = false` (`sdk.ts:2371`) — but it is
SDK-only (`CreateAgentSessionOptions`, `sdk.ts:721`). The launch flag table
(`commands/launch-help.ts`) has nothing that sets it, and `main.ts:1593-1597`
maps `--tools` to `options.toolNames` and nothing else. No CLI invocation,
including a palimpsest one, can set it. What ships is a mitigation.

**Auto-include, still gated on autolearn/memory.** With an explicit tool list and
no `restrictToolNames`, omp widens the list before filtering it
(`tools/index.ts`):

```
:687  if (requestedTools && !restrictToolNames) {      // the widening block
:730  autolearn.enabled && taskDepth 0  ->  push "manage_skill"
:732  ... push "learn" when the memory backend is hindsight|mnemopi|local
:786  isToolAllowed("manage_skill") = autolearn.enabled && (top level || explicit)
:807  const names = requestedTools.filter(... && isToolAllowed(name))
```

`manage_skill` creates, updates, and deletes managed `SKILL.md` files. A trainer
holding it is an executor. `autolearn.enabled: false` closes the gates at `:730`,
`:786`, `:791`; `memory.backend: off` closes `:782-785` and `:795`; the `:807`
filter then drops the auto-included names. Both keys are omp defaults, pinned in
the overlay so the guarantee does not depend on the user's `config.yml`.

**Second, independent mechanism: the deny map.** `tools.approval` in the overlay
sets `deny` on 34 write/exec/memory tools. Nothing needs denying today — the
roster is already `["read"]` — so this is not the primary lock. It exists so that
a *future* auto-include gated on a setting nobody here knows about still cannot
**execute**: user approval policies are authoritative in every mode including
yolo (`tools/approval.ts:200-201`, `:235-240`). `tools/index.ts` never reads
`cfgToolsApproval` — every consumer is execute-time — so the map provably cannot
widen or narrow the roster. It is the same "narrower than `restrictToolNames`, and
honest about it" trade the autolearn keys make, applied to execution instead of
registration.

**Residual risk, stated rather than smoothed over.** What is *proven*: a roster
of exactly `read`, captured over 14 `get_state` polls across 21 s so that
late-arriving MCP tools cannot hide behind the 250 ms startup window
(`mcp/settings.ts:22-30`). Six rpc spawns, all exiting 0 or 143, no prompt frame
ever sent. What is *not* proven: that no future omp release can widen it again. A
new provider id, a new extension-root source, or a new auto-include would each
need a new line here, and only an omp-side flag or the SDK option would stop it
structurally. `tests/launcher.test.ts` asserts the overlay is on the built argv
**and** that its three load-bearing keys and `--no-extensions` are present, so
deleting any of them breaks the build instead of silently restoring a write tool.

Prompt: `trainer/role.md`, always resident.

### L2 — advisor (one, integrated)

**The advisor is off by default, so the launcher has to turn it on.** The
setting is `advisor.enabled`, `default: false`, with
`protocolDefault: ["rpc", "acp"]` (`advisor/settings.ts:10-14`) — protocol hosts
opt in, and a TUI session does not. An earlier version of this document
described the advisor as always running; that was true only over rpc/acp. The
launcher passes `--advisor`, which is an ephemeral override applied before the
interactive host is built and is *not* gated on `isInteractive` or on protocol
mode (`main.ts:1877-1880`), so it reaches both the TUI and the one-shot paths.
`src/omp.ts` passes it unconditionally and `tests/launcher.test.ts` asserts its
presence, because a defense that can be dropped by a later edit is not one.

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

**Its gate is DEFERRED, not passing.** Deliberately instructing the trainer to
praise should produce a `blocker` and a retraction; that negative test has never
been run, and the baited form of it is written up in
`docs/advisor-gate-test.md`. What the config above asserts, via
`palimpsest doctor`, is only that the key exists and holds exactly one entry.

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
| launcher args | `--config config/locked-down.yml`, `--no-extensions`, or `--advisor` leaves the built argv; or a write/execute tool is named; or the overlay loses `mcp.enableProjectConfig`, `tools.xdev`, or a required `disabledProviders` entry; or the approval map is not deny-only, or names `read` |
| trainer contract | a prohibition is deleted from `role.md` |
| substrate index | counts drift from the atlas registry (801/191/256/354) |
| lattice | a tier-1 card declares no primitive and cannot propagate |
| falsifier: withhold | a framework is named before the user commits |
| falsifier: contradiction | settled material yields a contradiction |
| falsifier: novelty | **never auto-passes** — the user grades every claim |
| advisor count | `WATCHDOG.yml` has no `advisors:` key, or holds more or fewer than one |
| advisor tone | **DEFERRED, not passing** — the negative test has never run; see `docs/advisor-gate-test.md` |
| empty transcript | any check reads silence as success |
| memory: rejected stays | a rejected record is unfindable, or its tag stops being `verdict:rejected` |
| memory: verdict cannot move | settling a record edits the rejected row instead of appending |

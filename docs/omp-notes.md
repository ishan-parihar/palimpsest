# omp notes

Verified against the installed binary (v18.3.1) and the public docs at
`github.com/can1357/oh-my-pi`. Facts here cost turns to establish; these are the
ones that change decisions.

## The engine

`omp` is a heavily-extended fork of [Pi](https://github.com/badlogic/pi-mono),
published as `@oh-my-pi/pi-coding-agent`, compiled as a Bun single binary. The
`PI_SMOL_MODEL` / `PI_SLOW_MODEL` / `PI_PLAN_MODEL` env vars are the giveaway that
it *is* pi. Docs live in the repo under `docs/` — `rpc.md` (42KB),
`extensions.md` (58KB), `settings.md` (120KB), `system-prompt-customization.md`.

## What this harness uses, and why not more

| Need | Route | Why not the bigger one |
|---|---|---|
| Custom behaviour | `--append-system-prompt <file>` | Keeps the whole default harness; `--system-prompt` replaces the tool inventory and workflow rules too |
| Restrict capability | `agents/trainer.md` (`tools: [read]`), compiled into the spawn by `src/omp.ts`, **plus** `--config config/locked-down.yml` | Absence, not restraint. The trainer/executor line, declared rather than flagged; the launcher fails loud on anything it cannot parse. The overlay is not optional — see below |
| Force the advisor on | `--advisor` | `advisor.enabled` defaults to false and only rpc/acp inherit it; without the flag a TUI session runs with no advisor at all |

**`--tools` is not a hard boundary, and this cost a red-team finding.** With an
explicit tool list and no `restrictToolNames`, omp auto-includes `manage_skill`
(a write tool) when `autolearn.enabled` is true — `tools/index.ts:687` opens the
block, `:730-731` does the push, `:786-790` gates it, `:807` filters. And
`restrictToolNames`, the flag that skips the block, is **SDK-only**
(`sdk.ts:721`): nothing in `commands/launch-help.ts` sets it and
`main.ts:1593-1597` maps `--tools` to `options.toolNames` alone. So the strongest
CLI-available mitigation is the overlay, which is also confirmed by the
`--config` note above: overlays deep-merge over global and project config, so a
repo-committed overlay beats the user's own `config.yml` without editing it.

Also verified, since the docs here used to claim otherwise: `read` **does**
fetch URLs (`tools/read.ts:80` imports `executeReadUrl` / `fetchReadUrl` /
`parseReadUrlTarget` from `./fetch`) and **does** read directories
(`tools/read.ts:71` imports `buildDirectoryTree`). The trainer's boundary is no
write and no shell, not no-network and not no-directory.
| Determinism | `--no-rules --no-skills` | No 120 ambient skills, no inherited project discipline |
| Atlas access | `--add-dir <atlas>` | Referenced explicitly by `role.md` rather than discovered, so the substrate is guaranteed rather than ambient |

An **extension** (`.ts`, no npm install needed — `import type` is erased and
`pi.zod` is injected) is the next rung, not this one. It becomes worth it when
you need to hook `before_agent_start` to override the system prompt per turn,
intercept `input`, or block tool calls. Phase 1 needs none of that.

## Gotchas that would have bitten

- **The skills listing only reaches the system prompt when the `read` tool is
  available.** A probe run with `--no-tools` reports zero skills and looks like a
  discovery failure. `~/.agents/skills/` *is* scanned by default
  (`enableAgentsUser: true`, non-recursive `<root>/skills/<name>/SKILL.md`).
- `--hook` is an alias for `--extension`. There is no separate hook API.
- `pi.sendMessage()` during extension load throws `ExtensionRuntimeNotInitializedError`.
- There is **no config key for the system prompt** — it is CLI flag or file only.
  `config.yml` (`~/.omp/agent/config.yml`, or `--config <file>` for a never-persisted
  overlay) covers model roles, tool approval, compaction. Objects deep-merge;
  scalars and arrays are replaced wholesale.

## Phase 3 route: rpc, not an extension

`omp --mode=rpc` is newline-delimited JSON over stdio. First frame:

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2]}
```

Send `{"id":"req_1","type":"prompt","message":"..."}`; correlate on
`prompt_result` (agent *yielded*) versus `session_settled` (session *done* — a
prompt is not finished until nothing can wake it again). A failed provider turn
still returns `success: true`, so read `prompt_result.status`.

`set_host_tools` lets the host serve tools to the agent with **zero extension
code** — which is how the atlas should be exposed in Phase 3, rather than
growing the extension surface.

## The memory-wire daemon this repo talks to

Phase 3 records through [memory-wire](https://github.com/ishan-parihar/memory-wire)
v0.5.0 over loopback HTTP. `src/memory.ts` is the only file that speaks it.

```bash
memory-wire daemon start --addr 127.0.0.1:18899 --db ~/.local/share/memory-wire/palimpsest.db
memory-wire daemon status            # exit 0 only when a server is really answering
memory-wire daemon stop
```

| | |
|---|---|
| addr | `http://127.0.0.1:18899` |
| db | `~/.local/share/memory-wire/palimpsest.db` |
| health | `GET /health` returns exactly `ok`, plain text, 200 |
| state file | `~/.local/share/memory-wire/serve.json` |
| log | `~/.local/share/memory-wire/serve.log` |

**8888 is not ours, and must not be touched.** It is the tree-wide default
(`paths::DEFAULT_ADDR`) and on this box it is a **foreign process** — a database
service that answers `/health` with
`{"status":"healthy","database":"connected",…}` rather than `ok`. That is exactly
the case memory-wire's health check is built for: any process on the port answers
200, so only a body of exactly `ok` counts. `memory-wire doctor` with no
`MEMORY_WIRE_URL` therefore reports `server down: unexpected health response`,
which is the tool being honest rather than broken.

Two consequences, both worth knowing before a session fails mysteriously:

- **The client does not default to 8888.** `src/memory.ts` falls back to
  `http://127.0.0.1:18899`, and the only variable it reads is
  `PALIMPSEST_MEMORY_ADDR`. It does **not** read `MEMORY_WIRE_URL` — that one is
  set for every memory-wire consumer on the box (its hooks, `memory-wire doctor`,
  anything pointed at the shared `agents.db`), so honouring it let a foreign
  export redirect where assimilation records land. A writer's address is
  namespaced to the writer. Set `PALIMPSEST_MEMORY_ADDR` to aim palimpsest, and
  `MEMORY_WIRE_URL` to aim memory-wire's own tools; set both to one address.
- **`doctor` needs that variable too**, because it resolves its endpoint through
  `paths::endpoint()` and that is the same 8888 literal:

  ```bash
  MEMORY_WIRE_URL=http://127.0.0.1:18899 memory-wire doctor --db ~/.local/share/memory-wire/palimpsest.db
  # endpoint http://127.0.0.1:18899 · store … (297.1 KiB, ok) · server up
  ```

**The db is this repo's, not the shared one.** memory-wire's install runbook
defaults to `~/.local/share/memory-wire/agents.db`, which holds every other host's
memories. Phase 3 keeps a separate `palimpsest.db` so a `memory-wire sweep` run
for another project can never be pointed at this store by accident, and so a
corrupt palimpsest db is not a shared-store incident.

**The server has no authentication and is unauthenticated by design**, which is
why `--addr` defaults to loopback and why a non-loopback bind prints a warning
first. Keep it on loopback. There is no supervision here beyond the daemon: it
detaches into its own session via `setsid`, records pid **and process start time**
(because a pid is not an identity), and `stop` sends the same SIGTERM `serve`
already handles, waiting for the drain.


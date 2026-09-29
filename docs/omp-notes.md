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
| Restrict capability | `agents/trainer.md` (`tools: [read]`), compiled into the spawn by `src/omp.ts` | Absence, not restraint. This is the trainer/executor line, declared rather than flagged; the launcher fails loud on anything it cannot parse |
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

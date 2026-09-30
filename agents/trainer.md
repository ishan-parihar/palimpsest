---
name: trainer
description: Trains one mind in the mental-model atlas. Never executes.
tools: [read]
model: ["@default"]
thinkingLevel: high
---

System prompt: trainer/role.md

The trainer can look a card up. It cannot write a file or run a command.
The read tool itself CAN read directories and fetch URLs, so the boundary is
no-write-no-shell, stated precisely: capability absence rather than restraint.

`learn` is a write tool, so it is absent from the allowlist. The trainer
physically cannot write to memory — verdicts are structurally the user's, not a
rule it could forget.

## What cannot happen, and the line that proves it

`tools: [read]` alone did NOT buy this. An rpc `get_state` probe (zero model
calls) with `--tools=read` and an overlay that only closed omp's auto-include
offered **103 tools, 99 of them state-mutating** — including `bash`, `write`,
`edit`, and `mcp__memory_wire_memory_retain`. Three leaks, each now closed:

- **Extensions could write.** The installed omp-plugin registered its own
  `bash`, `write`, `edit`, `bash_*`, and `aft_*` via `registerTool`, which never
  passes through the allowlist resolver — so no `tools:` value could exclude
  them. Closed by `--no-extensions` on every spawn: `main.ts:1641-1643` sets
  `options.disableExtensionDiscovery`, and `omp-extension-roots.ts:274-278` makes
  `explicit-only` mode contribute no ambient roots.
- **MCP could record.** `mcp__memory_wire_memory_retain` came from the user's own
  `~/.omp/agent/mcp.json`. Closed by `mcp.enableProjectConfig: false` plus
  `disabledProviders` in `config/locked-down.yml`; the latter is the half that
  mattered, because the project switch alone still left 88 tools.
- **The xd:// write transport existed.** With `tools.xdev` on, omp allocates a
  device-only `write` so `write xd://<tool>` can dispatch devices
  (`tools/index.ts:869-899`). Closed by `tools.xdev: false`.

The measured roster is now exactly `["read"]`, polled 14 times over 21 s so
late-arriving MCP tools cannot hide. A `tools.approval` deny map backs that up
at execution time, so a future auto-include still cannot run.

**Residual risk, stated rather than waved through.** `restrictToolNames` is the
one gate that makes all of the above unnecessary — it also sets
`enableMCP = false` (`sdk.ts:2371`) — but it is SDK-only (`sdk.ts:721`) and
`main.ts:1593-1597` maps `--tools` to `options.toolNames` and nothing else. This
is a proven mitigation, not the gate: a new provider id, extension root source,
or auto-include in a future omp release would each need a new line in the
overlay. `tests/launcher.test.ts` asserts the overlay and `--no-extensions` are
on the built argv, so dropping either breaks the build.

`model: ["@default"]` routes to the default role, so `src/omp.ts` omits
`--model` rather than passing the `@`-prefixed role name, which is a definition
key and not a documented `--model` value.

`thinkingLevel` is the camelCase key omp's own `parseAgentFields` reads. The
bundled `scout` agent spells it `thinking-level`, which that parser does not
read; the level silently falls back to the model default. The trainer means it,
so it uses the key that is actually parsed.

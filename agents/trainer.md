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

`model: ["@default"]` routes to the default role, so `src/omp.ts` omits
`--model` rather than passing the `@`-prefixed role name, which is a definition
key and not a documented `--model` value.

`thinkingLevel` is the camelCase key omp's own `parseAgentFields` reads. The
bundled `scout` agent spells it `thinking-level`, which that parser does not
read; the level silently falls back to the model default. The trainer means it,
so it uses the key that is actually parsed.

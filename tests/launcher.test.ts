/**
 * The launcher's capability boundary has teeth.
 *
 * The findings here are no longer prose claims. Each one was measured at
 * runtime with an rpc `get_state` -> `dumpTools` probe that makes ZERO model
 * calls (get_state only, no prompt frame), and each mitigation was attributed by
 * an A/B pair of spawns:
 *
 *   S1  `--tools=read` is not a hard boundary. With the pre-existing overlay
 *       (autolearn off + memory off) the roster was **103 tools, 99 of them
 *       state-mutating**: `bash`, `write`, `edit`, and every `mcp__*` tool
 *       including `mcp__memory_wire_memory_retain` — the trainer could record.
 *       `restrictToolNames`, the one gate that would fix all of it, is SDK-only
 *       (sdk.ts:721); main.ts:1593-1597 maps `--tools` to `options.toolNames`
 *       and nothing else, so no CLI invocation can reach it.
 *   S12 LEAK 1, extensions. `--no-rules`/`--no-skills` do NOT disable extension
 *       loading (proven by `extension_ui_request` frames). The installed
 *       omp-plugin registered its own `bash`, `write`, `edit`, `bash_*`, and
 *       `aft_*` via `registerTool`, entirely outside the
 *       `resolveBuiltinToolPlan` allowlist, so no `--tools` value could exclude
 *       them. Measured: dropping the overlay's other keys but keeping
 *       `--no-extensions` removed all of them. Closed by the FLAG, because
 *       extension discovery is not a settings key — main.ts:1641-1643 sets
 *       `options.disableExtensionDiscovery`, putting extension roots in
 *       `explicit-only` mode (omp-extension-roots.ts:274-278).
 *   S13 LEAK 2, MCP. `mcp.enableProjectConfig: false` alone is NOT enough: it
 *       drops only `_source.level === "project"` servers (mcp/config.ts:133-134),
 *       and the user's own `~/.omp/agent/mcp.json` is user-level. Measured at 88
 *       tools with that key alone. `disabledProviders` closes the rest, and it
 *       wins over the user's config because the overlay merges with
 *       array-replaces-wholesale semantics (settings.ts:3745-3761).
 *   S14 LEAK 3, the xd:// device-only write transport. With `tools.xdev` on
 *       (default true) and a list granting `read` but not `write`, omp allocates
 *       a device-only `write` anyway (tools/index.ts:869-899):
 *       `write xd://<tool>` dispatches mounted devices while filesystem writes
 *       stay rejected. Measured as a literal `write` in the roster;
 *       `tools.xdev: false` removes it.
 *   S2  `advisor.enabled` defaults to false and only rpc/acp opt in
 *       (advisor/settings.ts:10-14), so the "one advisor, always" claim was
 *       false for a TUI session. `--advisor` (main.ts:1877-1880) forces it.
 *   S11 `read` reaches directories (tools/read.ts:71) and URLs
 *       (tools/read.ts:80), so the true boundary is "no write, no shell".
 *
 * These assert arg shape and overlay content only. No model call is made, so
 * the suite stays fast and offline — the flags are the thing under test.
 */
import { test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sessionArgs, runArgs, LOCKDOWN, REPO } from '../src/omp'

/** Both spawn paths must carry the same hardening, so both are built here. */
const oneShot = runArgs('probe', { trainer: ['role'] })
const interactive = sessionArgs()

const built: [string, string[]][] = [
  ['sessionArgs()', interactive],
  ['runArgs()', oneShot],
]

const overlay = readFileSync(LOCKDOWN, 'utf8')

test('S1: the --config lock-down overlay is on the command line', () => {
  expect(existsSync(LOCKDOWN)).toBe(true)
  for (const [name, args] of built) {
    const i = args.indexOf('--config')
    expect(`${name}: ${i}`).not.toBe(`${name}: -1`)
    expect(args[i + 1]).toBe(LOCKDOWN)
  }
})

test('S1: the overlay turns off the gate that auto-includes manage_skill', () => {
  // tools/index.ts:730 pushes manage_skill when cfgAutolearnEnabled is true, and
  // :786 gates it on the same setting. If autolearn is on in ANY layer, the
  // write tool is back and --tools=read stops meaning anything.
  expect(overlay).toMatch(/^autolearn:\n\s+enabled: false$/m)
  // Same reasoning for learn / retain / recall / reflect / memory_edit.
  expect(overlay).toMatch(/^memory:\n\s+backend: off$/m)
})

test('S1: the allowlist itself is still just read', () => {
  for (const [name, args] of built) {
    const toolFlags = args.filter((a) => a.startsWith('--tools='))
    expect(`${name}: ${toolFlags}`).toBe(`${name}: --tools=read`)
  }
})

test('S1: no write or execute tool is named anywhere in the command', () => {
  // Belt-and-braces on the argv: even if a future edit widens --tools, these
  // must not appear as explicit values.
  const forbidden = [
    'write', 'edit', 'ast_edit', 'bash', 'eval', 'task', 'lsp',
    'web_search', 'glob', 'grep', 'find', 'manage_skill', 'learn',
    'retain', 'recall', 'reflect', 'memory_edit', 'debug', 'todo',
  ]
  for (const [name, args] of built) {
    for (const tool of forbidden) {
      expect(`${name} ${tool}`).not.toBe(`${name} --tools=${tool}`)
      expect(args.includes(`--tools=${tool}`)).toBe(false)
    }
  }
})

test('S12: --no-extensions is on the command line, because extensions are not a setting', () => {
  // An installed omp-plugin registered bash/write/edit/bash_*/aft_* through
  // registerTool, which never passes through resolveBuiltinToolNames — so no
  // --tools value could exclude them, and no config key can either. The only
  // control is the flag: main.ts:1641-1643 -> options.disableExtensionDiscovery.
  for (const [name, args] of built) {
    expect(`${name}: ${args.includes('--no-extensions')}`).toBe(`${name}: true`)
  }
})

test('S12: --no-extensions precedes the allowlist, so nothing re-enables discovery', () => {
  // main.ts:1630-1643 takes the explicit-extensions branch only when
  // trustedExtensions is non-empty, which it never is here. Order matters so a
  // later flag cannot reinstate ambient roots.
  for (const [name, args] of built) {
    const noExt = args.indexOf('--no-extensions')
    const tools = args.indexOf('--tools=read')
    expect(`${name}: ${noExt < tools}`).toBe(`${name}: true`)
  }
})

test('S13: project-level MCP config is off in the overlay', () => {
  // mcp/config.ts:133-134 — the only thing this key does is drop
  // _source.level === "project" servers. Necessary, and NOT sufficient: see the
  // disabledProviders test below, which is the half that actually mattered.
  expect(overlay).toMatch(/^mcp:\n\s+enableProjectConfig: false$/m)
})

test('S13: the providers that read the USER mcp.json are disabled', () => {
  // builtin.ts:206-215 and mcp-json.ts:186 both read <agentDir>/mcp.json at
  // level "user". Measured: with mcp.enableProjectConfig: false alone the roster
  // was still 88 tools, every one of them an mcp__* tool.
  const list = /(^|\n)disabledProviders:\n((?:\s+-\s+\S+\n)+)/.exec(overlay)
  expect(list).not.toBeNull()
  const providers = list![2]!.split('\n').map(l => l.replace(/^\s*-\s+/, '').trim()).filter(Boolean)
  for (const required of ['native', 'mcp-json']) {
    expect(`disabledProviders has ${required}`).toBe(`disabledProviders has ${required}`)
    expect(providers).toContain(required)
  }
  // The third-party importers would reintroduce the same class from a project
  // config or a plugin, so they are disabled too.
  for (const importer of ['omp-plugins', 'agent-plugins', 'claude-plugins', 'claude', 'codex', 'gemini', 'opencode', 'windsurf', 'vscode', 'github']) {
    expect(providers).toContain(importer)
  }
})

test('S13: `cursor` is deliberately NOT disabled — it is also a model providerId', () => {
  // packages/catalog ships `cursor` as a model providerId, and
  // model-registry.ts:2097-2105 filters PROVIDER_DESCRIPTORS by the same
  // disabledProviders set. Disabling it would drop the Cursor models from the
  // catalog and could break the trainer's own default model. It is already
  // inert here twice over: the project half by mcp.enableProjectConfig: false,
  // and the ~/ half because foreign user configs are opt-in via
  // enabledProviders (capability/index.ts:51-59, 363-375).
  const list = /(^|\n)disabledProviders:\n((?:\s+-\s+\S+\n)+)/.exec(overlay)!
  const providers = list[2]!.split('\n').map(l => l.replace(/^\s*-\s+/, '').trim()).filter(Boolean)
  expect(providers).not.toContain('cursor')
})

test('S14: tools.xdev is off, so there is no device-only write transport', () => {
  // tools/index.ts:869-899: with xdev on and a list granting read but not
  // write, omp allocates a device-only `write` so `write xd://<tool>` can
  // dispatch mounted devices. Measured as a literal `write` in the roster with
  // everything else already locked down.
  expect(overlay).toMatch(/^tools:\n(?:.*\n)*?\s+xdev: false$/m)
})

test('S14: the approval map is deny-only and never names read', () => {
  // Second, independent mechanism. The roster is already exactly [read], so
  // nothing needs denying today; this exists so a future auto-include can still
  // not EXECUTE. tools/index.ts never reads cfgToolsApproval, so this map cannot
  // widen or narrow the roster — every consumer is execute-time
  // (tools/approval.ts, session-tools.ts:910, agent-session.ts:4525).
  const block = /\n\s+approval:\n((?:\s+\S+:\s+deny\n)+)/.exec(overlay)
  expect(block).not.toBeNull()
  const denied = block![1]!.split('\n').map(l => l.trim().split(':')[0]!).filter(Boolean)
  expect(denied.length).toBeGreaterThan(20)
  for (const policy of denied) {
    expect(`${policy} is deny`).toBe(`${policy} is deny`)
  }
  // read must stay callable, and `read` is the whole point.
  expect(denied).not.toContain('read')
  // Nothing may be granted `allow`, which would invert a deny.
  expect(overlay).not.toMatch(/^\s+allow$/m)
})

test('S2: --advisor is passed, so the advisor is not off by default', () => {
  for (const [name, args] of built) {
    expect(`${name}: ${args.includes('--advisor')}`).toBe(`${name}: true`)
  }
})

test('S2: the advisor is forced on rather than left to a user setting', () => {
  // advisor.enabled is default:false with protocolDefault rpc/acp, so a TUI
  // launch inherits false. --advisor is an ephemeral override (main.ts:1878),
  // applied before the interactive host is built, so it reaches the TUI too.
  const args = interactive
  const advisor = args.indexOf('--advisor')
  const tools = args.indexOf('--tools=read')
  expect(advisor).toBeGreaterThan(-1)
  expect(advisor).toBeLessThan(tools)
})

test('the hardening flags precede the prompt so nothing overrides them', () => {
  for (const [name, args] of built) {
    const lastHard = Math.max(
      args.indexOf('--config'),
      args.indexOf('--advisor'),
      args.indexOf('--no-extensions'),
    )
    const prompt = args.indexOf('--append-system-prompt')
    expect(`${name}: ${lastHard < prompt}`).toBe(`${name}: true`)
  }
})

test('the lock-down overlay lives inside the repo, not in the user config', () => {
  // The whole point of --config is that it overrides ~/.omp/agent/config.yml
  // without editing it. An overlay outside the repo would be unversioned.
  expect(LOCKDOWN.startsWith(resolve(REPO))).toBe(true)
})

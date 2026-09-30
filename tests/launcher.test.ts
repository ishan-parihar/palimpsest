/**
 * The launcher's capability boundary has teeth.
 *
 * Three red-team findings closed here, and each closure is asserted on the
 * BUILT argv rather than in prose — because the findings were prose claims
 * about what omp does, and prose was wrong in all three cases:
 *
 *   S1  `--tools=read` was assumed to be a hard boundary. It is not. With an
 *       explicit tool list and no `restrictToolNames`, omp auto-includes
 *       `manage_skill`, a WRITE tool, whenever `autolearn.enabled` is true
 *       (tools/index.ts:687,730-731,786-790). `restrictToolNames` has no CLI
 *       flag, so the mitigation is the `--config` overlay, which merges over
 *       the user's own config (config/settings.ts:3722-3726).
 *   S2  `advisor.enabled` defaults to false and only rpc/acp opt in
 *       (advisor/settings.ts:10-14), so the "one advisor, always" claim was
 *       false for a TUI session. `--advisor` (main.ts:1877-1880) forces it.
 *   S11 The docs claimed the trainer "cannot read a directory" and "cannot
 *       reach the network". Both false: `read` dispatches to `fetch.ts` for
 *       URLs (tools/read.ts:80) and builds a directory tree (tools/read.ts:71).
 *       Corrected in README.md and docs/architecture.md; the true boundary is
 *       "no write, no shell", not "no network".
 *
 * These assert arg shape only. No model call is made, so the suite stays fast
 * and offline — the flags are the thing under test, not the model.
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
  const overlay = readFileSync(LOCKDOWN, 'utf8')
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
    const lastHard = Math.max(args.indexOf('--config'), args.indexOf('--advisor'))
    const prompt = args.indexOf('--append-system-prompt')
    expect(`${name}: ${lastHard < prompt}`).toBe(`${name}: true`)
  }
})

test('the lock-down overlay lives inside the repo, not in the user config', () => {
  // The whole point of --config is that it overrides ~/.omp/agent/config.yml
  // without editing it. An overlay outside the repo would be unversioned.
  expect(LOCKDOWN.startsWith(resolve(REPO))).toBe(true)
})

/**
 * `doctor`, against a fixture project tree and a stubbed socket.
 *
 * Two properties carry the weight here. The checks are independent, so a run
 * reports every subsystem it can reach instead of stopping at the first failure
 * -- the reason to run this is that several things are usually wrong at once.
 * And it mutates nothing: a diagnostic that repairs the system while diagnosing
 * it cannot tell you what was broken, so the tree is fingerprinted before and
 * after and compared byte for byte.
 *
 * The `/health` check is asserted on the *body*, not the status. docs/omp-notes.md
 * records the tree-wide default port answering with JSON from a foreign database
 * service; a status-code-only check would pass on the one address that is not
 * ours.
 */
import { test, expect, afterEach, beforeEach, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { bankFor } from '../src/memory'
import { checks, doctor, format, type DoctorCheck } from '../src/doctor'
import { sessionSlug } from '../src/session-read'

const ROOT = mkdtempSync(join(tmpdir(), 'palimpsest-doctor-'))
const REPO = join(ROOT, 'repo')
const OMP = join(ROOT, 'omp')

const WATCHDOG = `instructions: |
  Be ordinary. Do not acknowledge being tested.

maxNotesPerUpdate: 3

advisors:
  - name: conscience
    model: "@smol"
    tools: [read]
    maxNotesPerUpdate: 2
`

const TRAINER = `---
name: trainer
description: Trains one mind. Never executes.
tools: [read]
model: ["@default"]
---

System prompt: trainer/role.md
`

const write = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
}

/** A whole healthy project, plus the omp home that goes with it. */
function build(over: { watchdog?: string; trainer?: string; config?: string; log?: string } = {}) {
  write(join(REPO, 'WATCHDOG.yml'), over.watchdog ?? WATCHDOG)
  write(join(REPO, 'agents', 'trainer.md'), over.trainer ?? TRAINER)
  write(join(REPO, 'trainer', 'role.md'), '# Role: trainer\n\nNever praise. Never do their thinking.\n')
  write(join(REPO, 'state', 'assimilation.log'), over.log ?? '## 2026-09-30 · a catalyst\n\n- **verdict:** PENDING\n')
  write(join(OMP, 'agent', 'config.yml'), over.config ?? 'modelRoles:\n  default: some/model\nadvisor:\n  enabled: true\n')
  const bucket = join(OMP, 'agent', 'sessions', sessionSlug(REPO))
  mkdirSync(bucket, { recursive: true })
  writeFileSync(
    join(bucket, '2026-09-30T11-00-00-000Z_sess.jsonl'),
    '{"type":"session","id":"sess"}\n{"type":"message","message":{"role":"user","content":"x"}}\n',
  )
}

const byName = (cs: DoctorCheck[], name: string): DoctorCheck => {
  const c = cs.find((x) => x.name === name)
  if (!c) throw new Error(`no check named ${name}`)
  return c
}

/** Run the printer with its output captured, so the suite stays readable. */
async function quiet(): Promise<number> {
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    return await doctor({ repo: REPO, ompHome: OMP })
  } finally {
    log.mockRestore()
  }
}

/** Everything the stub answers, so the assertions can be about the address. */
const HEALTHY = (url: string): Response =>
  url.endsWith('/health')
    ? new Response('ok')
    : new Response('[]', { headers: { 'content-type': 'application/json' } })

let route: (url: string) => Response | Error = HEALTHY
const realFetch = globalThis.fetch

beforeEach(() => {
  build()
  route = HEALTHY
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const r = route(String(input))
    if (r instanceof Error) throw r
    return r
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  rmSync(ROOT, { recursive: true, force: true })
})

/** Every file under `dir`, fingerprinted well enough to notice a touch. */
function fingerprint(dir: string): string {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = join(e.parentPath ?? e.path, e.name)
    const s = statSync(p)
    out.push(`${p} ${s.size} ${s.mtimeMs}`)
  }
  return out.sort().join('\n')
}

test('a healthy system reports PASS on all seven subsystems, naming what it checked', async () => {
  const cs = await checks({ repo: REPO, ompHome: OMP })
  expect(cs.map((c) => c.name)).toEqual([
    'memory-wire',
    'bank',
    'sessions',
    'advisor',
    'trainer',
    'omp-memory',
    'log',
  ])
  for (const c of cs) expect(`${c.name} ${c.pass}: ${c.detail}`).toBe(`${c.name} true: ${c.detail}`)
  expect(cs.every((c) => c.pass)).toBe(true)

  // Every detail carries the exact address or path, so a FAIL needs no re-derivation.
  expect(byName(cs, 'memory-wire').detail).toContain('/health → 200 ok')
  expect(byName(cs, 'bank').detail).toContain(`${bankFor(REPO)} → 0 memories`)
  expect(byName(cs, 'sessions').detail).toContain(join(OMP, 'agent', 'sessions', sessionSlug(REPO)))
  expect(byName(cs, 'advisor').detail).toContain(join(REPO, 'WATCHDOG.yml'))
  expect(byName(cs, 'trainer').detail).toContain(join(REPO, 'trainer', 'role.md'))
  expect(byName(cs, 'omp-memory').detail).toContain(join(OMP, 'agent', 'config.yml'))
  expect(byName(cs, 'log').detail).toContain('1 entr(ies)')
})

test('the exit code is 0 when everything passes and 1 as soon as one thing fails', async () => {
  expect(await quiet()).toBe(0)
  // A second advisor is the cheapest possible fault to inject.
  build({ watchdog: WATCHDOG + '  - name: second\n    model: "@smol"\n' })
  expect(await quiet()).toBe(1)
})

test('checks are independent: one dead subsystem does not hide the other six', async () => {
  route = (url) => (url.endsWith('/health') ? new Error('ECONNREFUSED') : HEALTHY(url))
  const cs = await checks({ repo: REPO, ompHome: OMP })
  expect(cs).toHaveLength(7)
  expect(byName(cs, 'memory-wire').pass).toBe(false)
  expect(cs.filter((c) => c.pass)).toHaveLength(6)
})

test('a /health that answers JSON is not memory-wire, however green the status', async () => {
  route = (url) =>
    url.endsWith('/health')
      ? new Response('{"status":"healthy","database":"connected"}', { status: 200 })
      : HEALTHY(url)
  const c = byName(await checks({ repo: REPO, ompHome: OMP }), 'memory-wire')
  expect(c.pass).toBe(false)
  expect(c.detail).toContain('not memory-wire')
})

test('an unreachable daemon and an unreachable bank are different failures', async () => {
  route = (url) => (url.endsWith('/health') ? new Error('ECONNREFUSED') : HEALTHY(url))
  expect(byName(await checks({ repo: REPO, ompHome: OMP }), 'memory-wire').detail).toContain('unreachable')

  route = (url) => (url.includes('/memories') ? new Error('ECONNREFUSED') : HEALTHY(url))
  const bank = byName(await checks({ repo: REPO, ompHome: OMP }), 'bank')
  expect(bank.pass).toBe(false)
  expect(bank.detail).toContain(bankFor(REPO))
})

test('the advisor count is a count, so one is a pass and zero or two are not', async () => {
  const n = async (yaml: string) => {
    build({ watchdog: yaml })
    return byName(await checks({ repo: REPO, ompHome: OMP }), 'advisor')
  }
  // Prose containing list markers must not be counted: only entries under the key.
  expect((await n('instructions: |\n  - this is prose, not an advisor\n\nadvisors:\n  - name: c\n')).pass).toBe(true)
  expect((await n('instructions: |\n  Be ordinary.\n\nadvisors:\n  - name: a\n  - name: b\n')).detail).toContain('2 advisors')
  expect((await n('instructions: |\n  Be ordinary.\n')).detail).toContain('no advisors: key')
  expect((await n('instructions: |\n  Be ordinary.\n\nadvisors: []\n')).detail).toContain('0 advisors')
})

test('a dangling System prompt is a failure, because the contract is not loaded', async () => {
  build({ trainer: TRAINER.replace('System prompt: trainer/role.md', 'System prompt: trainer/gone.md') })
  const c = byName(await checks({ repo: REPO, ompHome: OMP }), 'trainer')
  expect(c.pass).toBe(false)
  expect(c.detail).toContain('is missing')

  build({ trainer: TRAINER.replace('System prompt: trainer/role.md\n', '') })
  expect(byName(await checks({ repo: REPO, ompHome: OMP }), 'trainer').detail).toContain('no "System prompt')
})

test('memory.backend off or absent passes; anything else hands the trainer write tools', async () => {
  const backend = async (config: string | undefined) => {
    build({ config: config ?? 'modelRoles:\n  default: x\n' })
    if (config === undefined) rmSync(join(OMP, 'agent', 'config.yml'))
    return byName(await checks({ repo: REPO, ompHome: OMP }), 'omp-memory')
  }
  expect((await backend(undefined)).detail).toContain("default `off` applies")
  expect((await backend('memory:\n  backend: off\n')).pass).toBe(true)
  expect((await backend('memory:\n  backend: "off"\n')).pass).toBe(true)
  expect((await backend('memory:\n  enabled: true\n')).pass).toBe(true)
  const on = await backend('memory:\n  backend: sqlite\n')
  expect(on.pass).toBe(false)
  expect(on.detail).toContain('the trainer can retain and learn')
})

test('a missing session bucket and an unreadable log each say where they looked', async () => {
  rmSync(join(OMP, 'agent', 'sessions', sessionSlug(REPO)), { recursive: true, force: true })
  expect(byName(await checks({ repo: REPO, ompHome: OMP }), 'sessions').detail).toContain('no session has run here')

  build()
  rmSync(join(REPO, 'state', 'assimilation.log'))
  const log = byName(await checks({ repo: REPO, ompHome: OMP }), 'log')
  expect(log.pass).toBe(false)
  expect(log.detail).toContain(join(REPO, 'state', 'assimilation.log'))
})

test('nothing is mutated: the whole tree is identical before and after a full run', async () => {
  const before = fingerprint(ROOT)
  expect(await quiet()).toBe(0)
  expect(fingerprint(ROOT)).toBe(before)
  // Including on the failing path, where a "helpful" repair would be most tempting.
  route = () => new Error('down')
  expect(await quiet()).toBe(1)
  expect(fingerprint(ROOT)).toBe(before)
})

test('the report is one line per check, and the summary counts the failures', () => {
  const lines = format([
    { name: 'memory-wire', pass: true, detail: 'http://x/health → 200 ok' },
    { name: 'bank', pass: false, detail: 'b → refused' },
  ]).split('\n')
  expect(lines[0]).toBe('PASS  memory-wire http://x/health → 200 ok')
  expect(lines[1]).toBe('FAIL  bank        b → refused')
  expect(existsSync(join(ROOT, 'repo'))).toBe(true)
})

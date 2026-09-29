/**
 * The Phase 3 gate, against a real memory-wire server on a scratch --db.
 * docs/plan.md: "an `integrated` record promotes to episodic; a `rejected` record
 * is still retrievable with `veracity: 'false'`. Fails if rejection deletes."
 *
 * The server under test is started here, on a free loopback port, against a
 * `mktemp` database -- never the daemon the CLI talks to, and never anybody
 * else's bank. A gate that only proves a mock behaves is decoration, and this one
 * is about what the store does behind the call: dedup on a byte-identical retain
 * is what decides whether a verdict can move, so it is asserted rather than
 * assumed.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bankConfig,
  bankFor,
  baseUrl,
  listMemories,
  persistRecord,
  recall,
  verdictTag,
  type PersistOptions,
} from '../src/memory'
import type { Record as AssimilationRecord } from '../src/record'

const BINARY = `${process.env.HOME}/.local/bin/memory-wire`
const HEALTH_BODY = 'ok'

// The repo root, so the bank derivation under test is the real one.
const REPO = join(import.meta.dirname, '..')

let server: ChildProcess | undefined
let dir = ''
let addr = ''
const before = process.env.PALIMPSEST_MEMORY_ADDR

/** A free loopback port, found by letting the OS pick one. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
  const { port } = probe
  await probe.stop(true)
  if (!port) throw new Error('could not find a free loopback port')
  return port
}

/** Poll /health until the body is exactly `ok` -- a 200 from anything else is not memory-wire. */
async function healthy(url: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) return false
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok && (await res.text()).trim() === HEALTH_BODY) return true
    } catch {
      // not listening yet
    }
    await Bun.sleep(50)
  }
  return false
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'palimpsest-memory-'))
  addr = `http://127.0.0.1:${await freePort()}`
  // `serve` binds in the foreground and exits nonzero on a taken port, so a bind
  // race surfaces as a dead child rather than a test that talks to someone else.
  server = spawn(BINARY, ['serve', '--addr', addr.replace('http://', ''), '--db', join(dir, 'scratch.db')], {
    stdio: 'ignore',
  })
  expect(await healthy(addr, 15_000)).toBe(true)
  process.env.PALIMPSEST_MEMORY_ADDR = addr
})

afterAll(async () => {
  if (before === undefined) delete process.env.PALIMPSEST_MEMORY_ADDR
  else process.env.PALIMPSEST_MEMORY_ADDR = before
  server?.kill('SIGTERM')
  // memory-wire drains in-flight requests on SIGTERM, so wait for the drain
  // rather than yanking the socket out from under it.
  for (let i = 0; i < 100 && server?.exitCode === null; i++) await Bun.sleep(50)
  server?.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

/** A bank per test, so row counts are exact and no test can see another's rows. */
const opts = (name: string): PersistOptions => ({ bank: `${bankFor(REPO)}-${name}`, sessionId: 'gate' })

const REJECTED: AssimilationRecord = {
  date: '2026-09-30',
  brought: 'My team runs a quarterly review ritual and nobody can say what it changed.',
  fired: ['Feedback loops: the ritual is a sensor for a loop nobody is watching'],
  withheld: ['Goodhart: counting the ritual, not the outcome'],
  declined: ['Network effects: nobody outside the room can see the ritual'],
  contradiction: 'Held: a review is a checkpoint. Breaks: this one only confirms attendance.',
  overreach: [],
  claim: 'The quarterly ritual survives because cancelling it would name a decision nobody made.',
  falsifier: 'They skip two quarters in a row and nothing downstream changes.',
  verdict: 'rejected',
  propagated: [],
}

test('the client is pointed at the server the test started', () => {
  expect(baseUrl()).toBe(addr)
  expect(bankFor(REPO)).toMatch(/^palimpsest-[a-z0-9]+$/)
})

test('a rejected record is retained with an id, and recalled back', async () => {
  const bank = opts('roundtrip')
  const id = await persistRecord(REJECTED, bank)
  expect(typeof id).toBe('string')
  expect(id.length).toBeGreaterThan(0)

  const hits = await recall('quarterly review ritual decision', { bank: bank.bank })
  expect(hits.length).toBeGreaterThan(0)
  const mine = hits.find((h) => h.id === id)
  expect(mine).toBeDefined()
  // The verdict leads the content, so a human reading a recalled line sees the
  // ruling without a second lookup.
  expect(mine?.content.startsWith('verdict: rejected')).toBe(true)
  expect(mine?.content).toContain('cancelling it would name a decision nobody made')
  expect(mine?.score).toBeGreaterThan(0)
})

test('a rejected row is retrievable by its verdict tag, and invisible without it', async () => {
  const bank = opts('tags')
  const id = await persistRecord(REJECTED, bank)
  const byTag = await recall('quarterly ritual', { bank: bank.bank, tags: [verdictTag('rejected')] })
  expect(byTag.map((h) => h.id)).toContain(id)
  // A tag nothing carries returns [], which is the only reason a tag filter is
  // worth having at all.
  const other = await recall('quarterly ritual', { bank: bank.bank, tags: [verdictTag('integrated')] })
  expect(other).toEqual([])
  expect(verdictTag('not-my-language')).toBe('verdict:not-my-language')
})

test('settling a record appends the new verdict and never edits the rejected one', async () => {
  const bank = opts('settle')
  const rejected = await persistRecord(REJECTED, bank)
  // The same record ruled the other way. Retain dedups on a byte-identical
  // content hash, so if the verdict were not in the content this would hand back
  // `rejected` and the row would keep saying `rejected` -- silently.
  const integrated = await persistRecord({ ...REJECTED, verdict: 'integrated' }, bank)
  expect(integrated).not.toBe(rejected)

  const rows = await listMemories(bank.bank)
  expect(rows.length).toBe(2)
  // The rejection is still there, still ruling itself false, still addressable.
  expect(rows.find((r) => r.id === rejected)?.content.startsWith('verdict: rejected')).toBe(true)
  const byTag = await recall('quarterly ritual', { bank: bank.bank, tags: [verdictTag('rejected')] })
  expect(byTag.map((h) => h.id)).toEqual([rejected])
})

test('rewriting the same record at the same verdict is a no-op, not a second row', async () => {
  const bank = opts('dedup')
  const first = await persistRecord(REJECTED, bank)
  expect(await persistRecord(REJECTED, bank)).toBe(first)
  expect((await listMemories(bank.bank)).length).toBe(1)
})

test('nothing is deleted inside the test window, and no ttl was ever asked for', async () => {
  const bank = opts('retain')
  const ids: string[] = []
  for (let i = 0; i < 12; i++) {
    ids.push(await persistRecord({ ...REJECTED, claim: `claim number ${i} about the ritual` }, bank))
  }
  const rows = await listMemories(bank.bank)
  expect(rows.length).toBe(ids.length)
  for (const id of ids) expect(rows.map((r) => r.id)).toContain(id)

  // The whole forgetting policy is one opt-in key, and nobody set it. memory-wire
  // has no scheduler at all, so a bank without `ttl_days` cannot lose a row to
  // age -- the property the previous implementation had to engineer out of a
  // 24h working-memory trim, and here it is a single assertion.
  expect(await bankConfig(bank.bank)).not.toHaveProperty('ttl_days')
})

test('the claim and its falsifier travel as context, not as body', async () => {
  const bank = opts('context')
  const id = await persistRecord(REJECTED, bank)
  const row = (await listMemories(bank.bank)).find((r) => r.id === id)
  expect(row?.context).toContain('claim: The quarterly ritual survives')
  expect(row?.context).toContain('falsifier: They skip two quarters')
  // `withheld` and `declined` are the fields nobody counts, so they have to sit in
  // the searchable body where recall can rank them.
  expect(row?.content).toContain('withheld: Goodhart')
  expect(row?.content).toContain('declined: Network effects')
})

test('banks are isolated, so a record is not readable from another bank', async () => {
  const bank = opts('isolated')
  const id = await persistRecord(REJECTED, bank)
  expect(await recall('quarterly ritual', { bank: `${bank.bank}-elsewhere` })).toEqual([])
  expect((await recall('quarterly ritual', { bank: bank.bank })).map((h) => h.id)).toContain(id)
})

test('a blank bank id is refused locally, not sent as a 400 round trip', async () => {
  await expect(persistRecord(REJECTED, { bank: '  ', sessionId: 'gate' })).rejects.toThrow(/bank must be/)
  await expect(persistRecord(REJECTED, { bank: 'x', sessionId: '' })).rejects.toThrow(/sessionId must be/)
})

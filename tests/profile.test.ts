/**
 * The user profile, Phase 4. Five things, each of which can fail on its own:
 *
 *   1. an empty log REFUSES rather than producing an empty profile
 *   2. the trigger boundary: nine records are silent, the tenth synthesizes
 *   3. drift is a real difference against the previous profile
 *   4. a prior nobody has reached for in 90 days drops, with a note saying so
 *   5. replace is replace: one always-current document, not an accumulating pile
 *
 * Plus the two properties that are not visible in any output: the advisor tally
 * reads BOTH places omp writes a note (inline in the transcript, and in the
 * per-session sidecar subdirectory) and counts each session's notes once; and the
 * trainer cannot reach the profile at all.
 *
 * The store under test is a memory-wire started here, on a free loopback port,
 * against a `mktemp` database — never the daemon the CLI talks to, and never a
 * real bank. Every log, ledger, session bucket and fixture tree is a temp dir too,
 * so the committed `state/` and the real `~/.omp` are never read for anything but
 * the one read-only assertion below.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { append, settle, type Assimilation, type Verdict } from '../src/assimilate'
import { listMemories, replaceDocument } from '../src/memory'
import { consumed } from '../src/record-session'
import {
  BANK,
  DOCUMENT_ID,
  EVERY,
  TAGS,
  advisorRootFor,
  advisorTally,
  autoSynthesize,
  decode,
  encode,
  persist,
  render,
  shouldSynthesize,
  stored,
  synthesize,
  type UserProfile,
} from '../src/profile'

const REPO = join(import.meta.dirname, '..')
const BINARY = `${process.env.HOME}/.local/bin/memory-wire`
const NOW = '2026-09-30T00:00:00.000Z'

const TMP = mkdtempSync(join(tmpdir(), 'palimpsest-profile-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

let n = 0
/** A log, a ledger and a session bucket per test, so nothing here is shared. */
const sandbox = () => {
  const base = join(TMP, `t${n++}`)
  const bucket = join(base, 'sessions')
  mkdirSync(bucket, { recursive: true })
  return { log: join(base, 'assimilation.log'), ledger: join(base, 'consumed.json'), bucket }
}

/** Append one record to a sandbox log, and admit it to its ledger as a session. */
function record(box: ReturnType<typeof sandbox>, a: Partial<Assimilation> & { verdict: Verdict }): void {
  append({ date: '2026-09-01', catalyst: 'a catalyst', ...a }, box.log)
  const ledger = consumed(box.ledger)
  writeFileSync(box.ledger, JSON.stringify([...ledger, { file: `${box.log}#${n}`, sessionId: `s${n}`, date: a.date ?? '2026-09-01' }]))
}

/** A run of `count` records, all PENDING, so the trigger is the only variable. */
function fill(box: ReturnType<typeof sandbox>, count: number, from = 1): void {
  for (let i = 0; i < count; i++)
    record(box, { date: '2026-09-01', catalyst: `catalyst ${from + i}`, claim: `claim ${from + i}`, verdict: 'PENDING' })
}

// ---------------------------------------------------------------- 1. the refusal

test('an empty log refuses loudly and writes no profile', () => {
  const box = sandbox()
  expect(() => synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })).toThrow(
    /no assimilations to synthesize/,
  )
  // The refusal has to be about the ABSENCE of records, not about a profile that
  // happens to be empty: an empty profile would be indistinguishable from a user
  // who has assimilated nothing and been judged on it.
  expect(existsSync(box.log) ? readFileSync(box.log, 'utf8') : '').toBe('')
})

test('a log of records with nothing in them is still a profile', () => {
  const box = sandbox()
  record(box, { verdict: 'integrated' })
  const p = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
  expect(p.window.assimilations).toBe(1)
  expect(p.frameworks.integrated).toEqual([])
  expect(render(p)).toContain('— none recorded')
})

// -------------------------------------------------------------- 2. the trigger

test('the trigger fires on every 10th assimilation and on no other', () => {
  expect(shouldSynthesize(0)).toBe(false)
  expect(shouldSynthesize(1)).toBe(false)
  expect(shouldSynthesize(9)).toBe(false)
  expect(shouldSynthesize(10)).toBe(true)
  expect(shouldSynthesize(11)).toBe(false)
  expect(shouldSynthesize(19)).toBe(false)
  expect(shouldSynthesize(20)).toBe(true)
  expect(shouldSynthesize(100)).toBe(true)
  expect(EVERY).toBe(10)
})

test('nine records are silent and the tenth synthesizes', async () => {
  const box = sandbox()
  const opts = { log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW, bank: 'silent-bank' }
  for (let i = 1; i <= 9; i++) {
    record(box, { date: '2026-09-01', catalyst: `catalyst ${i}`, claim: `claim ${i}`, verdict: 'PENDING' })
    expect(await autoSynthesize(opts)).toBeUndefined()
  }
  record(box, { date: '2026-09-30', catalyst: 'catalyst 10', claim: 'claim 10', verdict: 'PENDING' })
  const line = await autoSynthesize(opts)
  expect(line).toContain('10 assimilations')
  expect(line).toContain('user profile v1')
  // The store was written, not just announced: a notice about a profile that was
  // never persisted is worse than silence.
  expect((await stored('silent-bank'))?.version).toBe(1)
})

test('the trigger line survives a store that is down, and says the profile was not written', async () => {
  const box = sandbox()
  fill(box, 10)
  // The address, not the bank name: a nonsense bank against a live server retains
  // perfectly well, so the only way to exercise the failure is to point the client
  // at a port nothing is listening on.
  const live = process.env.PALIMPSEST_MEMORY_ADDR
  process.env.PALIMPSEST_MEMORY_ADDR = 'http://127.0.0.1:1'
  try {
    const line = await autoSynthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
    expect(line).toContain('the profile was not written')
  } finally {
    if (live === undefined) delete process.env.PALIMPSEST_MEMORY_ADDR
    else process.env.PALIMPSEST_MEMORY_ADDR = live
  }
})

// ------------------------------------------------------------- 3. the roll-up

test('every framework list counts, cites its log dates, and splits by verdict', () => {
  const box = sandbox()
  record(box, { date: '2026-09-01', touch: ['Goodhart: counting the ritual'], claim: 'a', verdict: 'integrated' })
  record(box, { date: '2026-09-10', touch: ['Goodhart: counting the review'], claim: 'b', verdict: 'integrated' })
  record(box, { date: '2026-09-20', touch: ['Incentives: paying for volume'], claim: 'c', verdict: 'rejected' })
  record(box, { date: '2026-09-25', overreach: ['Scoring too far'], claim: 'd', verdict: 'integrated' })

  const p = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
  const goodhart = p.frameworks.integrated[0]!
  // Two records named Goodhart with different moves after the colon; the framework
  // is what repeats, and a count that read 1 for both would be counting moves.
  expect(goodhart.framework).toBe('Goodhart')
  expect(goodhart.count).toBe(2)
  expect(goodhart.dates).toEqual(['2026-09-01', '2026-09-10'])
  expect(goodhart.last_seen).toBe('2026-09-10')
  expect(p.frameworks.rejected.map((f) => f.framework)).toEqual(['Incentives'])
  expect(p.frameworks.overreached.map((f) => f.framework)).toEqual(['Scoring too far'])
  expect(p.verdicts).toEqual({ integrated: 3, rejected: 1, not_my_language: 0, pending: 0 })
  expect(p.window).toEqual({ assimilations: 4, sessions: 4, since: '2026-09-01' })
})

test('discrimination, contradictions and open threads are kept verbatim with their dates', () => {
  const box = sandbox()
  record(box, {
    date: '2026-09-02',
    declined: ['Network effects: nobody outside the room can see the ritual'],
    withheld: ['Incentives: paying for volume rewards volume'],
    contradiction: 'Held: a review is a checkpoint. Breaks: this one only confirms attendance.',
    claim: 'settled already',
    verdict: 'integrated',
  })
  record(box, { date: '2026-09-03', claim: 'still open', falsifier: 'they skip two quarters', verdict: 'PENDING' })
  // "none" is the trainer saying it found nothing, so it is not a contradiction.
  record(box, { date: '2026-09-04', contradiction: 'none', claim: 'also open', verdict: 'PENDING' })

  const p = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
  expect(p.discrimination.declined).toEqual([
    { entry: 'Network effects: nobody outside the room can see the ritual', dates: ['2026-09-02'] },
  ])
  expect(p.discrimination.withheld[0]!.dates).toEqual(['2026-09-02'])
  expect(p.contradictions).toHaveLength(1)
  expect(p.contradictions[0]!.what).toContain('Breaks: this one only confirms attendance')
  expect(p.contradictions[0]!.count).toBe(1)
  // A pending claim is an open thread, and a claim with no falsifier still is one —
  // the missing falsifier is the thing the user needs to see, not a reason to hide it.
  expect(p.open_threads.map((t) => t.claim)).toEqual(['also open', 'still open'])
  expect(p.open_threads.find((t) => t.claim === 'still open')!.falsifier).toBe('they skip two quarters')
  expect(p.open_threads.find((t) => t.claim === 'also open')!.falsifier).toBeUndefined()
})

test('the window counts sessions from the ledger, so a digest is not counted as one', () => {
  const box = sandbox()
  record(box, { claim: 'from a session', verdict: 'PENDING' })
  // A one-shot digest appends to the log and never touches the ledger.
  append({ date: '2026-09-02', catalyst: 'a document', claim: 'from a digest', verdict: 'PENDING' }, box.log)
  const p = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
  expect(p.window.assimilations).toBe(2)
  expect(p.window.sessions).toBe(1)
})

// ----------------------------------------------------------------- 4. expiry

test('a prior older than 90 days drops, with a note naming what went stale', () => {
  const box = sandbox()
  record(box, { date: '2026-01-01', touch: ['Stale: nobody has reached for this since January'], verdict: 'integrated' })
  record(box, { date: '2026-09-20', touch: ['Fresh'], verdict: 'integrated' })
  const p = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })

  expect(p.frameworks.integrated.map((f) => f.framework)).toEqual(['Fresh'])
  const note = p.drift.find((d) => d.what === 'expired: Stale')!
  expect(note.from).toBe('last seen 2026-01-01')
  expect(note.to).toContain('over 90d')
  expect(render(p)).toContain('expired: Stale')
})

test('expiry is measured from last_seen, so a refreshed prior does not expire', () => {
  const box = sandbox()
  record(box, { date: '2026-01-01', touch: ['Revived'], verdict: 'integrated' })
  record(box, { date: '2026-09-25', touch: ['Revived'], verdict: 'integrated' })
  const p = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
  expect(p.frameworks.integrated).toHaveLength(1)
  expect(p.frameworks.integrated[0]!.last_seen).toBe('2026-09-25')
  expect(p.drift).toEqual([])
})

test('an entry with no usable date is kept, because expiry is a claim about staleness', () => {
  const box = sandbox()
  record(box, { date: '?', touch: ['Undated'], verdict: 'integrated' })
  const p = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
  expect(p.frameworks.integrated.map((f) => f.framework)).toEqual(['Undated'])
  expect(p.drift).toEqual([])
})

// ----------------------------------------------------------------- 5. drift

test('drift is a real difference against the previous profile, and empty without one', () => {
  const box = sandbox()
  record(box, { date: '2026-09-01', touch: ['Goodhart'], claim: 'first', verdict: 'integrated' })
  const first = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
  expect(first.version).toBe(1)
  expect(first.drift).toEqual([])

  record(box, { date: '2026-09-10', claim: 'second', falsifier: 'f', verdict: 'PENDING' })
  record(box, { date: '2026-09-12', touch: ['Incentives'], claim: 'third', verdict: 'integrated' })
  const second = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW, previous: first })
  expect(second.version).toBe(2)
  const what = second.drift.map((d) => d.what)
  // The verdict tallies moved, a framework entered, and a pending claim is gone.
  expect(what).toContain('verdicts.pending')
  expect(what).toContain('frameworks.integrated/Incentives')
  expect(second.drift.find((d) => d.what === 'verdicts.pending')).toEqual({
    what: 'verdicts.pending',
    from: '0',
    to: '1',
  })
})

test('drift reports a settled thread, and expiry is not reported twice', () => {
  const box = sandbox()
  record(box, { date: '2026-09-01', touch: ['Old'], claim: 'settled long ago', verdict: 'integrated' })
  record(box, { date: '2026-09-02', claim: 'the open one', verdict: 'PENDING' })
  const first = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
  expect(first.open_threads).toHaveLength(1)
  expect(first.frameworks.integrated.map((f) => f.framework)).toEqual(['Old'])

  // A long gap: the prior goes stale AND the thread is settled in one step, both by
  // the real writers -- `settle` rewrites the log line, the clock moves four months.
  expect(settle('integrated', box.log)).toBe(true)
  const second = synthesize({
    log: box.log,
    ledger: box.ledger,
    advisorRoot: box.bucket,
    now: '2027-01-01T00:00:00.000Z',
    previous: first,
  })
  const expiries = second.drift.filter((d) => d.what === 'expired: Old')
  const absences = second.drift.filter((d) => d.what === 'frameworks.integrated/Old')
  expect(expiries).toHaveLength(1)
  // A framework that expired is not ALSO reported as having left the list; the
  // expiry is the reason it left, and two entries for one change is a drift list
  // nobody reads.
  expect(absences).toEqual([])
  expect(second.drift.some((d) => d.what === 'open_threads' && d.to === 'settled')).toBe(true)
})

// ------------------------------------------------------------- 6. the advisor

/** One omp session header, so the file is shaped like a real transcript. */
const header = (cwd: string) =>
  JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-09-20T00:00:00.000Z', cwd }) + '\n'

const inlineNote = (severity: string, body: string) =>
  JSON.stringify({
    type: 'custom_message',
    customType: 'advisor',
    content: `<advisory severity="${severity}">\n${body}\n</advisory>`,
    details: { notes: [{ note: body, severity }] },
    id: 'c1',
    timestamp: '2026-09-20T00:01:00.000Z',
  }) + '\n'

/** A sidecar as the critic's own agent session: one `advise` tool call. */
const adviseCall = (severity: string, body: string) =>
  JSON.stringify({
    type: 'message',
    id: 'm1',
    message: { role: 'assistant', content: [{ type: 'toolCall', name: 'advise', arguments: { note: body, severity } }] },
  }) + '\n'

test('advisor notes are read from the per-session sidecar subdirectory', () => {
  const box = sandbox()
  const stem = '2026-09-20T00-00-00-000Z_aaaa'
  writeFileSync(join(box.bucket, `${stem}.jsonl`), header(REPO))
  mkdirSync(join(box.bucket, stem), { recursive: true })
  writeFileSync(
    join(box.bucket, stem, '__advisor.conscience.jsonl'),
    adviseCall('blocker', 'the trainer praised the user') + adviseCall('nit', 'the number was unchecked'),
  )
  // Nothing at the bucket top: the sidecar lives in the session's own directory.
  expect(advisorTally(box.bucket)).toEqual({ blocker: 1, concern: 0, nit: 1 })
})

test('advisor notes are read from the transcript when there is no sidecar', () => {
  const box = sandbox()
  writeFileSync(
    join(box.bucket, '2026-09-21T00-00-00-000Z_bbbb.jsonl'),
    header(REPO) + inlineNote('concern', 'no falsifier beside the claim'),
  )
  expect(advisorTally(box.bucket)).toEqual({ blocker: 0, concern: 1, nit: 0 })
})

test('one session with notes in BOTH places is counted once, not twice', () => {
  const box = sandbox()
  const stem = '2026-09-22T00-00-00-000Z_cccc'
  const body = 'the same note, written twice by omp'
  // The inline copy is HTML-escaped for display, exactly as omp writes it, so a
  // text-matching dedup would fail to recognise these as one note.
  writeFileSync(join(box.bucket, `${stem}.jsonl`), header(REPO) + inlineNote('concern', body.replace('>', '&gt;')))
  mkdirSync(join(box.bucket, stem), { recursive: true })
  writeFileSync(join(box.bucket, stem, '__advisor.jsonl'), adviseCall('concern', body))
  expect(advisorTally(box.bucket)).toEqual({ blocker: 0, concern: 1, nit: 0 })
})

test('a severity this build has never seen is tallied, not dropped', () => {
  const box = sandbox()
  writeFileSync(join(box.bucket, '2026-09-23T00-00-00-000Z_dddd.jsonl'), header(REPO) + inlineNote('critique', 'a sixth check'))
  expect(advisorTally(box.bucket).critique).toBe(1)
})

test('a bucket with nothing in it is three zeroes, not a missing key', () => {
  expect(advisorTally(join(TMP, 'no-such-bucket'))).toEqual({ blocker: 0, concern: 0, nit: 0 })
})

test('the real bucket is read from both places and counted once', () => {
  // Not a number assertion: a committed test cannot depend on how many sessions
  // this box has run. What it pins is the SHAPE — if only one source were read,
  // the sessions that have no sidecar (the newest ones) would contribute nothing,
  // and if both were summed every session that has both would count twice. So the
  // assertion is that both halves of the bucket are reached, and that the real
  // bucket is the one the two fixture cases above model.
  const root = advisorRootFor(REPO)
  if (!existsSync(root)) return
  const tally = advisorTally(root)
  for (const key of ['blocker', 'concern', 'nit']) expect(tally[key]).toBeGreaterThanOrEqual(0)
  expect(Object.values(tally).every((n) => Number.isInteger(n) && n >= 0)).toBe(true)
})

// -------------------------------------------------------------- 7. the store

let server: ChildProcess | undefined
let addr = ''
const before = process.env.PALIMPSEST_MEMORY_ADDR

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('ok') })
  const { port } = probe
  await probe.stop(true)
  if (!port) throw new Error('could not find a free loopback port')
  return port
}

async function healthy(url: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })
      if (res.ok && (await res.text()).trim() === 'ok') return true
    } catch {
      /* not listening yet */
    }
    await Bun.sleep(50)
  }
  return false
}

beforeAll(async () => {
  const dir = join(TMP, 'store')
  mkdirSync(dir, { recursive: true })
  addr = `http://127.0.0.1:${await freePort()}`
  server = spawn(BINARY, ['serve', '--addr', addr.replace('http://', ''), '--db', join(dir, 'scratch.db')], {
    stdio: 'ignore',
  })
  expect(await healthy(addr, 15_000)).toBe(true)
  process.env.PALIMPSEST_MEMORY_ADDR = addr
})

afterAll(() => {
  if (before === undefined) delete process.env.PALIMPSEST_MEMORY_ADDR
  else process.env.PALIMPSEST_MEMORY_ADDR = before
  server?.kill('SIGTERM')
  rmSync(TMP, { recursive: true, force: true })
})

test('the stored profile round-trips through the document', async () => {
  const box = sandbox()
  record(box, { date: '2026-09-01', touch: ['Goodhart'], claim: 'c', verdict: 'integrated' })
  const p = synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
  const bank = 'palimpsest-profile-roundtrip'
  await persist(p, bank)
  const back = await stored(bank)
  expect(back?.version).toBe(p.version)
  expect(back?.frameworks.integrated[0]!.framework).toBe('Goodhart')
  expect(back?.window.since).toBe('2026-09-01')
})

test('a second synthesis REPLACES the first: one row, and it is the new one', async () => {
  const box = sandbox()
  const bank = 'palimpsest-profile-replace'
  record(box, { date: '2026-09-01', touch: ['Goodhart'], claim: 'first', verdict: 'integrated' })
  await persist(synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW }), bank)

  // Nine more records take it to the trigger, and the synthesis they cause is v2.
  fill(box, 8, 2)
  record(box, { date: '2026-09-20', touch: ['Incentives'], claim: 'second', verdict: 'rejected' })
  const second = await autoSynthesize({
    log: box.log,
    ledger: box.ledger,
    advisorRoot: box.bucket,
    now: NOW,
    bank,
  })
  expect(second).toContain('v2')

  // One document id, one row: the snapshot replaced rather than accumulated. A pile
  // of superseded profiles is a pile of facts about the user that have since been
  // contradicted, which is the whole reason replace is the right mode here. The
  // superseded v1 row is the thing that must be gone -- not the frameworks it
  // recorded, which are still in the log and still true.
  const rows = await listMemories(bank)
  expect(rows).toHaveLength(1)
  expect(rows[0]!.content).toContain('palimpsest-user-profile v2')
  expect(rows.filter((r) => r.content.includes('palimpsest-user-profile v1'))).toEqual([])
  const back = await stored(bank)
  expect(back?.version).toBe(2)
  expect(back?.drift.map((d) => d.what)).toContain('frameworks.rejected/Incentives')
})

test('the document is tagged palimpsest+profile and lives under the profile document id', async () => {
  const box = sandbox()
  const bank = 'palimpsest-profile-tags'
  record(box, { date: '2026-09-01', claim: 'c', verdict: 'PENDING' })
  await persist(synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW }), bank)
  const row = (await listMemories(bank))[0]!
  expect(row.content.startsWith('palimpsest-user-profile v1')).toBe(true)
  expect(row.context).toContain('user profile v1')
  expect(DOCUMENT_ID).toBe('profile')
  expect([...TAGS]).toEqual(['palimpsest', 'profile'])
})

test('an empty document and a blank id are refused locally, not sent as a 400 round trip', async () => {
  await expect(replaceDocument('x', { bank: ' ', documentId: 'profile', tags: [] })).rejects.toThrow(/bank must be/)
  await expect(replaceDocument('x', { bank: 'b', documentId: '  ', tags: [] })).rejects.toThrow(/documentId must be/)
  await expect(replaceDocument('   ', { bank: 'b', documentId: 'profile', tags: [] })).rejects.toThrow(/content must be/)
})

test('a row that is not a profile is not mistaken for one', async () => {
  const bank = 'palimpsest-profile-foreign'
  await replaceDocument('verdict: integrated\nbrought: a record', { bank, documentId: 'other', tags: ['palimpsest'] })
  expect(await stored(bank)).toBeUndefined()
  expect(decode('not a profile at all')).toBeUndefined()
  expect(decode('palimpsest-user-profile v1\n{not json')).toBeUndefined()
  expect(decode(encode(synthesizeFixture()))?.version).toBe(1)
})

/** A server that answers with one status for everything, standing in for a store. */
async function stub(status: number): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('nope', { status }) })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

test('a bank that does not exist yet is a first run, not a fault', async () => {
  // memory-wire creates a bank on its first retain, so before the first synthesis
  // there is nothing to list and a 404 is the honest answer. Read as a failure it
  // would make `palimpsest profile` exit 3 on a fresh install forever.
  const store = await stub(404)
  const live = process.env.PALIMPSEST_MEMORY_ADDR
  process.env.PALIMPSEST_MEMORY_ADDR = store.url
  try {
    expect(await stored('never-existed')).toBeUndefined()
  } finally {
    if (live === undefined) delete process.env.PALIMPSEST_MEMORY_ADDR
    else process.env.PALIMPSEST_MEMORY_ADDR = live
    await store.stop()
  }
})

test('any OTHER store fault propagates — "no previous profile" is not a diagnosis', async () => {
  const store = await stub(500)
  const live = process.env.PALIMPSEST_MEMORY_ADDR
  process.env.PALIMPSEST_MEMORY_ADDR = store.url
  try {
    await expect(stored('broken')).rejects.toThrow(/500/)
  } finally {
    if (live === undefined) delete process.env.PALIMPSEST_MEMORY_ADDR
    else process.env.PALIMPSEST_MEMORY_ADDR = live
    await store.stop()
  }
})

function synthesizeFixture(): UserProfile {
  const box = sandbox()
  record(box, { date: '2026-09-01', claim: 'c', verdict: 'PENDING' })
  return synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
}

// ------------------------------------------------------------ 8. the firewall

test('the trainer cannot reach the profile: no tool, no prompt, no reachable file', () => {
  // The firewall is the absence of a path, so it is asserted as an absence. A
  // profile the trainer could read would be ideal praise fuel, and praise is the
  // failure this system exists to catch (AGENTS.md rule 2).
  const trainerFacing = [
    'agents/trainer.md',
    'trainer/role.md',
    'trainer/digest.md',
    'trainer/probe.md',
    'trainer/falsify.md',
    'WATCHDOG.yml',
    'config/locked-down.yml',
    'src/omp.ts',
  ]
  for (const file of trainerFacing)
    expect(readFileSync(join(REPO, file), 'utf8')).not.toMatch(/profile/i)
})

test('the profile is never written to disk, so nothing about the user is committable', () => {
  const box = sandbox()
  record(box, { date: '2026-09-01', claim: 'c', verdict: 'integrated' })
  const before = [...new Bun.Glob('**/*').scanSync({ cwd: TMP, dot: true })]
  synthesize({ log: box.log, ledger: box.ledger, advisorRoot: box.bucket, now: NOW })
  const after = [...new Bun.Glob('**/*').scanSync({ cwd: TMP, dot: true })]
  // A profile is derived from the log in one command; a second committed copy of
  // the same facts about a person only widens who can read them.
  expect(after.sort()).toEqual(before.sort())
  expect(readFileSync(join(REPO, 'state', 'assimilation.log'), 'utf8')).toBe('')
})

test('the schema is exactly the nine keys, so a later change is visible as a version jump', () => {
  const p = synthesizeFixture()
  expect(Object.keys(p).sort()).toEqual(
    [
      'advisor',
      'contradictions',
      'discrimination',
      'drift',
      'frameworks',
      'open_threads',
      'updated_at',
      'verdicts',
      'version',
      'window',
    ].sort(),
  )
  expect(BANK).toBe('palimpsest-profile')
})

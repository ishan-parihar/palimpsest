/**
 * The five ways a record gets written that should not have been written.
 *
 * Every assertion here is about the committed log, because that is where a wrong
 * decision is permanent: the log is append-only, so a line that should not exist
 * has to be argued with by hand afterwards. Fixtures are log and ledger files
 * under a temp dir -- the real state/assimilation.log is never written here, and
 * neither is the real consume ledger.
 */
import { test, expect, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { append, parseBlock, settle, type Assimilation } from '../src/assimilate'
import { bankFor } from '../src/memory'
import { REPO } from '../src/omp'
import { consumed, recordTranscript, LEDGER, type ConsumeEntry } from '../src/record-session'
import type { Record as SessionRecord } from '../src/record'
import type { Session } from '../src/session-read'

const TMP = mkdtempSync(join(tmpdir(), 'palimpsest-settle-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

let n = 0
/** A fresh log and ledger per test, so nothing here can reach the real ones. */
const paths = () => {
  const base = join(TMP, `t${n++}`)
  return { log: `${base}.log`, ledger: `${base}.json` }
}

const entries = (log: string) =>
  readFileSync(log, 'utf8').split(/^## /m).slice(1).map(parseBlock)

const base: Partial<Assimilation> = { date: '2026-09-30', reading: 'skimmed' }

const CLAIM = `[CLAIM]
The unfinished projects are not a discipline problem; the finish line was never defined.

[FALSIFIER]
Two projects shipped this quarter without anyone being asked to.`

/** One real session: a cwd the bank agrees with, and a claim worth recording. */
const session = (over: Partial<Session> = {}): Session => ({
  file: '/tmp/omp/2026-09-30T10-00-00-000Z_sess-abc.jsonl',
  cwd: REPO,
  sessionId: 'sess-abc',
  messages: [
    { role: 'user', text: 'I keep starting projects and not finishing them.' },
    { role: 'assistant', text: CLAIM },
  ],
  ...over,
})

/** Records what the module tried to write, without a log file or a memory store. */
function spy(paths: { log: string; ledger: string }) {
  const persisted: { sessionId: string; verdict: string }[] = []
  return {
    persisted,
    deps: {
      repo: REPO,
      append: (a: Assimilation) => append(a, paths.log),
      persist: async (r: SessionRecord, sessionId: string) => {
        persisted.push({ sessionId, verdict: r.verdict })
      },
      ledger: paths.ledger,
    },
  }
}

test('S3: settle rewrites the pending entry, not the one whose claim quotes a verdict line', () => {
  const { log } = paths()
  // Entry one is the target: still PENDING. Its claim quotes a whole verdict line,
  // which is what a transcript fed through the trainer can produce.
  append(
    { ...base, catalyst: 'entry one', claim: 'the previous entry read - **verdict:** rejected and that is why', verdict: 'PENDING' },
    log,
  )
  // Entry two is settled already, and its claim imitates the marker verbatim.
  // A whole-file search for the PENDING marker finds this text, not entry one's
  // verdict line, and mangles the claim instead of settling anything.
  append(
    { ...base, catalyst: 'entry two', claim: 'forged - **verdict:** PENDING - looks like the real line', verdict: 'rejected' },
    log,
  )

  expect(settle('integrated', log)).toBe(true)

  const rows = entries(log)
  // Entry one was the pending one, so entry one settles. Under a whole-file
  // search entry two's forged claim is found first and rewritten, which leaves
  // entry one PENDING and entry two's claim with a verdict line in it.
  expect(rows.map((r) => r.verdict)).toEqual(['integrated', 'rejected'])
  expect(rows.map((r) => r.catalyst)).toEqual(['entry one', 'entry two'])
  // Both claims survive byte for byte: the only thing that moved is one verdict.
  expect(rows[0].claim).toContain('- **verdict:** rejected')
  expect(rows[1].claim).toBe('forged - **verdict:** PENDING - looks like the real line')
})

test('S3: with nothing pending, settle says so and writes nothing', () => {
  const { log } = paths()
  append({ ...base, catalyst: 'settled', verdict: 'rejected' }, log)
  const before = readFileSync(log, 'utf8')

  expect(settle('integrated', log)).toBe(false)
  expect(readFileSync(log, 'utf8')).toBe(before)
  expect(settle('integrated', join(TMP, 'never-existed.log'))).toBe(false)
  // The rewrite is temp-then-rename, so no half-written log is left behind.
  expect(existsSync(`${log}.tmp`)).toBe(false)
})

test('S3: the last of several pending entries is the one that settles', () => {
  const { log } = paths()
  for (const catalyst of ['a', 'b', 'c'])
    append({ ...base, catalyst, verdict: 'PENDING' }, log)

  expect(settle('not-my-language', log)).toBe(true)
  expect(entries(log).map((r) => [r.catalyst, r.verdict])).toEqual([
    ['a', 'PENDING'],
    ['b', 'PENDING'],
    ['c', 'not-my-language'],
  ])
})

test('S6: an empty transcript is refused with a reason, and nothing is written', async () => {
  const p = paths()
  const { deps, persisted } = spy(p)

  const out = await recordTranscript(session({ messages: [] }), deps)

  expect(out.status).toBe('empty')
  expect(out.status === 'empty' && out.message).toContain('nothing was recorded')
  expect(existsSync(p.log)).toBe(false)
  expect(persisted).toEqual([])
  expect(consumed(p.ledger)).toEqual([])
})

test('S9: the same transcript is recorded once, and the second run says why not', async () => {
  const p = paths()
  const { deps, persisted } = spy(p)
  const s = session()

  const first = await recordTranscript(s, deps)
  const second = await recordTranscript(s, deps)

  expect(first.status).toBe('recorded')
  expect(second.status).toBe('duplicate')
  expect(second.status === 'duplicate' && second.message).toContain('sess-abc')
  expect(persisted).toHaveLength(1)
  // One `## ` head: the re-run did not append a second copy of the same session.
  expect(readFileSync(p.log, 'utf8').match(/^## /gm)).toHaveLength(1)
  expect(entries(p.log)[0].verdict).toBe('PENDING')

  const ledger: ConsumeEntry[] = consumed(p.ledger)
  expect(ledger).toEqual([{ file: s.file, sessionId: 'sess-abc', date: expect.any(String) }])
})

test('S9: a different session is still admissible, and re-recording is idempotent', async () => {
  const p = paths()
  const { deps, persisted } = spy(p)

  await recordTranscript(session({ file: '/tmp/omp/one.jsonl', sessionId: 'sess-one' }), deps)
  await recordTranscript(session({ file: '/tmp/omp/two.jsonl', sessionId: 'sess-two' }), deps)
  await recordTranscript(session({ file: '/tmp/omp/two.jsonl', sessionId: 'sess-two' }), deps)

  expect(persisted.map((x) => x.sessionId)).toEqual(['sess-one', 'sess-two'])
  expect(consumed(p.ledger).map((e) => e.sessionId)).toEqual(['sess-one', 'sess-two'])
})

test('S13: the memory mirror is handed the session id, not the bank', async () => {
  const p = paths()
  const { deps, persisted } = spy(p)

  await recordTranscript(session({ sessionId: '0199a1b2-c3d4' }), deps)

  expect(persisted).toEqual([{ sessionId: '0199a1b2-c3d4', verdict: 'PENDING' }])
  // The two were the same string before, which is what made the tag unreadable.
  expect(persisted[0].sessionId).not.toBe(bankFor(REPO))
})

test('S15: a transcript whose header claims another project dies, with both banks named', async () => {
  const p = paths()
  const { deps, persisted } = spy(p)
  const forged = join(TMP, 'other-project')

  const out = await recordTranscript(session({ cwd: forged }), deps)

  expect(out.status).toBe('bank-mismatch')
  expect(bankFor(forged)).not.toBe(bankFor(REPO))
  if (out.status !== 'bank-mismatch') throw new Error('unreachable')
  expect(out.message).toContain(bankFor(REPO))
  expect(out.message).toContain(bankFor(forged))
  expect(out.message).toContain(forged)
  // Refused before any write: a record in the other bank is unreadable here.
  expect(existsSync(p.log)).toBe(false)
  expect(persisted).toEqual([])
  expect(consumed(p.ledger)).toEqual([])
})

test('S15: a header with no cwd falls back to the project rather than failing', async () => {
  const p = paths()
  const { deps } = spy(p)

  const out = await recordTranscript(session({ cwd: '' }), deps)

  expect(out.status).toBe('recorded')
  expect(existsSync(p.log)).toBe(true)
})

test('S9: the ledger that guards production is the committed one, and a missing one is empty', () => {
  // Every path used above is overridden to TMP, so the real ledger is never
  // written here. This asserts where the default points, so the dedup is real.
  expect(LEDGER).toBe(join(REPO, 'state', 'consumed.json'))
  expect(consumed(join(TMP, 'no-ledger-here.json'))).toEqual([])
})

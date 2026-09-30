/**
 * The session reader, against a fixture filesystem shaped like a real one.
 *
 * These are the gates on the format facts, not on the code: a reader that
 * silently skips every assistant turn, or that reads the advisor's own
 * transcript, produces a record that is empty or wrong rather than an error.
 * Both look like "nothing was recorded" to the user, so both are asserted here.
 */
import { test, expect, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { parse } from '../src/record'
import { readEvents, readLatest, sessionSlug } from '../src/session-read'

/**
 * The fixture home is a temp directory under the REAL home, not under $HOME:
 * os.homedir() ignores $HOME in Bun, so a fake one would silently send every
 * lookup back to the actual account and every test would pass vacuously.
 */
const HOME = mkdtempSync(join(homedir(), '.palimpsest-sessions-'))
const PROJECT = join(HOME, 'Documents', 'repo')

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
const slugFor = (p: string) => `-${relative(real(homedir()), real(p)).split(sep).join('-')}`
const BUCKET = join(homedir(), '.omp', 'agent', 'sessions', slugFor(PROJECT))

afterAll(() => rmSync(HOME, { recursive: true, force: true }))

const line = (o: unknown) => `${JSON.stringify(o)}\n`

/** The on-disk transcript fixtures, which carry whole files rather than parts. */
const fixture = (n: string) => join(import.meta.dirname, 'fixtures', 'sessions', `${n}.jsonl`)

/** The physical head of a real file: a padded title slot, then the header. */
const head = (id: string, cwd = PROJECT) =>
  line({
    type: 'title',
    v: 1,
    title: '',
    updatedAt: '2026-09-30T10:00:00.000Z',
    pad: ' '.repeat(64),
  }) +
  line({ type: 'session', version: 3, id, timestamp: '2026-09-30T10:00:00.000Z', cwd })

const message = (role: string, content: unknown, id = 'e1') =>
  line({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-09-30T10:00:01.000Z',
    message: { role, content, timestamp: 1759226401000 },
  })

const write = (name: string, body: string) => {
  mkdirSync(BUCKET, { recursive: true })
  writeFileSync(join(BUCKET, name), body)
}

const ASSIMILATION = `[CLAIM]
The unfinished projects are not a discipline problem; the finish line was never defined.

[FALSIFIER]
Two projects shipped this quarter without anyone being asked to.`

// An older session, so "latest" is a real choice rather than the only file.
write(
  '2026-09-28T09-00-00-000Z_sess-old.jsonl',
  head('sess-old') + message('user', 'OLD-SESSION-TURN', 'o1') + message('assistant', 'OLD-SESSION-ANSWER', 'o2'),
)

// The newest real session. Tool calls and tool results are the noise the reader
// has to drop: a toolCall is a content block inside an assistant turn, never a
// role, and toolResult is the camelCase role -- matching `tool_result` finds
// nothing and fails silently.
write(
  '2026-09-30T10-00-00-000Z_sess-new.jsonl',
  head('sess-new') +
    line({ type: 'model_change', id: 'm1', parentId: null, timestamp: 'x', model: 'test/model' }) +
    message('user', [{ type: 'text', text: 'I keep starting projects without finishing them.' }], 'u1') +
    message(
      'assistant',
      [
        { type: 'thinking', thinking: 'PRIVATE-THINKING' },
        { type: 'text', text: ASSIMILATION },
        { type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: '/secrets/PRIVATE-TOOLCALL' } },
      ],
      'a1',
    ) +
    message('toolResult', [{ type: 'text', text: 'PRIVATE-TOOLRESULT' }], 't1') +
    message('assistant', 'and here is the rest of the thought', 'a2') +
    // A session is appended to while it is read: the last line can be half-written.
    '{"type":"message","id":"a3","message":{"role":"assistant","content":[{"type":"tex',
)

// The advisor's own sidecar, in the same directory, carrying a marker-shaped
// block. Reading it would record the critic's words as the trainer's.
//
// FORWARD-COMPAT, and inert against reality: omp 18.3.1 writes the advisor's
// notes INLINE as `custom_message` entries, and none of the 27 real transcripts
// in this project's bucket has a sidecar file at all. The filter stays because
// excluding the critic's own transcript is still the right answer for a file
// that does exist.
write('__advisor.jsonl', head('adv') + message('assistant', '[CLAIM]\nPRIVATE-ADVISOR', 'v1'))
write('__advisor.conscience.jsonl', head('adv2') + message('assistant', 'PRIVATE-ADVISOR-2', 'v2'))

// Artifacts live in a sibling directory named after the session file.
mkdirSync(join(BUCKET, '2026-09-30T10-00-00-000Z_sess-new'), { recursive: true })

test('sessionSlug: home-relative, with a leading dash and dashes for separators', () => {
  expect(sessionSlug(PROJECT)).toBe(slugFor(PROJECT))
  expect(sessionSlug(PROJECT)).toMatch(/^-[\w.-]+$/)
  expect(sessionSlug(real(homedir()))).toBe('-')
  expect(sessionSlug(join(PROJECT, 'nested'))).toBe(`${slugFor(PROJECT)}-nested`)
})

test('sessionSlug: temp root and absolute paths get their own encodings', () => {
  expect(sessionSlug('/definitely/not/home')).toBe('--definitely-not-home--')
  // omp checks home before temp, so the temp encoding only applies when the
  // temp root is not itself under home -- the case on Linux and macOS.
  if (!real(tmpdir()).startsWith(`${real(homedir())}${sep}`)) {
    const probe = join(real(tmpdir()), 'palimpsest-probe')
    expect(sessionSlug(probe)).toBe(`-tmp-${relative(real(tmpdir()), real(probe)).split(sep).join('-')}`)
  }
})

test('readLatest: the newest session, and its header is the ground truth for cwd', () => {
  const s = readLatest(PROJECT)
  expect(s).toBeDefined()
  expect(s!.file).toBe(join(BUCKET, '2026-09-30T10-00-00-000Z_sess-new.jsonl'))
  expect(s!.sessionId).toBe('sess-new')
  expect(s!.cwd).toBe(real(PROJECT))
})

test('assistant text is extracted from content blocks, in order', () => {
  const texts = readLatest(PROJECT)!
    .messages.filter((m) => m.role === 'assistant')
    .map((m) => m.text)
  expect(texts).toEqual([ASSIMILATION, 'and here is the rest of the thought'])
})

test('toolCall blocks, thinking, toolResult turns and the advisor are all dropped', () => {
  const all = readLatest(PROJECT)!.messages.map((m) => `${m.role}:${m.text}`).join('\n')
  for (const leak of [
    'PRIVATE-TOOLCALL',
    'PRIVATE-TOOLRESULT',
    'PRIVATE-THINKING',
    'PRIVATE-ADVISOR',
    'OLD-SESSION',
  ])
    expect(all).not.toContain(leak)
  expect(readLatest(PROJECT)!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant'])
})

test('a user turn may be a plain string rather than blocks', () => {
  const dir = join(homedir(), '.omp', 'agent', 'sessions', slugFor(join(HOME, 'Documents', 'legacy')))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '2026-09-27T09-00-00-000Z_s.jsonl'),
    head('s', join(HOME, 'Documents', 'legacy')) + message('user', 'a plain string turn', 'u1'),
  )
  expect(readLatest(join(HOME, 'Documents', 'legacy'))!.messages).toEqual([
    { role: 'user', text: 'a plain string turn' },
  ])
})

test('no bucket and an empty bucket are both undefined, not a crash', () => {
  expect(readLatest(join(HOME, 'Documents', 'never-ran'))).toBeUndefined()
  const empty = join(homedir(), '.omp', 'agent', 'sessions', slugFor(join(HOME, 'Documents', 'empty')))
  mkdirSync(empty, { recursive: true })
  expect(readLatest(join(HOME, 'Documents', 'empty'))).toBeUndefined()
})

test('the read transcript parses into a record with a claim and a falsifier', () => {
  const r = parse(readLatest(PROJECT)!.messages)
  expect(r.brought).toBe('I keep starting projects without finishing them.')
  expect(r.claim).toContain('the finish line was never defined')
  expect(r.falsifier).toContain('Two projects shipped this quarter')
  // The trainer cannot grade itself: a verdict is hard-coded PENDING at parse.
  expect(r.verdict).toBe('PENDING')
})

// The advisor's notes are not turns, so they are not in `readLatest`'s messages
// and never reach the record -- but they are in the transcript, and the point of
// reading them is that the critic's firings stop being invisible.
test('an inline custom_message is an advisor note, not a turn', () => {
  const t = readEvents(fixture('advisor'))!
  // A note is not a turn: no role, so it is not in `events` and it renumbers
  // nothing. Every entry index a finding cites still means the same entry.
  expect(t.events.map((e) => e.index)).toEqual([0, 1])
  expect(t.events.map((e) => e.role)).toEqual(['user', 'assistant'])
  expect(t.advisorNotes).toHaveLength(2)

  const [first, second] = t.advisorNotes
  expect(first!.index).toBe(0)
  expect(first!.type).toBe('advisor')
  expect(first!.severity).toBe('concern')
  // `parentId` resolves to the entry it answers, which is what makes the note's
  // cost computable: 11:00:12.621 - 11:00:12.619.
  expect(first!.parentIndex).toBe(1)
  expect(first!.afterMs).toBe(2)

  // A note whose parent is not in this transcript still reads; the gap is
  // reported as uncomputable rather than guessed at or dropped.
  expect(second!.parentIndex).toBeUndefined()
  expect(second!.afterMs).toBeUndefined()
  expect(second!.text).toContain('[FALSIFY]')
})

test('a transcript with no custom_message reports zero notes, not undefined', () => {
  // The measurement has to exist to be zero. `undefined` would make every caller
  // re-ask, and would let a writer that stopped emitting notes look identical to
  // one whose notes were never read.
  for (const name of ['golden-digest', 'golden-session', 'empty']) {
    expect(readEvents(fixture(name))!.advisorNotes).toEqual([])
  }
})

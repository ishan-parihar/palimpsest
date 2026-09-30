/**
 * `trace`, against real fixture transcripts.
 *
 * The chronology is only worth anything if it shows the tool calls, because the
 * question being asked is always "when did it reach for `read`" -- before or
 * after it spoke. So these gates are on the things that would make a trace lie:
 * a toolCall read as text, a toolResult counted as a turn, a half-written line
 * costing the whole transcript, or the advisor's own sidecar passing as the
 * trainer's.
 */
import { test, expect, afterAll, spyOn } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { line, resolve, snippet, trace } from '../src/trace'

const FIX = join(import.meta.dirname, 'fixtures', 'sessions')
const fixture = (n: string) => join(FIX, n)

/** Run a printer and collect everything it wrote, with the code it returned. */
function capture(fn: () => number): { code: number; text: string } {
  const seen: string[] = []
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => void seen.push(a.join(' ')))
  const err = spyOn(console, 'error').mockImplementation((...a: unknown[]) => void seen.push(a.join(' ')))
  try {
    return { code: fn(), text: seen.join('\n') }
  } finally {
    log.mockRestore()
    err.mockRestore()
  }
}

// The bucket is a temp directory under the REAL home, not under $HOME:
// os.homedir() ignores $HOME in Bun, so a fake one would send every lookup back
// to the actual account and the exclusion below would pass vacuously.
const HOME = mkdtempSync(join(homedir(), '.palimpsest-trace-'))
const PROJECT = join(HOME, 'Documents', 'repo')
const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
const slug = `-${relative(real(homedir()), real(PROJECT)).split(sep).join('-')}`
const BUCKET = join(homedir(), '.omp', 'agent', 'sessions', slug)
mkdirSync(BUCKET, { recursive: true })
copyFileSync(fixture('golden-session.jsonl'), join(BUCKET, '2026-09-30T11-00-00-000Z_sess.jsonl'))
// __advisor sorts AFTER "2026-..." lexically, so without the filter this file
// would be picked as the latest session. It carries a marker-shaped block, so
// reading it would certify the critic's words as the trainer's trajectory.
copyFileSync(fixture('__advisor.jsonl'), join(BUCKET, '__advisor.jsonl'))

afterAll(() => rmSync(HOME, { recursive: true, force: true }))

test('every event is one line, carrying the index a finding cites', () => {
  const t = resolve(fixture('golden-session.jsonl'))!
  expect(t.events.map((e) => e.index)).toEqual([0, 1, 2, 3, 4])
  for (const e of t.events) {
    const l = line(e)
    expect(l.split('\n')).toHaveLength(1)
    expect(l.startsWith(String(e.index).padStart(3, '0'))).toBe(true)
    expect(l).toContain(e.timestamp)
    expect(l).toContain(e.role)
  }
})

test('a toolCall is a content block, not a role, and its arguments are compacted', () => {
  const t = resolve(fixture('golden-session.jsonl'))!
  // Entry 3 is the release turn: one toolCall, zero toolResult markers. Entry 0
  // is the user's catalyst, which reaches for nothing.
  const call = t.events[3]!
  expect(call.role).toBe('assistant')
  expect(call.toolCalls).toEqual([{ name: 'read', arguments: '{"path":"SKILL.md"}' }])
  expect(call.toolResults).toBe(0)
  expect(line(call)).toContain('tool read {"path":"SKILL.md"}')
  expect(t.events[0]!.toolCalls).toEqual([])
})

test('toolResults are counted on both shapes omp writes them in', () => {
  const nested = resolve(fixture('golden-digest.jsonl'))!.events.at(-2)!
  const bare = resolve(fixture('golden-session.jsonl'))!.events.at(-1)!
  // One nested `toolResult` content block...
  expect(nested.role).toBe('toolResult')
  expect(nested.toolResults).toBe(1)
  expect(line(nested)).toContain('1 toolResult')
  // ...and one bare toolResult-role turn with no such block.
  expect(bare.role).toBe('toolResult')
  expect(bare.toolResults).toBe(1)
})

test('thinking blocks are not the trainer speaking, and tool bodies are not either', () => {
  const t = resolve(fixture('golden-digest.jsonl'))!
  const spoken = t.events.map((e) => e.text).join('\n')
  expect(spoken).toContain('[CLAIM]')
  expect(spoken).not.toContain('PRIVATE-THINKING')
  expect(spoken).not.toContain('THE-PRIVATE-TOOL-BODY')
})

test('the snippet is the first 120 chars, whitespace collapsed, on one line', () => {
  const long = 'x'.repeat(400)
  expect(snippet(long)).toHaveLength(121) // 120 plus the ellipsis
  expect(snippet(long).endsWith('…')).toBe(true)
  expect(snippet('a\n\n  b\tc')).toBe('a b c')
  const e = resolve(fixture('golden-digest.jsonl'))!.events[1]!
  expect(line(e).split('\n')).toHaveLength(1)
  expect(line(e).length).toBeLessThan(400)
})

test('a half-written last line is skipped and counted, never fatal', () => {
  const whole = resolve(fixture('golden-digest.jsonl'))!
  const torn = resolve(fixture('half-written.jsonl'))!
  expect(torn!.unparseable).toBe(1)
  // Everything before the tear survives, and the torn line added nothing.
  expect(torn!.events.map((e) => e.index)).toEqual(whole!.events.map((e) => e.index).slice(0, whole!.events.length - 1))
  expect(capture(() => trace(fixture('half-written.jsonl'))).code).toBe(0)
})

test('an empty transcript is reported as empty, not as nothing to report', () => {
  const t = resolve(fixture('empty.jsonl'))!
  expect(t.events).toEqual([])
  expect(t.unparseable).toBe(0)
  const { code, text } = capture(() => trace(fixture('empty.jsonl')))
  expect(code).toBe(0)
  expect(text).toContain('no message entries')
})

test('the advisor sidecar is not a session, even when it sorts last', () => {
  const t = resolve(PROJECT)!
  expect(t!.file.endsWith('2026-09-30T11-00-00-000Z_sess.jsonl')).toBe(true)
  expect(t!.events.map((e) => e.text).join('\n')).not.toContain('THE-PRIVATE-ADVISOR-TURN')
  expect(t!.events.map((e) => e.text).join('\n')).not.toContain('user-verdict: integrated')
})

test('the printed report names the file, the header, and the skipped lines', () => {
  const { code, text } = capture(() => trace(fixture('half-written.jsonl')))
  expect(code).toBe(0)
  expect(text).toContain('half-written.jsonl')
  expect(text).toContain('id sess-digest')
  expect(text).toContain('3 entries · 6 lines · 1 unparseable line(s) skipped')
})

test('a missing transcript is a nonzero exit, not an empty success', () => {
  const { code, text } = capture(() => trace('/definitely/not/here.jsonl'))
  expect(code).toBe(1)
  expect(text).toContain('no session transcript found')
})

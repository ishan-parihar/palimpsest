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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { line, noteLine, resolve, snippet, trace } from '../src/trace'

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
//
// FORWARD-COMPAT, and inert against reality: omp 18.3.1 writes the advisor's
// notes INLINE as `custom_message` entries (the `advisor.jsonl` fixture above),
// and none of the 27 real transcripts in this project's bucket has a sidecar at
// all. This guard is kept rather than deleted because excluding the critic's own
// transcript is still right for a file that does exist -- and a filter nothing in
// the wild exercises is a filter nobody will notice breaking.
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

test('an empty transcript is reported as empty, and as nothing to measure', () => {
  const t = resolve(fixture('empty.jsonl'))!
  expect(t.events).toEqual([])
  expect(t.unparseable).toBe(0)
  const { code, text } = capture(() => trace(fixture('empty.jsonl')))
  // 3, not 0: "the transcript had no entries" is not "the transcript is clean".
  // A caller scripting this has to be able to tell a skip from a pass, and 0
  // read as a pass is how an empty file gets filed as evidence.
  expect(code).toBe(3)
  expect(text).toContain('no message entries')
})

test('an advisor note is read, timed against its parent turn, and counted', () => {
  const t = resolve(fixture('advisor.jsonl'))!
  // Two inline `custom_message` entries, neither of which is a turn: they carry no
  // `message.role`, so the `type === "message"` filter dropped them entirely and
  // the critic's whole visible output was invisible.
  expect(t.events.map((e) => e.index)).toEqual([0, 1])
  expect(t.advisorNotes).toHaveLength(2)

  const [first, second] = t.advisorNotes
  expect(first!.type).toBe('advisor')
  expect(first!.severity).toBe('concern')
  expect(first!.parentIndex).toBe(1)
  // 11:00:12.621 - 11:00:12.619. This is the advisor's latency, and it was not
  // computable at all before, because a firing was indistinguishable from silence.
  expect(first!.afterMs).toBe(2)
  expect(first!.text).toContain('[PROPAGATE]')

  // A note whose parent is not in the transcript still reads, with the gap
  // reported as uncomputable rather than guessed at.
  expect(second!.parentIndex).toBeUndefined()
  expect(second!.afterMs).toBeUndefined()

  const l = noteLine(first!)
  expect(l).toContain('advisor/concern')
  expect(l).toContain('+2ms after entry 1')
  expect(l).toContain(first!.timestamp)
  expect(noteLine(second!)).toContain('parent turn not in this transcript')
})

test('advisor notes reach the printed report, counted and tallied by severity', () => {
  const { code, text } = capture(() => trace(fixture('advisor.jsonl')))
  expect(code).toBe(0)
  expect(text).toContain('2 advisor notes (concern 2)')
  expect(text).toContain('advisor/concern  +2ms after entry 1')
  // A transcript whose writer emits none says so, so "the advisor never fired"
  // is a measured zero rather than an absence nobody can cite.
  expect(capture(() => trace(fixture('golden-digest.jsonl'))).text).toContain('0 advisor notes')
})

test('the severity tally is the severity, not a hardcoded one', () => {
  // The corpus is not all `concern`: the 27 real transcripts carry concern 16,
  // nit 1, blocker 1. A tally reporting only `concern` would print "0 concern"
  // for a run the advisor blocked, which is the one line that must not lie.
  const dir = mkdtempSync(join(tmpdir(), 'palimpsest-advisor-'))
  const blocked = join(dir, 'blocked.jsonl')
  writeFileSync(
    blocked,
    readFileSync(fixture('advisor.jsonl'), 'utf8').replace('"severity": "concern"', '"severity": "blocker"'),
  )
  try {
    expect(capture(() => trace(blocked)).text).toMatch(/2 advisor notes \([^)]*blocker 1[^)]*concern 1[^)]*\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

test('the exit-code table and the code that implements it agree', () => {
  // The table in src/trace.ts is the repo-wide convention, and a table nothing
  // checks is a comment. The two runnables this repo can execute without a model
  // call are asserted here: `trace` itself, and `falsify`'s failure code.
  const src = (n: string) => readFileSync(join(import.meta.dirname, '..', 'src', n), 'utf8')
  const falsify = /async function falsify[\s\S]*?\n}/.exec(src('cli.ts'))![0]
  // A FAILED check is a finding. It used to exit 2, which the table reserves for
  // a harness fault, so the two most different outcomes of one command were
  // indistinguishable to a caller.
  expect(falsify).toContain('process.exit(1)')
  expect(falsify).not.toContain('process.exit(2)')
  // 3 for nothing-to-measure, 1 for a path that is not there, 0 for a chronology.
  const trace = src('trace.ts')
  expect(trace).toMatch(/return 3\s*\n/)
  expect(trace).toContain('no session transcript found')
})

test('a missing transcript is a nonzero exit, not an empty success', () => {
  const { code, text } = capture(() => trace('/definitely/not/here.jsonl'))
  expect(code).toBe(1)
  expect(text).toContain('no session transcript found')
})

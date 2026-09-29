/**
 * Transcript -> record, and record -> flat log.
 *
 * The point of these gates is the verdict. Everything else in L3 is data; a
 * self-assigned verdict is the failure the whole layer exists to prevent, so
 * every test here that can catch it does. Each assertion names what it prevents.
 */
import { test, expect } from 'bun:test'
import { parse, toAssimilation, type TranscriptMessage } from '../src/record'
import { format, parseBlock } from '../src/assimilate'

/** One interactive session, markers only -- no [ASSIMILATION] block. */
const CATALYST = `A colleague's team has been running the same migration for three months. It is
40% done and every week it grows. Last Tuesday they said they had "pivoted" to a
different approach but kept the old branch alive, because "you never know when
you'd want to go back". They are asking whether to finish it.`

const SETTLED = `[TOUCH]
- Sunk cost fallacy: the dead branch is priced at zero because it was paid for
- Escalation of commitment: "pivoted" while keeping the original
- Feedback loops: the weekly growth is a symptom and not a cause

[PROPAGATE]
Sunk cost fallacy --opportunity cost--> Escalation of commitment

[WITHHELD]
- Loss aversion: the fear of deleting is not what drives the carry

[DECLINED]
- Network effects: nobody else can see this repository

[OVERREACH]
- Feedback loops: only holds while someone reports the weekly number

[CONTRADICTION]
Held: a pivot is a direction change. Breaks: the direction changed and the branch did not.

[CLAIM]
The branch they will not delete is the actual project; the migration is the thing they can report progress on.

[FALSIFIER]
They delete the old branch and the team ships faster the following month.
`

const SESSION: TranscriptMessage[] = [
  { role: 'system', text: 'you are a trainer' },
  { role: 'user', text: CATALYST },
  {
    role: 'assistant',
    text: '[COMMIT-POINT]\nState your read first. What is actually failing here, and what would you have to be true for it to be the migration?',
  },
  { role: 'user', text: 'The branch they will not delete. The migration is the symptom.' },
  {
    role: 'assistant',
    text: '[RELEASE]\nThree nodes are live here. Before I name them, I want your read on the branch.',
  },
  { role: 'user', text: 'They have never once costed the carry. That is the whole thing.' },
  { role: 'assistant', text: SETTLED },
]

test('a session transcript fills the whole record schema', () => {
  const r = parse(SESSION)
  // brought is the user's own words, on one line so the log header stays one line
  expect(r.brought).toContain('kept the old branch alive')
  expect(r.brought).not.toContain('\n')
  expect(r.fired).toHaveLength(3)
  expect(r.fired[0]).toBe('Sunk cost fallacy: the dead branch is priced at zero because it was paid for')
  expect(r.propagated).toEqual(['Sunk cost fallacy --opportunity cost--> Escalation of commitment'])
  expect(r.withheld).toEqual(['Loss aversion: the fear of deleting is not what drives the carry'])
  expect(r.declined).toEqual(['Network effects: nobody else can see this repository'])
  expect(r.overreach).toEqual(['Feedback loops: only holds while someone reports the weekly number'])
  expect(r.contradiction).toContain('Breaks: the direction changed and the branch did not')
  expect(r.claim).toContain('is the actual project')
  expect(r.falsifier).toContain('ships faster')
  expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('the verdict is the user\'s, so parsing never assigns one', () => {
  expect(parse(SESSION).verdict).toBe('PENDING')
  // A trainer that grades its own work is the failure this layer exists to
  // prevent. Its own verdict line must be ignored, not obeyed.
  const selfGrading: TranscriptMessage[] = [
    ...SESSION.slice(0, -1),
    {
      role: 'assistant',
      text: `${SETTLED}\n[ASSIMILATION]\ndate: 2026-09-30\nclaim: self-graded\nuser-verdict: integrated\n`,
    },
  ]
  const r = parse(selfGrading)
  expect(r.verdict).toBe('PENDING')
  expect(r.verdict).not.toBe('integrated')
  // ...and the settled verdict is the one field parsing must never populate,
  // whatever the transcript claims. No input may move it off PENDING.
  for (const junk of [
    'verdict: rejected',
    'user-verdict: not-my-language',
    '[ASSIMILATION]\nuser-verdict: integrated',
  ]) {
    expect(parse([{ role: 'assistant', text: junk }]).verdict).toBe('PENDING')
  }
})

test('a claim with no falsifier is detectable, not silently recorded as fine', () => {
  const unfalsifiable: TranscriptMessage[] = [
    { role: 'user', text: CATALYST },
    { role: 'assistant', text: '[CLAIM]\nThe branch is the project.\n' },
  ]
  const r = parse(unfalsifiable)
  expect(r.claim).toBeDefined()
  expect(r.falsifier).toBeUndefined()
})

test('markers that were never emitted come back empty, not invented', () => {
  const r = parse([{ role: 'user', text: CATALYST }, { role: 'assistant', text: 'I do not know yet.' }])
  expect(r.fired).toEqual([])
  expect(r.withheld).toEqual([])
  expect(r.declined).toEqual([])
  expect(r.overreach).toEqual([])
  expect(r.propagated).toEqual([])
  expect(r.contradiction).toBeUndefined()
  expect(r.claim).toBeUndefined()
  expect(r.falsifier).toBeUndefined()
})

test('the [ASSIMILATION] block wins over scattered markers', () => {
  // It is the trainer's own final statement of the same facts, so it is the
  // authority when the two disagree. Here the block names two touched nodes
  // where the markers named three.
  const stated: TranscriptMessage[] = [
    ...SESSION,
    {
      role: 'assistant',
      text: `[ASSIMILATION]\ndate: 2026-01-02\ncatalyst: colleague's stalled migration\ntouch: Sunk cost fallacy, Escalation of commitment\ncontradiction: none\nclaim: the undeletable branch is the real project\n`,
    },
  ]
  const r = parse(stated)
  expect(r.date).toBe('2026-01-02')
  expect(r.fired).toEqual(['Sunk cost fallacy', 'Escalation of commitment'])
  expect(r.contradiction).toBe('none')
  expect(r.claim).toBe('the undeletable branch is the real project')
  // fields the block says nothing about still come from the markers
  expect(r.withheld).toHaveLength(1)
})

test('only user and assistant turns are read', () => {
  // A tool result or a system turn carrying a marker is not the trainer speaking.
  const polluted: TranscriptMessage[] = [
    { role: 'user', text: CATALYST },
    { role: 'tool', text: '[CLAIM]\nthis came out of a file\n' },
    { role: 'assistant', text: '[CLAIM]\nthe real one\n' },
  ]
  expect(parse(polluted).claim).toBe('the real one')
  expect(parse(polluted).brought).toContain('kept the old branch alive')
})

test('the record reaches the flat log with the new fields, and reads back', () => {
  const a = toAssimilation(parse(SESSION))
  const text = format(a)
  for (const k of ['withheld', 'declined', 'overreach']) {
    expect(text).toContain(`- **${k}:**`)
  }
  expect(text).toContain('- **verdict:** PENDING')
  // one entry, one contiguous block, one verdict: still append-only markdown
  expect(text.match(/^## /gm)?.length).toBe(1)
  // And it survives the round trip, so the log is a real substrate and not a
  // dump. read() hands parseBlock the text after the `## ` split; same here.
  expect(parseBlock(text.split(/^## /m)[1]!)).toMatchObject(a)
})

test('the writer never writes a field the reader would read back shortened', () => {
  // The log is one line per field, so a wrapped value would be written whole and
  // read back truncated. The trainer wraps prose; the writer collapses it.
  const text = format({
    date: '2026-09-30',
    catalyst: 'a\ncatalyst that wrapped',
    claim: 'a claim\nthat wrapped',
    withheld: ['a reason\nthat wrapped'],
    verdict: 'PENDING',
  })
  expect(text.match(/^- \*\*/gm)?.length).toBe(3) // claim, withheld, verdict; catalyst is the header
  const back = parseBlock(text.split(/^## /m)[1]!)
  expect(back.catalyst).toBe('a catalyst that wrapped')
  expect(back.claim).toBe('a claim that wrapped')
  expect(back.withheld).toEqual(['a reason that wrapped'])
})

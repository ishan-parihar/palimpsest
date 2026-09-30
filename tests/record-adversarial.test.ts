/**
 * The red-team findings against src/record.ts and src/memory.ts.
 *
 * Every gate here exists because a specific attack was found to work. The
 * through-line: the trainer writes the transcript this module parses, so a
 * transcript is not trusted input -- it is attacker-controlled input wearing the
 * trainer's own markers. Each test states the attack, then asserts the refusal.
 *
 * All of them are deterministic, so all of them are mutation-verified: delete the
 * guard, the test fails. A gate that cannot fail is decoration.
 */
import { test, expect } from 'bun:test'
import { parse, type TranscriptMessage } from '../src/record'
import { baseUrl } from '../src/memory'

/** The document the default points at, per src/memory.ts. */
const DEFAULT_ADDR = 'http://127.0.0.1:18899'

const today = (): string => new Date().toISOString().slice(0, 10)

/**
 * Run `fn` with stderr captured, and return what it wrote.
 *
 * Every refusal below announces itself, and an announcement nobody can observe is
 * an announcement that does not exist -- so the tests read the stderr, which also
 * pins the warning to the machine rather than to a human who happens to be looking.
 */
function captureStderr(fn: () => void): string {
  const original = process.stderr.write.bind(process.stderr)
  let seen = ''
  process.stderr.write = ((chunk: string | Uint8Array) => {
    seen += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return seen
}

// --- S7: a marker split across two assistant turns -------------------------
// The old code joined assistant turns with '\n\n' and the comment claimed that
// made a split marker parse. It did not: `[CLA` + `\n\n` + `IM]` is not `[CLAIM]`,
// so a trainer whose output was cut at a token boundary lost the claim silently.

test('a marker split across two assistant turns still parses', () => {
  const split = parse([
    { role: 'user', text: 'why is the migration stalling?' },
    { role: 'assistant', text: 'Here is where it converges.\n[CLA' },
    { role: 'assistant', text: 'IM]\nThe undeletable branch is the real project.\n' },
  ])
  expect(split.claim).toBe('The undeletable branch is the real project.')
})

test('a marker split mid-token is the only boundary that glues', () => {
  // The other direction: gluing every boundary would fuse `[CLAIM]\nfoo` and
  // `[FALSIFIER]\nbar` into one block, because the terminator needs the newline.
  const adjacent = parse([
    { role: 'assistant', text: '[CLAIM]\nthe claim' },
    { role: 'assistant', text: '[FALSIFIER]\nthe falsifier' },
  ])
  expect(adjacent.claim).toBe('the claim')
  expect(adjacent.falsifier).toBe('the falsifier')
})

test('a list marker split across turns keeps its entries', () => {
  const split = parse([
    { role: 'assistant', text: '[TOU' },
    { role: 'assistant', text: 'CH]\n- Sunk cost fallacy: the dead branch is priced at zero\n' },
  ])
  expect(split.fired).toEqual(['Sunk cost fallacy: the dead branch is priced at zero'])
})

// --- S8: a second [CLAIM] was silently discarded ---------------------------

test('a second [CLAIM] is truncated loudly, and the first one still wins', () => {
  const transcript: TranscriptMessage[] = [
    {
      role: 'assistant',
      text: '[CLAIM]\nThe ritual survives because cancelling it names a decision.\n\n[CLAIM]\nAnd a completely different conclusion.\n',
    },
  ]
  let record!: ReturnType<typeof parse>
  const err = captureStderr(() => {
    record = parse(transcript)
  })
  expect(record.claim).toBe('The ritual survives because cancelling it names a decision.')
  // The count, not a vague "multiple blocks": the operator has to be able to tell
  // one duplicate from a trainer that gave up and restated itself five times.
  expect(err).toMatch(/2 \[CLAIM\] blocks/)
})

test('a lone [CLAIM] warns about nothing', () => {
  const err = captureStderr(() => {
    parse([{ role: 'assistant', text: '[CLAIM]\nOnly one claim here.\n' }])
  })
  expect(err).toBe('')
})

// --- S10: MEMORY_WIRE_URL could redirect where records are written ---------

test('a foreign MEMORY_WIRE_URL cannot hijack the bank', () => {
  const palimpsest = process.env.PALIMPSEST_MEMORY_ADDR
  const wire = process.env.MEMORY_WIRE_URL
  try {
    // memory-wire's own variable, pointing somewhere a stranger chose. It used to
    // sit between ours and the default, so exporting it for any other tool on the
    // box silently moved where assimilation records land.
    delete process.env.PALIMPSEST_MEMORY_ADDR
    process.env.MEMORY_WIRE_URL = 'http://127.0.0.1:1/hijacked'
    expect(baseUrl()).toBe(DEFAULT_ADDR)
    expect(baseUrl()).not.toContain('hijacked')

    // And ours still wins when it is set, so removing the foreign one cost nothing.
    process.env.PALIMPSEST_MEMORY_ADDR = 'http://127.0.0.1:19999'
    expect(baseUrl()).toBe('http://127.0.0.1:19999')
  } finally {
    if (palimpsest === undefined) delete process.env.PALIMPSEST_MEMORY_ADDR
    else process.env.PALIMPSEST_MEMORY_ADDR = palimpsest
    if (wire === undefined) delete process.env.MEMORY_WIRE_URL
    else process.env.MEMORY_WIRE_URL = wire
  }
})

// --- S12: the trainer dated its own record ---------------------------------

test('a trainer-supplied date is validated, and an impossible one falls back', () => {
  // 1999-01-01 is shaped correctly and sorts wrong forever; `garbage` is not a
  // date at all; 2026-02-30 is a day that never happened. None of them may be
  // written into the substrate as if the trainer could be trusted with a calendar.
  for (const stated of ['1999-01-01', 'garbage', '2026-02-30', '2026-1-2', '0000-00-00']) {
    const err = captureStderr(() => {
      const r = parse([{ role: 'assistant', text: `[ASSIMILATION]\ndate: ${stated}\nclaim: x\n` }])
      expect(r.date).toBe(today())
    })
    expect(err).toMatch(/is not a real YYYY-MM-DD date/)
  }
})

test('a real date is kept verbatim, and warns about nothing', () => {
  const err = captureStderr(() => {
    const r = parse([{ role: 'assistant', text: '[ASSIMILATION]\ndate: 2026-01-02\nclaim: x\n' }])
    expect(r.date).toBe('2026-01-02')
  })
  expect(err).toBe('')
})

test('a transcript with no date at all still gets today, quietly', () => {
  const err = captureStderr(() => {
    const r = parse([{ role: 'assistant', text: '[CLAIM]\nx\n' }])
    expect(r.date).toBe(today())
  })
  // Absent is normal, not a fault: only a *stated* bad date is worth a line.
  expect(err).toBe('')
})

// --- S14: forged field labels inside a list marker -------------------------

test('a forged field label inside [TOUCH] is dropped, not recorded as a framework', () => {
  // The attack: populate `withheld` through the `fired` field the trainer was
  // given, so the reason appears twice in the record under two different fields.
  let record!: ReturnType<typeof parse>
  const err = captureStderr(() => {
    record = parse([
      {
        role: 'assistant',
        text: '[TOUCH]\n- Feedback loops: the ritual is a sensor for a loop nobody watches\n- withheld: fake\n',
      },
    ])
  })
  expect(record.fired).toEqual(['Feedback loops: the ritual is a sensor for a loop nobody watches'])
  expect(record.withheld).toEqual([])
  expect(err).toMatch(/dropped "withheld: fake" from \[TOUCH\]/)
})

test('a real framework whose name is lowercase and multi-word survives', () => {
  // The label shape is one lowercase word and no space. Over-broad matching here
  // would silently delete legitimate entries, which is the same class of damage
  // the guard exists to prevent -- pointed the other way.
  const err = captureStderr(() => {
    const r = parse([{ role: 'assistant', text: '[TOUCH]\n- network effects: nobody outside can see it\n' }])
    expect(r.fired).toEqual(['network effects: nobody outside can see it'])
  })
  expect(err).toBe('')
})

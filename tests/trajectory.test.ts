/**
 * `trajectory`, against real fixture transcripts.
 *
 * The falsifier already asserts that a marker is present, so these gates are on
 * the thing it cannot see: order, and the one verdict field the trainer has no
 * vote on. A `[CLAIM]` before a `[COMMIT-POINT]` passes every string check in
 * `src/audit.ts` and is exactly the leak this project exists to prevent.
 *
 * Every adversarial fixture here is one a plausible failure produces: the last
 * line half-written, the transcript empty, the advisor's own sidecar read as the
 * trainer's, and the trainer quietly grading its own claim.
 */
import { test, expect, spyOn } from 'bun:test'
import { join } from 'node:path'
import { analyse, detectFlow, GOLDEN, stepsOf, trajectory, type Flow, type Report } from '../src/trajectory'
import { readEvents } from '../src/session-read'

const fixture = (n: string) => join(import.meta.dirname, 'fixtures', 'sessions', `${n}.jsonl`)
const report = (name: string, flow?: Flow): Report => analyse(readEvents(fixture(name))!, flow)

/** Run a printer and collect its output and exit code. */
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

const fmt = (d: Report['divergences'][number]) =>
  `${d.expected}|${d.position}|${d.found}|${d.entry ?? '-'}`

test('the three flows differ only at the front, and all end on the user', () => {
  expect(GOLDEN.digest).toEqual(['demand', 'release', 'claim', 'falsifier', 'assimilation', 'verdict-pending'])
  expect(GOLDEN.session.filter((s) => s !== 'user-commit')).toEqual(GOLDEN.digest)
  expect(GOLDEN.session.indexOf('user-commit')).toBe(1)
  // A machine run has no commitment at all, so nothing is withheld in front of
  // the claim: it is the same contract minus the first three steps.
  expect(GOLDEN.bench).toEqual(['claim', 'falsifier', 'assimilation', 'verdict-pending'])
  for (const flow of ['bench', 'digest', 'session'] as const) {
    expect(GOLDEN[flow].slice(-3)).toEqual(['falsifier', 'assimilation', 'verdict-pending'])
    // Every flow ends on the user's verdict, never on the trainer's.
    expect(GOLDEN[flow].at(-1)).toBe('verdict-pending')
  }
})

test('a one-shot digestion CONFORMS: demand, release, one claim, falsifier, PENDING', () => {
  const r = report('golden-digest')
  expect(r.flow).toBe('digest')
  expect(r.auto).toBe(true)
  expect(r.steps.map((s) => s.token)).toEqual(GOLDEN.digest)
  expect(r.conforms).toBe(true)
  expect(capture(() => trajectory(fixture('golden-digest')))).toMatchObject({ code: 0 })
})

test('the interactive flow CONFORMS, and the commitment is what makes it one', () => {
  const r = report('golden-session')
  expect(r.flow).toBe('session')
  expect(r.steps.map((s) => s.token)).toEqual(GOLDEN.session)
  // The commitment is the user's own turn, not an assistant marker.
  const commit = r.steps.find((s) => s.token === 'user-commit')!
  expect(readEvents(fixture('golden-session'))!.events[commit.entry]!.role).toBe('user')
  expect(capture(() => trajectory(fixture('golden-session'))).text).toContain('CONFORMS')
})

test('a machine run CONFORMS against the bench flow, frameworks named and all', () => {
  // `palimpsest bench` tells the trainer to digest the input directly: it never
  // demands a read and never releases behind one. Before this, that transcript
  // diverged at position 0 -- either as a missing demand or, once the leak check
  // was made to fire, as the trainer doing the only job a machine run has.
  const r = report('bench')
  expect(r.flow).toBe('bench')
  expect(r.steps.map((s) => s.token)).toEqual(GOLDEN.bench)
  expect(r.conforms).toBe(true)
  // Skipped, and named as skipped: the check is off, not passing.
  expect(r.skipped).toMatch(/framework-leak check is skipped/)
  expect(r.steps.some((s) => s.token.startsWith('framework-named'))).toBe(false)
  expect(capture(() => trajectory(fixture('bench'))).text).toContain('CONFORMS')
})

test('naming a framework is a leak again the moment there is a release to leak in front of', () => {
  // The suppression is scoped to having no gate, not to naming cards. A
  // transcript that released without demanding has leaked whatever it is.
  const r = report('divergent')
  expect(r.skipped).toBeUndefined()
  expect(r.steps[0]!.token).toContain('framework-named')
})

test('a second digestion is sliced off, and the first one is certified', () => {
  // One digestion per transcript is the unit. 15 of the 27 real transcripts run
  // more than one, and reporting the second one's steps as divergences of the
  // first buries the real finding under six positions of noise.
  const r = report('multi-digest')
  expect(r.flow).toBe('session')
  expect(r.steps.map((s) => s.token)).toEqual(GOLDEN.session)
  expect(r.conforms).toBe(true)
  // The slice is not a filter on the transcript: the second commitment is still
  // in the file, it is simply not compared.
  const whole = stepsOf(readEvents(fixture('multi-digest'))!.events)
  expect(whole).toHaveLength(GOLDEN.session.length * 2 - 1)
  expect(capture(() => trajectory(fixture('multi-digest'))).text).toContain('CONFORMS')
})

test('a within-turn double claim is sprawl, not a second digestion, and still diverges', () => {
  // The slice cuts at the first verdict, not at the first claim, so a turn that
  // emits two `[CLAIM]`s in one block is reported -- that is the sprawl the
  // `SPRAWL` flag in bench exists to catch.
  const r = report('divergent')
  expect(r.steps.filter((s) => s.token === 'claim')).toHaveLength(2)
  expect(r.conforms).toBe(false)
})

test('a framework named before the demand, two claims, and a self-graded verdict all diverge', () => {
  const r = report('divergent')
  expect(r.conforms).toBe(false)
  // No [COMMIT-POINT] anywhere: the release is at position 0, and a card heading
  // was recited ahead of it.
  expect(r.steps[0]!.token).toContain('framework-named')
  expect(r.steps.filter((s) => s.token === 'claim')).toHaveLength(2)
  expect(r.steps.at(-1)!.token).toBe('verdict-self-graded (integrated)')
  expect(r.divergences.map(fmt)).toEqual([
    'demand|0|framework-named (feedback loops: what drives what)|1',
    'falsifier|3|claim|1',
    'assimilation|4|falsifier|1',
    'verdict-pending|5|assimilation|1',
    '(nothing)|6|verdict-self-graded (integrated)|1',
  ])
  const { code, text } = capture(() => trajectory(fixture('divergent')))
  expect(code).toBe(1)
  expect(text).toContain('EXPECTED demand AT 0, FOUND framework-named')
  expect(text).toContain('(entry 1)')
})

test('a transcript that is perfect except for its own verdict diverges at that position only', () => {
  const r = report('self-graded')
  expect(r.divergences.map(fmt)).toEqual(['verdict-pending|5|verdict-self-graded (integrated)|1'])
  expect(capture(() => trajectory(fixture('self-graded'))).code).toBe(1)
})

test('an empty transcript never reads as a pass', () => {
  const r = report('empty')
  expect(r.steps).toEqual([])
  expect(r.conforms).toBe(false)
  expect(r.divergences).toHaveLength(GOLDEN.digest.length)
  expect(r.divergences[0]).toMatchObject({ expected: 'demand', position: 0, found: 'nothing' })
  expect(r.divergences[0]!.entry).toBeUndefined()
  const { code, text } = capture(() => trajectory(fixture('empty')))
  expect(code).toBe(1)
  expect(text).toContain('EXPECTED demand AT 0, FOUND nothing (transcript ended)')
})

test('a half-written last line costs the line, not the trajectory', () => {
  const torn = readEvents(fixture('half-written'))!
  expect(torn.unparseable).toBe(1)
  const r = analyse(torn)
  expect(r.conforms).toBe(true)
  expect(capture(() => trajectory(fixture('half-written'))).text).toContain('CONFORMS')
})

// FORWARD-COMPAT: omp 18.3.1 writes the advisor's notes inline as
// `custom_message` entries, so this file is not a shape the writer produces --
// none of the 27 real transcripts in this project's bucket carries a sidecar.
// Kept anyway: a sidecar is still the critic's own transcript, and if one ever
// reappears, reading it would certify the critic's words as the trainer's.
test('the advisor sidecar is the critic, and never certifies a trajectory', () => {
  const r = analyse(readEvents(fixture('__advisor'))!)
  expect(r.conforms).toBe(false)
  // It self-graded, which is the whole reason the critic's words are not the
  // trainer's record.
  expect(r.steps.some((s) => s.token.startsWith('verdict-self-graded'))).toBe(true)
  // It went straight to a claim, so it is detected as a machine run -- and it
  // still fails, because the verdict is the same contract on every flow. Naming
  // the flow is not a way to launder a self-graded record.
  expect(r.flow).toBe('bench')
  expect(capture(() => trajectory(fixture('__advisor'))).code).toBe(1)
})

test('a declared flow overrides detection, so a broken session flow cannot pass as one-shot', () => {
  const r = report('golden-digest', 'session')
  expect(r.auto).toBe(false)
  // The commitment is missing, and because the diff is positional everything
  // after it is reported one slot out. That cascade is the report: position 1 is
  // the real finding, and the rest is the consequence.
  expect(r.divergences.map(fmt)).toEqual([
    'user-commit|1|release|1',
    'release|2|claim|1',
    'claim|3|falsifier|1',
    'falsifier|4|assimilation|1',
    'assimilation|5|verdict-pending|1',
    'verdict-pending|6|nothing|-',
  ])
  expect(capture(() => trajectory(fixture('golden-digest'), 'session')).code).toBe(1)
})

test('an unknown flow is a usage error, not a silent detection', () => {
  const { code, text } = capture(() => trajectory(fixture('golden-digest'), 'nonsense' as 'digest'))
  expect(code).toBe(1)
  expect(text).toContain('unknown flow')
})

test('a missing transcript is nonzero, never a vacuous pass', () => {
  const { code, text } = capture(() => trajectory('/definitely/not/here.jsonl'))
  expect(code).toBe(1)
  expect(text).toContain('no such session file')
})

// --- the pieces, on their own ------------------------------------------------

test('leak detection runs on a supplied signature set, with no atlas needed', () => {
  const events = readEvents(fixture('divergent'))!.events
  const sigs = ['lag and delayed feedback']
  expect(stepsOf(events, sigs).some((s) => s.token.startsWith('framework-named'))).toBe(false)

  // The same transcript, told to look for a name it does contain.
  const found = stepsOf(events, ['feedback loops: what drives what'])
  expect(found[0]!.token).toBe('framework-named (feedback loops: what drives what)')
  expect(found[0]!.entry).toBe(1)
})

test('a name quoted after the demand is not a leak, even in the same turn', () => {
  // The one-shot turn carries [COMMIT-POINT] and then the whole digestion, which
  // names cards in its [TOUCH]/declined lines. Turn-granular checking called
  // that a leak and made a conforming transcript diverge at position 0.
  const steps = stepsOf(readEvents(fixture('golden-digest'))!.events, ['network effects'])
  expect(steps[0]!.token).toBe('demand')
  expect(steps.some((s) => s.token.startsWith('framework-named'))).toBe(false)
})

test('runs of user turns after the demand are one commitment, not many', () => {
  const events = readEvents(fixture('golden-session'))!.events
  const chatty = [events[0]!, events[1]!, { ...events[2]!, index: 2 }, { ...events[2]!, index: 3 }, events[3]!]
  expect(chatty.filter((e) => e.role === 'user')).toHaveLength(3)
  expect(chatty.filter((e) => e.role === 'assistant').length).toBeLessThan(3)
  const commits = stepsOf(chatty, []).filter((s) => s.token === 'user-commit')
  expect(commits).toHaveLength(1)
})

test('detection is a user-turn count, so a missing commitment needs the declared flow', () => {
  const events = readEvents(fixture('golden-session'))!.events
  expect(detectFlow(events)).toBe('session')
  expect(detectFlow(readEvents(fixture('golden-digest'))!.events)).toBe('digest')
  // A machine run is detected by the shape of its front, not by its user turns:
  // one turn, and it went straight to a claim.
  expect(detectFlow(readEvents(fixture('bench'))!.events)).toBe('bench')
  // The limit of detection, stated rather than hidden: strip the commitment turn
  // and the transcript is indistinguishable from a one-shot, so nothing in the
  // file can say which flow it was. That is what the declared flow is for.
  const noCommit = events.filter((e) => e.role !== 'user' || e.index === 0)
  expect(detectFlow(noCommit)).toBe('digest')
  expect(analyse({ ...readEvents(fixture('golden-session'))!, events: noCommit }, 'session').conforms).toBe(false)
})

test('an empty transcript stays the stricter contract, not a machine run', () => {
  // `bench` is claimed only when a claim is there to recognise. A file with no
  // markers at all is reported against `digest` -- silence is a divergence, and
  // excusing it as a machine run would read as a pass.
  const empty = readEvents(fixture('empty'))!
  expect(detectFlow(empty.events)).toBe('digest')
  expect(analyse(empty).flow).toBe('digest')
})

test('a declared bench flow overrides detection, so a broken machine run cannot pass', () => {
  // A transcript with a demand cannot be waved through as a machine run by
  // naming the flow; the declared contract is the one that gets compared.
  const r = report('golden-digest', 'bench')
  expect(r.auto).toBe(false)
  expect(r.divergences.length).toBeGreaterThan(0)
  expect(capture(() => trajectory(fixture('golden-digest'), 'bench')).code).toBe(1)
})

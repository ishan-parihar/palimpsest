/**
 * Golden-trajectory divergence.
 *
 * The falsifier checks that a marker is present; it cannot check that the markers
 * arrived in the order that makes them worth anything. A `[CLAIM]` before a
 * `[COMMIT-POINT]` passes every string check in `src/audit.ts` and is exactly the
 * leak the whole design exists to prevent. So the unit here is the ordered
 * sequence, not the token set.
 *
 * Two flows matter, and they differ only in the middle:
 *
 *   digest   one-shot. Demand and release can share a turn, because there is no
 *            user turn between them. This is `digest`/`bench` -- and the README
 *            names it as the known limit of the withhold property.
 *   session  interactive. The user's own turn sits between the demand and the
 *            release; that turn is the commitment, and its absence is the whole
 *            mechanic.
 *
 * Both end identically: exactly one `[CLAIM]`, exactly one `[FALSIFIER]`, and an
 * `[ASSIMILATION]` whose `user-verdict` is still `PENDING`. A transcript that
 * grades itself is reported as a divergence at that position, not as a pass --
 * the verdict is the user's, and `record.ts` hardwires it for the same reason.
 *
 * One digestion per transcript is the unit of comparison. A transcript carrying
 * two of them diverges from position 6 onward, which is the honest report: this
 * command certifies one trajectory, not a session log.
 *
 * A `falsify`/`bench` transcript diverges at position 0 by design. Those runs
 * instruct the trainer to skip the interactive loop and not emit
 * `[COMMIT-POINT]`, so they never exercise commitment-before-disclosure, and a
 * command that called them conforming would be reading silence as a pass. Use it
 * on a `digest` or `session` transcript, or declare `digest` explicitly.
 */
import { cardNames } from './atlas'
import { readEvents, type SessionEvents, type SessionEvent } from './session-read'

export type Flow = 'digest' | 'session'

/**
 * The two golden sequences, in order. `user-commit` is the only difference
 * between them; everything after it is the same contract.
 */
export const GOLDEN: Record<Flow, string[]> = {
  digest: ['demand', 'release', 'claim', 'falsifier', 'assimilation', 'verdict-pending'],
  session: ['demand', 'user-commit', 'release', 'claim', 'falsifier', 'assimilation', 'verdict-pending'],
}

export type Step = { token: string; entry: number }

export type Divergence = {
  expected: string
  position: number
  /** `nothing` when the transcript ran out -- silence is reported, never a pass. */
  found: string
  entry?: number
}

export type Report = {
  flow: Flow
  /** Whether the flow was detected or declared by the caller. */
  auto: boolean
  steps: Step[]
  divergences: Divergence[]
  conforms: boolean
  /** Set when the atlas index could not be read, so the leak check was skipped. */
  skipped?: string
}

const isAssistant = (r: string) => r === 'assistant' || r === 'model'
const isUser = (r: string) => r === 'user' || r === 'human'

/** The structural markers, in the order a turn that has all of them writes them. */
const MARKERS: [RegExp, string][] = [
  [/\[COMMIT-POINT\]/g, 'demand'],
  [/\[RELEASE\]/g, 'release'],
  [/\[CLAIM\]/g, 'claim'],
  [/\[FALSIFIER\]/g, 'falsifier'],
  [/\[ASSIMILATION\]/g, 'assimilation'],
]

/**
 * Every marker in one turn, with where it sits in the text.
 *
 * Ordered by position rather than by a fixed enumeration, because a turn that
 * emits `[ASSIMILATION]` before its `[CLAIM]` is a real divergence and must be
 * reported as one. `record.ts` takes the *first* block of each marker and cannot
 * see that ordering at all; counting and placing them is a different operation,
 * not a second parser.
 */
function markersIn(text: string): { pos: number; token: string }[] {
  const at: { pos: number; token: string }[] = []
  for (const [re, token] of MARKERS)
    for (const m of text.matchAll(re)) at.push({ pos: m.index ?? 0, token })
  return at.sort((a, b) => a.pos - b.pos)
}

/**
 * Atlas card names, for the one thing markers cannot show: a framework said out
 * loud before the commitment. Measured against the real index rather than by
 * regex, the same ground truth `audit.measure()` counts -- so this command and
 * the falsifier cannot disagree about what cards exist. Hyphens are normalised
 * on both sides because the index stores `systems-thinking` and prose writes
 * "systems thinking"; lengths under 8 are dropped so a short card name cannot
 * fire inside an ordinary word.
 *
 * `audit.withhold` runs a looser prefix heuristic for prose leaks; that stays
 * its job. What this command adds is the ordering the prefix heuristic cannot
 * see, so a leak reported here is a leak after the release as well as before the
 * demand.
 *
 * Unavailable atlas is a skip, not a failure: the structural check still stands.
 */
function leakSignatures(): string[] | undefined {
  try {
    return cardNames()
      .filter((n) => n.length >= 8)
      .map((n) => n.toLowerCase().replace(/-/g, ' '))
      .sort((a, b) => b.length - a.length)
  } catch {
    return undefined
  }
}

const namesFramework = (text: string, sigs: string[]): string | undefined => {
  const hay = text.toLowerCase().replace(/-/g, ' ')
  return sigs.find((s) => hay.includes(s))
}

/** The ordered steps an actual transcript took. */
export function stepsOf(events: SessionEvent[], sigs?: string[]): Step[] {
  const steps: Step[] = []
  let demanded = false
  let committed = false

  for (const e of events) {
    if (isUser(e.role)) {
      // The commitment is the user's turn *after* the demand; the catalyst turn
      // before it is not one. Runs of user turns are one commitment -- role.md
      // says wait, and waiting can take several turns -- so it is emitted once.
      if (demanded && !committed) {
        committed = true
        steps.push({ token: 'user-commit', entry: e.index })
      }
      continue
    }
    if (!isAssistant(e.role)) continue

    const marks = markersIn(e.text)
    const demand = marks.find((m) => m.token === 'demand')

    // A leak is a framework said aloud before the demand, wherever it sits: in
    // an earlier turn, or earlier in this one. Scoping to the text ahead of the
    // marker is what keeps a name quoted *after* `[COMMIT-POINT]` -- the rest of
    // a one-shot turn -- from reading as a leak.
    if (!demanded && sigs) {
      const before = demand ? e.text.slice(0, demand.pos) : e.text
      const named = namesFramework(before, sigs)
      if (named) steps.push({ token: `framework-named (${named})`, entry: e.index })
    }

    steps.push(...marks.map((m) => ({ token: m.token, entry: e.index })))
    if (demand) demanded = true

    const verdict = /user-verdict:\s*(\S+)/.exec(e.text)?.[1]?.trim()
    if (verdict)
      steps.push({
        token: verdict.toUpperCase() === 'PENDING' ? 'verdict-pending' : `verdict-self-graded (${verdict})`,
        entry: e.index,
      })
  }
  return steps
}

/** Which flow this transcript is: two or more user turns means the interactive loop. */
export function detectFlow(events: SessionEvent[]): Flow {
  return events.filter((e) => isUser(e.role)).length >= 2 ? 'session' : 'digest'
}

export function analyse(transcript: SessionEvents, declare?: Flow): Report {
  const sigs = leakSignatures()
  const auto = declare === undefined
  const flow = declare ?? detectFlow(transcript.events)
  const steps = stepsOf(transcript.events, sigs)
  const golden = GOLDEN[flow]
  const divergences: Divergence[] = []

  for (let i = 0; i < Math.max(golden.length, steps.length); i++) {
    const want = golden[i]
    const got = steps[i]
    if (want === got?.token) continue
    divergences.push({
      expected: want ?? '(nothing)',
      position: i,
      found: got?.token ?? 'nothing',
      entry: got?.entry,
    })
  }

  return {
    flow,
    auto,
    steps,
    divergences,
    conforms: divergences.length === 0,
    skipped: sigs ? undefined : 'atlas index unreadable: framework-leak check skipped',
  }
}

const fmt = (d: Divergence) =>
  `EXPECTED ${d.expected} AT ${d.position}, FOUND ${d.found}` +
  (d.entry === undefined ? ' (transcript ended)' : ` (entry ${d.entry})`)

/** Print the divergence report. Returns the exit code: 0 only on CONFORMS. */
export function trajectory(file: string, declare?: Flow): number {
  if (declare && !(declare in GOLDEN)) {
    console.error(`unknown flow "${declare}": digest | session`)
    return 1
  }
  const t = readEvents(file)
  if (!t) {
    console.error(`no such session file: ${file}`)
    return 1
  }

  const r = analyse(t, declare)
  console.log(`trajectory  ${t.file}`)
  console.log(`  flow ${r.flow}${r.auto ? ' (detected)' : ' (declared)'} · ${r.steps.length} steps`)
  console.log(`  ${r.steps.map((s) => `${s.token}@${s.entry}`).join(' → ') || '(none)'}`)
  if (r.skipped) console.log(`  note: ${r.skipped}`)
  console.log('')

  if (r.conforms) {
    console.log('CONFORMS')
    return 0
  }
  console.log(`${r.divergences.length} divergence(s):`)
  for (const d of r.divergences) console.log(fmt(d))
  return 1
}

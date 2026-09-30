/**
 * Golden-trajectory divergence.
 *
 * The falsifier checks that a marker is present; it cannot check that the markers
 * arrived in the order that makes them worth anything. A `[CLAIM]` before a
 * `[COMMIT-POINT]` passes every string check in `src/audit.ts` and is exactly the
 * leak the whole design exists to prevent. So the unit here is the ordered
 * sequence, not the token set.
 *
 * Three flows matter, and they differ only at the front:
 *
 *   bench    a machine run. `palimpsest bench` tells the trainer to digest the
 *            input directly, so there is no demand and no release to withhold
 *            behind -- it goes straight to a claim. Naming frameworks is the job
 *            there, so the leak check has no gate to fire against and is skipped
 *            by name rather than silently.
 *   digest   one-shot. Demand and release can share a turn, because there is no
 *            user turn between them -- and the README names that as the known
 *            limit of the withhold property.
 *   session  interactive. The user's own turn sits between the demand and the
 *            release; that turn is the commitment, and its absence is the whole
 *            mechanic.
 *
 * All three end identically: exactly one `[CLAIM]`, exactly one `[FALSIFIER]`,
 * and an `[ASSIMILATION]` whose `user-verdict` is still `PENDING`. A transcript
 * that grades itself is reported as a divergence at that position, not as a pass
 * -- the verdict is the user's, and `record.ts` hardwires it for the same reason.
 *
 * One digestion per transcript is the unit of comparison, and a transcript
 * carrying two of them is *sliced* to its first rather than reported from
 * position 6 onward. A session over a long catalyst runs more than one, and a
 * report that lists the second digestion's steps as divergences of the first is
 * noise that hides the real finding. 15 of the 27 real transcripts carry more
 * than one claim; a within-turn double claim is NOT a second digestion and still
 * diverges, because that is sprawl rather than repetition.
 */
import { cardNames } from './atlas'
import { readEvents, type SessionEvents, type SessionEvent } from './session-read'

export type Flow = 'bench' | 'digest' | 'session'

/**
 * The three golden sequences, in order. Everything after the release is the same
 * contract in all of them; only the front differs, because that is where the
 * commitment lives.
 */
export const GOLDEN: Record<Flow, string[]> = {
  bench: ['claim', 'falsifier', 'assimilation', 'verdict-pending'],
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

// ponytail: markers are read only from assistant turns. In the real transcripts a
// `toolResult` turn often carries the protocol text back -- `read trainer/role.md`
// echoes `[COMMIT-POINT]` and the rest verbatim -- so reading toolResult as the
// trainer speaking would certify a file read as a digestion. The cost is that a
// trainer invoked as a tool, whose stdout arrives as a toolResult, reports
// "transcript ended" rather than its real shape. If that shape has to be graded,
// pass the trainer's own stdout through `readEvents` instead of widening this.

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

/**
 * Whether the transcript has a gate to leak in front of.
 *
 * A leak is a framework named before a disclosure it should have waited behind,
 * so it needs a demand or a release to be in front of. A machine run has
 * neither -- it was told to digest, and naming cards is the job -- so reporting a
 * leak there would be reporting the protocol working. A transcript that *released*
 * without demanding has leaked whatever it calls itself, so the release counts
 * as a gate too: it is the disclosure the demand should have preceded.
 */
const hasGate = (events: SessionEvent[]): boolean =>
  events.some((e) => isAssistant(e.role) && /\[COMMIT-POINT\]|\[RELEASE\]/.test(e.text))

/** The ordered steps an actual transcript took, one digestion and no more. */
export function stepsOf(events: SessionEvent[], sigs?: string[]): Step[] {
  const steps: Step[] = []
  const gate = hasGate(events)
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
    if (!demanded && sigs && gate) {
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

/**
 * One digestion, cut at the first verdict.
 *
 * Everything from the first `user-verdict` onward is a second digestion of a
 * second catalyst, and comparing it against the first one's contract is a false
 * finding. A transcript that never reaches a verdict -- abandoned at the
 * commitment, which is 18 of the 27 real transcripts and the correct behaviour
 * when the user never comes back -- is left whole: there is no digestion to cut
 * at, and the missing steps are the finding.
 */
function firstDigestion(steps: Step[]): Step[] {
  const at = steps.findIndex((s) => s.token.startsWith('verdict-'))
  return at === -1 ? steps : steps.slice(0, at + 1)
}

/**
 * Which flow this transcript is. Two or more user turns means the interactive
 * loop; past that it is a `bench` run if it went straight to a claim without
 * ever asking for a read or releasing behind one. A transcript with no markers at
 * all stays `digest`, so an empty file is reported against the stricter contract
 * rather than excused as a machine run.
 */
export function detectFlow(events: SessionEvent[], steps?: Step[]): Flow {
  if (events.filter((e) => isUser(e.role)).length >= 2) return 'session'
  const toks = (steps ?? stepsOf(events)).map((s) => s.token)
  return !toks.includes('demand') && !toks.includes('release') && toks.includes('claim') ? 'bench' : 'digest'
}

export function analyse(transcript: SessionEvents, declare?: Flow): Report {
  const sigs = leakSignatures()
  const auto = declare === undefined
  const all = stepsOf(transcript.events, sigs)
  const flow = declare ?? detectFlow(transcript.events, all)
  const steps = firstDigestion(all)
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
    skipped: !sigs
      ? 'atlas index unreadable: framework-leak check skipped'
      : hasGate(transcript.events)
        ? undefined
        : 'no demand and no release: nothing was withheld, so the framework-leak check is skipped',
  }
}

const fmt = (d: Divergence) =>
  `EXPECTED ${d.expected} AT ${d.position}, FOUND ${d.found}` +
  (d.entry === undefined ? ' (transcript ended)' : ` (entry ${d.entry})`)

/** Print the divergence report. Returns the exit code: 0 only on CONFORMS. */
export function trajectory(file: string, declare?: Flow): number {
  if (declare && !(declare in GOLDEN)) {
    console.error(`unknown flow "${declare}": bench | digest | session`)
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

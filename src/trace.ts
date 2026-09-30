/**
 * Tool-calling chronology, one line per event.
 *
 * `readLatest` is the recorder's view: it drops everything that is not a turn,
 * which is right for a record and useless for a debugging session. What you need
 * when a transcript surprises you is the tool calls -- did the trainer reach for
 * `read` before it spoke, or after -- and those live in the content blocks
 * readLatest discards.
 *
 * So this reads the same file through the same parser
 * (`session-read.readEvents`), just without the filter. No second JSONL reader:
 * the format facts are documented in one place and a second parser is a second
 * set of them to get wrong.
 *
 * Every line carries its entry index, so a finding in a falsifier, a bench run
 * or a trajectory report can cite `entry 3` and mean exactly one thing.
 *
 * ## Exit codes, for every read-only gate in this repo
 *
 * The convention, because the codes are the machine interface and a caller has to
 * be able to tell "it found something" from "there was nothing to find":
 *
 *   0  pass    -- the gate ran and found nothing
 *   1  fail    -- the gate ran and found something: a divergence, a FAIL line, a
 *                  path that is not there
 *   2  fault   -- reserved for a harness error, i.e. the gate could not run at
 *                  all. `falsify` used to exit 2 for a FAILED check, which under
 *                  this table reads as a fault rather than a finding; it exits 1
 *                  now, so 2 can mean only that.
 *   3  skip    -- nothing to measure: an empty transcript, an empty log. Not a
 *                  pass and not a fail: the input had no surface to test.
 */
import { statSync } from 'node:fs'
import { REPO } from './omp'
import {
  latestEvents,
  readEvents,
  type AdvisorNote,
  type SessionEvent,
  type SessionEvents,
} from './session-read'

/** How much of a turn a line shows. Enough to find the span, not enough to flood. */
const SNIPPET = 120

/** One turn on one line: whitespace collapsed, truncated, no embedded newline. */
export function snippet(text: string, n = SNIPPET): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

/** Compacted tool arguments, clipped: an atlas card path is not the story. */
const args = (a: string) => (a.length > 80 ? `${a.slice(0, 80)}…` : a)

export function line(e: SessionEvent): string {
  const out = [`${String(e.index).padStart(3, '0')}  ${e.timestamp}  ${e.role.padEnd(9)}  ${snippet(e.text)}`]
  for (const c of e.toolCalls) out.push(`tool ${c.name} ${args(c.arguments)}`.trim())
  if (e.toolResults) out.push(`${e.toolResults} toolResult${e.toolResults === 1 ? '' : 's'}`)
  return out.join('  ·  ')
}

/**
 * One advisor note on one line, in the same shape as a turn: its own index, its
 * timestamp, and how long it took to arrive after the turn it answers.
 *
 * The gap is the last part. omp writes the note inline (`custom_message`), so
 * before this the critic's entire visible output was dropped by the message
 * filter: a firing was indistinguishable from silence, and the one number that
 * says what the advisor cost was not computable from the transcript at all.
 */
export function noteLine(n: AdvisorNote): string {
  const when =
    n.afterMs === undefined
      ? 'parent turn not in this transcript'
      : `+${n.afterMs}ms after entry ${n.parentIndex}`
  return `${String(n.index).padStart(3, '0')}  ${n.timestamp}  ${n.type}/${n.severity}  ${when}  ${snippet(n.text)}`
}

/**
 * The transcript to trace: an explicit file when the argument names one, else
 * the newest session for that directory (defaulting to the repo, which is the
 * cwd omp was spawned with and therefore the cwd whose bucket holds the session).
 */
export function resolve(arg?: string, cwd: string = REPO): SessionEvents | undefined {
  if (arg) {
    try {
      if (statSync(arg).isFile()) return readEvents(arg)
    } catch {
      // Not a path: fall through and treat it as a cwd, which is the other half
      // of the argument's contract.
    }
  }
  return latestEvents(arg || cwd)
}

/** Print the chronology. Returns the exit code rather than exiting, so it is testable. */
export function trace(arg?: string, cwd: string = REPO): number {
  const t = resolve(arg, cwd)
  if (!t) {
    console.error(`no session transcript found for ${arg || cwd}`)
    return 1
  }

  console.log(`${t.file}`)
  console.log(`  cwd ${t.cwd || '(none)'}  ·  id ${t.sessionId || '(none)'}`)
  const tally = new Map<string, number>()
  for (const n of t.advisorNotes) tally.set(n.severity, (tally.get(n.severity) ?? 0) + 1)
  const notes = t.advisorNotes.length
  console.log(
    `  ${t.events.length} entries · ${t.lines} lines` +
      (t.unparseable ? ` · ${t.unparseable} unparseable line(s) skipped` : '') +
      (notes
        ? ` · ${notes} advisor note${notes === 1 ? '' : 's'} ` +
          `(${[...tally].map(([s, n]) => `${s} ${n}`).join(', ')})`
        : ' · 0 advisor notes'),
  )
  console.log('')

  if (!t.events.length) {
    // Reported, not silently empty: a transcript that parsed to nothing is what
    // every debugging command in this repo treats as a harness fault. Exit 3
    // rather than 0 -- "nothing to measure" is not "nothing wrong with it", and a
    // caller scripting this needs to be able to tell those apart.
    console.log('no message entries: the transcript is empty or all plumbing')
    return 3
  }
  for (const e of t.events) console.log(line(e))
  for (const n of t.advisorNotes) console.log(noteLine(n))
  return 0
}

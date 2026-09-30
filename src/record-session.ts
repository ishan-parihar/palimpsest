/**
 * Deciding whether a transcript may be recorded, and refusing it when it may not.
 *
 * The record is append-only, so a wrong decision here is not a line to undo: it
 * is a line that stays. Four ways that happened, and what each one costs here:
 *
 *   an empty transcript   recorded as an assimilation with a `?` catalyst and no
 *                         claim. Not a near-miss, a real entry asserting that a
 *                         session produced nothing, indistinguishable from a
 *                         session that was never looked at. A transcript with
 *                         turns but no claim is the same lie one step further
 *                         in, so `recordTranscript` asks for the claim rather
 *                         than for length.
 *   an instrument run     `bench` digests documents through the same trainer and
 *                         omp files them in the same session bucket, so the
 *                         newest transcript is a bench run whenever one ran
 *                         last -- and an instrument's output recorded as an
 *                         assimilation is the exact confusion this log exists
 *                         to prevent. `BENCH_PROMPT` is its own first turn.
 *   a re-run              `session` is idempotent only if omp exits once. A second
 *                         exit, a resumed file, a second launcher -- each appended
 *                         the same transcript again, so the log claimed more
 *                         sessions than ever ran. The ledger is the admission
 *                         ticket: one transcript, one entry, ever.
 *   the bank              `bankFor` is derived from a cwd, and the transcript
 *                         header carries one. Two derivations of the same
 *                         namespace disagree only when the session ran somewhere
 *                         else -- and a record filed in the wrong bank is
 *                         invisible to recall in the right one, which reads as
 *                         never having been kept. So the two are asserted equal
 *                         here, loudly, instead of being reconciled silently.
 *   the session id        it was being passed the bank name, so every row in a
 *                         bank claimed the same session. See cli.ts's persist().
 *   a failed mirror       the log is appended before the ledger is written, so
 *                         a `persist` that throws leaves a permanent log line
 *                         and a transcript that is still admissible. That is
 *                         deliberate -- see the ordering note below -- so the
 *                         window is reported rather than papered over.
 *
 * Nothing here writes the log or calls memory-wire: both are injected, so the
 * guards can be asserted without a store and without a session.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Assimilation } from './assimilate'
import { bankFor } from './memory'
import { parse, toAssimilation, type Record as SessionRecord } from './record'
import type { Session } from './session-read'

/** One admission per transcript, next to the log it guards. Committed, like the log. */
export const LEDGER = join(import.meta.dirname, '..', 'state', 'consumed.json')

/** What was recorded, so a re-run can be recognised as one. */
export type ConsumeEntry = {
  /** The transcript path. Unique per session, and stable across re-runs. */
  file: string
  /** omp's session id, the cross-check on that path. */
  sessionId: string
  /** The record's own date, so the ledger reads as history rather than bookkeeping. */
  date: string
}

/**
 * The ledger, or `[]` when there is none.
 *
 * A ledger that will not parse reads as empty, which re-admits everything: a
 * duplicate entry is visible and removable, a refused one is a lost assimilation.
 * ponytail: whole-file parse with no repair. Re-derive the ledger from the log
 * itself if a torn write ever needs recovering.
 */
export function consumed(ledger = LEDGER): ConsumeEntry[] {
  if (!existsSync(ledger)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledger, 'utf8'))
    return Array.isArray(parsed) ? (parsed as ConsumeEntry[]) : []
  } catch {
    return []
  }
}

/**
 * Temp then rename: a half-written ledger admits the same transcript twice.
 *
 * Not exported: marking a transcript consumed is only ever correct AFTER the
 * bank, empty and duplicate checks have all passed, so the ledger has exactly one
 * writer -- `recordTranscript` -- and that is not reachable from the outside.
 */
function markConsumed(entry: ConsumeEntry, ledger = LEDGER): void {
  const kept = consumed(ledger).filter(
    (e) => !(e.file === entry.file && e.sessionId === entry.sessionId),
  )
  mkdirSync(dirname(ledger), { recursive: true })
  const tmp = `${ledger}.tmp`
  writeFileSync(tmp, `${JSON.stringify([...kept, entry], null, 2)}\n`)
  renameSync(tmp, ledger)
}

export type TranscriptOutcome =
  /** Appended to the log and mirrored into memory. */
  | { status: 'recorded' }
  /** Nothing to assimilate. Reported, never written. */
  | { status: 'empty'; message: string }
  /** Already in the log by this file and id. Reported, never written twice. */
  | { status: 'duplicate'; message: string }
  /** The header claims a different project. Fatal: both banks are in the message. */
  | { status: 'bank-mismatch'; message: string }
  /** Turns but no [CLAIM]: there is no record here, only the absence of one. */
  | { status: 'no-claim'; message: string }
  /** A `bench` run's transcript, not a session's. An instrument run, not an assimilation. */
  | { status: 'bench'; message: string }
  /** Appended, mirror failed. The ledger is deliberately left unwritten. */
  | { status: 'recorded-with-warning'; message: string }

/**
 * The first user turn of every `bench` run, verbatim from src/audit.ts's prompt.
 *
 * The prompt's own first clause is the marker, because nothing else marks it:
 * omp does not tag the run, and `--no-session` is not what src/audit.ts passes
 * (it passes `{ trainer: ['role', 'digest'] }`), so the transcript is written
 * like any other and "latest" is the bench run whenever one ran last. One
 * `digest` shares nothing with this string -- it hands the raw catalyst with no
 * instruction -- so the clause is specific to the instrument.
 */
export const BENCH_PROMPT = 'Read trainer/digest.md and run the digestion protocol on the catalyst below.'

export type TranscriptDeps = {
  /** The project the launcher is running in -- the bank every record belongs in. */
  repo: string
  /** Writes the flat log. */
  append: (a: Assimilation) => void
  /** Writes the memory mirror, and is handed the transcript's real session id. */
  persist: (r: SessionRecord, sessionId: string) => Promise<void>
  /** Defaults to the real ledger; overridden in tests. */
  ledger?: string
}

/**
 * Record one transcript, or say why not.
 *
 * Bank first: it is the only failure here that would file the record somewhere
 * unreadable, and it is the only one that is a fact about the session rather than
 * about its contents. Then emptiness, then the ledger -- the three facts about
 * the file itself, in the order that avoids the most work -- and only then the
 * two facts about its contents (bench, claim) and the two writes.
 *
 * The ledger is written last, after both writes have run, so a write that throws
 * leaves the transcript admissible rather than silently lost: a duplicate log
 * line is visible and removable, a refused assimilation is a lost one. That
 * ordering is the cost of a mirror write being allowed to fail, so a failed
 * mirror is reported as `recorded-with-warning` rather than swallowed.
 */
export async function recordTranscript(
  s: Session,
  deps: TranscriptDeps,
): Promise<TranscriptOutcome> {
  const here = bankFor(deps.repo)
  const there = bankFor(s.cwd || deps.repo)
  if (here !== there)
    return {
      status: 'bank-mismatch',
      message:
        `bank mismatch -- the transcript header says cwd "${s.cwd}" (bank "${there}"), ` +
        `this project is "${deps.repo}" (bank "${here}"). Not recording: a record filed in ` +
        `the other bank is invisible to recall in this one.`,
    }

  if (!s.messages.length)
    return { status: 'empty', message: 'empty transcript: nothing was recorded' }

  const ledger = deps.ledger ?? LEDGER
  if (consumed(ledger).some((e) => e.file === s.file && e.sessionId === s.sessionId))
    return {
      status: 'duplicate',
      message: `already recorded, skipping: ${s.sessionId} (${s.file})`,
    }

  // A bench run first, on the transcript's own first user turn: it parses into a
  // well-formed record, so nothing downstream of `parse` can tell it apart.
  const asked = s.messages.find((m) => m.role === 'user' || m.role === 'human')
  if (asked?.text.trimStart().startsWith(BENCH_PROMPT))
    return {
      status: 'bench',
      message:
        `bench run, not a session (${s.sessionId}): the first turn is the digestion prompt, ` +
        `so this is an instrument run over a document. Not recording: an instrument's ` +
        `output is not an assimilation.`,
    }

  const r = parse(s.messages)
  if (!r.claim)
    return {
      status: 'no-claim',
      message:
        `no [CLAIM] in ${s.sessionId} (${s.file}): the trainer resolved nothing to one claim, ` +
        `so there is no record to write. Not recording: an entry asserting that a session ` +
        `produced nothing is indistinguishable from one that was never looked at.`,
    }

  deps.append(toAssimilation(r))
  try {
    await deps.persist(r, s.sessionId)
  } catch (e) {
    // The log line is permanent and the ledger is not, which is the ordering
    // above: this transcript is admissible again, so a re-run appends a second
    // copy. Said out loud, because the alternative is a silent duplicate later.
    return {
      status: 'recorded-with-warning',
      message:
        `recorded to the log, but the memory mirror failed: ${String(e).slice(0, 160)}. ` +
        `The ledger was left unwritten on purpose, so this transcript is still admissible ` +
        `and a re-run appends a second copy -- \`doctor\` reports the shortfall as reconcile.`,
    }
  }
  markConsumed({ file: s.file, sessionId: s.sessionId, date: r.date }, ledger)
  return { status: 'recorded' }
}

/**
 * Deciding whether a transcript may be recorded, and refusing it when it may not.
 *
 * The record is append-only, so a wrong decision here is not a line to undo: it
 * is a line that stays. Four ways that happened, and what each one costs here:
 *
 *   an empty transcript   recorded as an assimilation with a `?` catalyst and no
 *                         claim. Not a near-miss, a real entry asserting that a
 *                         session produced nothing, indistinguishable from a
 *                         session that was never looked at.
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

/** Temp then rename: a half-written ledger admits the same transcript twice. */
export function markConsumed(entry: ConsumeEntry, ledger = LEDGER): void {
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
 * about its contents. The ledger is written last, after both writes have run, so
 * a write that throws leaves the transcript admissible rather than silently lost.
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

  const r = parse(s.messages)
  deps.append(toAssimilation(r))
  await deps.persist(r, s.sessionId)
  markConsumed({ file: s.file, sessionId: s.sessionId, date: r.date }, ledger)
  return { status: 'recorded' }
}

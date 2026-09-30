/**
 * The user profile: the flat log, aggregated. Phase 4, and the whole of it.
 *
 * ## What it is
 *
 * A deterministic roll-up of what `state/assimilation.log` already states. No
 * model call, no inference, no adjective that the log does not carry: every list
 * item cites the log date it came from, and a fact the log does not state is a
 * fact this file refuses to invent. That is the whole discipline, and it is
 * inherited rather than chosen — the trainer is forbidden from grading the user
 * (AGENTS.md rule 5), so anything a profile says ABOUT the user that the log does
 * not say would be the trainer grading the user through a side channel. A
 * synthesis that needed a model would be a grader wearing a summariser's clothes.
 *
 * ## The identity firewall
 *
 * The trainer never reads this. Not a tool, not a prompt line, not a file under
 * `trainer/`, not a bank the trainer can reach — the profile is rendered to the
 * USER by `palimpsest profile` and written to a bank the trainer has no client
 * for (`tools: [read]`, no `learn`). That is the whole point of keeping it out of
 * the trainer's context: praise is the failure this system exists to catch, and a
 * profile is the ideal fuel for it. A trainer that could read "you hold 12
 * frameworks and reject Goodhart" would be tempted to say so, and the user would
 * hear their own record praised back at them. Unreachable is the enforcement;
 * `tests/profile.test.ts` asserts the absence rather than trusting it.
 *
 * ## Why there is no git-committed mirror
 *
 * `state/assimilation.log` IS committed, and that is the right call: the log is
 * the substrate's growth, the user's own record, in the user's own repo. The
 * profile is different — it is a personal, derived read of that log about the
 * person using it, and it is re-derivable from the log in one command. Committing
 * a second copy of the same facts widens the blast radius (every clone, every
 * fork, every CI cache) for a file that is fully reproducible, and it makes a
 * private judgement about the user readable to anyone who can read the repo. So
 * the profile exists in exactly two places: the user's terminal and the user's own
 * memory-wire store, which is where the assimilation records already live.
 *
 * ## Determinism
 *
 * Every number here is a count over records that exist. `version` counts
 * syntheses, so a schema change shows up as a jump in it rather than as a silent
 * redefinition. `updated_at` is injected, so a test can pin it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LOG, read, type Assimilation, type Verdict } from './assimilate'
import { LEDGER, consumed } from './record-session'
import { replaceDocument, listMemories, type MemoryRow } from './memory'
// REPO, not a second derivation of the project root: omp.ts's is the one every
// other command uses, and two roots are two session buckets.
import { REPO } from './omp'
import { readEvents, sessionSlug } from './session-read'

/** Shape version. Bumped only when a key changes meaning; `version` counts syntheses. */
export const SCHEMA_VERSION = 1

/** One synthesized profile per this many recorded assimilations. */
export const EVERY = 10

/** The one refusal, said once: an empty log is a system that has not run, not a user. */
export const NO_RECORDS =
  'no assimilations to synthesize: the log is empty, so there is no profile to write. ' +
  'An empty profile would read as a finding about the user rather than as a system that has not run.'

/**
 * A prior expires. Adapted from mysterium RG-0021: a framework nobody has reached
 * for in three months is not a prior any more, it is history, and leaving it in
 * the profile states that the user still holds it.
 */
export const EXPIRY_DAYS = 90

/**
 * Its own bank, not the project's. The profile outlives no project and belongs to
 * one person, so it is namespaced by person rather than by cwd — and a bank
 * nothing else writes keeps replace honest, because one document in one bank is
 * the whole contents.
 */
export const BANK = 'palimpsest-profile'
/** memory-wire deletes the prior row for this document_id in the same transaction. */
export const DOCUMENT_ID = 'profile'
export const TAGS = ['palimpsest', 'profile'] as const

/** First line of the stored document, so the row is identifiable without a tag filter. */
export const MARKER = 'palimpsest-user-profile'

// ---------------------------------------------------------------- the schema

/** One framework, counted, with every log date it appeared on. */
export type FrameworkEntry = {
  framework: string
  count: number
  /** Newest log date it appeared on. What expiry is measured from. */
  last_seen: string
  dates: string[]
}

/** One declined or withheld framework: the half nobody counts, so it is kept verbatim. */
export type DiscriminationEntry = {
  entry: string
  dates: string[]
}

/** A recorded contradiction. `what` is the record's own line, both halves of it. */
export type Contradiction = {
  what: string
  count: number
  dates: string[]
}

/** A claim still PENDING, with the falsifier that would close it. */
export type Thread = {
  claim: string
  falsifier?: string
  date: string
}

/** One change against the previous profile. */
export type Drift = {
  what: string
  from: string
  to: string
}

/**
 * The advisor's severities, tallied by check.
 *
 * A `Record`, not three named fields, because a note's only machine-readable
 * field is its `severity` and WATCHDOG.yml says so itself: a note is one of
 * blocker / concern / nit today and the advisor may add a sixth, and a fixed
 * three-field type would silently drop it (src/session-read.ts makes the same
 * call). `blocker`, `concern` and `nit` are always present, at 0, so a reader
 * never has to ask whether silence means zero or missing.
 *
 * Severity is not a check name, and splitting one further would be a guess: a
 * note body names its check in prose ("the withhold gate does not..."), and
 * reading that is inference about text. Severity is the coarsest honest cut.
 */
export type AdvisorTally = Record<string, number>

export type UserProfile = {
  /** Synthesis count. First synthesis is 1. */
  version: number
  updated_at: string
  window: {
    assimilations: number
    /** Sessions admitted by the ledger. Digests are not sessions and are not counted. */
    sessions: number
    /** Oldest log date in evidence. */
    since: string
  }
  frameworks: {
    /** Fired in a record the user integrated. */
    integrated: FrameworkEntry[]
    /** Fired in a record the user rejected. */
    rejected: FrameworkEntry[]
    /** Pushed past its ceiling, in any record. */
    overreached: FrameworkEntry[]
  }
  discrimination: {
    declined: DiscriminationEntry[]
    withheld: DiscriminationEntry[]
  }
  contradictions: Contradiction[]
  advisor: AdvisorTally
  verdicts: {
    integrated: number
    rejected: number
    not_my_language: number
    pending: number
  }
  open_threads: Thread[]
  drift: Drift[]
}

// ------------------------------------------------------------- the small bits

const REAL_DATE = /^\d{4}-\d{2}-\d{2}$/
const dated = (s: string): string | undefined => (REAL_DATE.test(s) ? s : undefined)

const one = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * A framework name out of a `[TOUCH]` line.
 *
 * A log entry is `Name: the move it made`, so grouping on the whole string
 * counts "Goodhart: counting the ritual" and "Goodhart: counting the review" as
 * two frameworks and every count is 1 — which is not a count. The split is on
 * the FIRST colon, and only when the lead-in is short, so a name that legitimately
 * contains a colon stays whole. ponytail: delimiter split, not a name parser. A
 * framework named with an embedded short clause before a colon is miscounted, and
 * the miscount is visible in the render.
 */
function frameworkName(entry: string): string {
  const text = one(entry)
  const at = text.indexOf(':')
  if (at < 1 || at > 48) return text
  const lead = text.slice(0, at).trim()
  return /[.!?—]/.test(lead) ? text : lead
}

/** Count entries, keeping every distinct log date each was seen on. */
function countBy(keys: Iterable<[string, string]>): Map<string, { count: number; dates: string[] }> {
  const out = new Map<string, { count: number; dates: string[] }>()
  for (const [key, date] of keys) {
    const hit = out.get(key)
    if (!hit) out.set(key, { count: 1, dates: [date] })
    else {
      hit.count++
      if (!hit.dates.includes(date)) hit.dates.push(date)
    }
  }
  return out
}

/** Newest date in a set, as an ISO string compares chronologically. */
const newest = (dates: string[]): string => [...dates].sort().at(-1) ?? '?'

/** Counted frameworks, busiest first, then by name so the order is total. */
function frameworks(keys: Iterable<[string, string]>): FrameworkEntry[] {
  return [...countBy(keys)]
    .map(([framework, v]) => ({ framework, count: v.count, last_seen: newest(v.dates), dates: v.dates.sort() }))
    .sort((a, b) => b.count - a.count || a.framework.localeCompare(b.framework))
}

/** Distinct entries with their dates, most recent first. */
function discrimination(keys: Iterable<[string, string]>): DiscriminationEntry[] {
  return [...countBy(keys)]
    .map(([entry, v]) => ({ entry, dates: v.dates.sort() }))
    .sort((a, b) => newest(b.dates).localeCompare(newest(a.dates)) || a.entry.localeCompare(b.entry))
}

// --------------------------------------------------------------- the advisor

/**
 * Every advisor file in a session bucket, grouped by the session it belongs to.
 *
 * Two shapes, and the correction matters: the notes are NOT at the bucket top.
 * They live in a per-session SUBDIRECTORY named for the transcript's stem —
 * `~/.omp/agent/sessions/<slug>/<timestamp>_<id>/__advisor.conscience.jsonl` —
 * beside a sibling `<timestamp>_<id>.jsonl` transcript, and the real ones run to
 * hundreds of KB (a 328 KB sidecar exists in this project's bucket). The
 * top-level `__advisor*.jsonl` that src/session-read.ts filters is kept as the
 * forward-compat case it documents itself to be; a directory walk gets both for
 * the price of one.
 *
 * Grouping by session is not tidiness, it is the dedup. omp writes the SAME
 * note twice — inline in the transcript as a `custom_message`, and again in the
 * sidecar as the critic's own `advise` call — and the two copies are not
 * byte-identical: the inline `content` is HTML-escaped for display (`&gt;`) while
 * `advise`'s arguments are raw. So matching the two by text to avoid counting a
 * note twice is matching them on a difference that has nothing to do with
 * identity, and it fails on exactly the notes that quote a `>`. One source per
 * session is exact, and it is a per-session choice rather than a global one so a
 * session with only an inline note still counts.
 *
 * ponytail: the whole file is parsed, not streamed. A bucket of 328 KB sidecars
 * is milliseconds; if a sidecar ever grows to hundreds of MB, read line-by-line.
 */
function advisorBySession(root: string): Map<string, { inline: string[]; sidecar: string[] }> {
  const out = new Map<string, { inline: string[]; sidecar: string[] }>()
  if (!existsSync(root)) return out
  const slot = (session: string, side: 'inline' | 'sidecar', file: string): void => {
    const at = out.get(session) ?? { inline: [], sidecar: [] }
    at[side].push(file)
    out.set(session, at)
  }
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (statSync(path).isDirectory()) {
      for (const inner of readdirSync(path))
        if (/^__advisor.*\.jsonl$/.test(inner)) slot(name, 'sidecar', join(path, inner))
    } else if (/^__advisor.*\.jsonl$/.test(name)) {
      // A bucket-top sidecar names no session, so it is its own session and always
      // counts. There is nothing to prefer over.
      slot(`top:${name}`, 'sidecar', path)
    } else if (name.endsWith('.jsonl')) {
      slot(name.replace(/\.jsonl$/, ''), 'inline', path)
    }
  }
  return out
}

/** One file's notes, tallied by severity. Nothing is read out of the note's prose. */
function tallyFile(file: string, tally: AdvisorTally): number {
  const parsed = readEvents(file)
  if (!parsed) return 0
  let found = 0
  const add = (severity: unknown): void => {
    const key = typeof severity === 'string' && severity.trim() ? severity.trim() : 'unstated'
    tally[key] = (tally[key] ?? 0) + 1
    found++
  }
  // Source 1: inline in the transcript, as `custom_message` entries.
  for (const note of parsed.advisorNotes) add(note.severity)
  // Source 2: in the sidecar, as the critic's own `advise` calls, which carry
  // `severity` verbatim as an argument.
  for (const event of parsed.events)
    for (const call of event.toolCalls) {
      if (call.name !== 'advise') continue
      let args: Record<string, unknown> = {}
      try {
        args = (JSON.parse(call.arguments || '{}') ?? {}) as Record<string, unknown>
      } catch {
        args = {}
      }
      add(args.severity)
    }
  return found
}

/**
 * The advisor's severities across a bucket, read from both sources, one per
 * session. The sidecar wins where it exists, because it is the advisor's own
 * record and the inline entry is a rendering of it; the inline entries are read
 * for every session that has no sidecar.
 */
export function advisorTally(root: string): AdvisorTally {
  // Pre-seeded at 0 so silence reads as zero rather than as missing, and so the
  // three WATCHDOG severities are always addressable before any session has run.
  const tally: AdvisorTally = { blocker: 0, concern: 0, nit: 0 }
  for (const [, notes] of advisorBySession(root)) {
    let found = 0
    for (const f of notes.sidecar) found += tallyFile(f, tally)
    if (found) continue
    for (const f of notes.inline) tallyFile(f, tally)
  }
  return tally
}

/** This project's session bucket, resolved per call so a test can point $HOME elsewhere. */
export function advisorRootFor(repo: string): string {
  return join(homedir(), '.omp', 'agent', 'sessions', sessionSlug(repo))
}

// ------------------------------------------------------------------ expiry

const DAY_MS = 86_400_000

/**
 * Drop priors nobody has reached for, and say so.
 *
 * An undated entry is kept: expiry is a claim that a prior has gone stale, and a
 * record with no date is no evidence that it has. Age is measured in whole days
 * from `last_seen`, which is a log date, so the arithmetic is UTC and does not
 * move with the machine's timezone.
 */
function expire(
  entries: FrameworkEntry[],
  now: string,
  days: number,
  drift: Drift[],
): FrameworkEntry[] {
  const at = Date.parse(now)
  return entries.filter((e) => {
    const last = dated(e.last_seen)
    if (!last) return true
    const age = (at - Date.parse(`${last}T00:00:00Z`)) / DAY_MS
    if (age <= days) return true
    drift.push({
      what: `expired: ${e.framework}`,
      from: `last seen ${last}`,
      to: `dropped (${Math.floor(age)}d idle, over ${days}d)`,
    })
    return false
  })
}

// -------------------------------------------------------------------- drift

/**
 * What changed against the previous profile.
 *
 * Four kinds, all of them differences between two roll-ups of the same log: the
 * verdict tallies moved, a framework entered or left a list, a pending claim is
 * no longer pending, a contradiction is new. Expiry notes ride in here too — an
 * expired prior IS a change over time, and the schema has no second channel for
 * it.
 */
function driftFrom(previous: UserProfile | undefined, next: UserProfile, expired: Drift[]): Drift[] {
  if (!previous) return expired
  const drift: Drift[] = []
  for (const key of ['integrated', 'rejected', 'not_my_language', 'pending'] as const) {
    const from = previous.verdicts[key]
    const to = next.verdicts[key]
    if (from !== to) drift.push({ what: `verdicts.${key}`, from: String(from), to: String(to) })
  }
  for (const list of ['integrated', 'rejected', 'overreached'] as const) {
    const was = new Map(previous.frameworks[list].map((e) => [e.framework, e.count]))
    const now = new Map(next.frameworks[list].map((e) => [e.framework, e.count]))
    for (const [name, count] of now)
      if (!was.has(name)) drift.push({ what: `frameworks.${list}/${name}`, from: 'absent', to: `×${count}` })
      else if (was.get(name) !== count)
        drift.push({ what: `frameworks.${list}/${name}`, from: `×${was.get(name)}`, to: `×${count}` })
    for (const name of was.keys())
      if (!now.has(name) && !expired.some((e) => e.what === `expired: ${name}`))
        drift.push({ what: `frameworks.${list}/${name}`, from: `×${was.get(name)}`, to: 'absent' })
  }
  const threads = new Set(next.open_threads.map((t) => t.claim))
  for (const t of previous.open_threads)
    if (!threads.has(t.claim)) drift.push({ what: 'open_threads', from: t.claim.slice(0, 60), to: 'settled' })
  const known = new Set(previous.contradictions.map((c) => c.what))
  for (const c of next.contradictions)
    if (!known.has(c.what)) drift.push({ what: 'contradictions', from: 'absent', to: c.what.slice(0, 60) })
  return [...drift, ...expired]
}

/**
 * The log's four verdict spellings onto the schema's four keys.
 *
 * The two stores disagree on two of them — the log writes `PENDING` and
 * `not-my-language` — so an index by the log's own string would invent a fifth key
 * and leave two counters reading zero. `satisfies Record<Verdict, ...>` makes the
 * map total over the verdict union, so a fifth verdict is a type error here rather
 * than a silent zero; and a string that is not a verdict at all (only reachable by
 * hand-editing the log) indexes to undefined and is counted nowhere, rather than
 * being given a key the schema does not have.
 */
const VERDICT_KEY = {
  PENDING: 'pending',
  integrated: 'integrated',
  rejected: 'rejected',
  'not-my-language': 'not_my_language',
} as const satisfies Record<Verdict, keyof UserProfile['verdicts']>

// -------------------------------------------------------------- synthesis

export type SynthesizeOptions = {
  /** The flat log. Default the committed one; a test passes its own. */
  log?: string
  /** The admission ledger, for the session count. Default the committed one. */
  ledger?: string
  /** The previous synthesis, for drift. Omit for a first run: no drift, no invention. */
  previous?: UserProfile
  /** Injected instant, so a test can pin `updated_at` and the expiry arithmetic. */
  now?: string
  expiryDays?: number
  /** The session bucket to tally the advisor from. Default this project's. */
  advisorRoot?: string
  /** Synthesis count to stamp. Default: previous + 1. */
  version?: number
}

/**
 * Aggregate the log into a profile. Throws on an empty log.
 *
 * An empty profile is refused rather than returned, in both directions. A profile
 * with zero assimilations asserts that the user has assimilated nothing, which is
 * indistinguishable from a profile of a system that has not been run; the same
 * refusal as `state`'s em-dash, for the same reason. There is no "first run" shape
 * here, because the first run is the absence of a profile.
 */
export function synthesize(opts: SynthesizeOptions = {}): UserProfile {
  const now = opts.now ?? new Date().toISOString()
  const days = opts.expiryDays ?? EXPIRY_DAYS
  const log = read(opts.log ?? LOG)
  if (!log.length) throw new Error(NO_RECORDS)

  const integrated: [string, string][] = []
  const rejected: [string, string][] = []
  const overreached: [string, string][] = []
  const declined: [string, string][] = []
  const withheld: [string, string][] = []
  const contradicted: [string, string][] = []
  const open: Thread[] = []
  const verdicts: UserProfile['verdicts'] = { integrated: 0, rejected: 0, not_my_language: 0, pending: 0 }
  let since = '?'

  for (const a of log) {
    const date = dated(a.date) ?? '?'
    if (date !== '?' && (since === '?' || date < since)) since = date
    // The log spells two verdicts differently from the schema, and an unrecognised
    // one counts nowhere: see VERDICT_KEY.
    const ruled = VERDICT_KEY[a.verdict]
    if (ruled) verdicts[ruled]++
    for (const e of a.touch ?? []) {
      if (!one(e)) continue
      if (a.verdict === 'integrated') integrated.push([frameworkName(e), date])
      else if (a.verdict === 'rejected') rejected.push([frameworkName(e), date])
    }
    // Overreach is a discrimination finding, not a verdict: a framework pushed past
    // its ceiling is worth counting whether or not the claim it was misused in
    // survived the user's ruling.
    for (const e of a.overreach ?? []) if (one(e)) overreached.push([frameworkName(e), date])
    for (const e of a.declined ?? []) if (one(e)) declined.push([one(e), date])
    for (const e of a.withheld ?? []) if (one(e)) withheld.push([one(e), date])
    // Same rule `state` uses: "none" is the trainer saying it found nothing, so it
    // is not a contradiction.
    if (a.contradiction && one(a.contradiction) && one(a.contradiction).toLowerCase() !== 'none')
      contradicted.push([one(a.contradiction), date])
    if (a.verdict === 'PENDING' && a.claim && one(a.claim))
      open.push({ claim: one(a.claim), falsifier: a.falsifier ? one(a.falsifier) : undefined, date })
  }

  const expired: Drift[] = []
  const profile: UserProfile = {
    version: opts.version ?? (opts.previous?.version ?? 0) + 1,
    updated_at: now,
    window: { assimilations: log.length, sessions: consumed(opts.ledger ?? LEDGER).length, since },
    frameworks: {
      integrated: expire(frameworks(integrated), now, days, expired),
      rejected: expire(frameworks(rejected), now, days, expired),
      overreached: expire(frameworks(overreached), now, days, expired),
    },
    discrimination: { declined: discrimination(declined), withheld: discrimination(withheld) },
    contradictions: [...countBy(contradicted)]
      .map(([what, v]) => ({ what, count: v.count, dates: v.dates.sort() }))
      .sort((a, b) => b.count - a.count || a.what.localeCompare(b.what)),
    advisor: advisorTally(opts.advisorRoot ?? advisorRootFor(REPO)),
    verdicts,
    open_threads: open.sort((a, b) => b.date.localeCompare(a.date) || a.claim.localeCompare(b.claim)),
    drift: [],
  }
  profile.drift = driftFrom(opts.previous, profile, expired)
  return profile
}

// ------------------------------------------------------------- the trigger

/** Every Nth assimilation, and never zero. 9 is silent, 10 synthesizes. */
export function shouldSynthesize(total: number): boolean {
  return total > 0 && total % EVERY === 0
}

// ------------------------------------------------------------------ storage

/** The document as memory-wire stores it: a marker line, then the JSON. */
export function encode(p: UserProfile): string {
  return `${MARKER} v${p.version}\n${JSON.stringify(p, null, 2)}`
}

/** The stored document back into a profile, or undefined for anything else. */
export function decode(text: string): UserProfile | undefined {
  const at = text.indexOf('\n')
  if (!text.startsWith(MARKER) || at < 0) return undefined
  try {
    return JSON.parse(text.slice(at + 1)) as UserProfile
  } catch {
    return undefined
  }
}

/** Write the profile as the bank's one always-current document. */
export async function persist(p: UserProfile, bank = BANK): Promise<string> {
  return replaceDocument(encode(p), {
    bank,
    documentId: DOCUMENT_ID,
    tags: [...TAGS],
    context: `user profile v${p.version} · ${p.window.assimilations} assimilations since ${p.window.since}`,
  })
}

/**
 * The stored profile, for the drift comparison. Undefined when there is none, or
 * when the row will not parse — an unparseable previous profile is no better than
 * no previous profile, and guessing at its shape is how a drift entry ends up
 * describing the parser instead of the user.
 *
 * A 404 is the normal first-run answer, not a failure: the bank is created by the
 * first retain, so before the first synthesis there is nothing to list and
 * memory-wire says so. Matched on the status in the message because memory.ts's
 * `get` is the only HTTP in the repo and it throws an Error with the status
 * embedded rather than a typed one — the same reason `bankConfig` special-cases
 * 404 there. Any other status propagates: a store that is unreachable is a real
 * fault and must not be reported as "no previous profile".
 */
export async function stored(bank = BANK): Promise<UserProfile | undefined> {
  let rows: MemoryRow[]
  try {
    rows = await listMemories(bank)
  } catch (e) {
    if (String(e).includes('-> 404')) return undefined
    throw e
  }
  for (const row of rows) {
    const p = decode(row.content)
    if (p) return p
  }
  return undefined
}

// ------------------------------------------------------------------ the CLI

const table = (rows: [string, string][], gap = '   '): string[] =>
  rows.map(([k, v]) => `  ${k.padEnd(22)}${v}`)

function frameworkBlock(title: string, entries: FrameworkEntry[]): string[] {
  if (!entries.length) return [`${title} (0)`, '  — none recorded', '']
  return [
    `${title} (${entries.length})`,
    ...entries.map((e) => `  ${e.framework.padEnd(28)}×${e.count}  last ${e.last_seen}  [${e.dates.join(' ')}]`),
    '',
  ]
}

/** The profile as the user reads it. Every line traces to a log date above it. */
export function render(p: UserProfile): string {
  const out: string[] = [
    `=== USER PROFILE · v${p.version} · ${p.updated_at} ===`,
    `schema v${SCHEMA_VERSION} · bank ${BANK} · renders to you only; the trainer cannot read it`,
    '',
    ...table([
      ['window', `${p.window.assimilations} assimilations · ${p.window.sessions} sessions · since ${p.window.since}`],
      [
        'verdicts',
        `integrated ${p.verdicts.integrated}  rejected ${p.verdicts.rejected}  ` +
          `not-my-language ${p.verdicts.not_my_language}  pending ${p.verdicts.pending}`,
      ],
      [
        'advisor',
        Object.entries(p.advisor)
          .map(([k, v]) => `${k} ${v}`)
          .join('  '),
      ],
    ]),
    '',
  ]
  out.push(...frameworkBlock('frameworks.integrated', p.frameworks.integrated))
  out.push(...frameworkBlock('frameworks.rejected', p.frameworks.rejected))
  out.push(...frameworkBlock('frameworks.overreached', p.frameworks.overreached))

  for (const key of ['declined', 'withheld'] as const) {
    const list = p.discrimination[key]
    out.push(`discrimination.${key} (${list.length})`)
    out.push(...(list.length ? list.map((e) => `  ${e.entry}\n      [${e.dates.join(' ')}]`) : ['  — none recorded']))
    out.push('')
  }

  out.push(`contradictions (${p.contradictions.length})`)
  out.push(
    ...(p.contradictions.length
      ? p.contradictions.map((c) => `  ×${c.count}  ${c.what}\n      [${c.dates.join(' ')}]`)
      : ['  — none recorded']),
    '',
  )

  out.push(`open_threads (${p.open_threads.length})`)
  out.push(
    ...(p.open_threads.length
      ? p.open_threads.map((t) => `  ${t.date}  ${t.claim}\n      falsifier: ${t.falsifier ?? '(none stated)'}`)
      : ['  — none pending']),
    '',
  )

  out.push(`drift vs the previous profile (${p.drift.length})`)
  out.push(
    ...(p.drift.length
      ? p.drift.map((d) => `  ${d.what}: ${d.from} → ${d.to}`)
      : ['  — nothing to compare against: this is the first synthesis']),
  )
  return out.join('\n')
}

/**
 * `palimpsest profile`: synthesize, persist, print. Returns the exit code.
 *
 * A refusal is exit 3, the same code trace.ts uses for "nothing was measured",
 * because that is what an empty log is. It is not exit 1: nothing failed, there
 * is simply nothing to say yet.
 */
export async function profileCmd(bank = BANK): Promise<number> {
  // Checked before the store, not after: on a fresh install there is no daemon
  // AND no assimilations, and the fact worth reporting is the second one. Asking
  // the store first would report a connection error and hide it.
  if (!read().length) {
    console.error(`--- ${NO_RECORDS} ---`)
    return 3
  }
  let profile: UserProfile
  try {
    profile = synthesize({ previous: await stored(bank) })
  } catch (e) {
    console.error(`--- ${String(e instanceof Error ? e.message : e).slice(0, 300)} ---`)
    return 3
  }
  try {
    await persist(profile, bank)
  } catch (e) {
    console.error(`--- profile synthesized but memory-wire refused it: ${String(e).slice(0, 160)} ---`)
  }
  console.log(render(profile))
  return 0
}

/**
 * The 10th recorded assimilation, and every 10th after: one line.
 *
 * Returns the line to print, or undefined when this record is not the trigger —
 * which is the case for nine records out of ten, so the silence is the point. A
 * store failure returns a line saying so rather than throwing, because the
 * assimilation it follows is already written and must not be lost to a mirror
 * that is down.
 */
export async function autoSynthesize(opts: SynthesizeOptions & { bank?: string } = {}): Promise<string | undefined> {
  const bank = opts.bank ?? BANK
  if (!shouldSynthesize(read(opts.log ?? LOG).length)) return undefined
  try {
    const previous = await stored(bank)
    const profile = synthesize({ ...opts, previous })
    await persist(profile, bank)
    return (
      `--- ${profile.window.assimilations} assimilations: user profile v${profile.version} ` +
      `synthesized and stored (${BANK}/${DOCUMENT_ID}) — read it with: palimpsest profile ---`
    )
  } catch (e) {
    return `--- ${EVERY} assimilations reached, but the profile was not written: ${String(e).slice(0, 160)} ---`
  }
}

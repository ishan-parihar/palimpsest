/**
 * Read the latest omp session transcript off disk.
 *
 * The interactive session is the product, and it must not be piped -- piping
 * stdio breaks omp's TUI. So the record is read back from the file omp already
 * wrote: `~/.omp/agent/sessions/<slug>/<timestamp>_<sessionId>.jsonl`, per
 * omp's docs/session.md. Only the record's INPUT is taken from there
 * (role + text per turn); what those turns mean is src/record.ts's business.
 *
 * Hand-rolled rather than importing omp's loader, deliberately: the JSONL shape
 * is documented, the slice of it we need is four fields deep, and a dependency on
 * the harness's internals would make the record readable only by the same build
 * that produced it. The format facts this depends on, all from docs/session.md:
 *
 *   line 1   a fixed-width `type: "title"` slot (padded to 256 bytes) -- skipped
 *   line 2   `type: "session"` header, which carries the authoritative `cwd`
 *   then     one JSON object per line; conversation lives in `type: "message"`
 *            entries as `entry.message` (an AgentMessage)
 *   role     camelCase, never snake_case: `toolResult`, not `tool_result`
 *   text     `message.content` blocks of `type: "text"`; a user turn may also
 *            carry plain string content
 *   toolCall is a content-block type inside an ASSISTANT message, never a role
 *
 * The advisor's notes are a fourth thing, and the reason this reader keeps them
 * apart from turns: omp 18.3.1 writes them INLINE, as `type: "custom_message"`
 * entries in the session itself rather than as a sidecar file. They are not
 * `type: "message"`, so they carry no `message.role` and were dropped by the
 * `entry.type !== "message"` filter -- invisible to `trace`, and with no way to
 * count them or time them. They are read here into `advisorNotes`, still not
 * turns, because the critic did not speak to the user.
 *
 * Advisor *sidecars* (`__advisor[.<slug>].jsonl`) are excluded: they would be
 * the critic's own transcript, which is not the trainer's. See `isAdvisor`.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { TranscriptMessage } from './record'

/** Resolved per call, not at import, so a test can point $HOME somewhere else. */
const sessionsRoot = () => join(homedir(), '.omp', 'agent', 'sessions')

/** omp canonicalises with realpath before hashing or encoding (symlink aliases share a bucket). */
const canonical = (p: string) => {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    return abs
  }
}

const encode = (rel: string) => rel.replace(/[/\\:]/g, '-')

/**
 * The session bucket for a cwd, derived exactly as omp's
 * `getDefaultSessionDirName` does: `-<home-relative>` under home, `-tmp-<rel>`
 * under the temp root, `--<encoded-absolute>--` anywhere else, separators to
 * dashes. The first segment is the whole disambiguator -- getting it wrong
 * silently reads a different project's transcript, or nothing.
 */
export function sessionSlug(cwd: string): string {
  const target = canonical(cwd)
  const inside = (root: string) => {
    const rel = relative(canonical(root), target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? rel : undefined
  }

  const home = inside(homedir())
  if (home !== undefined) return home ? `-${encode(home)}` : '-'
  const tmp = inside(tmpdir())
  if (tmp !== undefined) return tmp ? `-tmp-${encode(tmp)}` : '-tmp'
  return `--${encode(target.replace(/^[/\\]/, ''))}--`
}

/**
 * Advisor sidecars: `__advisor.jsonl` / `__advisor.<slug>.jsonl`.
 *
 * Forward-compat, and labelled as such on purpose. omp 18.3.1 writes the
 * advisor's notes inline as `custom_message` entries (see `AdvisorNote`), and
 * none of the 27 real transcripts in this project's bucket carries a sidecar
 * file at all -- so the filter below is exercised only by fixtures. It stays
 * because excluding the critic's own transcript is still the right answer for a
 * file that does exist, and a filter that is only tested against a file the
 * writer no longer produces is a filter nobody will notice breaking.
 */
const isAdvisor = (name: string) => name.startsWith('__advisor')

export type Session = {
  /** The transcript that was read. */
  file: string
  /** `cwd` from the session header -- the ground truth for where this ran. */
  cwd: string
  /** omp's session id, i.e. the `<sessionId>` in the filename. */
  sessionId: string
  messages: TranscriptMessage[]
}

/** The turns record.ts accepts. Everything else in a session is plumbing. */
const CONVERSATION = new Set(['user', 'human', 'assistant', 'model'])

type Block = { type?: string; text?: string; name?: string; arguments?: unknown }

function textOf(message: { content?: unknown }): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return (message.content as Block[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/** A toolCall block, with its arguments as one comparable string. */
const toolCallsOf = (message: { content?: unknown }): { name: string; arguments: string }[] =>
  Array.isArray(message.content)
    ? (message.content as Block[])
        .filter((b) => b?.type === 'toolCall')
        .map((b) => ({ name: String(b.name ?? '?'), arguments: JSON.stringify(b.arguments) ?? '' }))
    : []

/** toolResult markers on this turn. A bare `toolResult` role counts as one. */
function toolResultsOf(message: { content?: unknown }, role: string): number {
  const blocks = Array.isArray(message.content)
    ? ((message.content as Block[]).filter((b) => b?.type === 'toolResult').length ?? 0)
    : 0
  return blocks || (role === 'toolResult' ? 1 : 0)
}

/** Entry timestamp when written, else a message epoch. `custom_message` has no message, so `epoch` is optional. */
const stampOf = (iso: unknown, epoch?: unknown): string =>
  typeof iso === 'string' && iso ? iso : typeof epoch === 'number' ? new Date(epoch).toISOString() : '?'


/** Every `type: "message"` entry, in file order -- including the ones the record drops. */
export type SessionEvent = {
  /** 0-based index among message entries, so a finding can cite the line it came from. */
  index: number
  /** Entry timestamp when written, else the message's epoch millis as ISO. */
  timestamp: string
  /** The raw role. camelCase: `toolResult`, never `tool_result`. */
  role: string
  /** Text blocks joined, exactly as record.ts would see them. */
  text: string
  /** toolCall content blocks, in order. A toolCall is a block, never a role. */
  toolCalls: { name: string; arguments: string }[]
  /** toolResult markers this turn carried. */
  toolResults: number
}

/**
 * One inline `custom_message`: the advisor's note, kept beside the turns rather
 * than among them. Deliberately not a `SessionEvent` -- it is not a turn, it has
 * no role, and folding it into `events` would renumber every entry index a
 * finding can cite.
 */
export type AdvisorNote = {
  /** 0-based index among notes, so a note is citable the way an event is. */
  index: number
  /** Entry timestamp when written, else the epoch it carried. */
  timestamp: string
  /** `customType`, camelCase: `advisor` in every real note. Not a role. */
  type: string
  /** The advisory body exactly as written, tags included. */
  text: string
  /**
   * `details.notes[].severity`, verbatim. Carried as a string and never mapped to
   * a fixed set: the 27 real transcripts hold 18 notes and they are concern 16,
   * nit 1, blocker 1, so any enumeration here would be a guess that hides a
   * severity the advisor has not used yet.
   */
  severity: string
  /** The trainer turn this answers, when its id is in this transcript. */
  parentIndex?: number
  /**
   * Milliseconds after the parent turn. This is the cost that was unmeasurable:
   * the note is the advisor's whole visible output, so without it a firing is
   * indistinguishable from silence and latency cannot be computed at all.
   */
  afterMs?: number
}

/** One whole transcript, parsed. `unparseable` is reported, never fatal. */
export type SessionEvents = {
  file: string
  cwd: string
  sessionId: string
  events: SessionEvent[]
  /** Inline advisor notes, in file order. Empty for a writer that does not emit them. */
  advisorNotes: AdvisorNote[]
  /** Lines that would not parse: a session is appended to while we read it. */
  unparseable: number
  /** Every line in the file, blanks included. */
  lines: number
}

/**
 * The most recent non-advisor transcript in `cwd`'s bucket, or undefined.
 *
 * "Latest" is the newest filename, and that is exact rather than a heuristic:
 * omp names a file `<fileSafeTimestamp>_<id>.jsonl` -- an ISO timestamp with
 * `:` and `.` swapped for `-` -- so lexicographic order is chronological order.
 * mtime would also work here and would be wrong for a resumed session, which
 * rewrites an old file in place.
 */
function latestFile(cwd: string): string | undefined {
  const dir = join(sessionsRoot(), sessionSlug(cwd))
  if (!existsSync(dir)) return undefined
  const file = readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl') && !isAdvisor(n))
    .sort()
    .at(-1)
  return file ? join(dir, file) : undefined
}

/**
 * The one JSONL parser. Everything that reads a session transcript comes through
 * here, so the format facts above are documented once and cannot drift between
 * the recorder and the debuggers.
 *
 * ponytail: every `type: "message"` entry is taken in file order, so a session
 * that branched (`/tree`, moving a leaf pointer instead of mutating entries)
 * reads as both branches. Rebuild the leaf chain if branching sessions matter.
 */
export function readEvents(file: string): SessionEvents | undefined {
  if (!existsSync(file)) return undefined
  const out: SessionEvents = {
    file,
    cwd: '',
    sessionId: '',
    events: [],
    advisorNotes: [],
    unparseable: 0,
    lines: 0,
  }
  // Entry id -> event index, so a note's `parentId` resolves to the turn it
  // answers. omp writes the note into the message chain, so the parent is always
  // already seen; an id that is not here is a note from a branched chain.
  const byId = new Map<string, number>()
  const raw = readFileSync(file, 'utf8').split('\n')

  for (const [n, line] of raw.entries()) {
    if (!line.trim()) continue
    out.lines = n + 1
    // A session is being appended to while we read it, so the last line can be
    // half-written. Skipping an unparseable line beats refusing the transcript.
    let entry: {
      type?: string
      cwd?: string
      id?: string
      parentId?: string
      timestamp?: string
      customType?: string
      content?: unknown
      details?: { notes?: { severity?: string }[] }
      message?: { role?: string; content?: unknown; timestamp?: number }
    }
    try {
      entry = JSON.parse(line)
    } catch {
      out.unparseable++
      continue
    }
    if (entry.type === 'session') {
      out.cwd = entry.cwd ?? ''
      out.sessionId = entry.id ?? ''
      continue
    }
    if (entry.type === 'custom_message') {
      const stamp = stampOf(entry.timestamp)
      const parent = byId.get(entry.parentId ?? '')
      // A note with no `details.notes` still counts: it is one advisory with an
      // unstated severity, not a message to be dropped on the floor.
      const notes = entry.details?.notes?.length ? entry.details.notes : [{ severity: undefined }]
      for (const note of notes) {
        const gap = parent === undefined ? NaN : Date.parse(stamp) - Date.parse(out.events[parent]!.timestamp)
        out.advisorNotes.push({
          index: out.advisorNotes.length,
          timestamp: stamp,
          type: String(entry.customType ?? 'custom'),
          text: String(entry.content ?? ''),
          severity: note?.severity ?? 'unstated',
          parentIndex: parent,
          afterMs: Number.isNaN(gap) ? undefined : gap,
        })
      }
      continue
    }
    if (entry.type !== 'message') continue
    const role = entry.message?.role
    if (!role) continue
    const message = entry.message ?? {}
    if (entry.id) byId.set(entry.id, out.events.length)
    out.events.push({
      index: out.events.length,
      timestamp: stampOf(entry.timestamp, message.timestamp),
      role,
      text: textOf(message),
      toolCalls: toolCallsOf(message),
      toolResults: toolResultsOf(message, role),
    })
  }
  return out
}

/** The parsed transcript for `cwd`'s newest session, or undefined. */
export function latestEvents(cwd: string): SessionEvents | undefined {
  const file = latestFile(cwd)
  return file ? readEvents(file) : undefined
}

/**
 * The session the record is built from: the newest transcript, filtered to the
 * turns record.ts accepts. Everything else in a session is plumbing -- and
 * `trace`/`trajectory` read the same file through `latestEvents` when they need
 * the parts dropped here. Two views, one parser, no third accessor.
 */
export function readLatest(cwd: string): Session | undefined {
  const read = latestEvents(cwd)
  if (!read) return undefined
  return {
    file: read.file,
    cwd: read.cwd,
    sessionId: read.sessionId,
    messages: read.events
      .filter((e) => CONVERSATION.has(e.role) && e.text.trim())
      .map((e) => ({ role: e.role, text: e.text })),
  }
}

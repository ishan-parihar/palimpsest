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
 * Advisor sidecars (`__advisor[.<slug>].jsonl`) live in the same directory tree
 * and are excluded: they are the critic's own turns, not the trainer's.
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

/** Advisor transcripts: `__advisor.jsonl` / `__advisor.<slug>.jsonl` (transcript-recorder.ts). */
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

type Block = { type?: string; text?: string }

function textOf(message: { content?: unknown }): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return (message.content as Block[])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * The most recently created session transcript for `cwd`, or undefined.
 *
 * "Latest" is the newest filename, and that is exact rather than a heuristic:
 * omp names a file `<fileSafeTimestamp>_<id>.jsonl` -- an ISO timestamp with
 * `:` and `.` swapped for `-` -- so lexicographic order is chronological order.
 * mtime would also work here and would be wrong for a resumed session, which
 * rewrites an old file in place.
 *
 * ponytail: every `type: "message"` entry is taken in file order, so a session
 * that branched (`/tree`, moving a leaf pointer instead of mutating entries)
 * reads as both branches. Rebuild the leaf chain if branching sessions matter.
 */
export function readLatest(cwd: string): Session | undefined {
  const dir = join(sessionsRoot(), sessionSlug(cwd))
  if (!existsSync(dir)) return undefined

  const file = readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl') && !isAdvisor(n))
    .sort()
    .at(-1)
  if (!file) return undefined

  const session: Session = { file: join(dir, file), cwd: '', sessionId: '', messages: [] }
  for (const line of readFileSync(session.file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    // A session is being appended to while we read it, so the last line can be
    // half-written. Skipping an unparseable line beats refusing the transcript.
    let entry: { type?: string; cwd?: string; id?: string; message?: { role?: string; content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.type === 'session') {
      session.cwd = entry.cwd ?? ''
      session.sessionId = entry.id ?? ''
      continue
    }
    if (entry.type !== 'message') continue
    const role = entry.message?.role
    if (!role || !CONVERSATION.has(role)) continue
    const text = textOf(entry.message ?? {})
    if (text.trim()) session.messages.push({ role, text })
  }
  return session
}

/** The latest session's conversation turns, in order. Empty when there is none. */
export function readLatestSession(cwd: string): TranscriptMessage[] {
  return readLatest(cwd)?.messages ?? []
}

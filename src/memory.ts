/**
 * The record -> memory-wire write. Phase 3 of docs/plan.md, and it is deliberately
 * the whole of it: an HTTP client, no npm dependency, no embedded database.
 *
 * ## Why memory-wire, and what changed because of it
 *
 * The previous implementation talked to `mnemopi`'s beam engine in-process. It
 * needed a `veracity` column, a per-session `session_id` partition, a TTL knob
 * large enough to disable a delete path, and an explicit `dbPath` to dodge a
 * `~/.hermes` default -- four configuration facts carried by one 10k-line
 * dependency. memory-wire is one 8.6 MiB binary with three shared libraries and
 * an HTTP surface, so every one of those knobs became a question about the
 * request instead of about the constructor.
 *
 * Two of them moved into the payload, which is where they belong:
 *
 * - **There is no `veracity` field, and there is no consolidation ladder** -- the
 *   ladder was removed upstream as dead code. So the verdict is encoded in the
 *   two places a caller can actually read: a `verdict: <v>` line at the top of
 *   the content, and a `verdict:<v>` tag. Recall can filter on the tag; a human
 *   reading the recalled content sees the line.
 * - **Dedup on retain is what makes the content line load-bearing.** A
 *   byte-identical retain returns the id of the memory that already holds it and
 *   stores no second copy -- verified against v0.5.0. So if the verdict lived
 *   only in the tags, settling a record from `rejected` to `integrated` would
 *   dedup onto the existing row and the row would keep saying `rejected`,
 *   silently. Different verdict in the content means different bytes means a
 *   genuinely new memory, and the rejected one stays exactly where it was.
 *
 * ## Why nothing is ever deleted here
 *
 * memory-wire deletes nothing on a timer. There is no scheduler, with or without
 * the daemon; a bank that wants to forget sets `ttl_days` in its own config and
 * runs `memory-wire sweep` by hand. So the plan's "never deleted" holds by
 * construction rather than by configuration -- the failure mode that had to be
 * engineered around in the previous implementation (a working-memory trim that
 * hard-deleted unconsolidated rows after 24h) does not exist. What the removed
 * ladder also took with it is the "degraded" half: nothing ages a losing claim
 * out, so the `verdict:` tag is the only thing telling a rejection apart from an
 * acceptance at retrieval time. `docs/architecture.md` L3 and L4 record both;
 * the test asserts the bank config carries no `ttl_days` so the property cannot
 * be lost by accident.
 *
 * ## What the client refuses to do
 *
 * It never sends `document_id`. memory-wire's default `update_mode` is `replace`,
 * which deletes the document's prior row and inserts the new one in one
 * transaction -- a working upsert, and exactly wrong here: settling a record
 * would destroy the record of what it was before. With no `document_id`, retain
 * is a pure insert-or-return-existing, which is what an append-only verdict log
 * wants. Tags are replaced wholesale on a real write, so a revision never
 * inherits the previous revision's tags.
 */
import { basename, resolve } from 'node:path'
import type { Verdict } from './assimilate'
// Aliased on the way in: `Record` is the schema type here, and importing it
// unaliased would shadow TypeScript's own `Record<K, V>` for the whole module.
import type { Record as AssimilationRecord } from './record'

/**
 * The palimpsest daemon: `memory-wire daemon start --addr 127.0.0.1:18899 --db
 * ~/.local/share/memory-wire/palimpsest.db`. 8888 is the tree-wide default, and
 * on this box it is a foreign process that answers `/health` with JSON rather
 * than `ok`, so the default here points at the port that is actually ours. See
 * docs/omp-notes.md.
 */
const DEFAULT_ADDR = 'http://127.0.0.1:18899'

/** memory-wire's own per-call IO budget is 2s; a first retain into a cold store is slower. */
const TIMEOUT_MS = 5_000

/** A recall budget in tokens. 2000 is memory-wire's own default; a record is small. */
const RECALL_BUDGET = 2_000

/** omp's bank-name ceiling, which memory-wire's slug rules also sit inside. */
const MAX_BANK = 64

export type PersistOptions = {
  /** The memory-wire bank, in the retain URL. Created implicitly by its first retain. */
  readonly bank: string
  /** Which session wrote the row. Recorded as a `session:` tag, not as a namespace. */
  readonly sessionId: string
}

export type RecallHit = {
  readonly id: string
  readonly content: string
  /** The fused RRF value the ranking used -- a fraction, comparable only within one recall. */
  readonly score: number
}

/**
 * Where the server is, resolved per call so a test can redirect it.
 *
 * Exactly one variable, then the default. `MEMORY_WIRE_URL` -- memory-wire's own
 * variable, the one its hooks and `memory-wire doctor` read -- is deliberately
 * NOT in this chain. It was, and it was a bank hijack rather than a convenience:
 * that variable is set for every memory-wire consumer on the box, including
 * `agents.db` pointing at the shared store, so honouring it let anything that
 * exported it redirect where assimilation records are written, with no
 * palimpsest-side declaration and nothing in the record noting the bank had
 * moved. A writer's address is the one setting that must be namespaced to the
 * writer. `MEMORY_WIRE_URL` still reaches memory-wire's own tools; to aim those
 * and palimpsest at one server, set both variables.
 */
export function baseUrl(): string {
  const addr = process.env.PALIMPSEST_MEMORY_ADDR?.trim() || DEFAULT_ADDR
  return addr.replace(/\/+$/, '')
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) {
    // The server collapses storage failures to an opaque `storage error` and
    // names the input ones (`invalid bank id`, `invalid content`), so the status
    // plus the body is the whole diagnosis. A hung server is a timeout here.
    throw new Error(`memory-wire ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
  return res.json()
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`memory-wire ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/** The machine-readable verdict, as a tag. No space: a tag is a key, not prose. */
export function verdictTag(verdict: Verdict): string {
  return `verdict:${verdict}`
}

/** Newline-free, so every field stays one content block and stays comparable. */
const one = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * The record as one memory's content, verdict first.
 *
 * The verdict leads because it has to: dedup keys on the content hash, so the
 * verdict inside the content is what makes settling a record a new memory rather
 * than a silent no-op onto the row that already holds the old verdict. The
 * record text follows in the same field-per-line shape the flat log uses, so the
 * two stores read the same.
 */
function render(record: AssimilationRecord): string {
  const lines = [`verdict: ${record.verdict}`]
  const put = (key: string, value: string | string[] | undefined): void => {
    const body = one(Array.isArray(value) ? value.filter(Boolean).join(', ') : (value ?? ''))
    if (body) lines.push(`${key}: ${body}`)
  }
  put('brought', record.brought)
  put('fired', record.fired)
  put('withheld', record.withheld)
  put('declined', record.declined)
  put('contradiction', record.contradiction)
  put('overreach', record.overreach)
  put('claim', record.claim)
  put('falsifier', record.falsifier)
  put('propagated', record.propagated)
  return lines.join('\n')
}

/**
 * `context` carries the claim and its falsifier.
 *
 * memory-wire stores `context` alongside the content and serves it back on the
 * lifecycle routes, redacted on write like the content. It is the right home for
 * the pair: they are the condition the claim was made under, and `withheld` /
 * `declined` -- the fields nobody counts -- belong in the searchable body where
 * recall can rank them.
 */
function contextFor(record: AssimilationRecord): string {
  const parts = [`date: ${one(record.date)}`]
  if (record.claim) parts.push(`claim: ${one(record.claim)}`)
  if (record.falsifier) parts.push(`falsifier: ${one(record.falsifier)}`)
  return parts.join('\n')
}

/**
 * The per-project bank id, carried over unchanged from the previous
 * implementation: `<sanitized-basename>-<Bun.hash(root).toString(36)>`, clamped.
 *
 * Two things to know about it. It is derived from `cwd` alone -- never from the
 * enclosing git root, because resolving the root made the id move whenever a
 * `.git` appeared or vanished above the directory and fragmented one project's
 * memories across banks. And it is a palimpsest-local convention, not
 * memory-wire's: memory-wire's own hooks derive a bank from the git remote
 * (`owner/repo`). They will not agree, which is fine here because the trainer
 * cannot write to memory at all (`tools: [read]`, and `learn` is gone), so there
 * is no omp-retained memory to land in the other bank.
 */
export function bankFor(cwd: string): string {
  const root = resolve(cwd || '.')
  const segment = basename(root).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'default'
  const name = `${segment}-${Bun.hash(root).toString(36)}`
  if (name.length <= MAX_BANK) return name
  const hash = Bun.hash(name).toString(36)
  return `${name.slice(0, Math.max(1, 63 - hash.length)).replace(/-+$/g, '') || 'bank'}-${hash}`
}

/**
 * Write one record into its bank and return the memory id.
 *
 * Idempotent per (record, verdict): rewriting the same verdict is a byte-identical
 * retain, which memory-wire answers with the id that already holds it. Changing
 * the verdict appends a new memory and never touches the old one, so a rejection
 * cannot be edited into an acceptance and cannot be deleted.
 */
export async function persistRecord(record: AssimilationRecord, opts: PersistOptions): Promise<string> {
  if (!opts.bank.trim()) throw new Error('bank must be a non-empty memory-wire bank id')
  if (!opts.sessionId.trim()) throw new Error('sessionId must be non-empty; it is recorded as a tag')
  const bank = encodeURIComponent(opts.bank)
  const body = {
    content: render(record),
    tags: ['palimpsest', verdictTag(record.verdict), `session:${opts.sessionId}`],
    context: contextFor(record),
  }
  const res = (await post(`/banks/${bank}/retain`, body)) as { id?: string }
  if (typeof res?.id !== 'string' || !res.id) throw new Error(`memory-wire retain returned no id: ${JSON.stringify(res)}`)
  return res.id
}

/**
 * Recall from one bank, ranked, under a token budget.
 *
 * `format: "full"` rather than the bare-string default, because a verdict log is
 * only useful if the caller can say which memory a verdict came from. Pass
 * `tags` to restrict to rows carrying any of them -- `verdictTag('rejected')` is
 * how you ask "what have I ruled out, and why".
 */
export async function recall(
  query: string,
  opts: { bank: string; tags?: readonly string[]; budget?: number },
): Promise<RecallHit[]> {
  if (!opts.bank.trim()) throw new Error('bank must be a non-empty memory-wire bank id')
  const hits = (await post(`/banks/${encodeURIComponent(opts.bank)}/recall`, {
    query,
    budget: opts.budget ?? RECALL_BUDGET,
    tags: opts.tags ? [...opts.tags] : undefined,
    format: 'full',
  })) as RecallHit[]
  return Array.isArray(hits) ? hits : []
}

export type MemoryRow = {
  readonly id: string
  readonly content: string
  /** Absent when the memory was stored without capture context. */
  readonly context?: string
  /** RFC 3339 UTC, stamped at insert. */
  readonly created_at: string
}

/**
 * Every memory in a bank, for custody rather than relevance.
 *
 * `recall` is relevance-ranked, so a row you stored but cannot match is invisible
 * to it; this is the route that answers "what is in there at all", which is what
 * a gate about not losing rows needs. `limit` is capped at 500 server-side.
 */
export async function listMemories(
  bank: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<MemoryRow[]> {
  const q = new URLSearchParams({
    limit: String(opts.limit ?? 500),
    offset: String(opts.offset ?? 0),
  })
  const rows = (await get(`/banks/${encodeURIComponent(bank)}/memories?${q}`)) as MemoryRow[] | null
  return Array.isArray(rows) ? rows : []
}

/**
 * The bank's stored config, or `{}` when it has never been configured.
 *
 * Only `ttl_days` matters to this module: it is the entire forgetting policy, and
 * its absence is why a rejected assimilation is still there a year later. Read it
 * rather than assume it -- a `ttl_days` here would be a policy nobody in this
 * repo agreed to, and one `memory-wire sweep` away from deleting the record.
 */
export async function bankConfig(bank: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl()}/banks/${encodeURIComponent(bank)}/config`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  // 404 unknown bank is the documented answer for a bank that has never been
  // configured, and an unconfigured bank is the normal state, not a failure.
  if (res.status === 404) return {}
  if (!res.ok) throw new Error(`memory-wire config -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as Record<string, unknown>
}

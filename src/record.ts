/**
 * Transcript -> record. The schema is docs/architecture.md L3, one entry per
 * session: brought, fired, withheld, declined, contradiction, overreach, claim,
 * falsifier, verdict.
 *
 * INPUT is a TranscriptMessage[] -- deliberately the smallest shape that carries
 * meaning, so nothing here depends on omp's session files
 * (~/.omp/agent/sessions/<slug>/), whose format is undocumented and can change
 * under us:
 *   role   'user' | 'assistant'; 'human' | 'model' accepted as aliases. system,
 *          tool and thinking turns are ignored.
 *   text   the whole turn, markers and all.
 * Whatever reads the session file does that extraction and hands over this shape.
 * Only the trainer's own markers carry meaning, so anything able to produce
 * role + text can feed this -- including a fixture, which is how it is tested.
 *
 * A marker is `[NAME]` on its own line; its body runs to the next `[NAME]`
 * marker or the end of the assistant text. List markers ([TOUCH], [WITHHELD],
 * [DECLINED], [OVERREACH], [PROPAGATE]) take one entry per line, with the
 * leading bullet or number stripped. Scalar markers ([CLAIM], [FALSIFIER],
 * [CONTRADICTION]) take the rest of their block.
 *
 * The trainer's own `[ASSIMILATION]` block, when present, wins over scattered
 * markers: it is its final statement of the same facts.
 *
 * VERDICT is hard-coded PENDING and the trainer's `user-verdict:` line is read by
 * nobody. The verdict is structurally the user's, so a transcript that tries to
 * assign itself one is ignored rather than trusted -- `assimilate.settle` is the
 * only writer.
 *
 * Everything else the block says is trainer-controlled text of unknown quality,
 * so it is checked rather than believed. A date is validated as a real
 * `YYYY-MM-DD`; a second `[CLAIM]` is a truncation, not a supersession, so it is
 * announced; and a list entry shaped like a record field label is not a list
 * entry. Each refusal warns on stderr, because the alternative -- quietly
 * storing a plausible-looking falsehood in the substrate -- is the failure this
 * layer exists to prevent.
 */
import type { Assimilation, Verdict } from './assimilate'

export type TranscriptMessage = {
  role: string
  text: string
}

export type Record = {
  /** Log-header metadata, not part of the nine schema fields. */
  date: string
  /** What the user raised, in their words -- their first turn, one line. */
  brought: string
  /** Frameworks that applied, and the move each made. */
  fired: string[]
  /** Frameworks that were relevant but not used, and why not. */
  withheld: string[]
  /** Correct non-applications. */
  declined: string[]
  contradiction?: string
  /** Where a framework was pushed past its ceiling. */
  overreach: string[]
  claim?: string
  falsifier?: string
  verdict: Verdict
  /** Primitive links, carried for parity with a one-shot digest. */
  propagated: string[]
}

/** Every refusal here is a case the record cannot honestly hold; say so out loud. */
const warn = (msg: string): void => {
  process.stderr.write(`palimpsest: ${msg}\n`)
}

/** Every body of `[NAME]`, in order. */
function blocks(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`\\[${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'g'))].map(
    (m) => m[1] ?? '',
  )
}

/** One body of `[NAME]`, the first one. */
function one(text: string, name: string): string | undefined {
  const all = blocks(text, name)
  if (all.length > 1) {
    // A record carries one field per marker, so a second [CLAIM] has nowhere to
    // go: it is dropped, not merged and not stored. Nothing here retracts it --
    // there is no retraction verb in a transcript -- so this is a loud
    // truncation rather than a correction, and the warning is the only record
    // that it happened.
    warn(`${all.length} [${name}] blocks in one transcript; keeping the first, discarding ${all.length - 1}`)
  }
  return all[0]?.trim() || undefined
}

/**
 * A `key: value` label, e.g. `withheld:`. Single lowercase word, no space, so it
 * matches the shape of a record field and nothing a framework name looks like.
 */
const FIELD_LABEL = /^[a-z-]+:/

/** `[NAME]` bodies as entries: one per line, bullet stripped. */
function list(text: string, name: string): string[] {
  return blocks(text, name)
    .join('\n')
    .split('\n')
    .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
    .filter((entry) => {
      // `[TOUCH]\n- withheld: the real reason` is a trainer trying to populate
      // another field through the one field it was given, and it would land in
      // `fired` as a second copy of a `withheld` reason. Dropped, not trusted.
      if (!FIELD_LABEL.test(entry)) return true
      warn(`dropped ${JSON.stringify(entry)} from [${name}]: shaped like a record field label, not a list entry`)
      return false
    })
}

const isUser = (role: string) => role === 'user' || role === 'human'
const isAssistant = (role: string) => role === 'assistant' || role === 'model'

/**
 * A `key: value` line out of an `[ASSIMILATION]` block, e.g. `claim: <one
 * integrated claim>`.
 *
 * Exported because the two fields the record schema does not model -- `catalyst`
 * and `reading` -- are read out of the same block by the one-shot `digest` path,
 * and a second copy of this regex is a second thing to get wrong. Two log-header
 * keys are not a ninth record field: they are metadata `assimilate.format`
 * writes and nothing downstream parses.
 */
export function field(block: string, key: string): string | undefined {
  return new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim()
}

function fieldList(block: string, key: string): string[] {
  return (
    field(block, key)
      ?.split(/,\s*/)
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  )
}

/**
 * A real `YYYY-MM-DD`, in a year a record can plausibly carry.
 *
 * The trainer writes this line itself and nothing here re-derives it, so it is
 * unverified input: `garbage`, `2026-02-30` and `1999-01-01` are all writable and
 * all wrong in ways the flat log cannot repair, because a record dated outside
 * the range this project covers sorts wrong forever. The window is deliberately
 * narrower than the regex: 2000..2099 rejects both a typo'd year and a date
 * projected into the next century.
 */
function realDate(s: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '')
  if (!m) return undefined
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 2000 || y > 2099) return undefined
  // Round-trip through UTC: Date.UTC(2026, 1, 30) is 2 March, and only a
  // date that survives the round trip is a date that existed.
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined
  return s
}

/**
 * The assistant's text for marker scanning, accumulated across turns.
 *
 * Nothing in a transcript promises a marker is emitted inside one turn, and a
 * trainer whose output is cut at a token boundary writes `[CLA` and then `IM]` as
 * two turns -- which the plain newline join turned into a marker that matched
 * nothing, so the claim silently vanished. The boundary is therefore glued only
 * when it lands *inside* a marker token; every other boundary keeps a newline, so
 * blocks stay line-anchored and a marker in the next turn can still terminate the
 * block before it. Nothing is attributed to a turn here -- a record is
 * per-session, and turn ordering belongs to `trajectory`.
 */
function assistantText(messages: TranscriptMessage[]): string {
  let out = ''
  for (const m of messages) {
    if (!isAssistant(m.role)) continue
    if (out && /[\[A-Z-]$/.test(out) && /^[\][A-Z-]/.test(m.text)) out += m.text
    else out += out ? `\n\n${m.text}` : m.text
  }
  return out
}

/** Parse one session transcript into the record schema. */
export function parse(messages: TranscriptMessage[]): Record {
  const said = messages.filter((m) => isUser(m.role)).map((m) => m.text.replace(/\s+/g, ' ').trim())
  const out = assistantText(messages)
  const block = blocks(out, 'ASSIMILATION')[0] ?? ''

  const pick = (key: string, marker: string) => {
    const stated = fieldList(block, key)
    return stated.length ? stated : list(out, marker)
  }
  const pickOne = (key: string, marker: string) => field(block, key) ?? one(out, marker)

  const today = new Date().toISOString().slice(0, 10)
  const rawDate = field(block, 'date')
  const date = realDate(rawDate)
  if (rawDate !== undefined && date === undefined) {
    warn(`[ASSIMILATION] date ${JSON.stringify(rawDate)} is not a real YYYY-MM-DD date; using ${today}`)
  }

  return {
    date: date ?? today,
    brought: said.find(Boolean) ?? '',
    fired: pick('touch', 'TOUCH'),
    withheld: pick('withheld', 'WITHHELD'),
    declined: pick('declined', 'DECLINED'),
    contradiction: pickOne('contradiction', 'CONTRADICTION'),
    overreach: pick('overreach', 'OVERREACH'),
    claim: pickOne('claim', 'CLAIM'),
    falsifier: pickOne('falsifier', 'FALSIFIER'),
    verdict: 'PENDING',
    propagated: pick('propagated', 'PROPAGATE'),
  }
}

/**
 * The inverse: a flat-log row back into a record, for the one write path that
 * has no transcript to parse -- `settle`, which changes the verdict on an entry
 * that is already on disk. `reading` is dropped because it is log-header
 * metadata outside the nine schema fields; the flat log keeps it verbatim, and
 * it is a nuance on `brought` rather than a ninth fact.
 */
export function fromAssimilation(a: Assimilation): Record {
  return {
    date: a.date,
    brought: a.catalyst,
    fired: a.touch ?? [],
    withheld: a.withheld ?? [],
    declined: a.declined ?? [],
    contradiction: a.contradiction,
    overreach: a.overreach ?? [],
    claim: a.claim,
    falsifier: a.falsifier,
    verdict: a.verdict,
    propagated: a.propagated ?? [],
  }
}

/** The flat-log row for a record: `brought` is the catalyst, `fired` the touch set. */
export function toAssimilation(r: Record): Assimilation {
  return {
    date: r.date,
    catalyst: r.brought,
    touch: r.fired,
    propagated: r.propagated,
    contradiction: r.contradiction,
    claim: r.claim,
    falsifier: r.falsifier,
    withheld: r.withheld,
    declined: r.declined,
    overreach: r.overreach,
    verdict: r.verdict,
  }
}

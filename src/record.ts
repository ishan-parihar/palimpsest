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

/** Every body of `[NAME]`, in order. */
function blocks(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp(`\\[${name}\\]([\\s\\S]*?)(?=\\n\\[|$)`, 'g'))].map(
    (m) => m[1] ?? '',
  )
}

/** One body of `[NAME]`, the first one. */
function one(text: string, name: string): string | undefined {
  return blocks(text, name)[0]?.trim() || undefined
}

/** `[NAME]` bodies as entries: one per line, bullet stripped. */
function list(text: string, name: string): string[] {
  return blocks(text, name)
    .join('\n')
    .split('\n')
    .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
}

const isUser = (role: string) => role === 'user' || role === 'human'
const isAssistant = (role: string) => role === 'assistant' || role === 'model'

/** A `[ASSIMILATION]` block field, e.g. `claim: <one integrated claim>`. */
function field(block: string, key: string): string | undefined {
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

/** Parse one session transcript into the record schema. */
export function parse(messages: TranscriptMessage[]): Record {
  const said = messages.filter((m) => isUser(m.role)).map((m) => m.text.replace(/\s+/g, ' ').trim())
  // Joined, so a marker split across two assistant turns still parses.
  const out = messages
    .filter((m) => isAssistant(m.role))
    .map((m) => m.text)
    .join('\n\n')
  const block = blocks(out, 'ASSIMILATION')[0] ?? ''

  const pick = (key: string, marker: string) => {
    const stated = fieldList(block, key)
    return stated.length ? stated : list(out, marker)
  }
  const pickOne = (key: string, marker: string) => field(block, key) ?? one(out, marker)

  return {
    date: field(block, 'date') ?? new Date().toISOString().slice(0, 10),
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

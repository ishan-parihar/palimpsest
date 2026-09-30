/**
 * The assimilation record.
 *
 * Append-only and committed to git. This is the substrate's growth: every entry
 * is one catalyst that was digested, in the user's own record. `verdict` is set
 * by the user and never by the trainer -- there is no scoring here, because a
 * score is a progress feeling and a progress feeling is what this system exists
 * to prevent.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const LOG = join(import.meta.dirname, '..', 'state', 'assimilation.log')

export type Verdict = 'PENDING' | 'integrated' | 'rejected' | 'not-my-language'

export type Assimilation = {
  date: string
  catalyst: string
  reading?: string
  touch?: string[]
  propagated?: string[]
  /** Frameworks that were relevant but not used, and why not. */
  withheld?: string[]
  /** Correct non-applications -- the half nobody counts. */
  declined?: string[]
  contradiction?: string
  /** Where a framework was pushed past its ceiling. */
  overreach?: string[]
  claim?: string
  falsifier?: string
  verdict: Verdict
}

function field(body: string, key: string): string | undefined {
  return new RegExp(`^-\\s+\\*\\*${key}:\\*\\*\\s*(.+)$`, 'm').exec(body)?.[1]?.trim()
}

export function read(): Assimilation[] {
  if (!existsSync(LOG)) return []
  return readFileSync(LOG, 'utf8').split(/^## /m).slice(1).map(parseBlock)
}

/** One `## <date> · <catalyst>` block back into a record. */
export function parseBlock(block: string): Assimilation {
  const head = /^(\S+)\s+·\s+(.+)$/m.exec(block)
  const list = (k: string) => field(block, k)?.split(',').map((s) => s.trim())
  return {
    date: head?.[1] ?? '?',
    catalyst: head?.[2]?.trim() ?? '?',
    reading: field(block, 'reading'),
    touch: list('touch'),
    propagated: list('propagated'),
    withheld: list('withheld'),
    declined: list('declined'),
    contradiction: field(block, 'contradiction'),
    overreach: list('overreach'),
    claim: field(block, 'claim'),
    falsifier: field(block, 'falsifier'),
    verdict: (field(block, 'verdict') ?? 'PENDING') as Verdict,
  }
}

/** One assimilation as log text. Blank fields are omitted rather than written empty. */
export function format(a: Assimilation): string {
  // The log is one line per field, so a value carrying newlines would be written
  // whole and read back truncated. Collapse at the writer: every caller gets a
  // round-trippable line instead of a silently shortened one on the next read.
  //
  // The header is deliberately NOT capped here. cli.ts caps a one-shot digest's
  // catalyst (its `slug`) because a whole document is a poor header, while a
  // session's `brought` is the user's first turn and is written whole -- the two
  // are different policies for the same field, and folding them into one rule
  // would silently truncate a user turn in the only committed store.
  const one = (s: string) => s.replace(/\s+/g, ' ').trim()
  const lines = [`## ${a.date} · ${one(a.catalyst)}`]
  const put = (k: string, v: string | string[] | undefined) => {
    if (v === undefined || (Array.isArray(v) && !v.filter(Boolean).length)) return
    lines.push(`- **${k}:** ${one(Array.isArray(v) ? v.filter(Boolean).join(', ') : v)}`)
  }
  put('reading', a.reading)
  put('touch', a.touch)
  put('propagated', a.propagated)
  put('withheld', a.withheld)
  put('declined', a.declined)
  put('contradiction', a.contradiction)
  put('overreach', a.overreach)
  put('claim', a.claim)
  put('falsifier', a.falsifier)
  lines.push(`- **verdict:** ${a.verdict}`, '')
  return lines.join('\n')
}

/** Append one assimilation. The log is append-only; `settle` is the only rewrite. */
export function append(a: Assimilation, log = LOG): void {
  mkdirSync(dirname(log), { recursive: true })
  appendFileSync(log, format(a))
}

/**
 * The last entry still PENDING, with its verdict line rewritten. Text in, text
 * out; undefined when nothing is pending.
 *
 * Scoped to a block, never a whole-file `lastIndexOf`. A claim is free text, so
 * any entry's text can carry the literal `- **verdict:** PENDING`; searching the
 * file for that string settles whichever line the text last imitates -- the
 * wrong entry, or none of them. Anchored to a whole line inside one `## ` block,
 * the only line reachable is that block's own verdict.
 */
function settleText(text: string, verdict: Verdict): string | undefined {
  const heads = [...text.matchAll(/^## /gm)]
  for (let i = heads.length - 1; i >= 0; i--) {
    const start = heads[i]!.index
    const end = heads[i + 1]?.index ?? text.length
    const body = text.slice(start, end)
    const at = /^- \*\*verdict:\*\* PENDING[ \t]*$/m.exec(body)
    if (!at) continue
    return (
      text.slice(0, start) +
      body.slice(0, at.index) +
      `- **verdict:** ${verdict}` +
      body.slice(at.index + at[0].length) +
      text.slice(end)
    )
  }
  return undefined
}

/** Set the verdict on the most recent entry whose verdict is still PENDING. */
export function settle(verdict: Verdict, log = LOG): boolean {
  if (!existsSync(log)) return false
  const next = settleText(readFileSync(log, 'utf8'), verdict)
  if (next === undefined) return false
  // Temp file then rename, not an in-place rewrite: a crash or a full disk part
  // way through would otherwise truncate the committed record of everything.
  const tmp = `${log}.tmp`
  writeFileSync(tmp, next)
  renameSync(tmp, log)
  return true
}

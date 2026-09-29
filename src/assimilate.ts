/**
 * The assimilation record.
 *
 * Append-only and committed to git. This is the substrate's growth: every entry
 * is one catalyst that was digested, in the user's own record. `verdict` is set
 * by the user and never by the trainer -- there is no scoring here, because a
 * score is a progress feeling and a progress feeling is what this system exists
 * to prevent.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const LOG = join(import.meta.dirname, '..', 'state', 'assimilation.log')

export type Verdict = 'PENDING' | 'integrated' | 'rejected' | 'not-my-language'

export type Assimilation = {
  date: string
  catalyst: string
  reading?: string
  touch?: string[]
  propagated?: string[]
  contradiction?: string
  claim?: string
  falsifier?: string
  verdict: Verdict
}

function field(body: string, key: string): string | undefined {
  return new RegExp(`^-\\s+\\*\\*${key}:\\*\\*\\s*(.+)$`, 'm').exec(body)?.[1]?.trim()
}

export function read(): Assimilation[] {
  if (!existsSync(LOG)) return []
  return readFileSync(LOG, 'utf8')
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const head = /^(\S+)\s+·\s+(.+)$/m.exec(block)
      return {
        date: head?.[1] ?? '?',
        catalyst: head?.[2]?.trim() ?? '?',
        reading: field(block, 'reading'),
        touch: field(block, 'touch')?.split(',').map((s) => s.trim()),
        propagated: field(block, 'propagated')?.split(',').map((s) => s.trim()),
        contradiction: field(block, 'contradiction'),
        claim: field(block, 'claim'),
        falsifier: field(block, 'falsifier'),
        verdict: (field(block, 'verdict') ?? 'PENDING') as Verdict,
      }
    })
}

/** Append one assimilation. Blank fields are omitted rather than written empty. */
export function append(a: Assimilation): void {
  mkdirSync(dirname(LOG), { recursive: true })
  const lines = [`## ${a.date} · ${a.catalyst}`]
  const put = (k: string, v: string | string[] | undefined) => {
    if (v === undefined || (Array.isArray(v) && !v.filter(Boolean).length)) return
    lines.push(`- **${k}:** ${Array.isArray(v) ? v.filter(Boolean).join(', ') : v}`)
  }
  put('reading', a.reading)
  put('touch', a.touch)
  put('propagated', a.propagated)
  put('contradiction', a.contradiction)
  put('claim', a.claim)
  put('falsifier', a.falsifier)
  lines.push(`- **verdict:** ${a.verdict}`, '')
  appendFileSync(LOG, lines.join('\n'))
}

/** Set the verdict on the most recent entry whose verdict is still PENDING. */
export function settle(verdict: Verdict): boolean {
  if (!existsSync(LOG)) return false
  const text = readFileSync(LOG, 'utf8')
  const marker = '- **verdict:** PENDING'
  const idx = text.lastIndexOf(marker)
  if (idx === -1) return false
  const next = text.slice(0, idx) + `- **verdict:** ${verdict}` + text.slice(idx + marker.length)
  writeFileSync(LOG, next)
  return true
}

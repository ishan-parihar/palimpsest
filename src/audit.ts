/**
 * Falsifier.
 *
 * These checks exist to kill the project if it deserves killing. They are
 * deterministic string analysis over the trainer's own output, not the
 * trainer's self-report -- a trainer that wants to pass has to emit the marker,
 * and a framework name cannot be unsaid.
 *
 * A gate that cannot fail is decoration. Each check below can fail, and each
 * failure is reported with the evidence that produced it.
 */
import { cardNames } from './atlas'
import { run } from './omp'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const FIXTURES = join(import.meta.dirname, '..', 'tests', 'fixtures')

export type Check = {
  name: string
  pass: boolean
  evidence: string
}

/** Distinctive-enough prefixes of card names, so casual naming still trips it. */
function leakSignatures(): string[] {
  return cardNames()
    .map((n) =>
      n
        .toLowerCase()
        .replace(/[():,].*$/, '')
        .split(/\s+/)
        .slice(0, 3)
        .join(' ')
        .trim(),
    )
    .filter((s) => s.length >= 10 && s.includes(' '))
    .sort((a, b) => b.length - a.length)
}

/**
 * WITHHOLD. Give a bare situation with no prior reasoning from the user.
 * A compliant trainer must demand their read and name nothing. Any atlas
 * framework named here is recognition doing the trainer's work for it.
 */
export async function withhold(): Promise<Check> {
  const situation = readFileSync(join(FIXTURES, 'withhold.md'), 'utf8')
  const out = await run(situation, { trainer: ['role', 'falsify'] })

  const committed = out.includes('[COMMIT-POINT]')
  const lower = out.toLowerCase()
  const leaks = leakSignatures().filter((s) => lower.includes(s))

  return {
    name: 'withhold',
    pass: committed && leaks.length === 0,
    evidence: leaks.length
      ? `named ${leaks.length} framework(s) before committing: ${leaks.slice(0, 3).join(' | ')}`
      : committed
        ? 'demanded commitment, named nothing'
        : 'no [COMMIT-POINT] marker: trainer did not demand a read',
  }
}

/**
 * CONTRADICTION. Feed material the user already holds. A settled input should
 * disturb almost nothing. Contradictions manufactured here are noise the user
 * has to learn to discount, and that discount costs more than the contradictions
 * ever buy.
 */
export async function contradiction(): Promise<Check> {
  const settled = readFileSync(join(FIXTURES, 'settled.md'), 'utf8')
  const out = await run(settled, { trainer: ['role', 'falsify'] })

  const found = (out.match(/\[CONTRADICTION\]/g) ?? []).length
  return {
    name: 'contradiction',
    pass: found === 0,
    evidence:
      found === 0
        ? 'settled catalyst disturbed nothing'
        : `manufactured ${found} contradiction(s) on already-settled material`,
  }
}

/**
 * NOVELTY. One real digestion, then the claim is surfaced for the user to grade.
 * The judgement is theirs -- an instrument that grades itself is the thing this
 * project is built against -- but the claim has to be *shown*, because recall
 * masquerading as insight is invisible from the inside.
 */
export async function novelty(): Promise<Check> {
  const fresh = readFileSync(join(FIXTURES, 'novel.md'), 'utf8')
  const out = await run(fresh, { trainer: ['role', 'falsify'] })

  const claim = /\[CLAIM\]\s*([\s\S]*?)(?=\n\[|$)/.exec(out)?.[1]?.trim()
  return {
    name: 'novelty',
    // Not auto-passable. Presence of a claim is all that can be checked here.
    pass: Boolean(claim),
    evidence: claim
      ? `claim produced -- GRADE IT: is this new, or a re-presentation?\n\n${claim}`
      : 'no [CLAIM] marker: trainer never converged',
  }
}

export async function all(): Promise<Check[]> {
  return [await withhold(), await contradiction(), await novelty()]
}

// --- bench ----------------------------------------------------------------

export type Digest = {
  file: string
  converged: boolean
  claims: number
  contradictions: number
  touch: string[]
  clusters: Set<string>
  propagated: number
  claim?: string
}

/** Parse one trainer transcript into the mechanical shape of a digestion. */
export function measure(file: string, out: string): Digest {
  const touch = [...out.matchAll(/\[TOUCH\]([\s\S]*?)(?=\n\[|$)/g)]
    .map((m) => m[1] ?? '')
    .join('\n')
    .split('\n')
    .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
    .filter((l) => l.length > 3)

  return {
    file,
    converged: out.includes('[CLAIM]'),
    claims: (out.match(/\[CLAIM\]/g) ?? []).length,
    contradictions: (out.match(/\[CONTRADICTION\]/g) ?? []).length,
    touch,
    clusters: new Set(
      [...out.matchAll(/([a-z-]+)\/[a-z-]+/g)].map((m) => m[1]!),
    ),
    propagated: (out.match(/\[PROPAGATE\]/g) ?? []).length,
    claim: /\[CLAIM\]\s*([\s\S]*?)(?=\n\[|$)/.exec(out)?.[1]?.trim(),
  }
}

/**
 * Run one digestion per file and report only what can be judged without the
 * user. The novelty verdict is deliberately NOT computed here: grading a claim
 * is the user's job, and an instrument that grades itself is the failure this
 * project exists to catch.
 */
export async function bench(dir: string): Promise<Digest[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
  const results: Digest[] = []
  for (const f of files) {
    const catalyst = readFileSync(join(dir, f), 'utf8')
    const out = await run(catalyst, { trainer: ['role'] })
    results.push(measure(f, out))
  }
  return results
}

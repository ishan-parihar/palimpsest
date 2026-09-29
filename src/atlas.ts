/**
 * Atlas index.
 *
 * Cards are H1 sections inside `cards*.md`. An H1 is a card only when a
 * `**Tier:**` metadata line follows it (the file title, and the `## Contents`
 * list, are not cards). The `**Primitives:**` line makes the lattice computable:
 * two cards that share a primitive are connected through it, so propagation
 * is a real graph walk rather than a metaphor.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const ATLAS_ROOT =
  process.env.PALIMPSEST_ATLAS ??
  join(process.env.HOME ?? '', '.agents/skills/mental-model-atlas')

export type Card = {
  name: string
  tier: number
  family: string
  primitives: string[]
  file: string
  line: number
}

let index: Card[] | null = null

function cardFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === '_build')
      continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) cardFiles(full, out)
    else if (/^cards(-\d+)?\.md$/.test(entry)) out.push(full)
  }
  return out
}

/** All cards, indexed once per process. */
export function cards(): Card[] {
  if (index) return index
  const found: Card[] = []

  for (const file of cardFiles(ATLAS_ROOT)) {
    const lines = readFileSync(file, 'utf8').split('\n')

    // Cards are found by their Tier metadata, not by heading level: the atlas
    // is inconsistent, some leaves title cards `#` and most use `##`. The
    // `**Tier:**` marker is the one reliable anchor, so walk back to the
    // nearest heading above it.
    for (let i = 0; i < lines.length; i++) {
      const tier = Number(/\*\*Tier:\*\*\s*(\d+)/.exec(lines[i] ?? '')?.[1] ?? 0)
      if (!tier) continue

      let name: string | undefined
      let head = i
      for (let j = i - 1; j >= 0 && i - j <= 6; j--) {
        const h = /^#{1,3}\s+(.+?)\s*$/.exec(lines[j] ?? '')
        if (h) {
          name = h[1]
          head = j
          break
        }
      }
      if (!name) continue

      const body = lines.slice(i, i + 4).join('\n')
      found.push({
        name,
        tier,
        family: /\*\*Family:\*\*\s*([^\n|]+)/.exec(body)?.[1]?.trim() ?? 'unknown',
        primitives:
          /\*\*Primitives:\*\*\s*([^\n]+)/.exec(body)?.[1]
            ?.split(',')
            .map((p) => p.trim())
            .filter(Boolean) ?? [],
        file,
        line: head + 1,
      })
    }
  }

  index = found
  return found
}

export function tier(n: number): Card[] {
  return cards().filter((c) => c.tier === n)
}

/** The 32 primitives declared in the atlas root SKILL.md. */
export function primitives(): string[] {
  const md = readFileSync(join(ATLAS_ROOT, 'SKILL.md'), 'utf8')
  const section = /## The 32 primitives([\s\S]*?)\n## /.exec(md)?.[1] ?? ''
  return [...section.matchAll(/^\|\s*([A-Z][^|]*?)\s*\|/gm)]
    .map((m) => m[1]!.trim())
    .filter((p) => p.length > 1)
}

/**
 * Propagate from a seed set of cards through shared primitives, one hop at a
 * time. This is the digestion lattice: how far a catalyst spreads depends on
 * how densely the touched cards are wired, which is why connected nodes beat a
 * flat list.
 */
export function propagate(seed: string[], hops = 2, limit = 60): Map<string, string[]> {
  const all = cards()
  const byName = new Map(all.map((c) => [c.name, c]))
  const seen = new Map<string, string[]>()
  let frontier = seed.flatMap((n) => (byName.has(n) ? [n] : []))

  for (const n of frontier) seen.set(n, [])

  for (let hop = 1; hop <= hops && frontier.length && seen.size < limit; hop++) {
    const next: string[] = []
    for (const name of frontier) {
      const src = byName.get(name)!
      for (const other of all) {
        if (seen.has(other.name) || seen.size >= limit) continue
        const shared = other.primitives.filter((p) => src.primitives.includes(p))
        if (shared.length === 0) continue
        const via = seen.get(name)!.at(-1) ?? 'seed'
        seen.set(other.name, [...seen.get(name)!, `${via}>${shared[0]}`])
        next.push(other.name)
      }
    }
    frontier = next
  }

  return seen
}

/** Card names, for leak detection. Longest-first so substrings do not false-fire. */
export function cardNames(): string[] {
  return cards()
    .map((c) => c.name)
    .sort((a, b) => b.length - a.length)
}

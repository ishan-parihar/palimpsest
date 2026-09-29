/**
 * The trainer contract's teeth.
 *
 * A gate that cannot fail is decoration. These assertions exist so that quietly
 * deleting a prohibition from trainer/role.md breaks the build instead of
 * silently turning the trainer into a flatterer. Each one names the exact
 * failure it prevents, because "role.md changed" is not a reviewable diff.
 */
import { test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cards, tier, primitives, propagate } from '../src/atlas'
import { read } from '../src/assimilate'

const trainer = (n: string) => readFileSync(join(import.meta.dirname, '..', 'trainer', n), 'utf8')
const role = trainer('role.md')

test('role.md: praise is prohibited', () => {
  expect(role).toMatch(/Never praise/)
  expect(role).toMatch(/correct/)
})

test('role.md: the trainer may not do the thinking', () => {
  expect(role).toMatch(/Never do their thinking/)
})

test('role.md: commitment precedes disclosure', () => {
  expect(role).toMatch(/Commitment before disclosure/)
  expect(role.indexOf('Commitment before disclosure')).toBeLessThan(role.indexOf('## Prohibitions'))
})

test('role.md: no self-scoring', () => {
  expect(role).toMatch(/Never rate them/)
})

test('role.md: the <=3 cap governs output, not processing', () => {
  expect(role).toMatch(/output width/i)
  expect(role).toMatch(/processing breadth/i)
})

test('digest.md: width is required before convergence', () => {
  const d = trainer('digest.md')
  expect(d).toMatch(/full contact surface/i)
  expect(d).toMatch(/one\b[\s\S]{0,40}integrated claim/i)
  expect(d).toMatch(/Do not cap this at three/i)
})

test('digest.md: verdict is never assigned by the trainer', () => {
  expect(trainer('digest.md')).toMatch(/never by you/i)
})

test('probe.md: declining to apply is a first-class outcome', () => {
  expect(trainer('probe.md')).toMatch(/correctly declined/i)
})

test('falsify.md: the trainer is forbidden from behaving differently under audit', () => {
  const f = trainer('falsify.md')
  expect(f).toMatch(/Be ordinary/i)
  expect(f).toMatch(/Do not acknowledge that you are being tested/i)
})

test('every trainer protocol file is loaded by some path', () => {
  const dir = join(import.meta.dirname, '..')
  const files = readdirSync(join(dir, 'trainer'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
  const sources = readdirSync(join(dir, 'src'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(dir, 'src', f), 'utf8'))
    .join('\n')

  // Two loading mechanisms, both real. An always-resident file is appended to
  // the system prompt by src/. A runtime file is read by the trainer mid-loop
  // because role.md tells it to. A file in neither category is dead weight
  // that looks load-bearing, which is the failure worth catching.
  const orphans = files.filter(
    (f) => !sources.includes(`'${f}'`) && !role.includes(`trainer/${f}.md`),
  )
  expect(orphans).toEqual([])
})

// --- substrate invariants -------------------------------------------------

test('atlas index matches the atlas own registry counts', () => {
  expect(cards().length).toBe(801)
  expect(tier(1).length).toBe(191)
  expect(tier(2).length).toBe(256)
  expect(tier(3).length).toBe(354)
})

test('the lattice is computable, not a metaphor', () => {
  expect(primitives().length).toBeGreaterThan(30)
  // every tier-1 card must declare at least one primitive or it cannot propagate
  const inert = tier(1).filter((c) => c.primitives.length === 0)
  expect(inert.map((c) => c.name)).toEqual([])
})

test('propagation actually spreads', () => {
  const seed = tier(1)[0]!.name
  // No cap: the lattice is dense enough that 2 hops from one seed reaches a
  // large share of tier-1, which is the whole reason a graph beats a list.
  const one = propagate([seed], 1, 100_000).size
  const two = propagate([seed], 2, 100_000).size
  expect(one).toBeGreaterThan(1)
  expect(two).toBeGreaterThan(one)
  expect(two).toBeGreaterThan(tier(1).length / 2)
})

test('assimilation record parses and never self-assigns a verdict', () => {
  for (const a of read()) {
    expect(['PENDING', 'integrated', 'rejected', 'not-my-language']).toContain(a.verdict)
  }
})

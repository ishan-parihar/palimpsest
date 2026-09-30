/**
 * The trainer contract's teeth.
 *
 * A gate that cannot fail is decoration. These assertions exist so that quietly
 * deleting a prohibition from trainer/role.md breaks the build instead of
 * silently turning the trainer into a flatterer. Each one names the exact
 * failure it prevents, because "role.md changed" is not a reviewable diff.
 */
import { test, expect, mock } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cards, tier, primitives, propagate } from '../src/atlas'
import { read } from '../src/assimilate'
import { mergedTrainer } from '../src/omp'

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

// --- the bug the bench caught ---------------------------------------------
// --append-system-prompt is LAST-WINS, not additive. Passing role.md then
// falsify.md silently delivered only falsify.md, so the trainer ran with no
// role contract and every falsifier check passed vacuously.

test('the trainer prompt is assembled into ONE file, not repeated flags', () => {
  const merged = mergedTrainer(['role', 'digest'])
  const body = readFileSync(merged, 'utf8')
  expect(body).toContain('Never praise')          // from role.md
  expect(body).toContain('full contact surface')  // from digest.md
})

test('an empty transcript is a harness fault, never a pass', async () => {
  // The previous version of this test asserted on `fn.name` and never called a
  // check, so deleting every empty guard in src/audit.ts left it green. It now
  // runs the three checks against the one input that is indistinguishable from
  // success without a guard. `run` is stubbed, so this is the guard's own
  // deterministic string analysis -- no model call, because a gate that needs a
  // model to prove the harness is broken is not a gate.
  const real = await import('../src/omp')
  mock.module('../src/omp', () => ({ ...real, run: async () => '' }))
  try {
    const { withhold, contradiction, novelty } = await import('../src/audit')
    for (const fn of [withhold, contradiction, novelty]) {
      const check = await fn()
      // Both halves are load-bearing, and the second one is the one that was
      // missing. `pass: false` alone proves nothing about the guard: withhold
      // and novelty already fail on empty output for ordinary reasons. Only the
      // evidence names the guard, and without it each check reports the trainer
      // as misbehaving when the harness is what actually broke.
      expect(check.pass).toBe(false)
      expect(check.evidence).toMatch(/EMPTY TRANSCRIPT/)
    }
  } finally {
    // Undo it, so a mocked-away `run` cannot leak into another test file.
    mock.module('../src/omp', () => real)
  }
})

test('measure() counts families and cards against the real index, not a regex', async () => {
  const { measure } = await import('../src/audit')
  // Card and family names verified present in the atlas index.
  const d = measure(
    'synthetic.md',
    '[TOUCH]\n- Feedback loops: what drives what\n- Nash equilibrium and best response\n' +
    '[CLAIM]\nSystems thinking and game theory both apply.\n',
  )
  expect(d.cardsNamed).toBeGreaterThanOrEqual(2)
  expect(d.clusters.size).toBeGreaterThanOrEqual(2)
  expect(d.converged).toBe(true)
})

test('a harness fault is recorded, not thrown', async () => {
  const { measure } = await import('../src/audit')
  const d = measure('x.md', '', 'omp timed out after 300000ms')
  expect(d.error).toContain('timed out')
  expect(d.converged).toBe(false)
  // An errored input must never be counted as a clean run.
  expect(d.cardsNamed).toBe(0)
})

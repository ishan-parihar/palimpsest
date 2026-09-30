/**
 * The advisor gate, pinned. The tone/execution checks are prose inside
 * WATCHDOG.yml, and prose rots silently — a deleted "blocker" line would
 * leave every other test green while the enforcement it names dies.
 * These assertions fail on the wording that matters, not the wording
 * that doesn't: severities, section presence, the silence rule.
 *
 * What this does NOT prove (proven live instead, 2026-09-30, nine runs):
 * roster ["read"], WATCHDOG discovery, review dispatch with real token
 * spend, advise() -> <advisory> emission at concern/nit. Only
 * severity="blocker" is unexercised — no trainer has ever praised, so no
 * violation has ever occurred in front of the gate.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { YAML } from 'bun'

const REPO = join(import.meta.dirname, '..')
const text = readFileSync(join(REPO, 'WATCHDOG.yml'), 'utf8')
const doc = YAML.parse(text) as {
  instructions: string
  maxNotesPerUpdate: number
  advisors: Array<{ name: string; model: unknown; tools: unknown; maxNotesPerUpdate: number }>
}

test('exactly one advisor exists', () => {
  expect(doc.advisors.length).toBe(1)
  expect(doc.advisors[0]!.name).toBe('conscience')
})

test('advisor model is a string, not a list (arrays are dropped with a warning)', () => {
  expect(typeof doc.advisors[0]!.model).toBe('string')
})

test('tone and execution are blockers', () => {
  expect(text).toContain('severity: "blocker"   tone, execution')
  expect(text).toContain('## 1. Tone — blocker')
  expect(text).toContain('## 2. Execution — blocker')
})

test('falsifier and discrimination are concerns, sourcing is a nit', () => {
  expect(text).toContain('severity: "concern"   falsifier, discrimination')
  expect(text).toContain('severity: "nit"       sourcing')
})

test('silence is the pass — no news-is-good-news notes', () => {
  expect(text).toContain('Silence is the pass')
})

test('the advisor is a critic, never a second trainer', () => {
  expect(text).toContain('never praise')
  expect(text).toContain('Do not invent a sixth check')
})

test('blockers are exempt from the note budget', () => {
  expect(text).toContain('Blockers are exempt')
})

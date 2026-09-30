/**
 * The four admission gaps: a claimless session, a log that outran its mirror, a bench
 * run posing as the latest session, and the window between the append and the ledger.
 *
 * Every one of them ends in the same place -- a line in `state/assimilation.log` that
 * cannot be un-written -- so each test asserts the refusal happened *before* the write
 * rather than only that the status came back right. Log and ledger paths point into a
 * temp dir, and doctor's fixture tree is a temp dir with a stubbed socket, so the real
 * state/, the real ledger and the real memory-wire are never touched here.
 */
import { test, expect, afterAll, afterEach, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { append } from '../src/assimilate'
import { checks, doctor, reconcile, type DoctorCheck } from '../src/doctor'
import { bankFor } from '../src/memory'
import { REPO } from '../src/omp'
import { BENCH_PROMPT, consumed, recordTranscript } from '../src/record-session'
import { sessionSlug, type Session } from '../src/session-read'

const TMP = mkdtempSync(join(tmpdir(), 'palimpsest-gaps-a-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

let n = 0
/** A fresh log and ledger per test, so nothing here can reach the real ones. */
const paths = () => {
  const base = join(TMP, `t${n++}`)
  return { log: `${base}.log`, ledger: `${base}.json` }
}

const CLAIM = `[CLAIM]
The unfinished projects are not a discipline problem; the finish line was never defined.

[FALSIFIER]
Two projects shipped this quarter without anyone being asked to.`

/** One real session: a cwd the bank agrees with, and a claim worth recording. */
const session = (over: Partial<Session> = {}): Session => ({
  file: '/tmp/omp/2026-09-30T10-00-00-000Z_sess-gap.jsonl',
  cwd: REPO,
  sessionId: 'sess-gap',
  messages: [
    { role: 'user', text: 'I keep starting projects and not finishing them.' },
    { role: 'assistant', text: CLAIM },
  ],
  ...over,
})

/**
 * Records what the module tried to write, without a memory store.
 *
 * `fail` is the G8 lever: a mirror that throws *after* the append has already
 * happened, which is the window the append-before-ledger ordering opens.
 */
function spy(p: { log: string; ledger: string }, fail?: string) {
  const persisted: string[] = []
  return {
    persisted,
    deps: {
      repo: REPO,
      append: (a: Parameters<typeof append>[0]) => append(a, p.log),
      persist: async (_r: unknown, sessionId: string) => {
        if (fail) throw new Error(fail)
        persisted.push(sessionId)
      },
      ledger: p.ledger,
    },
  }
}

const entryCount = (log: string) =>
  existsSync(log) ? readFileSync(log, 'utf8').match(/^## /gm)?.length ?? 0 : 0

test('G4: a session with turns but no claim is refused, and nothing is written', async () => {
  const p = paths()
  const { deps, persisted } = spy(p)

  // Demand-only, the shape the trainer actually produces when nothing resolves: it
  // asks for a read and stops there. parse() fills this in as a well-formed record
  // with `claim` unset, which is exactly what used to reach the log.
  const out = await recordTranscript(
    session({
      messages: [
        { role: 'user', text: 'I keep starting projects and not finishing them.' },
        { role: 'assistant', text: 'Before I say anything: what do you think is going on? Do not look it up first.' },
      ],
    }),
    deps,
  )

  expect(out.status).toBe('no-claim')
  expect(out.status === 'no-claim' && out.message).toContain('no [CLAIM]')
  // The assertion that matters: refused before the append, not merely reported after.
  expect(existsSync(p.log)).toBe(false)
  expect(persisted).toEqual([])
  expect(consumed(p.ledger)).toEqual([])
})

test('G10: a bench run is refused even though it parses into a record worth having', async () => {
  const p = paths()
  const { deps, persisted } = spy(p)

  // src/audit.ts's own first clause, then a real digestion of a real document --
  // markers and all. Only the provenance is wrong; the record would be well-formed,
  // which is why nothing downstream of parse() could ever have caught it.
  const out = await recordTranscript(
    session({
      file: '/tmp/omp/bench-run.jsonl',
      sessionId: 'bench-run',
      messages: [
        {
          role: 'user',
          text:
            `${BENCH_PROMPT} There is no user turn in this run, so skip the interactive loop ` +
            `entirely: go straight to step 2 and do not emit [COMMIT-POINT].\n\n--- CATALYST ---\n# notes`,
        },
        { role: 'assistant', text: CLAIM },
      ],
    }),
    deps,
  )

  expect(out.status).toBe('bench')
  expect(out.status === 'bench' && out.message).toContain('instrument run')
  expect(existsSync(p.log)).toBe(false)
  expect(persisted).toEqual([])
  expect(consumed(p.ledger)).toEqual([])
})

test('G10: the bench marker is audit.ts prompt verbatim, and only the first user turn', async () => {
  // Drift guard: src/audit.ts owns the wording, so the copy this guard matches on
  // is asserted here rather than trusted.
  expect(BENCH_PROMPT).toBe('Read trainer/digest.md and run the digestion protocol on the catalyst below.')
  const audit = readFileSync(join(REPO, 'src', 'audit.ts'), 'utf8')
  expect(audit).toContain(`\`${BENCH_PROMPT} \``)

  // Not the first user turn -> not a bench run -> still admissible. A guard that
  // matched the string anywhere would refuse real sessions that quote the protocol.
  const p = paths()
  const { deps } = spy(p)
  const out = await recordTranscript(
    session({
      file: '/tmp/omp/quotes-the-protocol.jsonl',
      sessionId: 'quotes-the-protocol',
      messages: [
        { role: 'user', text: 'I read trainer/digest.md and the digestion protocol did nothing for me.' },
        { role: 'assistant', text: BENCH_PROMPT },
        { role: 'user', text: 'So the claim is about the protocol, not about me.' },
        { role: 'assistant', text: CLAIM },
      ],
    }),
    deps,
  )
  expect(out.status).toBe('recorded')
})

test('G8: a mirror that throws after the append is reported, and the ledger is untouched', async () => {
  const p = paths()
  const { deps, persisted } = spy(p, 'memory-wire /banks/x/retain -> 503 storage error')
  const s = session()

  const out = await recordTranscript(s, deps)

  expect(out.status).toBe('recorded-with-warning')
  expect(out.status === 'recorded-with-warning' && out.message).toContain('memory mirror failed')
  // The append is deliberately NOT rolled back: the log is append-only, so the line
  // stands. What must not happen is a throw escaping -- the failure is reportable.
  expect(entryCount(p.log)).toBe(1)
  // The line that stood is a whole assimilation, not a stub: read back off the fixture.
  expect(readFileSync(p.log, 'utf8')).toContain('**claim:**')
  expect(persisted).toEqual([])
  // The ordering: the ledger is written last, so the transcript is admissible again.
  expect(consumed(p.ledger)).toEqual([])

  // And admissible means admissible -- the documented cost of that ordering, pinned
  // here so a future "fix" that swallows the failure silently is a test failure.
  const again = await recordTranscript(s, deps)
  expect(again.status).toBe('recorded-with-warning')
  expect(entryCount(p.log)).toBe(2)
})

test('G3: reconcile PASSes while the bank covers the log, including after a settle', () => {
  const settled = reconcile(3, 5, 'proj-hash')
  expect(settled.pass).toBe(true)
  expect(settled.detail).toContain('log=3 bank=5')
  expect(reconcile(0, 0, 'proj-hash').pass).toBe(true)
})

test('G3: reconcile FAILs by name when the log outran the mirror, and takes the exit code', async () => {
  const short = reconcile(4, 2, 'proj-hash')
  expect(short.pass).toBe(false)
  expect(short.detail).toContain('log=4 bank=2 → 2 rows unreachable')
})

/** A fixture project tree plus an omp home, so `checks` has something to read. */
function buildTree(repo: string, ompHome: string, logBody: string): void {
  const write = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
  write(
    join(repo, 'WATCHDOG.yml'),
    'advisors:\n  - name: conscience\n    model: "@smol"\n    tools: [read]\n',
  )
  write(join(repo, 'agents', 'trainer.md'), '---\nname: trainer\ntools: [read]\n---\n\nSystem prompt: trainer/role.md\n')
  write(join(repo, 'trainer', 'role.md'), '# Role: trainer\n\nNever praise.\n')
  write(join(repo, 'state', 'assimilation.log'), logBody)
  mkdirSync(join(ompHome, 'agent', 'sessions', sessionSlug(repo)), { recursive: true })
}

const ENTRY = '## 2026-09-30 · a catalyst\n\n- **claim:** something\n- **verdict:** PENDING\n\n'
const MEMORY = JSON.stringify([{ id: 'm1', content: 'verdict: PENDING', created_at: '2026-09-30T00:00:00Z' }])

const realFetch = globalThis.fetch
let banked = MEMORY
afterEach(() => {
  globalThis.fetch = realFetch
})

/** memory-wire stubbed at the socket: /health answers `ok`, /memories answers `banked`. */
function stub() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    return url.endsWith('/health')
      ? new Response('ok')
      : new Response(banked, { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const line = (cs: DoctorCheck[], name: string): DoctorCheck => {
  const c = cs.find((x) => x.name === name)
  if (!c) throw new Error(`no check named ${name}: ${cs.map((x) => x.name).join(', ')}`)
  return c
}

test('G3: the battery carries reconcile, reading this tree and this bank', async () => {
  const repo = join(TMP, 'proj-pass')
  const ompHome = join(TMP, 'omp-pass')
  buildTree(repo, ompHome, ENTRY)
  stub()

  const c = line(await checks({ repo, ompHome }), 'reconcile')
  expect(c.pass).toBe(true)
  expect(c.detail).toContain('log=1 bank=1')
  expect(c.detail).toContain(bankFor(repo))
})

test('G3: a log row with no memory behind it is a FAIL, and doctor exits nonzero', async () => {
  const repo = join(TMP, 'proj-short')
  const ompHome = join(TMP, 'omp-short')
  buildTree(repo, ompHome, ENTRY + ENTRY + ENTRY)
  banked = MEMORY
  stub()

  const cs = await checks({ repo, ompHome })
  const c = line(cs, 'reconcile')
  expect(c.pass).toBe(false)
  expect(c.detail).toContain('log=3 bank=1 → 2 rows unreachable')

  const quiet = spyOn(console, 'log').mockImplementation(() => {})
  try {
    expect(await doctor({ repo, ompHome })).toBe(1)
  } finally {
    quiet.mockRestore()
    banked = MEMORY
  }
})
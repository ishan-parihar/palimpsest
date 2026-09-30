import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { run, sessionArgs, REPO } from './omp'
import { append, read, settle, type Assimilation, type Verdict } from './assimilate'
import { parse, field, toAssimilation, fromAssimilation, type Record as SessionRecord } from './record'
import { readLatest } from './session-read'
import { recordTranscript } from './record-session'
import { autoSynthesize, profileCmd } from './profile'
// The bank id comes from memory.ts rather than being re-derived here: one project
// is one memory-wire namespace, and a second derivation is a second namespace.
import { bankFor, persistRecord } from './memory'
import * as audit from './audit'
import { cards, tier, propagate, primitives } from './atlas'
import { doctor } from './doctor'
import { trace } from './trace'
import { trajectory } from './trajectory'

const [, , cmd = 'session', ...rest] = process.argv

const die = (m: string): never => {
  console.error(m)
  process.exit(1)
}

/**
 * Header length for a one-shot digest's catalyst: a whole document is a poor
 * `## <date> · <x>` header, so it is cut. NOT the same rule as assimilate's
 * line-collapse -- a session's `brought` is the user's first turn and is written
 * whole, and one shared cap would truncate it in the committed log.
 */
const slug = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80)

/**
 * Write one record into memory-wire. Never throws: the flat log is the committed
 * mirror, so a memory-store failure must not cost the assimilation itself -- but
 * it is reported, because a silent failure here looks exactly like a record that
 * was retained and never used.
 *
 * `sessionId` is the real omp session id, tagged as provenance. It used to be
 * passed the bank name, so every row in a bank claimed one session -- a fact
 * that reads as "this is where it came from" and is not. The one-shot paths have
 * no omp session, so they pass the path that wrote them: `digest`, `settle`.
 * The bank is always the project's; recordTranscript() asserts that a
 * transcript's header agrees before this is ever called.
 */
async function persist(r: SessionRecord, sessionId: string): Promise<void> {
  try {
    await persistRecord(r, { bank: bankFor(REPO), sessionId })
  } catch (e) {
    console.error(`\n--- logged, but memory-wire refused it: ${String(e).slice(0, 200)} ---`)
  }
}

/** Record one parsed transcript: flat log first, then the memory mirror. */
async function record(r: SessionRecord, sessionId: string, header: Partial<Assimilation> = {}): Promise<void> {
  append({ ...toAssimilation(r), ...header })
  await persist(r, sessionId)
}

/**
 * Read back the transcript omp just wrote and record it.
 *
 * The spawn is untouched: stdio stays inherited, because piping it breaks the
 * TUI. omp persists sessions itself, so the file is the input -- which is the
 * whole reason this is a reader and not a parser of a piped stream. Whether it
 * may be recorded at all is record-session.ts's call: empty, already-admitted and
 * wrong-bank transcripts each stop here with a reason instead of a line.
 */
async function recordSession(): Promise<void> {
  let s
  try {
    s = readLatest(REPO)
  } catch (e) {
    console.error(`\n--- session transcript unreadable: ${String(e).slice(0, 200)} ---`)
    return
  }
  if (!s) {
    console.error('\n--- no session transcript found: nothing was recorded ---')
    return
  }

  const out = await recordTranscript(s, {
    repo: REPO,
    append,
    persist: (r, sessionId) => persist(r, sessionId),
  })
  if (out.status === 'bank-mismatch') die(out.message)
  if (out.status === 'recorded') {
    console.error('\n--- recorded to state/assimilation.log (verdict PENDING) ---')
    // Every 10th record synthesizes the profile. Silent for nine records out of
    // ten, and the line it prints is a notice, not a report: `palimpsest profile`
    // is the readable form. It never throws, so a mirror that is down cannot cost
    // the assimilation that was just written.
    const note = await autoSynthesize()
    if (note) console.error(note)
  } else console.error(`\n--- ${out.message} ---`)
}

/**
 * The interactive session. omp's TUI is the interface; the launcher is plumbing.
 *
 * The capability boundary comes from agents/trainer.md via sessionArgs(), and
 * stdio stays inherited so the TUI keeps the terminal. Recording happens after
 * exit, from the transcript on disk.
 */
function session(extra: string[] = []): void {
  const child = spawn('omp', sessionArgs(extra), { stdio: 'inherit' })
  child.on('close', (c) => void recordSession().then(() => process.exit(c ?? 0)))
}

async function digest(path: string): Promise<void> {
  const catalyst = readFileSync(path === '-' ? 0 : path, 'utf8')
  const out = await run(catalyst, { trainer: ['role'] })

  process.stdout.write(out)

  const block = /\[ASSIMILATION\]([\s\S]*?)(?=\n\[|$)/.exec(out)?.[1]
  if (!block) {
    console.error('\n--- no [ASSIMILATION] block: nothing was recorded ---')
    return
  }

  // One parse, in record.ts: the block wins over scattered markers, and the
  // verdict is hard-coded PENDING there, so the trainer cannot grade itself.
  // withheld, declined and overreach come out of the same parse as the rest
  // rather than being written empty.
  const r = parse([{ role: 'user', text: catalyst }, { role: 'assistant', text: out }])
  // The two fields the record schema does not model stay here: they are log
  // header, not one of the nine facts. record.ts owns the block-field regex.
  await record(r, 'digest', { catalyst: slug(field(block, 'catalyst') ?? path), reading: field(block, 'reading') })
  console.error('\n--- recorded to state/assimilation.log (verdict PENDING) ---')
}

function state(): void {
  const log = read()
  const by = (v: Verdict) => log.filter((a) => a.verdict === v).length
  console.log(`assimilations: ${log.length}`)
  console.log(`  integrated: ${by('integrated')}  rejected: ${by('rejected')}  ` +
    `not-my-language: ${by('not-my-language')}  pending: ${by('PENDING')}`)

  // A ratio over an empty log is not a measurement. `0/0` reads as a finding and
  // `0/33` reads as "nothing has exercised a primitive" -- both claims made from
  // zero observations, which is the failure this whole repo is built against. The
  // em-dash is the honest print, and it is the same fact as exit code 3.
  const UNMEASURED = '— (nothing assimilated yet)'
  const withCon = log.filter((a) => a.contradiction && a.contradiction !== 'none')
  console.log(`  found a real contradiction: ${log.length ? `${withCon.length}/${log.length}` : UNMEASURED}`)

  // Which primitives have actually done work, versus which are still inert.
  const used = new Set(log.flatMap((a) => a.propagated ?? []))
  console.log(`  primitives exercised: ${log.length ? `${used.size}/${primitives().length}` : UNMEASURED}`)

  const latest = log.at(-1)
  if (latest) {
    console.log(`\nlatest: ${latest.date} · ${latest.catalyst}`)
    console.log(`  claim: ${latest.claim ?? '(none)'}`)
    console.log(`  verdict: ${latest.verdict}`)
  } else {
    console.log('\nnothing assimilated yet. run: palimpsest digest <file>')
  }
}

function atlasCmd(q?: string): void {
  const all = cards()
  if (!q) {
    console.log(`${all.length} cards · T1 ${tier(1).length} · T2 ${tier(2).length} · T3 ${tier(3).length}`)
    console.log(`${primitives().length} primitives · ${new Set(all.map((c) => c.family)).size} families`)
    return
  }
  const needle = q.toLowerCase()
  const hits = all.filter(
    (c) =>
      c.name.toLowerCase().includes(needle) ||
      c.family.toLowerCase().includes(needle) ||
      c.primitives.some((p) => p.toLowerCase().includes(needle)),
  )
  if (!hits.length) die(`no card matches "${q}"`)
  for (const c of hits.slice(0, 20))
    console.log(`T${c.tier} ${c.name}\n   ${c.family} · ${c.primitives.join(', ') || '(no primitives)'}`)
  if (hits.length > 20) console.log(`… ${hits.length - 20} more`)
}

async function falsify(only?: string): Promise<void> {
  const which = only ?? 'all'
  const suite = {
    withhold: audit.withhold,
    contradiction: audit.contradiction,
    novelty: audit.novelty,
  } as const

  const todo = which === 'all' ? Object.keys(suite) : [which]
  if (todo.some((t) => !(t in suite))) die(`unknown check "${which}"`)

  const results = []
  for (const name of todo) {
    process.stderr.write(`running ${name}…\n`)
    results.push(await suite[name as keyof typeof suite]())
  }

  console.log('\n=== FALSIFIER ===')
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(14)} ${r.evidence}`)
  const failed = results.filter((r) => !r.pass)
  console.log(failed.length ? `\n${failed.length} FAILED` : '\nall mechanical checks passed')
  // 1, not 2: a FAILED check is a finding, and the exit-code table documented in
  // trace.ts reserves 2 for a harness fault. Leaving 2 here would make the two
  // most different outcomes of this command indistinguishable to a caller.
  if (failed.length) process.exit(1)
}

/**
 * Instrument test across many catalysts. Reports only what can be judged
 * without the user. The novelty verdict is NOT computed here on purpose.
 */
function benchReport(results: audit.Digest[]): void {
  const n = results.length
  const errored = results.filter((r) => r.error)
  const ok = results.filter((r) => !r.error)
  const converged = ok.filter((r) => r.converged)
  const oneClaim = ok.filter((r) => r.claims === 1)
  const contact = ok.map((r) => r.touch.length).sort((a, b) => a - b)
  const fams = ok.map((r) => r.clusters.size)
  const named = ok.map((r) => r.cardsNamed)
  const contra = ok.map((r) => r.contradictions)
  const med = (a: number[]) => (a.length ? a[Math.floor(a.length / 2)] : 0)

  console.log(`\n=== BENCH: ${n} catalysts (${ok.length} ran, ${errored.length} harness-faulted) ===\n`)
  if (errored.length) {
    console.log('harness faults (not trainer findings):')
    for (const r of errored) console.log(`  ${r.file}: ${r.error}`)
    console.log('')
  }
  if (!ok.length) return
  console.log(`converged to a claim      ${converged.length}/${ok.length}`)
  console.log(`converged to exactly one  ${oneClaim.length}/${ok.length}`)
  console.log(`contact surface           min ${contact[0]} median ${med(contact)} max ${contact.at(-1)}`)
  console.log(`atlas cards named         min ${Math.min(...named)} median ${med(named)} max ${Math.max(...named)}`)
  console.log(`atlas families spanned    min ${Math.min(...fams)} median ${med(fams)} max ${Math.max(...fams)}`)
  console.log(`contradictions            ${contra.join(', ')}  (total ${contra.reduce((a, b) => a + b, 0)})`)
  console.log(`\nper-input:`)
  for (const r of ok) {
    const flags = [
      !r.converged ? 'NO-CLAIM' : '',
      r.claims > 1 ? `SPRAWL(${r.claims})` : '',
      r.touch.length < 3 ? 'THIN' : '',
      r.clusters.size < 2 ? 'SINGLE-FAMILY' : '',
      r.cardsNamed < 2 ? 'ATLAS-UNUSED' : '',
    ].filter(Boolean)
    console.log(
      `  ${r.file.padEnd(36)} touch ${String(r.touch.length).padStart(2)}  ` +
      `cards ${String(r.cardsNamed).padStart(2)}  families ${r.clusters.size}  ` +
      `contra ${r.contradictions}  ${flags.join(' ')}`,
    )
  }

  console.log(`\n--- claims, for YOU to grade ---`)
  for (const r of ok) {
    console.log(`\n[${r.file}]`)
    console.log(r.claim ?? '(none)')
  }
}

const ver = (v: string): Verdict => {
  if (!['integrated', 'rejected', 'not-my-language'].includes(v))
    die('verdict must be: integrated | rejected | not-my-language')
  return v as Verdict
}

switch (cmd) {
  case 'session': session(rest); break
  case 'digest': await digest(rest[0] ?? die('usage: palimpsest digest <file|->')); break
  case 'falsify': await falsify(rest[0]); break
  case 'state': state(); break
  // The one command that writes a synthesis rather than a record. Renders to the
  // user and only the user: the trainer has no client for the bank it lands in.
  case 'profile': {
    const code = await profileCmd()
    if (code) process.exit(code)
    break
  }
  case 'settle': {
    const verdict = ver(rest[0] ?? die('usage: palimpsest settle <verdict>'))
    if (!settle(verdict)) die('no PENDING assimilation to settle')
    // The log is the mirror; the verdict has to reach memory-wire too, or a
    // rejected claim keeps living in the store as something true.
    const latest = read().at(-1)
    if (latest) await persist(fromAssimilation(latest), 'settle')
    console.log(`latest assimilation marked ${verdict}`)
    break
  }
  case 'atlas': atlasCmd(rest[0]); break
  case 'bench': {
    const dir = rest[0] ?? die('usage: palimpsest bench <dir>')
    process.stderr.write(`benching ${dir}\n`)
    const results = await audit.bench(dir, (d) =>
      // Per-input line the moment it lands, so a long run is legible while it
      // is still going and a crash does not take the earlier results with it.
      process.stderr.write(
        `  ${d.error ? 'ERR ' : d.converged ? 'ok  ' : 'FAIL'} ${d.file.padEnd(38)} ` +
        `touch ${String(d.touch.length).padStart(2)} cards ${String(d.cardsNamed).padStart(2)} ` +
        `families ${d.clusters.size} contra ${d.contradictions}` +
        `${d.claims > 1 ? ` SPRAWL(${d.claims})` : ''}` +
        `${d.error ? ` ${d.error.slice(0, 40)}` : ''}\n`,
      ),
    )
    benchReport(results)
    break
  }
  case 'propagate': {
    const p = propagate(rest[0]?.split(',') ?? [], Number(rest[1] ?? 1))
    console.log(`${p.size} reachable`)
    for (const [name, path] of p) console.log(`  ${name}  ${path.at(-1) ?? '(seed)'}`)
    break
  }
  // Additive from here down: three read-only debugging commands. They exit
  // nonzero through process.exit rather than die(), so their exit code is a
  // gate result rather than a usage error.
  case 'doctor': {
    const code = await doctor()
    if (code) process.exit(code)
    break
  }
  case 'trace': {
    const code = trace(rest[0])
    if (code) process.exit(code)
    break
  }
  case 'trajectory': {
    const file = rest[0] ?? die('usage: palimpsest trajectory <session-file> [digest|session|bench]')
    const code = trajectory(file, rest[1])
    if (code) process.exit(code)
    break
  }
  default: die(`unknown command "${cmd}"\nusage: palimpsest [session|digest|falsify|state|profile|settle|atlas|propagate|bench|doctor|trace|trajectory]`)
}

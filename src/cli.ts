import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { run, REPO, ATLAS } from './omp'
import { append, read, settle, type Verdict } from './assimilate'
import * as audit from './audit'
import { cards, tier, propagate, primitives } from './atlas'

const [, , cmd = 'session', ...rest] = process.argv

const die = (m: string): never => {
  console.error(m)
  process.exit(1)
}

const slug = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80)

/** The interactive session. omp's TUI is the interface; the launcher is plumbing. */
function session(extra: string[] = []): void {
  const child = spawn(
    'omp',
    [
      '--no-rules', '--no-skills', '--tools=read',
      '--cwd', REPO, '--add-dir', ATLAS,
      '--append-system-prompt', `${REPO}/trainer/role.md`,
      ...extra,
    ],
    { stdio: 'inherit' },
  )
  child.on('close', (c) => process.exit(c ?? 0))
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
  const g = (k: string) =>
    new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim() ?? undefined
  const list = (k: string) =>
    g(k)?.split(/,\s*/).map((s) => s.trim()).filter(Boolean)

  append({
    date: g('date') ?? new Date().toISOString().slice(0, 10),
    catalyst: slug(g('catalyst') ?? path),
    reading: g('reading'),
    touch: list('touch'),
    propagated: list('propagated'),
    contradiction: g('contradiction'),
    claim: g('claim'),
    falsifier: g('falsifier'),
    verdict: 'PENDING',
  })
  console.error('\n--- recorded to state/assimilation.log (verdict PENDING) ---')
}

function state(): void {
  const log = read()
  const by = (v: Verdict) => log.filter((a) => a.verdict === v).length
  console.log(`assimilations: ${log.length}`)
  console.log(`  integrated: ${by('integrated')}  rejected: ${by('rejected')}  ` +
    `not-my-language: ${by('not-my-language')}  pending: ${by('PENDING')}`)

  const withCon = log.filter((a) => a.contradiction && a.contradiction !== 'none')
  console.log(`  found a real contradiction: ${withCon.length}/${log.length}`)

  // Which primitives have actually done work, versus which are still inert.
  const used = new Set(log.flatMap((a) => a.propagated ?? []))
  console.log(`  primitives exercised: ${used.size}/${primitives().length}`)

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
  if (failed.length) process.exit(2)
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
  case 'settle': settle(ver(rest[0] ?? die('usage: palimpsest settle <verdict>')))
    ? console.log(`latest assimilation marked ${rest[0]}`)
    : die('no PENDING assimilation to settle'); break
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
  default: die(`unknown command "${cmd}"\nusage: palimpsest [session|digest|falsify|state|settle|atlas|propagate|bench]`)
}

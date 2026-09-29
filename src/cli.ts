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
  case 'propagate': {
    const p = propagate(rest[0]?.split(',') ?? [], Number(rest[1] ?? 1))
    console.log(`${p.size} reachable`)
    for (const [name, path] of p) console.log(`  ${name}  ${path.at(-1) ?? '(seed)'}`)
    break
  }
  default: die(`unknown command "${cmd}"\nusage: palimpsest [session|digest|falsify|state|settle|atlas|propagate]`)
}

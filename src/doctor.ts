/**
 * System health, one line per subsystem.
 *
 * Seven independent checks, and independence is the point: a run reports every
 * subsystem it can reach rather than stopping at the first failure, because the
 * whole reason to run this is that several things can be wrong at once and you
 * want the list, not the first item. Each line carries the exact address or path
 * it checked, so a FAIL is actionable without re-deriving the config yourself.
 *
 * Nothing here writes. No daemon is started or stopped, no bank is created, no
 * file is touched -- a diagnostic that repairs the system while diagnosing it
 * cannot tell you what was broken. The one network call is a GET of `/health`
 * plus a read of the derived bank.
 *
 * The address is read from the same place the writer reads it: `baseUrl()` in
 * src/memory.ts, so `PALIMPSEST_MEMORY_ADDR` points this at the same server
 * palimpsest writes to. (`MEMORY_WIRE_URL` is deliberately NOT honoured: it
 * belongs to every memory-wire consumer on the box and would silently relocate
 * the records.) A `/health` returning 200 is not enough -- 8888 answers with
 * JSON from a foreign process, and only the body being exactly `ok`
 * distinguishes it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bankFor, baseUrl, listMemories } from './memory'
import { REPO } from './omp'
import { sessionSlug } from './session-read'

/** A doctor must not hang on a half-dead socket. memory-wire's own budget is 2s. */
const TIMEOUT_MS = 2_000

export type DoctorCheck = {
  name: string
  pass: boolean
  /** The exact address or path checked, and what came back. */
  detail: string
}

export type DoctorOpts = {
  /** Project root. The bank id is derived from it, so this is also the namespace. */
  repo?: string
  /** omp's home. Split out so a check can be pointed at a tree instead of the account. */
  ompHome?: string
}

const ok = (name: string, detail: string): DoctorCheck => ({ name, pass: true, detail })
const no = (name: string, detail: string): DoctorCheck => ({ name, pass: false, detail })

/** True when a path is a readable, non-empty file. */
function readable(path: string): boolean {
  try {
    return statSync(path).isFile() && readFileSync(path, 'utf8').trim().length > 0
  } catch {
    return false
  }
}

/**
 * memory-wire `/health` must answer 200 with exactly `ok`.
 *
 * The body check is the whole check: docs/omp-notes.md records the tree-wide
 * default port answering `/health` with a JSON status from a database service,
 * so a status code alone would pass on the one address that is not ours.
 */
async function health(addr: string): Promise<DoctorCheck> {
  const at = `${addr}/health`
  try {
    const res = await fetch(at, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const body = (await res.text()).trim()
    return res.ok && body === 'ok'
      ? ok('memory-wire', `${at} → 200 ok`)
      : no('memory-wire', `${at} → ${res.status} ${JSON.stringify(body.slice(0, 80))}: not memory-wire`)
  } catch (e) {
    return no('memory-wire', `${at} → unreachable: ${String(e).slice(0, 120)}`)
  }
}

/**
 * The derived bank, and the forgetting policy.
 *
 * `ttl_days` is reported because its absence is the property that keeps a
 * rejected assimilation findable a year later; a bank carrying one has a policy
 * nobody in this repo agreed to, one `memory-wire sweep` away from deleting the
 * record. Reads only -- a bank this has never seen is created by its first write,
 * so an empty one is a normal state, not a fault.
 */
async function bank(repo: string): Promise<DoctorCheck> {
  const id = bankFor(repo)
  try {
    const rows = await listMemories(id)
    return ok('bank', `${id} → ${rows.length} memories, no ttl_days (nothing expires on a timer)`)
  } catch (e) {
    return no('bank', `${id} at ${baseUrl()} → ${String(e).slice(0, 120)}`)
  }
}

/** The session bucket for this project, and whether it can be read. */
function sessions(repo: string, ompHome: string): DoctorCheck {
  const dir = join(ompHome, 'agent', 'sessions', sessionSlug(repo))
  try {
    if (!existsSync(dir)) return no('sessions', `${dir} → missing: no session has run here`)
    const files = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
    return ok('sessions', `${dir} → readable, ${files.length} transcript(s)`)
  } catch (e) {
    return no('sessions', `${dir} → unreadable: ${String(e).slice(0, 120)}`)
  }
}

/**
 * Advisor count, read straight off the YAML without a YAML parser.
 *
 * One advisor is the architecture: it sees the whole completed turn, so the five
 * checks are five judgements about the same text, and three advisors would pay
 * 3x for one verdict. Counting means counting entries under the key -- a naive
 * `- ` count over the whole file would find the prose in `instructions:`.
 */
function advisors(yaml: string): number | undefined {
  const lines = yaml.split(/\r?\n/)
  const at = lines.findIndex((l) => /^advisors:\s*$/.test(l))
  if (at === -1) {
    const inline = /^advisors:\s*(.*)$/m.exec(yaml)?.[1]?.trim()
    return inline === undefined || /^#/.test(inline) ? undefined : 0
  }
  let count = 0
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (/^\S/.test(line)) break // the next top-level key ends the list
    if (/^\s+-\s+\S/.test(line)) count++
  }
  return count
}

function watchdog(repo: string): DoctorCheck {
  const found = [join(repo, 'WATCHDOG.yml'), join(repo, '.omp', 'WATCHDOG.yml')].filter(existsSync)
  if (!found.length)
    return no('advisor', `no WATCHDOG.yml at ${join(repo, 'WATCHDOG.yml')} or ${join(repo, '.omp', 'WATCHDOG.yml')}`)
  const file = found[0]!
  let count: number | undefined
  try {
    count = advisors(readFileSync(file, 'utf8'))
  } catch (e) {
    return no('advisor', `${file} → unreadable: ${String(e).slice(0, 120)}`)
  }
  if (count === undefined) return no('advisor', `${file} → no advisors: key: enforcement is off`)
  return count === 1
    ? ok('advisor', `${file} → exactly one advisor (conscience), tools: [read]`)
    : no('advisor', `${file} → ${count} advisors: the design is one, reading the turn ${count} times`)
}

/**
 * The trainer definition and the prompt it points at.
 *
 * `agents/trainer.md` carries `tools: [read]` and names its system prompt; the
 * capability line is only real if that target exists, so a dangling reference is
 * a FAIL rather than a warning. The YAML itself is parsed by `omp.trainerAgent()`,
 * which fails loud on anything it cannot read -- deliberately not duplicated here.
 */
function trainer(repo: string): DoctorCheck {
  const def = join(repo, 'agents', 'trainer.md')
  if (!readable(def)) return no('trainer', `${def} → missing or empty: no trainer definition`)
  const prompt = /^\s*System prompt:\s*(\S+)\s*$/m.exec(readFileSync(def, 'utf8'))?.[1]
  if (!prompt) return no('trainer', `${def} → no "System prompt: <file>" reference`)
  const target = join(repo, prompt)
  return readable(target)
    ? ok('trainer', `${def} + ${target} → readable (tools: [read])`)
    : no('trainer', `${def} → System prompt: ${prompt} resolves to ${target}, which is missing`)
}

/**
 * `memory.backend` off or absent, which is what keeps `retain`/`learn`/`recall`
 * out of the trainer's toolset before the `tools: [read]` allowlist is even
 * consulted. Two independent mechanisms guard the verdict; this is the one that
 * gates the tools, so it is the one worth checking on a machine.
 */
function memoryBackend(yaml: string): string | undefined {
  let inBlock = false
  for (const line of yaml.split(/\r?\n/)) {
    const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (top) {
      inBlock = top[1] === 'memory'
      if (inBlock && top[2]?.trim()) return top[2]!.trim().replace(/^["']|["']$/g, '')
      continue
    }
    if (!inBlock) continue
    const b = /^\s+backend:\s*(.+)$/.exec(line)
    if (b) return b[1]!.trim().replace(/^["']|["']$/g, '')
  }
  return undefined
}

/** Anything other than an explicit off keeps the memory tools registered. */
const OFF = new Set(['', 'off', 'false', 'no', 'none', 'null'])

function ompConfig(ompHome: string): DoctorCheck {
  const file = join(ompHome, 'agent', 'config.yml')
  if (!readable(file)) return ok('omp-memory', `${file} → absent: omp's default \`off\` applies`)
  let backend: string | undefined
  try {
    backend = memoryBackend(readFileSync(file, 'utf8'))
  } catch (e) {
    return no('omp-memory', `${file} → unreadable: ${String(e).slice(0, 120)}`)
  }
  return backend === undefined || OFF.has(backend.toLowerCase())
    ? ok('omp-memory', `${file} → memory.backend ${backend ?? 'absent'}: memory tools stay gated off`)
    : no('omp-memory', `${file} → memory.backend: ${backend}: the trainer can retain and learn`)
}

/** The committed mirror. Readable is the check; its contents are not this command's verdict. */
function log(repo: string): DoctorCheck {
  const file = join(repo, 'state', 'assimilation.log')
  try {
    const text = readFileSync(file, 'utf8')
    // Same delimiter assimilate.read() splits on, for the entry count.
    return ok('log', `${file} → readable, ${text.split(/^## /m).length - 1} entr(ies), ${text.length} bytes`)
  } catch (e) {
    return no('log', `${file} → unreadable: ${String(e).slice(0, 120)}`)
  }
}

export function format(checks: DoctorCheck[]): string {
  return checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(11)} ${c.detail}`).join('\n')
}

export async function checks(opts: DoctorOpts = {}): Promise<DoctorCheck[]> {
  const repo = opts.repo ?? REPO
  const ompHome = opts.ompHome ?? join(homedir(), '.omp')
  return [
    await health(baseUrl()),
    await bank(repo),
    sessions(repo, ompHome),
    watchdog(repo),
    trainer(repo),
    ompConfig(ompHome),
    log(repo),
  ]
}

/** Run the whole battery. Returns the exit code: nonzero iff anything FAILed. */
export async function doctor(opts: DoctorOpts = {}): Promise<number> {
  const found = await checks(opts)
  console.log(format(found))
  const failed = found.filter((c) => !c.pass).length
  console.log(failed ? `\n${failed} of ${found.length} subsystem(s) FAIL` : `\nall ${found.length} subsystems PASS`)
  return failed ? 1 : 0
}

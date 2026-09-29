/**
 * omp invocation.
 *
 * Two deliberate restrictions, both load-bearing:
 *   agents/trainer.md   the trainer/executor line is DECLARED, not flagged. Its
 *                       `tools: [read]` allowlist is the source of truth and
 *                       sessionArgs() derives `--tools` from it. The trainer can
 *                       look a card up; it cannot read a directory, run a
 *                       command, write a file, or reach the network. Absence,
 *                       not restraint.
 *   --no-rules --no-skills
 *                       no inherited project discipline, no 120 ambient skills.
 *                       The trainer's only instructions are the ones in trainer/.
 *
 * omp has no flag for routing the top-level session through an agent definition
 * (verified against the launch flag table: definitions are discovered for the
 * `task` subagent system only, from `.omp/agents/` and the user agents dir). So
 * the launcher compiles the definition into the spawn. The one-shot paths in
 * run() keep passing the flags directly and are deliberately left alone.
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REPO = import.meta.dirname + '/..'
export const ATLAS = process.env.PALIMPSEST_ATLAS ?? `${process.env.HOME}/.agents/skills/mental-model-atlas`

/** The declarative trainer: capabilities, model, thinking level, prompt. */
export const AGENT = join(REPO, 'agents', 'trainer.md')

export type TrainerAgent = {
  name: string
  /** The capability allowlist. This IS the trainer/executor boundary. */
  tools: string[]
  /** Undefined means "the default role", i.e. no --model override. */
  model?: string
  thinkingLevel?: string
  /** Absolute path to the always-resident system prompt. */
  prompt: string
}

const unquote = (s: string) => s.replace(/^["']|["']$/g, '').trim()

/**
 * The slice of YAML an agent definition needs: `key: scalar`, `key: [a, b]`,
 * and `key:` followed by indented `- item`. Deliberately not a YAML parser — it
 * reads only what agents/trainer.md uses and throws on anything it does not
 * recognise, because a silently-misread `tools:` would hand the trainer a full
 * toolset while the definition still reads like a boundary. Same reason
 * trainerAgent() rejects an empty allowlist: `tools:` with nothing under it is a
 * typo, and omp reads that as "no tools", not "all tools".
 */
function frontmatter(text: string): { fields: Record<string, string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) throw new Error(`${AGENT}: no YAML frontmatter`)

  const fields: Record<string, string[]> = {}
  let key: string | undefined
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item) {
      if (!key) throw new Error(`${AGENT}: list item with no key: ${line}`)
      fields[key]!.push(unquote(item[1]!))
      continue
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) throw new Error(`${AGENT}: unparseable frontmatter line: ${line}`)
    key = kv[1]
    const rest = kv[2].trim()
    fields[key] = rest === ''
      ? []
      : rest.replace(/^\[/, '').replace(/\]$/, '').split(',').map(unquote).filter(Boolean)
  }
  return { fields, body: m[2]! }
}

/** Read agents/trainer.md. Throws rather than guessing if the boundary is unreadable. */
export function trainerAgent(): TrainerAgent {
  const { fields, body } = frontmatter(readFileSync(AGENT, 'utf8'))
  const at = (k: string) => fields[k]?.[0]
  const tools = fields.tools ?? []
  const prompt = /^\s*System prompt:\s*(\S+)\s*$/m.exec(body)?.[1]

  if (!at('name')) throw new Error(`${AGENT}: name is required`)
  if (!tools.length) throw new Error(`${AGENT}: tools must be a non-empty allowlist`)
  if (!prompt) throw new Error(`${AGENT}: no "System prompt: <file>" reference in the body`)

  // `@default` IS the default role, so it is expressed as the absence of an
  // override rather than as a --model value (the @-prefixed form is a
  // definition key, not a documented CLI value).
  const model = at('model')
  return {
    name: at('name')!,
    tools,
    model: model && model !== '@default' ? model : undefined,
    thinkingLevel: at('thinkingLevel'),
    prompt: join(REPO, prompt),
  }
}

/** Args for the interactive session, derived from the agent definition. */
export function sessionArgs(extra: string[] = []): string[] {
  const a = trainerAgent()
  return [
    '--no-rules', '--no-skills',
    `--tools=${a.tools.join(',')}`,
    '--cwd', REPO,
    '--add-dir', ATLAS,
    ...(a.model ? ['--model', a.model] : []),
    ...(a.thinkingLevel ? ['--thinking', a.thinkingLevel] : []),
    '--append-system-prompt', a.prompt,
    ...extra,
  ]
}

export type RunOpts = {
  /** Trainer contract files to append, in order. */
  trainer: string[]
  timeoutMs?: number
  cwd?: string
}

export function trainerPath(name: string): string {
  return `${REPO}/trainer/${name}.md`
}

/**
 * Concatenate the trainer files into ONE file and return that path.
 *
 * Repeating --append-system-prompt is not additive: a later flag replaces the
 * earlier value, so passing role.md then digest.md silently delivered only
 * digest.md and the trainer ran with no contract at all. One flag, one file,
 * no ambiguity. This is the exact failure the bench caught and the falsifier
 * could not see, because every falsifier check greps for a marker rather than
 * for the presence of the protocol that produces it.
 */
export function mergedTrainer(files: string[]): string {
  const body = files
    .map((f) => readFileSync(trainerPath(f), 'utf8').trim())
    .join('\n\n---\n\n')
  const dir = mkdtempSync(join(tmpdir(), 'palimpsest-'))
  const out = join(dir, 'trainer-prompt.md')
  writeFileSync(out, body)
  return out
}

export function run(prompt: string, opts: RunOpts): Promise<string> {
  const args = [
    '-p',
    '--mode=text',
    '--no-rules',
    '--no-skills',
    '--tools=read',
    '--cwd', opts.cwd ?? REPO,
    '--add-dir', ATLAS,
    '--append-system-prompt', mergedTrainer(opts.trainer),
    prompt,
  ]

  return new Promise((resolve, reject) => {
    const child = spawn('omp', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`omp timed out after ${opts.timeoutMs ?? 300_000}ms`))
    }, opts.timeoutMs ?? 300_000)

    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && !out.trim()) reject(new Error(`omp exited ${code}: ${err.slice(0, 400)}`))
      else resolve(out)
    })
  })
}

/**
 * omp invocation.
 *
 * Two deliberate restrictions, both load-bearing:
 *   --tools=read    the trainer can look a card up. It cannot read a directory,
 *                   run a command, write a file, or touch the network. That is
 *                   the architectural form of "trainer, not executor": the
 *                   capability to execute is simply absent, not merely refused.
 *   --no-rules --no-skills
 *                   no inherited project discipline, no 120 ambient skills. The
 *                   trainer's only instructions are the ones in trainer/.
 */
import { spawn } from 'node:child_process'

export const REPO = import.meta.dirname + '/..'
export const ATLAS = process.env.PALIMPSEST_ATLAS ?? `${process.env.HOME}/.agents/skills/mental-model-atlas`

export type RunOpts = {
  /** Trainer contract files to append, in order. */
  trainer: string[]
  timeoutMs?: number
  cwd?: string
}

export function trainerPath(name: string): string {
  return `${REPO}/trainer/${name}.md`
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
    ...opts.trainer.flatMap((t) => ['--append-system-prompt', trainerPath(t)]),
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

import { rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { describeStep, readJson, stepSchema, type Film, type Step } from './film.ts'

// What exploring leaves: a log of everything the agent did, each step already pinned and with
// its outcome, numbered, plus the agent's notes. Nothing in it is ever deleted (going back
// marks steps undone), and it isn't a film: the agent writes the film from it afterwards,
// choosing the steps that make the demo.

export const LOG: string = join('.product-demo', 'explore', 'log.json')

export interface LogEntry {
  n: number
  step: Step
  /** Where the page was after the step: path, query and hash. */
  at: string
  /** Taken back with `back`: the browser was returned to before it. */
  undone?: boolean | undefined
  /** Something the toolkit noticed, such as a page that never settled. */
  warning?: string | undefined
}

export interface Log {
  app: string
  /** The agent's notes: what it learnt about the app, what the film should do. */
  notes?: string | undefined
  entries: LogEntry[]
}

const logSchema: z.ZodType<Log> = z.strictObject({
  app: z.url(),
  notes: z.string().optional(),
  entries: z.array(
    z.strictObject({
      n: z.number().int(),
      step: stepSchema,
      at: z.string(),
      undone: z.boolean().optional(),
      warning: z.string().optional(),
    }),
  ),
})

export async function readLog(path: string = LOG): Promise<Log> {
  if (!existsSync(path))
    throw new Error('There is no explore log yet. Start with `product-demo explore <url>`.')
  const parsed = logSchema.safeParse(await readJson(path))
  if (!parsed.success)
    throw new Error(`${path} is not a valid log:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export async function writeLog(log: Log, path: string = LOG): Promise<void> {
  await writeFile(path, JSON.stringify(log, null, 2))
}

/** Starts a new log, keeping the last one beside it under the time it was put aside. */
export async function startLog(app: string): Promise<void> {
  if (existsSync(LOG)) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    await rename(LOG, join('.product-demo', 'explore', `log-${stamp}.json`))
  }
  await writeLog({ app, entries: [] })
}

/** The log as numbered lines, for choosing steps from. */
export function listLog(log: Log): string {
  if (log.entries.length === 0) return 'The log is empty.'
  const lines = log.entries.map(
    (e) =>
      `${String(e.n).padStart(3)}. ${describeStep(e.step)} → ${e.at}${e.undone ? ' (undone)' : ''}${e.warning ? ` [${e.warning}]` : ''}`,
  )
  return [`Explored ${log.app}`, ...(log.notes ? [`Notes: ${log.notes}`] : []), ...lines].join('\n')
}

/** A film made from the log's steps, in the order given. */
export function compose(log: Log, numbers: number[]): Film {
  const steps = numbers.map((n) => {
    const entry = log.entries.find((e) => e.n === n)
    if (!entry) throw new Error(`The log has no step ${n}. Run \`product-demo log\` to see them.`)
    return entry.step
  })
  if (steps.length === 0)
    throw new Error('Name the log steps to use, like: product-demo compose 2 3 5')
  return { app: log.app, steps }
}

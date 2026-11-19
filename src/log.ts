import { rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { readJson, stepSchema, type Step } from './film.ts'

let DIR = ''
export function useLogDir(dir: string): void {
  DIR = dir
}
export const logFile = (): string => join(DIR, 'log.json')

export interface LogEntry {
  n: number
  step: Step
  at: string
  undone?: boolean | undefined
  warning?: string | undefined
}

export interface Log {
  app: string
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

export async function readLog(path: string = logFile()): Promise<Log> {
  if (!existsSync(path))
    throw new Error(
      'There is no explore log yet. Start with `product-demo-agent-toolkit explore <url>`.',
    )
  const parsed = logSchema.safeParse(await readJson(path))
  if (!parsed.success)
    throw new Error(`${path} is not a valid log:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}

export async function writeLog(log: Log, path: string = logFile()): Promise<void> {
  await writeFile(path, JSON.stringify(log, null, 2))
}

export async function startLog(app: string): Promise<void> {
  if (existsSync(logFile())) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    await rename(logFile(), join(DIR, `log-${stamp}.json`))
  }
  await writeLog({ app, entries: [] })
}

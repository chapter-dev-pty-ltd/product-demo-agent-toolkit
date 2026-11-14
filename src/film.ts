import { readFile } from 'node:fs/promises'
import { z } from 'zod'

/** An element, by its accessible role and name, its visible text, or a CSS selector. */
export type Target = { role: string; name: string } | { text: string } | { css: string }

export type Step =
  | { visit: string }
  | { click: Target }
  | { fill: Target; text: string }
  | { press: string }
  | { scroll: 'up' | 'down' }
  | { wait: { text: string } | number }

/** A demo to perform: the app to open, the steps to take on it, and how long to hold the ending. */
export interface Film {
  app: string
  steps: Step[]
  ending?: { hold: number } | undefined
}

const target: z.ZodType<Target> = z.union([
  z.strictObject({ role: z.string(), name: z.string() }),
  z.strictObject({ text: z.string() }),
  z.strictObject({ css: z.string() }),
])

const step: z.ZodType<Step> = z.union([
  z.strictObject({ visit: z.string() }),
  z.strictObject({ click: target }),
  z.strictObject({ fill: target, text: z.string() }),
  z.strictObject({ press: z.string() }),
  z.strictObject({ scroll: z.enum(['up', 'down']) }),
  z.strictObject({ wait: z.union([z.strictObject({ text: z.string() }), z.number().positive()]) }),
])

const film: z.ZodType<Film> = z.strictObject({
  app: z.url(),
  steps: z.array(step).min(1),
  ending: z.strictObject({ hold: z.number().nonnegative() }).optional(),
})

export async function readFilm(path: string): Promise<Film> {
  const parsed = film.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!parsed.success)
    throw new Error(`${path} is not a valid film:\n${z.prettifyError(parsed.error)}`)
  return parsed.data
}

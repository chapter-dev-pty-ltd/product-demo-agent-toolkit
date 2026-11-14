import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Fingerprint } from './similo.ts'

/**
 * An element. Written by hand: its accessible role and name, its visible text, or a CSS
 * selector. Pinned by `explore`: the locator Playwright's codegen would write for it, and
 * its Similo fingerprint for when that locator finds nothing or more than one.
 */
export type Target =
  | { role: string; name: string }
  | { text: string }
  | { css: string }
  | { locator: string; selector: string; fingerprint: Fingerprint }

/** What a step changed when it was explored, so `record` can check it changes the same. */
export interface Outcome {
  /** The address it went to: path, query and hash. */
  url?: string | undefined
  /** A line of text it made appear. */
  appeared?: string | undefined
}

export type Step = (
  | { visit: string }
  | { click: Target }
  | { fill: Target; text: string }
  | { press: string }
  | { scroll: 'up' | 'down' }
  | { wait: { text: string } | number }
) & { outcome?: Outcome | undefined }

/** A demo to perform: the app to open, the steps to take on it, and how long to hold the ending. */
export interface Film {
  app: string
  steps: Step[]
  ending?: { hold: number } | undefined
}

const fingerprint: z.ZodType<Fingerprint> = z.strictObject({
  tag: z.string(),
  role: z.string(),
  id: z.string(),
  testId: z.string(),
  name: z.string(),
  type: z.string(),
  className: z.string(),
  href: z.string(),
  alt: z.string(),
  text: z.string(),
  label: z.string(),
  neighbours: z.string(),
  xpath: z.string(),
  idXpath: z.string(),
  isButton: z.boolean(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

const target: z.ZodType<Target> = z.union([
  z.strictObject({ role: z.string(), name: z.string() }),
  z.strictObject({ text: z.string() }),
  z.strictObject({ css: z.string() }),
  z.strictObject({ locator: z.string(), selector: z.string(), fingerprint }),
])

const outcome = z
  .strictObject({ url: z.string().optional(), appeared: z.string().optional() })
  .optional()

const step: z.ZodType<Step> = z.union([
  z.strictObject({ visit: z.string(), outcome }),
  z.strictObject({ click: target, outcome }),
  z.strictObject({ fill: target, text: z.string(), outcome }),
  z.strictObject({ press: z.string(), outcome }),
  z.strictObject({ scroll: z.enum(['up', 'down']), outcome }),
  z.strictObject({
    wait: z.union([z.strictObject({ text: z.string() }), z.number().positive()]),
    outcome,
  }),
])

const film: z.ZodType<Film> = z.strictObject({
  app: z.url(),
  steps: z.array(step).min(1),
  ending: z.strictObject({ hold: z.number().nonnegative() }).optional(),
})

export async function readFilm(path: string): Promise<Film> {
  const parsed = film.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!parsed.success) {
    throw new Error(`${path} is not a valid film:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

/** A step in a sentence, for messages: `click link "COBOL"`. */
export function describeStep(step: Step): string {
  const of = (t: Target) =>
    'locator' in t
      ? t.locator
      : 'role' in t
        ? `${t.role} "${t.name}"`
        : 'text' in t
          ? `"${t.text}"`
          : t.css
  if ('visit' in step) return `visit ${step.visit}`
  if ('click' in step) return `click ${of(step.click)}`
  if ('fill' in step) return `fill ${of(step.fill)} with "${step.text}"`
  if ('press' in step) return `press ${step.press}`
  if ('scroll' in step) return `scroll ${step.scroll}`
  return typeof step.wait === 'number' ? `wait ${step.wait}s` : `wait for "${step.wait.text}"`
}

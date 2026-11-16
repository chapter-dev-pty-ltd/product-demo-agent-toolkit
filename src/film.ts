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

/** What a step changed when it was explored, so rehearse and shoot can check it changes the same. */
export interface Outcome {
  /** The address it went to: path, query and hash. */
  url?: string | undefined
  /** A line of text it made appear. */
  appeared?: string | undefined
  /** On a canvas-like surface, the boxes of what's drawn after it: x, y, width, height. */
  drawn?: number[][] | undefined
}

/** Where on an element, as fractions of its box: 0,0 is its top left, 1,1 its bottom right. */
export interface Point {
  x: number
  y: number
}

/** Keys held through a click. */
export type Key = 'Shift' | 'Control' | 'Alt' | 'Meta' | 'ControlOrMeta'
export const KEYS: readonly Key[] = ['Shift', 'Control', 'Alt', 'Meta', 'ControlOrMeta']

export type Step = (
  | { visit: string }
  | {
      click: Target
      at?: Point | undefined
      double?: boolean | undefined
      right?: boolean | undefined
      modifiers?: Key[] | undefined
    }
  | { fill: Target; text: string }
  | { select: Target; option: string }
  | { type: string }
  | { press: string }
  | { hover: Target; at?: Point | undefined; seconds?: number | undefined }
  | { drag: Target; at?: Point | undefined; to: Target; toAt?: Point | undefined }
  | { scroll: 'up' | 'down'; in?: Target | undefined; pixels?: number | undefined }
  | { upload: string; into?: Target | undefined }
  | { wait: { text: string; gone?: boolean | undefined } | number }
) & {
  outcome?: Outcome | undefined
  /** Why the step is there, or anything odd about it. Read by people and agents, never run. */
  note?: string | undefined
}

/** A demo to perform: the app to open, the steps to take on it, and how long to hold the ending. */
export interface Film {
  app: string
  /** What the film is for and what it has to show. Read by people and agents, never run. */
  notes?: string | undefined
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
  .strictObject({
    url: z.string().optional(),
    appeared: z.string().optional(),
    drawn: z.array(z.array(z.number()).length(4)).optional(),
  })
  .optional()

const note = z.string().optional()

const point = z.strictObject({ x: z.number(), y: z.number() }).optional()

export const stepSchema: z.ZodType<Step> = z.union([
  z.strictObject({ visit: z.string(), outcome, note }),
  z.strictObject({
    click: target,
    at: point,
    double: z.boolean().optional(),
    right: z.boolean().optional(),
    modifiers: z.array(z.enum(KEYS)).optional(),
    outcome,
    note,
  }),
  z.strictObject({ fill: target, text: z.string(), outcome, note }),
  z.strictObject({ select: target, option: z.string(), outcome, note }),
  z.strictObject({ type: z.string(), outcome, note }),
  z.strictObject({ press: z.string(), outcome, note }),
  z.strictObject({
    hover: target,
    at: point,
    seconds: z.number().positive().optional(),
    outcome,
    note,
  }),
  z.strictObject({ drag: target, at: point, to: target, toAt: point, outcome, note }),
  z.strictObject({
    scroll: z.enum(['up', 'down']),
    in: target.optional(),
    pixels: z.number().positive().optional(),
    outcome,
    note,
  }),
  z.strictObject({ upload: z.string(), into: target.optional(), outcome, note }),
  z.strictObject({
    wait: z.union([
      z.strictObject({ text: z.string(), gone: z.boolean().optional() }),
      z.number().positive(),
    ]),
    outcome,
    note,
  }),
])

const film: z.ZodType<Film> = z.strictObject({
  app: z.url(),
  notes: z.string().optional(),
  steps: z.array(stepSchema),
  ending: z.strictObject({ hold: z.number().nonnegative() }).optional(),
})

/** Reads a JSON file, saying plainly when it doesn't parse. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${path} isn't valid JSON (${error.message}). Fix it, then try again.`)
    }
    throw error
  }
}

export async function readFilm(path: string): Promise<Film> {
  const parsed = film.safeParse(await readJson(path))
  if (!parsed.success) {
    throw new Error(`${path} is not a valid film:\n${z.prettifyError(parsed.error)}`)
  }
  if (parsed.data.steps.length === 0) throw new Error(`${path} has no steps.`)
  return parsed.data
}

/** A step in a sentence, for messages: `click link "COBOL"`, with its note if it has one. */
export function describeStep(step: Step): string {
  const said = say(step)
  return step.note ? `${said}, noted: "${step.note}"` : said
}

function say(step: Step): string {
  if ('visit' in step) return `visit ${step.visit}`
  if ('click' in step) {
    const how = step.right ? 'right-click' : step.double ? 'double-click' : 'click'
    const held = step.modifiers?.length ? ` holding ${step.modifiers.join('+')}` : ''
    return `${how} ${of(step.click)}${held}`
  }
  if ('fill' in step) return `fill ${of(step.fill)} with "${step.text}"`
  if ('select' in step) return `choose "${step.option}" in ${of(step.select)}`
  if ('type' in step) return `type "${step.type}"`
  if ('press' in step) return `press ${step.press}`
  if ('hover' in step) return `hover over ${of(step.hover)}`
  if ('drag' in step) return `drag ${of(step.drag)} onto ${of(step.to)}`
  if ('scroll' in step) return `scroll ${step.scroll}${step.in ? ` in ${of(step.in)}` : ''}`
  if ('upload' in step) return `upload ${step.upload}${step.into ? ` with ${of(step.into)}` : ''}`
  if (typeof step.wait === 'number') return `wait ${step.wait}s`
  return `wait for "${step.wait.text}"${step.wait.gone ? ' to go' : ''}`
}

function of(target: Target): string {
  if ('locator' in target) return target.locator
  if ('role' in target) return `${target.role} "${target.name}"`
  return 'text' in target ? `"${target.text}"` : target.css
}

import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { soundSchema, type Sound } from './config.ts'
import type { Fingerprint } from './similo.ts'

export type Target =
  | { role: string; name: string }
  | { text: string }
  | { css: string }
  | { locator: string; selector: string; fingerprint: Fingerprint }

export interface Point {
  x: number
  y: number
}

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
  note?: string | undefined
  highlight?: Highlight | undefined
  say?: string | undefined
  on?: string | undefined
  cut?: true | Part | undefined
  speed?: number | (Part & { by: number }) | undefined
  sound?: Sound | undefined
}

export interface Part {
  from?: number | undefined
  to?: number | undefined
}

export interface Highlight {
  style?: 'box' | 'magnify' | 'cursor' | undefined
  colour?: string | undefined
  box?: number[] | undefined
  zoom?: number | undefined
  seconds?: number | undefined
}

export function stepTarget(step: Step): Target | undefined {
  if ('click' in step) return step.click
  if ('fill' in step) return step.fill
  if ('select' in step) return step.select
  if ('hover' in step) return step.hover
  if ('drag' in step) return step.to
  if ('scroll' in step) return step.in
  if ('upload' in step) return step.into
  return undefined
}

export interface Film {
  app: string
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

const note = z.string().optional()
const line = z.string().min(1).optional()
const word = z.string().min(1).optional()
const highlight = z
  .strictObject({
    style: z.enum(['box', 'magnify', 'cursor']).optional(),
    colour: z
      .string()
      .regex(/^#[0-9a-f]{3,8}$/i)
      .optional(),
    box: z.array(z.number()).length(4).optional(),
    zoom: z.number().min(0).max(1).optional(),
    seconds: z.number().positive().optional(),
  })
  .optional()

const point = z.strictObject({ x: z.number(), y: z.number() }).optional()

const part = { from: z.number().min(0).optional(), to: z.number().positive().optional() }
const by = z.number().gt(1).max(16)
const cut = z.union([z.literal(true), z.strictObject(part)]).optional()
const speed = z.union([by, z.strictObject({ by, ...part })]).optional()
const sound = soundSchema.optional()

export const stepSchema: z.ZodType<Step> = z
  .union([
    z.strictObject({ visit: z.string(), note, highlight, say: line, on: word, cut, speed, sound }),
    z.strictObject({
      click: target,
      at: point,
      double: z.boolean().optional(),
      right: z.boolean().optional(),
      modifiers: z.array(z.enum(KEYS)).optional(),
      note,
      highlight,
      say: line,
      on: word,
      cut,
      speed,
      sound,
    }),
    z.strictObject({
      fill: target,
      text: z.string(),
      note,
      highlight,
      say: line,
      on: word,
      cut,
      speed,
      sound,
    }),
    z.strictObject({
      select: target,
      option: z.string(),
      note,
      highlight,
      say: line,
      on: word,
      cut,
      speed,
      sound,
    }),
    z.strictObject({ type: z.string(), note, highlight, say: line, on: word, cut, speed, sound }),
    z.strictObject({ press: z.string(), note, highlight, say: line, on: word, cut, speed, sound }),
    z.strictObject({
      hover: target,
      at: point,
      seconds: z.number().positive().optional(),
      note,
      highlight,
      say: line,
      on: word,
      cut,
      speed,
      sound,
    }),
    z.strictObject({
      drag: target,
      at: point,
      to: target,
      toAt: point,
      note,
      highlight,
      say: line,
      on: word,
      cut,
      speed,
      sound,
    }),
    z.strictObject({
      scroll: z.enum(['up', 'down']),
      in: target.optional(),
      pixels: z.number().positive().optional(),
      note,
      highlight,
      say: line,
      on: word,
      cut,
      speed,
      sound,
    }),
    z.strictObject({
      upload: z.string(),
      into: target.optional(),
      note,
      highlight,
      say: line,
      on: word,
      cut,
      speed,
      sound,
    }),
    z.strictObject({
      wait: z.union([
        z.strictObject({ text: z.string(), gone: z.boolean().optional() }),
        z.number().positive(),
      ]),
      note,
      highlight,
      say: line,
      on: word,
      cut,
      speed,
      sound,
    }),
  ])
  .refine((step) => !(step.cut && step.speed), 'A step is either cut or sped up, not both.')

const film: z.ZodType<Film> = z.strictObject({
  app: z.url(),
  notes: z.string().optional(),
  steps: z.array(stepSchema),
  ending: z.strictObject({ hold: z.number().nonnegative() }).optional(),
})

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

const LOOK = ['backdrop', 'display', 'window', 'cursor', 'sound', 'music', 'voice']

// Changed in the film's own JSON, not a parsed copy, so the rest of the file stays as written.
export async function changeFilm(
  path: string,
  change: (steps: Record<string, unknown>[]) => void,
): Promise<string> {
  const json = JSON.parse(await readFile(path, 'utf8'))
  change(json.steps)
  const text = `${JSON.stringify(json, null, 2)}\n`
  await writeFile(path, text)
  return text
}

export async function readFilm(path: string): Promise<Film> {
  const json = await readJson(path)
  const look =
    json && typeof json === 'object' ? LOOK.filter((key) => Object.hasOwn(json, key)) : []
  if (look.length > 0) {
    throw new Error(
      `${path} sets ${look.join(', ')}. How a video looks and sounds is set in its look.json, beside its film: remove it from the film.`,
    )
  }
  const parsed = film.safeParse(json)
  if (!parsed.success) {
    throw new Error(`${path} is not a valid film:\n${z.prettifyError(parsed.error)}`)
  }
  if (parsed.data.steps.length === 0) throw new Error(`${path} has no steps.`)
  return parsed.data
}

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

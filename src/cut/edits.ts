import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Film, Part, Step } from '../film.ts'
import type { Footage } from '../perform.ts'
import type { EditRequest, ShownEdit } from '../../studio/api.ts'

export type Edit = { from: number; to: number; step: number } & ({ cut: true } | { speed: number })

type StepEdit = Pick<Step, 'cut' | 'speed'>

const SAME = 1e-3
const ms = (seconds: number) => Math.round(seconds * 1000) / 1000

function spans(footage: Footage): { from: number; to: number }[] | undefined {
  const start = footage.frames[0]?.at ?? 0
  return footage.steps?.map((s, i) => ({
    from: Math.max(0, s.at - start),
    to: (footage.steps?.[i + 1]?.at ?? footage.end) - start,
  }))
}

export function staleTake(film: Film, footage: Footage): string | undefined {
  if (footage.steps || !film.steps.some((s) => s.cut || s.speed)) return undefined
  return "this take was shot before steps' times were recorded, so the film's cuts and speed-ups are left out. Shoot it again to see them."
}

export function filmEdits(film: Film, footage: Footage): Edit[] {
  const steps = spans(footage) ?? []
  return film.steps.flatMap((step, i): Edit[] => {
    const span = steps[i]
    const edit = step.cut ?? step.speed
    if (!span || edit === undefined) return []
    const part = typeof edit === 'object' ? edit : {}
    const from = span.from + (part.from ?? 0)
    const to = part.to === undefined ? span.to : Math.min(span.to, span.from + part.to)
    if (!(to > from)) return []
    const change =
      step.cut !== undefined
        ? ({ cut: true } as const)
        : { speed: typeof step.speed === 'object' ? step.speed.by : (step.speed ?? 1) }
    return [{ from, to, step: i, ...change }]
  })
}

export const editsKey = (edits: Edit[]): string =>
  edits.length ? createHash('sha1').update(JSON.stringify(edits)).digest('hex').slice(0, 8) : ''

const rate = (edit: Edit) => ('cut' in edit ? Infinity : edit.speed)

export function toVideo(edits: Edit[], at: number): number {
  let removed = 0
  for (const e of edits) {
    if (at <= e.from) break
    removed += (Math.min(at, e.to) - e.from) * (1 - 1 / rate(e))
  }
  return at - removed
}

// A moment on a cut's join is both the end of what's before it and the start of what's after:
// a range ending there keeps the cut, one starting there begins after it.
export function toTake(edits: Edit[], at: number, end = false): number {
  let shift = 0
  for (const e of edits) {
    const from = e.from - shift
    const length = (e.to - e.from) / rate(e)
    if (at < from - SAME || (end && at <= from + SAME)) return Math.min(at + shift, e.from)
    if (at < from + length) return e.from + (at - from) * rate(e)
    shift += e.to - e.from - length
  }
  return at + shift
}

export function retime(footage: Footage, edits: Edit[]): Footage {
  if (!edits.length) return footage
  const start = footage.frames[0]?.at ?? 0
  const kept = (item: { at: number }) =>
    !edits.some((e) => 'cut' in e && item.at - start >= e.from && item.at - start < e.to)
  const map = (at: number) => start + toVideo(edits, at - start)
  const moved = <T extends { at: number }>(item: T): T => ({ ...item, at: map(item.at) })
  return {
    ...footage,
    frames: footage.frames.map(moved),
    pointer: footage.pointer.map(moved),
    addresses: (footage.addresses ?? []).map(moved),
    clicks: footage.clicks.filter(kept).map(moved),
    keys: (footage.keys ?? []).filter(kept).map(moved),
    lines: (footage.lines ?? []).filter(kept).map(moved),
    highlights: footage.highlights
      .map((h) => ({ ...h, at: map(h.at), until: map(h.until) }))
      .filter((h) => h.until > h.at),
    end: map(footage.end),
  }
}

const editRequest: z.ZodType<EditRequest> = z.union([
  z.strictObject({ remove: z.number().int().min(0) }),
  z.strictObject({ from: z.number(), to: z.number(), cut: z.literal(true) }),
  z.strictObject({ from: z.number(), to: z.number(), speed: z.number().gt(1).max(16) }),
  z.strictObject({ step: z.number().int().min(0), cut: z.literal(true) }),
  z.strictObject({ step: z.number().int().min(0), speed: z.number().gt(1).max(16) }),
])

const stepEdit = (change: { cut: true } | { speed: number }, part: Part): StepEdit => {
  const whole = part.from === undefined && part.to === undefined
  if ('cut' in change) return { cut: whole ? true : part }
  return { speed: whole ? change.speed : { by: change.speed, ...part } }
}

// Each step's new cut or speed; undefined takes the step's edit away.
export type Plan = Map<number, StepEdit | undefined>

export function planEdit(film: Film, footage: Footage, raw: unknown): Plan {
  const request = editRequest.parse(raw)
  if ('remove' in request) return new Map([[request.remove, undefined]])
  if ('step' in request) {
    const now = film.steps[request.step]?.cut ?? film.steps[request.step]?.speed
    if (now === undefined) throw new Error(`Step ${request.step + 1} isn't cut or sped up.`)
    const { from, to } = typeof now === 'object' ? now : {}
    const part = { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }
    return new Map([[request.step, stepEdit(request, part)]])
  }
  const steps = spans(footage)
  if (!steps) {
    throw new Error(
      "This take was shot before steps' times were recorded. Shoot it again to cut or speed it up.",
    )
  }
  const edits = filmEdits(film, footage)
  const from = toTake(edits, request.from)
  const to = toTake(edits, request.to, true)
  if (!(to - from > SAME))
    throw new Error('That part is empty: give one that ends after it starts.')
  const plan: Plan = new Map()
  for (const [i, span] of steps.entries()) {
    if (span.to <= from + SAME || span.from >= to - SAME) continue
    const part = {
      ...(from > span.from + SAME ? { from: ms(from - span.from) } : {}),
      ...(to < span.to - SAME ? { to: ms(to - span.from) } : {}),
    }
    plan.set(i, stepEdit(request, part))
  }
  return plan
}

export function clearPlan(film: Film): Plan {
  return new Map(film.steps.flatMap((s, i) => (s.cut || s.speed ? [[i, undefined]] : [])))
}

// Written into the film's own JSON, not a parsed copy, so the rest of the file stays as written.
export async function writePlan(filmFile: string, plan: Plan): Promise<string> {
  const json = JSON.parse(await readFile(filmFile, 'utf8'))
  for (const [i, edit] of plan) {
    const step = json.steps[i]
    if (!step) continue
    delete step.cut
    delete step.speed
    Object.assign(step, edit)
  }
  const text = `${JSON.stringify(json, null, 2)}\n`
  await writeFile(filmFile, text)
  return text
}

export function shownEdits(edits: Edit[]): ShownEdit[] {
  return edits.map((e) => ({
    step: e.step,
    from: ms(toVideo(edits, e.from)),
    to: ms(toVideo(edits, e.to)),
    speed: 'cut' in e ? 'cut' : e.speed,
    taken: ms(e.to - e.from),
  }))
}

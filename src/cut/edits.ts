import { createHash } from 'node:crypto'
import { z } from 'zod'
import { changeSteps, type Film, type Part, type Step } from '../film.ts'
import type { Footage } from '../perform.ts'
import type { EditRequest, ShownEdit } from '../../studio/api.ts'
import { toVideo, type Span } from '../../studio/time.ts'

export { toTake, toVideo } from '../../studio/time.ts'

export interface Edit extends Span {
  step: number
}

type StepEdit = Pick<Step, 'cut' | 'speed'>

// Why an edit can't be made, said to whoever asked for it.
export class Refused extends Error {}

const SAME = 1e-3
const ms = (seconds: number) => Math.round(seconds * 1000) / 1000

// The ending's hold is the tail of the last step, so edits can reach the end of the video.
function spans(footage: Footage): { from: number; to: number }[] | undefined {
  const start = footage.frames[0]?.at ?? 0
  const end = footage.end + (footage.film.ending?.hold ?? 2)
  return footage.steps?.map((s, i) => ({
    from: Math.max(0, s.at - start),
    to: (footage.steps?.[i + 1]?.at ?? end) - start,
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
    const speed =
      step.cut !== undefined
        ? 'cut'
        : typeof step.speed === 'object'
          ? step.speed.by
          : (step.speed ?? 1)
    return [{ from, to, step: i, speed }]
  })
}

export const editsKey = (edits: Edit[]): string =>
  edits.length ? createHash('sha1').update(JSON.stringify(edits)).digest('hex').slice(0, 8) : ''

export function retime(footage: Footage, edits: Edit[]): Footage {
  if (!edits.length) return footage
  const start = footage.frames[0]?.at ?? 0
  const kept = (item: { at: number }) =>
    !edits.some((e) => e.speed === 'cut' && item.at - start >= e.from && item.at - start < e.to)
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
    ...(footage.steps ? { steps: footage.steps.map(moved) } : {}),
    end: map(footage.end),
  }
}

export function stepAt(footage: Footage, at: number): number | undefined {
  const i = (footage.steps ?? []).findLastIndex((s) => s.at <= at + SAME)
  return i < 0 ? undefined : i
}

const speedBy = z.number().gt(1).max(16)
const stepList = z.array(z.number().int().min(0)).min(1)
const editRequest: z.ZodType<EditRequest> = z.union([
  z.strictObject({ from: z.number(), to: z.number(), cut: z.literal(true) }),
  z.strictObject({ from: z.number(), to: z.number(), speed: speedBy }),
  z.strictObject({ steps: stepList, remove: z.literal(true) }),
  z.strictObject({ steps: stepList, cut: z.literal(true) }),
  z.strictObject({ steps: stepList, speed: speedBy }),
  z.strictObject({ steps: stepList, from: z.number(), to: z.number() }),
  z.strictObject({ steps: stepList, by: z.number() }),
])

type Change = { cut: true } | { speed: number }

const stepEdit = (change: Change, part: Part): StepEdit => {
  const whole = part.from === undefined && part.to === undefined
  if ('cut' in change) return { cut: whole ? true : part }
  return { speed: whole ? change.speed : { by: change.speed, ...part } }
}

// Each step's new cut or speed; undefined takes the step's edit away.
export type Plan = Map<number, StepEdit | undefined>

export function planEdit(film: Film, footage: Footage, raw: unknown): Plan {
  const request = editRequest.parse(raw)
  const steps = spans(footage)
  if (!steps) {
    throw new Refused(
      "This take was shot before steps' times were recorded. Shoot it again to cut or speed it up.",
    )
  }
  const edits = filmEdits(film, footage)
  if (!('steps' in request)) return planRange(steps, edits, request.from, request.to, request)
  const own = edits.filter((e) => request.steps.includes(e.step))
  const [first] = own
  if (!first) throw new Refused("Those steps aren't cut or sped up.")
  const plan: Plan = new Map(own.map((e) => [e.step, undefined]))
  if ('remove' in request) return plan
  if ('cut' in request || 'speed' in request) {
    for (const e of own) {
      const now = film.steps[e.step]?.cut ?? film.steps[e.step]?.speed
      const { from, to } = typeof now === 'object' ? now : {}
      const part = { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }
      plan.set(e.step, stepEdit(request, part))
    }
    return plan
  }
  const change: Change = first.speed === 'cut' ? { cut: true } : { speed: first.speed }
  const others = edits.filter((e) => !request.steps.includes(e.step))
  const start = own[0]?.from ?? 0
  const end = own.at(-1)?.to ?? 0
  const length = (steps.at(-1)?.to ?? 0) - SAME
  let from: number
  let to: number
  if ('by' in request) {
    from = Math.max(0, Math.min(length - (end - start), start + request.by))
    to = from + (end - start)
  } else {
    from = Math.max(0, request.from)
    to = Math.min(length, request.to)
  }
  for (const [i, edit] of planRange(steps, others, from, to, change)) plan.set(i, edit)
  return plan
}

function planRange(
  steps: { from: number; to: number }[],
  others: Edit[],
  from: number,
  to: number,
  change: Change,
): Plan {
  if (!(to - from > SAME))
    throw new Refused('That part is empty: give one that ends after it starts.')
  const plan: Plan = new Map()
  for (const [i, span] of steps.entries()) {
    if (span.to <= from + SAME || span.from >= to - SAME) continue
    if (others.some((e) => e.step === i)) {
      throw new Refused(
        `Step ${i + 1} already has a cut or speed-up: select it to change it, or remove it first.`,
      )
    }
    const part = {
      ...(from > span.from + SAME ? { from: ms(from - span.from) } : {}),
      ...(to < span.to - SAME ? { to: ms(to - span.from) } : {}),
    }
    plan.set(i, stepEdit(change, part))
  }
  return plan
}

export function clearPlan(film: Film): Plan {
  return new Map(film.steps.flatMap((s, i) => (s.cut || s.speed ? [[i, undefined]] : [])))
}

export function writePlan(filmFile: string, plan: Plan): Promise<string> {
  return changeSteps(filmFile, (step, i) => {
    if (!plan.has(i)) return
    delete step.cut
    delete step.speed
    Object.assign(step, plan.get(i))
  })
}

// Edits made in one go over several steps sit end to end with the same speed, and show as one.
export function shownEdits(edits: Edit[]): ShownEdit[] {
  const shown: ShownEdit[] = []
  for (const e of edits) {
    const joined = shown.at(-1)
    if (joined && joined.speed === e.speed && Math.abs(joined.to - e.from) < SAME) {
      joined.steps.push(e.step)
      joined.to = ms(e.to)
    } else shown.push({ steps: [e.step], from: ms(e.from), to: ms(e.to), speed: e.speed })
  }
  return shown
}

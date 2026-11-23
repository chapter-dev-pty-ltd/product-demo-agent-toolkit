import { z } from 'zod'
import { soundOn, type Sound } from '../config.ts'
import {
  changeScene,
  changeSteps,
  coverSize,
  hex,
  type Film,
  type Part,
  type Step,
} from '../film.ts'
import type { Footage } from '../perform.ts'
import type {
  CoverRequest,
  EditRequest,
  HighlightRequest,
  ShownEdit,
  SoundRequest,
} from '../../studio/api.ts'
import { toVideo, type Hold, type Span } from '../../studio/time.ts'

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
  if (footage.steps || !film.steps.some((s) => s.cut || s.speed || s.sound !== undefined))
    return undefined
  return "this take was shot before steps' times were recorded, so the film's cuts, speed-ups and step sounds are left out. Shoot it again to see them."
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

export function retime(footage: Footage, edits: Edit[], holds: Hold[] = []): Footage {
  if (!edits.length && !holds.length) return footage
  const start = footage.frames[0]?.at ?? 0
  const kept = (item: { at: number }) =>
    !edits.some((e) => e.speed === 'cut' && item.at - start >= e.from && item.at - start < e.to)
  const map = (at: number) => start + toVideo(edits, at - start, holds)
  const moved = <T extends { at: number }>(item: T): T => ({ ...item, at: map(item.at) })
  // A cover at the very start moves the first frame too; the stage times everything from it.
  const first = holds.length && footage.frames[0] ? [footage.frames[0]] : []
  return {
    ...footage,
    frames: [...first, ...footage.frames.map(moved)],
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

export function muteQuietSteps(film: Film, footage: Footage): Footage {
  const muted = (kind: 'click' | 'typing', at: number) => {
    const step = stepAt(footage, at)
    const sound = step === undefined ? undefined : film.steps[step]?.sound
    return sound !== undefined && !soundOn(kind, sound)
  }
  return {
    ...footage,
    clicks: footage.clicks.map((c) => ({ ...c, muted: muted('click', c.at) })),
    keys: (footage.keys ?? []).map((k) => ({ ...k, muted: muted('typing', k.at) })),
  }
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

const stepIndex = z.number().int().min(0)
const soundRequest: z.ZodType<SoundRequest> = z.strictObject({
  step: stepIndex,
  click: z.boolean(),
})
const highlightRequest: z.ZodType<HighlightRequest> = z.union([
  z.strictObject({ step: stepIndex, style: z.enum(['box', 'magnify', 'cursor']) }),
  z.strictObject({ step: stepIndex, remove: z.literal(true) }),
])

export function writeClickSound(filmFile: string, film: Film, raw: unknown): Promise<string> {
  const request = soundRequest.parse(raw)
  if (!film.steps[request.step]) throw new Refused(`There's no step ${request.step + 1}.`)
  return changeSteps(filmFile, (step, i) => {
    if (i !== request.step) return
    const typing = soundOn('typing', (step.sound as Sound | undefined) ?? true)
    const click = request.click
    if (click && typing) delete step.sound
    else step.sound = click === typing ? click : { click, typing }
  })
}

const coverRequest: z.ZodType<CoverRequest> = z.strictObject({
  scene: stepIndex,
  title: z.string().trim().min(1).optional(),
  subtitle: z.string().trim().optional(),
  colour: hex.optional(),
  background: hex.nullable().optional(),
  size: coverSize.optional(),
})

export function writeCover(filmFile: string, film: Film, raw: unknown): Promise<string> {
  const request = coverRequest.parse(raw)
  if (!film.scenes?.[request.scene]?.cover)
    throw new Refused(`Scene ${request.scene + 1} has no cover.`)
  return changeScene(filmFile, request.scene, (scene) => {
    const cover = { ...(scene.cover as Record<string, unknown>) }
    const { title, subtitle, colour, background, size } = request
    if (title) scene.title = title
    if (subtitle) cover.subtitle = subtitle
    else if (subtitle === '') delete cover.subtitle
    if (colour) cover.colour = colour
    if (background) cover.background = background
    else if (background === null) delete cover.background
    if (size) cover.size = size
    scene.cover = cover
  })
}

export function writeHighlight(filmFile: string, film: Film, raw: unknown): Promise<string> {
  const request = highlightRequest.parse(raw)
  if (!film.steps[request.step]?.highlight)
    throw new Refused(`Step ${request.step + 1} has no highlight.`)
  return changeSteps(filmFile, (step, i) => {
    if (i !== request.step) return
    if ('remove' in request) delete step.highlight
    else step.highlight = { ...(step.highlight as object), style: request.style }
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

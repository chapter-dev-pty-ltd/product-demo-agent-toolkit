import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright-core'
import type { Config } from './config.ts'
import {
  describeStep,
  stepTarget,
  type Film,
  type Key,
  type Point,
  type Step,
  type Target,
} from './film.ts'
import { watch } from './settle.ts'
import { decide, fingerprint, rank } from './similo.ts'
import { launchBrowser } from './tools.ts'
import { speakLines, wordAt, type Spoken } from './voice.ts'

export interface Rehearsal {
  film: Film
  stills: { step: string; file: string }[]
  warnings: string[]
}

export interface Footage {
  film: Film
  source: string
  frames: { file: string; at: number }[]
  pointer: { at: number; x: number; y: number }[]
  // muted: the step it's in has its sound turned off in the film.
  clicks: { at: number; x: number; y: number; muted?: boolean }[]
  keys: { at: number; key: string; muted?: boolean }[]
  addresses: { at: number; url: string }[]
  lines: { at: number; file: string; text: string }[]
  highlights: { step: number; at: number; until: number; box: number[] }[]
  steps?: { at: number }[]
  viewport: { width: number; height: number }
  end: number
  warnings: string[]
}

export class NeedsDecision extends Error {}

export async function rehearse(film: Film, dir: string, config: Config): Promise<Rehearsal> {
  const stills: Rehearsal['stills'] = []
  const { warnings } = await perform(film, dir, config, {
    still: async (page, step, index) => {
      const file = join(dir, `${String(index).padStart(2, '0')}.png`)
      await page.screenshot({ path: file })
      stills.push({ step, file })
    },
  })
  const rehearsal: Rehearsal = { film, stills, warnings }
  await writeFile(join(dir, 'rehearsal.json'), JSON.stringify(rehearsal, null, 2))
  return rehearsal
}

export async function shoot(
  film: Film,
  source: string,
  dir: string,
  config: Config,
): Promise<Footage> {
  await mkdir(join(dir, 'frames'), { recursive: true })
  const frames: Footage['frames'] = []
  const writes: Promise<void>[] = []
  let started = 0
  let end = 0
  const { warnings, trail, keys, lines, addresses, highlights, starts } = await perform(
    film,
    dir,
    config,
    {
      camera: async (page) => {
        started = performance.now()
        const session = await page.context().newCDPSession(page)
        session.on('Page.screencastFrame', (event) => {
          void session
            .send('Page.screencastFrameAck', { sessionId: event.sessionId })
            .catch(() => {})
          const file = join('frames', `${String(frames.length).padStart(6, '0')}.jpg`)
          frames.push({ file, at: (performance.now() - started) / 1000 })
          writes.push(writeFile(join(dir, file), Buffer.from(event.data, 'base64')))
        })
        await session.send('Page.startScreencast', {
          format: 'jpeg',
          quality: 90,
          maxWidth: config.window.width,
          maxHeight: config.window.height,
        })
        return async () => {
          end = (performance.now() - started) / 1000
          await session.send('Page.stopScreencast')
        }
      },
    },
  )
  await Promise.all(writes)
  const since = (t: number) => Math.max(0, (t - started) / 1000)
  const first = trail.findLastIndex((m) => m.t <= started)
  const pointer = trail.slice(Math.max(0, first)).map((m) => ({ at: since(m.t), x: m.x, y: m.y }))
  const clicks = trail
    .filter((m) => m.click && m.t >= started)
    .map((m) => ({ at: since(m.t), x: m.x, y: m.y }))
  const footage: Footage = {
    film,
    source,
    viewport: { width: config.window.width, height: config.window.height },
    frames,
    pointer,
    clicks,
    keys: keys.filter((k) => k.t >= started).map((k) => ({ at: since(k.t), key: k.key })),
    lines: lines.map((l) => ({ ...l, at: since(l.at) })),
    addresses: addresses
      .slice(
        Math.max(
          0,
          addresses.findLastIndex((a) => a.t <= started),
        ),
      )
      .map((a) => ({ at: since(a.t), url: a.url })),
    highlights: highlights.map((h) => ({ ...h, at: since(h.at), until: since(h.until) })),
    steps: starts.map((t) => ({ at: since(t) })),
    end,
    warnings,
  }
  await writeFile(join(dir, 'footage.json'), JSON.stringify(footage, null, 2))
  return footage
}

interface Watchers {
  camera?: (page: Page) => Promise<() => Promise<void>>
  still?: (page: Page, step: string, index: number) => Promise<void>
}

async function perform(
  film: Film,
  dir: string,
  config: Config,
  watchers: Watchers,
): Promise<{
  warnings: string[]
  trail: Hand['trail']
  keys: Hand['keys']
  lines: Footage['lines']
  addresses: { t: number; url: string }[]
  highlights: Footage['highlights']
  starts: number[]
}> {
  await mkdir(dir, { recursive: true })
  const spoken = await speakLines(
    film.steps.flatMap((s) => (s.say ? [s.say] : [])),
    config.voice,
  )
  const browser = await launchBrowser()
  try {
    const { width, height } = config.window
    const page = await browser.newPage({ viewport: { width, height } })
    const settler = watch(page)
    const addresses: { t: number; url: string }[] = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) addresses.push({ t: performance.now(), url: frame.url() })
    })
    await page.goto(film.app)
    const hand = new Hand(page)
    await hand.rest(width / 2, height / 2)
    await settler.settled({ beat: 400 })
    const stopCamera = await watchers.camera?.(page)
    await watchers.still?.(page, 'the opening screen', 0)

    const warnings: string[] = []
    const highlights: Footage['highlights'] = []
    const lines: Footage['lines'] = []
    const starts: number[] = []
    let line: { spoken: Spoken; at: number } | undefined
    for (const [index, step] of film.steps.entries()) {
      starts.push(performance.now())
      const label = `Step ${index + 1} (${describeStep(step)})`
      const finder: Finder = (target) =>
        find(page, target, config, (warning) => warnings.push(`${label}: ${warning}`))
      try {
        if (step.say) {
          const said = spoken.get(step.say)
          if (!said) throw new Error('Its line was never spoken.')
          line = { spoken: said, at: performance.now() }
          lines.push({ at: line.at, file: said.file, text: said.text })
        }
        hand.due = undefined
        if (step.on) {
          if (!line) throw new Error(`"on" needs a line: give this step or one before it "say".`)
          const word = wordAt(line.spoken, step.on)
          if (word === undefined) throw new Error(`"${step.on}" isn't in "${line.spoken.text}".`)
          hand.due = line.at + word * 1000
        }
        hand.landed = undefined
        const next = film.steps[index + 1]
        hand.passing =
          'hover' in step && step.seconds === undefined && !step.highlight && pointing(next)
        const lit = step.highlight ? await highlightOn(page, step, finder) : undefined
        hand.notBefore = lit ? lit.at + ZOOM_MS : 0
        await settler.mark()
        await act(page, hand, film.app, step, finder)
        if (hand.due !== undefined && step.on && hand.landed !== undefined) {
          const late = (hand.landed - hand.due) / 1000
          if (late > 0.2) {
            warnings.push(
              `${label}: landed ${late.toFixed(1)}s after "${step.on}" was said. Give it more words before it, or less to do before it.`,
            )
          }
        }
        hand.due = undefined
        const carriesOn = Boolean(line && next?.on && !next.say)
        const rest = film.steps.slice(index + 1)
        const nextLine = rest.findIndex((later) => later.say)
        const keepsLine = Boolean(
          line && rest.slice(0, nextLine === -1 ? undefined : nextLine).some((later) => later.on),
        )
        const settled = hand.passing
          ? { settled: true, waitingOn: [] }
          : await settler.settled({ beat: carriesOn ? 0 : 400 })
        if (!settled.settled) {
          warnings.push(
            `${label}: went on before the page settled (${settled.waitingOn.join(', ')}).`,
          )
        }
        await watchers.still?.(page, label, index + 1)
        if (lit) {
          await page.waitForTimeout((step.highlight?.seconds ?? 2) * 1000)
          highlights.push({ step: index, ...lit, until: performance.now() })
        }
        if (line && !keepsLine) {
          const left = line.at + line.spoken.seconds * 1000 + 350 - performance.now()
          if (left > 0) await page.waitForTimeout(left)
          line = undefined
        }
      } catch (error) {
        const failed = join(dir, 'failed.png')
        await page.screenshot({ path: failed }).catch(() => {})
        const why = error instanceof Error ? error.message : String(error)
        const Failure = error instanceof NeedsDecision ? NeedsDecision : Error
        throw new Failure(`${label} failed: ${why}\nThe screen is in ${failed}`)
      }
    }
    await stopCamera?.()
    return { warnings, trail: hand.trail, keys: hand.keys, lines, addresses, highlights, starts }
  } finally {
    await browser.close()
  }
}

export type Finder = (target: Target) => Promise<Locator>

const pointing = (step: Step | undefined): boolean =>
  step !== undefined && ['hover', 'click', 'drag', 'fill', 'select'].some((kind) => kind in step)

const TO_KEYBOARD_MS = 600

const ZOOM_MS = 800

export async function act(
  page: Page,
  hand: Hand,
  app: string,
  step: Step,
  find: Finder,
): Promise<void> {
  if ('visit' in step || 'wait' in step) await hand.onTime()
  if ('visit' in step) {
    await page.goto(new URL(step.visit, app).href)
    await hand.rest(hand.x, hand.y)
  } else if ('click' in step) {
    await hand.click(await find(step.click), step)
  } else if ('fill' in step) {
    const due = hand.due
    if (due !== undefined) hand.due = due - TO_KEYBOARD_MS - 150
    await hand.click(await find(step.fill))
    hand.due = due
    hand.landed = undefined
    await fill(page, hand, step.text)
  } else if ('select' in step) {
    const select = await find(step.select)
    await hand.reach(select)
    await hand.onTime()
    await hand.pause(200)
    await select.selectOption({ label: step.option }, { timeout: 5000 }).catch(() => {
      throw new Error(`It has no option "${step.option}", or it isn't a <select>.`)
    })
  } else if ('type' in step) {
    await hand.type(step.type)
  } else if ('press' in step) {
    await hand.key(step.press)
  } else if ('hover' in step) {
    await hand.reach(await find(step.hover), step.at)
    await hand.onTime()
    if (!hand.passing) await hand.pause((step.seconds ?? 1.2) * 1000)
  } else if ('drag' in step) {
    const from = await find(step.drag)
    const to = await find(step.to)
    await hand.drag(from, step.at, to, step.toAt)
  } else if ('scroll' in step) {
    if (step.in) await hand.reach(await find(step.in))
    const pixels = step.pixels ?? 600
    await hand.scroll(step.scroll === 'down' ? pixels : -pixels)
  } else if ('upload' in step) {
    await upload(page, hand, step.upload, step.into && (await find(step.into)))
  } else if (typeof step.wait === 'number') {
    await page.waitForTimeout(step.wait * 1000)
  } else if (step.wait.gone) {
    await page
      .getByText(step.wait.text)
      .filter({ visible: true })
      .first()
      .waitFor({ state: 'hidden', timeout: 30_000 })
  } else {
    await page.getByText(step.wait.text).first().waitFor({ timeout: 30_000 })
  }
}

async function highlightOn(
  page: Page,
  step: Step,
  find: Finder,
): Promise<{ at: number; box: number[] }> {
  const given = step.highlight?.box
  const target = stepTarget(step)
  let box = given
  if (!box) {
    if (!target) throw new Error('Its highlight needs a box: the step has no element to point at.')
    const bounds = await (await find(target)).boundingBox()
    if (!bounds) throw new Error('The element to highlight has no size on screen.')
    box = [bounds.x, bounds.y, bounds.width, bounds.height]
  }
  return { at: performance.now(), box }
}

async function fill(page: Page, hand: Hand, text: string): Promise<void> {
  const field = await page.evaluate((value) => {
    const element = document.activeElement
    const direct = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range', 'number']
    if (element instanceof HTMLInputElement && direct.includes(element.type)) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        element,
        value,
      )
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
      return 'set'
    }
    const typable =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLElement && element.isContentEditable)
    return typable ? 'type' : 'none'
  }, text)
  if (field === 'set') return
  if (field === 'none') throw new Error("Clicking it didn't focus a field to type into.")
  await hand.toKeyboard()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await hand.type(text)
}

async function upload(page: Page, hand: Hand, file: string, control?: Locator): Promise<void> {
  if (!existsSync(file)) throw new Error(`There's no file at ${file}.`)
  if (control) {
    const chooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => undefined)
    await hand.click(control)
    const picker = await chooser
    if (picker) return picker.setFiles(file)
    const inside = control.locator('input[type=file]')
    if (await inside.count()) return inside.first().setInputFiles(file)
  }
  const input = page.locator('input[type=file]')
  if (!(await input.count())) {
    throw new Error('There is no file input on the page. Name the control that opens the picker.')
  }
  await input.first().setInputFiles(file)
}

export async function find(
  page: Page,
  target: Target,
  config: Config,
  note: (warning: string) => void,
): Promise<Locator> {
  const locator =
    'selector' in target
      ? page.locator(target.selector)
      : 'role' in target
        ? page.locator(`role=${target.role}[name=${JSON.stringify(target.name)}]`)
        : 'text' in target
          ? page.getByText(target.text)
          : page.locator(target.css)
  await locator
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => {})
  const count = await locator.count()
  const positional = 'selector' in target && /\bnth=/.test(target.selector)
  if (positional) {
    const decision = decide(await rank(page, target.fingerprint))
    if ('found' in decision) return ready(decision.found.locator)
  }
  if (count === 1) return ready(locator)

  let candidates = await locator.all()
  if ('fingerprint' in target) {
    const decision = decide(await rank(page, target.fingerprint))
    if ('found' in decision) {
      note(`its locator matched ${count}, so it was found by its fingerprint.`)
      return ready(decision.found.locator)
    }
    if ('missing' in decision) {
      throw new Error(`Nothing on the page is the element it pinned (locator matched ${count}).`)
    }
    candidates = decision.ambiguous.map((c) => c.locator)
  } else if (count === 0) {
    throw new Error('Nothing on the page matches it.')
  }

  const first = candidates[0]
  if (!first) throw new Error('Nothing on the page matches it.')
  const listed = await Promise.all(candidates.map(summarise))
  if (config.mode === 'just_do_it') {
    note(`${candidates.length} elements matched; took the first, ${listed[0]}.`)
    return ready(first)
  }
  throw new NeedsDecision(
    `${candidates.length} elements match it:\n${listed.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}\n` +
      'Ask the user which one they meant, then explore that step again to pin it.',
  )
}

async function ready(locator: Locator): Promise<Locator> {
  await locator.scrollIntoViewIfNeeded()
  return locator
}

async function summarise(element: Locator): Promise<string> {
  const print = await fingerprint(element).catch(() => undefined)
  if (!print) return 'an element that is not visible'
  const inside = print.neighbours ? ` in "${print.neighbours.slice(0, 60)}"` : ''
  return `${print.tag} "${print.text.slice(0, 40)}"${print.href ? ` (${print.href})` : ''}${inside}`
}

export class Hand {
  x = 0
  y = 0
  page: Page
  quick: boolean
  trail: { t: number; x: number; y: number; click?: true }[] = []
  due: number | undefined
  keys: { t: number; key: string }[] = []
  passing = false
  notBefore = 0
  private onMouse = 0
  private flow: { speed: number; at: number } | undefined
  constructor(page: Page, quick = false) {
    this.page = page
    this.quick = quick
  }

  async pause(ms: number): Promise<void> {
    if (!this.quick) await this.page.waitForTimeout(ms)
  }

  async rest(x: number, y: number): Promise<void> {
    await this.move(x, y)
  }

  private async move(x: number, y: number): Promise<void> {
    await this.page.mouse.move(x, y)
    if (!this.quick) this.trail.push({ t: performance.now(), x, y })
    this.x = x
    this.y = y
  }

  landed: number | undefined

  async onTime(): Promise<void> {
    const wait = this.due === undefined ? 0 : this.due - performance.now()
    if (wait > 0) await this.page.waitForTimeout(wait)
    if (this.due !== undefined) this.landed ??= performance.now()
  }

  travel(x: number, y: number): number {
    const varied = 0.9 + Math.random() * 0.2
    return Math.min(900, 250 + Math.hypot(x - this.x, y - this.y) * 0.5) * varied
  }

  async glide(x: number, y: number, ms: number = this.travel(x, y)): Promise<void> {
    if (this.quick) return this.rest(x, y)
    const fromX = this.x
    const fromY = this.y
    const distance = Math.hypot(x - fromX, y - fromY)
    if (distance < 1) return this.rest(x, y)
    const carried = this.flow && performance.now() - this.flow.at < 400 ? this.flow.speed : 0
    const v0 = Math.min(1.5, (carried * ms) / distance)
    const v1 = this.passing ? 0.35 : 0
    const bend = distance > 80 ? Math.min(36, distance * 0.05) : 0
    const side = x >= fromX ? 1 : -1
    const nx = (-(y - fromY) / distance) * side
    const ny = ((x - fromX) / distance) * side
    const start = performance.now()
    for (;;) {
      const k = Math.min(1, (performance.now() - start) / ms)
      const s = flowing(k, v0, v1)
      const arc = bend * Math.sin(Math.PI * k)
      await this.move(fromX + (x - fromX) * s + nx * arc, fromY + (y - fromY) * s + ny * arc)
      if (k >= 1) break
      await this.page.waitForTimeout(16)
    }
    this.flow = v1 > 0 ? { speed: (v1 * distance) / ms, at: performance.now() } : undefined
  }

  async toKeyboard(): Promise<void> {
    const wait = this.onMouse + TO_KEYBOARD_MS - performance.now()
    if (wait > 0 && !this.quick) await this.page.waitForTimeout(wait)
    this.onMouse = 0
  }

  private async whenZoomed(): Promise<void> {
    const wait = this.notBefore - performance.now()
    if (wait > 0 && !this.quick) await this.page.waitForTimeout(wait)
  }

  async reach(target: Locator, at?: Point): Promise<{ x: number; y: number }> {
    const spot = await spotOn(target, at)
    let ms = this.travel(spot.x, spot.y)
    if (this.due !== undefined && !this.quick) {
      const left = this.due - performance.now() - (this.passing ? 0 : 250)
      const slowest = ms * 1.25
      if (left > slowest) await this.page.waitForTimeout(left - slowest)
      ms = Math.max(ms, Math.min(left, slowest))
    }
    await this.glide(spot.x, spot.y, ms)
    return spot
  }

  async click(
    target: Locator,
    how: {
      at?: Point | undefined
      double?: boolean | undefined
      right?: boolean | undefined
      modifiers?: Key[] | undefined
    } = {},
  ): Promise<void> {
    await this.reach(target, how.at)
    await this.pause(120)
    await this.whenZoomed()
    await this.onTime()
    const button = how.right ? 'right' : 'left'
    const held = how.modifiers ?? []
    for (const key of held) await this.page.keyboard.down(key)
    try {
      const presses = how.double ? 2 : 1
      for (let clickCount = 1; clickCount <= presses; clickCount++) {
        await this.page.mouse.down({ button, clickCount })
        if (!this.quick)
          this.trail.push({ t: performance.now(), x: this.x, y: this.y, click: true })
        await this.pause(80)
        await this.page.mouse.up({ button, clickCount })
        if (clickCount < presses) await this.pause(60)
      }
      this.onMouse = performance.now()
    } finally {
      for (const key of held.toReversed()) await this.page.keyboard.up(key)
    }
  }

  async drag(
    from: Locator,
    at: Point | undefined,
    to: Locator,
    toAt: Point | undefined,
  ): Promise<void> {
    const start = await this.reach(from, at)
    const end = await spotOn(to, toAt)
    await this.pause(120)
    await this.whenZoomed()
    await this.onTime()
    const mouse = this.page.mouse
    await mouse.down()
    await this.page.waitForTimeout(this.quick ? 80 : 150)
    const distance = Math.hypot(end.x - start.x, end.y - start.y)
    const ms = this.quick ? 400 : Math.min(1400, 450 + distance * 0.7)
    const began = performance.now()
    for (let k = 0; k < 1; k = Math.min(1, (performance.now() - began) / ms)) {
      const s = flowing(k, 0, 0)
      await this.move(start.x + (end.x - start.x) * s, start.y + (end.y - start.y) * s)
      await this.page.waitForTimeout(16)
    }
    await this.move(end.x, end.y)
    await this.page.waitForTimeout(this.quick ? 200 : 350)
    await mouse.move(end.x + 1, end.y)
    await this.move(end.x, end.y)
    await mouse.up()
    this.onMouse = performance.now()
  }

  async type(text: string): Promise<void> {
    if (this.quick) return this.page.keyboard.type(text)
    await this.toKeyboard()
    await this.onTime()
    for (const character of text) {
      await this.page.keyboard.type(character)
      this.keys.push({ t: performance.now(), key: character })
      await this.page.waitForTimeout(55 + Math.random() * 60 + (character === ' ' ? 40 : 0))
    }
  }

  async key(key: string): Promise<void> {
    await this.toKeyboard()
    await this.onTime()
    await this.page.keyboard.press(key)
    if (!this.quick) this.keys.push({ t: performance.now(), key })
  }

  async scroll(pixels: number): Promise<void> {
    await this.onTime()
    const ticks = 15
    const curve = (t: number) => (1 - Math.cos(Math.PI * t)) / 2
    for (let tick = 0; tick < ticks; tick++) {
      await this.page.mouse.wheel(0, pixels * (curve((tick + 1) / ticks) - curve(tick / ticks)))
      await this.pause(20)
    }
  }
}

async function spotOn(target: Locator, at?: Point): Promise<{ x: number; y: number }> {
  let box = await target.boundingBox()
  for (let tries = 0; box && tries < 10; tries++) {
    await new Promise((done) => setTimeout(done, 50))
    const now = await target.boundingBox()
    const still =
      now && Math.abs(now.x - box.x) + Math.abs(now.y - box.y) + Math.abs(now.width - box.width) < 1
    box = now
    if (still) break
  }
  if (!box) throw new Error('The element has no size on screen.')
  return { x: box.x + box.width * (at?.x ?? 0.5), y: box.y + box.height * (at?.y ?? 0.5) }
}

const flowing = (k: number, v0: number, v1: number): number =>
  v0 * (k - 6 * k ** 3 + 8 * k ** 4 - 3 * k ** 5) +
  (10 * k ** 3 - 15 * k ** 4 + 6 * k ** 5) +
  v1 * (-4 * k ** 3 + 7 * k ** 4 - 3 * k ** 5)

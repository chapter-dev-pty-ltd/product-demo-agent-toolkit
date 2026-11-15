import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright-core'
import type { Config } from './config.ts'
import { describeStep, type Film, type Key, type Point, type Step, type Target } from './film.ts'
import { checkOutcome } from './outcome.ts'
import { watch } from './settle.ts'
import { decide, fingerprint, rank } from './similo.ts'
import { launchBrowser } from './tools.ts'

export const VIEWPORT = { width: 1440, height: 900 }

// Rehearse and shoot are the same run: a fresh browser, every step performed at a
// person's pace with a hand-moved pointer, settling and checking each step's outcome.
// Shooting films it; rehearsing leaves a still after every step to judge it by instead.

/** What a rehearsal leaves: a still of the opening screen and after every step. */
export interface Rehearsal {
  film: Film
  stills: { step: string; file: string }[]
  /** Choices made without asking (`just_do_it`), recoveries, and steps that never settled. */
  warnings: string[]
}

/** What a shoot leaves for `cut`: every frame, timed from the start. */
export interface Footage {
  film: Film
  frames: { file: string; at: number }[]
  end: number
  /** Choices made without asking (`just_do_it`), recoveries, and steps that never settled. */
  warnings: string[]
}

/** A step that can't go on until someone decides something. Trying again won't help. */
export class NeedsDecision extends Error {}

const CURSOR = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M3 2l17 11.5-7.4 1.4 4.3 8.2-3.2 1.6-4.3-8.3L3 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`

/** Performs the film without a camera, keeping a still after each step. */
export async function rehearse(film: Film, dir: string, config: Config): Promise<Rehearsal> {
  const stills: Rehearsal['stills'] = []
  const warnings = await perform(film, dir, config, {
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

/** Performs the film on camera, keeping every frame. */
export async function shoot(film: Film, dir: string, config: Config): Promise<Footage> {
  await mkdir(join(dir, 'frames'), { recursive: true })
  const frames: Footage['frames'] = []
  const writes: Promise<void>[] = []
  let started = 0
  let end = 0
  const warnings = await perform(film, dir, config, {
    camera: async (page) => {
      started = performance.now()
      const session = await page.context().newCDPSession(page)
      session.on('Page.screencastFrame', (event) => {
        void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
        const file = join('frames', `${String(frames.length).padStart(6, '0')}.jpg`)
        frames.push({ file, at: (performance.now() - started) / 1000 })
        writes.push(writeFile(join(dir, file), Buffer.from(event.data, 'base64')))
      })
      await session.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 90,
        maxWidth: VIEWPORT.width,
        maxHeight: VIEWPORT.height,
      })
      return async () => {
        end = (performance.now() - started) / 1000
        await session.send('Page.stopScreencast')
      }
    },
  })
  await Promise.all(writes)
  const footage: Footage = { film, frames, end, warnings }
  await writeFile(join(dir, 'footage.json'), JSON.stringify(footage, null, 2))
  return footage
}

interface Watchers {
  /** Starts filming once the opening screen has settled; returns how to stop, before the browser closes. */
  camera?: (page: Page) => Promise<() => Promise<void>>
  /** Keeps a still of the screen: the opening one (index 0), then after each step. */
  still?: (page: Page, step: string, index: number) => Promise<void>
}

/** One run of the film in a fresh browser. Returns its warnings; throws at the first step that fails. */
async function perform(
  film: Film,
  dir: string,
  config: Config,
  watchers: Watchers,
): Promise<string[]> {
  await mkdir(dir, { recursive: true })
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    const settler = watch(page)
    await page.addInitScript(drawCursor, CURSOR)
    await page.goto(film.app)
    const hand = new Hand(page)
    await hand.rest(VIEWPORT.width / 2, VIEWPORT.height / 2)
    await settler.settled({ beat: 400 })
    const stopCamera = await watchers.camera?.(page)
    await watchers.still?.(page, 'the opening screen', 0)

    const warnings: string[] = []
    for (const [index, step] of film.steps.entries()) {
      const label = `Step ${index + 1} (${describeStep(step)})`
      const finder: Finder = (target) =>
        find(page, target, config, (warning) => warnings.push(`${label}: ${warning}`))
      try {
        await settler.mark()
        await act(page, hand, film.app, step, finder)
        const settled = await settler.settled({ beat: 400 })
        if (!settled.settled) {
          warnings.push(
            `${label}: went on before the page settled (${settled.waitingOn.join(', ')}).`,
          )
        }
        const unseen = step.outcome ? await checkOutcome(page, step.outcome) : undefined
        if (unseen) warnings.push(`${label}: ${unseen}`)
        await watchers.still?.(page, label, index + 1)
      } catch (error) {
        const failed = join(dir, 'failed.png')
        await page.screenshot({ path: failed }).catch(() => {})
        const why = error instanceof Error ? error.message : String(error)
        const Failure = error instanceof NeedsDecision ? NeedsDecision : Error
        throw new Failure(`${label} failed: ${why}\nThe screen is in ${failed}`)
      }
    }
    await stopCamera?.()
    return warnings
  } finally {
    await browser.close()
  }
}

export type Finder = (target: Target) => Promise<Locator>

/** Performs one step with the hand: at a person's pace when filming, at once when exploring. */
export async function act(
  page: Page,
  hand: Hand,
  app: string,
  step: Step,
  find: Finder,
): Promise<void> {
  if ('visit' in step) {
    await page.goto(new URL(step.visit, app).href)
    await hand.rest(hand.x, hand.y)
  } else if ('click' in step) {
    await hand.click(await find(step.click), step)
  } else if ('fill' in step) {
    await hand.click(await find(step.fill))
    await fill(page, hand, step.text)
  } else if ('select' in step) {
    // A native select's list is drawn outside the page and swallows the next click, so the
    // hand goes to it and the option is chosen by its label, as Playwright's selectOption does.
    const select = await find(step.select)
    await hand.reach(select)
    await hand.pause(200)
    await select.selectOption({ label: step.option }, { timeout: 5000 }).catch(() => {
      throw new Error(`It has no option "${step.option}", or it isn't a <select>.`)
    })
  } else if ('type' in step) {
    await page.keyboard.type(step.type, { delay: hand.quick ? 0 : 70 })
  } else if ('press' in step) {
    await page.keyboard.press(step.press)
  } else if ('hover' in step) {
    await hand.reach(await find(step.hover), step.at)
    await hand.pause((step.seconds ?? 1.2) * 1000)
  } else if ('drag' in step) {
    // The drop is found before the press: once something is held, what's dragged can cover it.
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

/** Types into the focused field, replacing what's in it. */
async function fill(page: Page, hand: Hand, text: string): Promise<void> {
  // A date, time, colour or number input can't be typed into reliably (a controlled number
  // input moves the caret after each key), so it's set the way Playwright's fill() sets it.
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
  // Select-all with no field focused selects the whole page.
  if (field === 'none') throw new Error("Clicking it didn't focus a field to type into.")
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text, { delay: hand.quick ? 0 : 70 })
}

/** Gives a file to the page: through the control that opens the picker, as a person would. */
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

/**
 * The element a target names. A pinned target's locator first; when it matches nothing or
 * more than one, its Similo fingerprint. When two elements are equally likely, `ask` stops
 * so the agent can ask the user, and `just_do_it` takes the best and notes it.
 */
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
  // A locator that picks by position (`nth=2`) always matches one element, right or not,
  // so a pinned one is checked by its fingerprint first.
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

/** An element in a line: what it says, and where it sits. */
async function summarise(element: Locator): Promise<string> {
  const print = await fingerprint(element).catch(() => undefined)
  if (!print) return 'an element that is not visible'
  const inside = print.neighbours ? ` in "${print.neighbours.slice(0, 60)}"` : ''
  return `${print.tag} "${print.text.slice(0, 40)}"${print.href ? ` (${print.href})` : ''}${inside}`
}

/** The pointer, moved the way a hand moves it: eased, and slower over longer distances. */
export class Hand {
  x = 0
  y = 0
  page: Page
  /** Exploring: no travel and no pauses, only what the page needs to hear. */
  quick: boolean
  constructor(page: Page, quick = false) {
    this.page = page
    this.quick = quick
  }

  async pause(ms: number): Promise<void> {
    if (!this.quick) await this.page.waitForTimeout(ms)
  }

  /** Puts the pointer somewhere without travelling, so the page draws it there. */
  async rest(x: number, y: number): Promise<void> {
    await this.page.mouse.move(x, y)
    this.x = x
    this.y = y
  }

  async glide(x: number, y: number): Promise<void> {
    if (this.quick) return this.rest(x, y)
    const fromX = this.x
    const fromY = this.y
    const ms = Math.min(900, 250 + Math.hypot(x - fromX, y - fromY) * 0.5)
    for (let t = 0; t <= ms; t += 16) {
      const k = ease(t / ms)
      await this.page.mouse.move(fromX + (x - fromX) * k, fromY + (y - fromY) * k)
      await this.page.waitForTimeout(16)
    }
    await this.rest(x, y)
  }

  /** Moves onto an element, to a point on it (its middle unless told). */
  async reach(target: Locator, at?: Point): Promise<{ x: number; y: number }> {
    const spot = await spotOn(target, at)
    await this.glide(spot.x, spot.y)
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
    const button = how.right ? 'right' : 'left'
    const held = how.modifiers ?? []
    for (const key of held) await this.page.keyboard.down(key)
    try {
      // Two presses, the second counted as such, so the page hears the dblclick a person makes.
      const presses = how.double ? 2 : 1
      for (let clickCount = 1; clickCount <= presses; clickCount++) {
        await this.page.mouse.down({ button, clickCount })
        await this.pause(80)
        await this.page.mouse.up({ button, clickCount })
        if (clickCount < presses) await this.pause(60)
      }
    } finally {
      for (const key of held.toReversed()) await this.page.keyboard.up(key)
    }
  }

  /**
   * Presses on one element, carries it with the button held and lets go on another. The
   * pointer moves every frame, even when exploring: drag libraries wait for some travel
   * before they start, and a sortable list reorders as rows are passed.
   */
  async drag(
    from: Locator,
    at: Point | undefined,
    to: Locator,
    toAt: Point | undefined,
  ): Promise<void> {
    const start = await this.reach(from, at)
    const end = await spotOn(to, toAt)
    await this.pause(120)
    const mouse = this.page.mouse
    await mouse.down()
    await this.page.waitForTimeout(this.quick ? 80 : 200)
    const distance = Math.hypot(end.x - start.x, end.y - start.y)
    const ms = this.quick ? 400 : Math.min(1400, 450 + distance * 0.7)
    for (let t = 16; t < ms; t += 16) {
      const k = ease(t / ms)
      await mouse.move(start.x + (end.x - start.x) * k, start.y + (end.y - start.y) * k)
      await this.page.waitForTimeout(16)
    }
    // Over the drop long enough for it to light up, then a nudge, since some libraries test
    // the target on a move rather than on release.
    await mouse.move(end.x, end.y)
    await this.page.waitForTimeout(this.quick ? 200 : 350)
    await mouse.move(end.x + 1, end.y)
    await mouse.move(end.x, end.y)
    await mouse.up()
    this.x = end.x
    this.y = end.y
  }

  /** Turns the wheel where the pointer is, eased in and out. */
  async scroll(pixels: number): Promise<void> {
    const ticks = 15
    const curve = (t: number) => (1 - Math.cos(Math.PI * t)) / 2
    for (let tick = 0; tick < ticks; tick++) {
      await this.page.mouse.wheel(0, pixels * (curve((tick + 1) / ticks) - curve(tick / ticks)))
      await this.pause(20)
    }
  }
}

/** A point on an element, in page pixels: `at` as fractions of its box, or its middle. */
async function spotOn(target: Locator, at?: Point): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox()
  if (!box) throw new Error('The element has no size on screen.')
  return { x: box.x + box.width * (at?.x ?? 0.5), y: box.y + box.height * (at?.y ?? 0.5) }
}

const ease = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2)

/** Runs in the page: a pointer that follows the mouse, since headless Chromium draws none. */
function drawCursor(svg: string): void {
  const draw = () => {
    const cursor = document.createElement('div')
    cursor.dataset.productDemo = 'pointer'
    cursor.innerHTML = svg
    cursor.style.cssText =
      'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;transform:translate(-100px,-100px)'
    document.documentElement.append(cursor)
    addEventListener(
      'mousemove',
      (e) => (cursor.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`),
      true,
    )
  }
  if (document.documentElement) draw()
  else addEventListener('DOMContentLoaded', draw)
}

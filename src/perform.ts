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

export const VIEWPORT = { width: 1440, height: 900 }

// Rehearse and shoot are the same run: a fresh browser, every step performed at a
// person's pace with a hand-moved pointer, letting the page settle after each.
// Shooting films it; rehearsing leaves a still after every step to judge it by instead.

/** What a rehearsal leaves: a still of the opening screen and after every step. */
export interface Rehearsal {
  film: Film
  stills: { step: string; file: string }[]
  /** Choices made without asking (`just_do_it`), recoveries, and steps that never settled. */
  warnings: string[]
}

/** What a shoot leaves for `cut`: every frame, and where the pointer went, timed from the start. */
export interface Footage {
  film: Film
  /** The film file it was shot from, so a cut can read the film's latest directions. */
  source: string
  frames: { file: string; at: number }[]
  /** Where the pointer was, from each move; the cut draws the cursor along it. */
  pointer: { at: number; x: number; y: number }[]
  /** Where and when the pointer clicked. */
  clicks: { at: number; x: number; y: number }[]
  /** Each key pressed, typing included, and when: the cut plays a key sound for each. */
  keys: { at: number; key: string }[]
  /** The page's address over time, for a browser frame's address bar. */
  addresses: { at: number; url: string }[]
  /** Each line of voiceover, its audio file, and when the shoot started it. */
  lines: { at: number; file: string; text: string }[]
  /** When each highlighted step held, and its element's box in screen pixels. */
  highlights: { step: number; at: number; until: number; box: number[] }[]
  end: number
  /** Choices made without asking (`just_do_it`), recoveries, and steps that never settled. */
  warnings: string[]
}

/** A step that can't go on until someone decides something. Trying again won't help. */
export class NeedsDecision extends Error {}

/** Performs the film without a camera, keeping a still after each step. */
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

/** Performs the film on camera, keeping every frame. */
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
  const { warnings, trail, keys, lines, addresses, highlights } = await perform(film, dir, config, {
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
  // The pointer from where it rested when the camera started: earlier moves count as at 0.
  const since = (t: number) => Math.max(0, (t - started) / 1000)
  const first = trail.findLastIndex((m) => m.t <= started)
  const pointer = trail.slice(Math.max(0, first)).map((m) => ({ at: since(m.t), x: m.x, y: m.y }))
  const clicks = trail
    .filter((m) => m.click && m.t >= started)
    .map((m) => ({ at: since(m.t), x: m.x, y: m.y }))
  const footage: Footage = {
    film,
    source,
    frames,
    pointer,
    clicks,
    keys: keys.filter((k) => k.t >= started).map((k) => ({ at: since(k.t), key: k.key })),
    lines: lines.map((l) => ({ ...l, at: since(l.at) })),
    // The address from the one showing when the camera started.
    addresses: addresses
      .slice(
        Math.max(
          0,
          addresses.findLastIndex((a) => a.t <= started),
        ),
      )
      .map((a) => ({ at: since(a.t), url: a.url })),
    highlights: highlights.map((h) => ({ ...h, at: since(h.at), until: since(h.until) })),
    end,
    warnings,
  }
  await writeFile(join(dir, 'footage.json'), JSON.stringify(footage, null, 2))
  return footage
}

interface Watchers {
  /** Starts filming once the opening screen has settled; returns how to stop, before the browser closes. */
  camera?: (page: Page) => Promise<() => Promise<void>>
  /** Keeps a still of the screen: the opening one (index 0), then after each step. */
  still?: (page: Page, step: string, index: number) => Promise<void>
}

/**
 * One run of the film in a fresh browser. Returns its warnings and the hand's trail; throws
 * at the first step that fails.
 */
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
}> {
  await mkdir(dir, { recursive: true })
  // The lines are spoken first: the shoot is paced by them.
  const given = Object.fromEntries(Object.entries(film.voice ?? {}).filter(([, v]) => v))
  const spoken = await speakLines(
    film.steps.flatMap((s) => (s.say ? [s.say] : [])),
    { ...config.voice, ...given },
  )
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    const settler = watch(page)
    // Every address the page shows, a link followed or a route changed in place.
    const addresses: { t: number; url: string }[] = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) addresses.push({ t: performance.now(), url: frame.url() })
    })
    await page.goto(film.app)
    const hand = new Hand(page)
    await hand.rest(VIEWPORT.width / 2, VIEWPORT.height / 2)
    await settler.settled({ beat: 400 })
    const stopCamera = await watchers.camera?.(page)
    await watchers.still?.(page, 'the opening screen', 0)

    const warnings: string[] = []
    const highlights: Footage['highlights'] = []
    const lines: Footage['lines'] = []
    // The line being spoken, and when it started.
    let line: { spoken: Spoken; at: number } | undefined
    for (const [index, step] of film.steps.entries()) {
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
        // An action with a word lands on it: the hand arrives early and presses as it's said.
        hand.due = undefined
        if (step.on) {
          if (!line) throw new Error(`"on" needs a line: give this step or one before it "say".`)
          const word = wordAt(line.spoken, step.on)
          if (word === undefined) throw new Error(`"${step.on}" isn't in "${line.spoken.text}".`)
          hand.due = line.at + word * 1000
        }
        hand.landed = undefined
        // A highlight comes on before its action, so the action happens inside it.
        const lit = step.highlight ? await highlightOn(page, step, finder) : undefined
        await settler.mark()
        await act(page, hand, film.app, step, finder)
        // Late on its word: the line gave the action too little time after the one before it.
        if (hand.due !== undefined && step.on && hand.landed !== undefined) {
          const late = (hand.landed - hand.due) / 1000
          if (late > 0.2) {
            warnings.push(
              `${label}: landed ${late.toFixed(1)}s after "${step.on}" was said. Give it more words before it, or less to do before it.`,
            )
          }
        }
        hand.due = undefined
        // Within a line, the voice paces the film: only the page is waited for, not a beat too.
        const next = film.steps[index + 1]
        const carriesOn = Boolean(line && next?.on && !next.say)
        const settled = await settler.settled({ beat: carriesOn ? 0 : 400 })
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
        // A line finishes before the film moves on, unless the next step lands on one of its words.
        if (line && !carriesOn) {
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
    return { warnings, trail: hand.trail, keys: hand.keys, lines, addresses, highlights }
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
  if ('visit' in step || 'wait' in step) await hand.onTime()
  if ('visit' in step) {
    await page.goto(new URL(step.visit, app).href)
    await hand.rest(hand.x, hand.y)
  } else if ('click' in step) {
    await hand.click(await find(step.click), step)
  } else if ('fill' in step) {
    // On a word, the typing starts on it: the field is clicked a beat before.
    const due = hand.due
    if (due !== undefined) hand.due = due - 400
    await hand.click(await find(step.fill))
    hand.due = due
    hand.landed = undefined
    await fill(page, hand, step.text)
  } else if ('select' in step) {
    // A native select's list is drawn outside the page and swallows the next click, so the
    // hand goes to it and the option is chosen by its label, as Playwright's selectOption does.
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

/**
 * Turns a step's highlight on: the box of its element (or the box it gives), measured before
 * the action, and a moment for the cut to zoom in. The time is the clock's; the shoot makes
 * it the video's.
 */
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
  const at = performance.now()
  // Time for the cut to zoom in before anything moves.
  await page.waitForTimeout(600)
  return { at, box }
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
  await hand.type(text)
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
  /** Every move and click, with its time, for the cut to draw the cursor from. */
  trail: { t: number; x: number; y: number; click?: true }[] = []
  /** When the action must land, on a word of the voiceover; the hand arrives early and waits. */
  due: number | undefined
  /** Each key pressed and when, for the cut's key sounds. */
  keys: { t: number; key: string }[] = []
  constructor(page: Page, quick = false) {
    this.page = page
    this.quick = quick
  }

  async pause(ms: number): Promise<void> {
    if (!this.quick) await this.page.waitForTimeout(ms)
  }

  /** Puts the pointer somewhere without travelling. */
  async rest(x: number, y: number): Promise<void> {
    await this.move(x, y)
  }

  /** Moves the mouse, and keeps the move in the trail. */
  private async move(x: number, y: number): Promise<void> {
    await this.page.mouse.move(x, y)
    if (!this.quick) this.trail.push({ t: performance.now(), x, y })
    this.x = x
    this.y = y
  }

  /** When the action due on a word actually landed. */
  landed: number | undefined

  /** Waits for the moment the action is due, if it has one, and notes when it lands. */
  async onTime(): Promise<void> {
    const wait = this.due === undefined ? 0 : this.due - performance.now()
    if (wait > 0) await this.page.waitForTimeout(wait)
    if (this.due !== undefined) this.landed ??= performance.now()
  }

  /** How long a glide to there takes, in ms: longer for further, up to 0.9s. */
  travel(x: number, y: number): number {
    return Math.min(900, 250 + Math.hypot(x - this.x, y - this.y) * 0.5)
  }

  async glide(x: number, y: number): Promise<void> {
    if (this.quick) return this.rest(x, y)
    const fromX = this.x
    const fromY = this.y
    const ms = this.travel(x, y)
    for (let t = 0; t <= ms; t += 16) {
      const k = ease(t / ms)
      await this.move(fromX + (x - fromX) * k, fromY + (y - fromY) * k)
      await this.page.waitForTimeout(16)
    }
    await this.rest(x, y)
  }

  /** Moves onto an element, to a point on it (its middle unless told). */
  async reach(target: Locator, at?: Point): Promise<{ x: number; y: number }> {
    const spot = await spotOn(target, at)
    // Due on a word: set off so as to arrive a moment before it.
    if (this.due !== undefined) {
      const wait = this.due - performance.now() - this.travel(spot.x, spot.y) - 250
      if (wait > 0) await this.page.waitForTimeout(wait)
    }
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
    await this.onTime()
    const button = how.right ? 'right' : 'left'
    const held = how.modifiers ?? []
    for (const key of held) await this.page.keyboard.down(key)
    try {
      // Two presses, the second counted as such, so the page hears the dblclick a person makes.
      const presses = how.double ? 2 : 1
      for (let clickCount = 1; clickCount <= presses; clickCount++) {
        await this.page.mouse.down({ button, clickCount })
        if (!this.quick)
          this.trail.push({ t: performance.now(), x: this.x, y: this.y, click: true })
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
    await this.onTime()
    const mouse = this.page.mouse
    await mouse.down()
    await this.page.waitForTimeout(this.quick ? 80 : 200)
    const distance = Math.hypot(end.x - start.x, end.y - start.y)
    const ms = this.quick ? 400 : Math.min(1400, 450 + distance * 0.7)
    for (let t = 16; t < ms; t += 16) {
      const k = ease(t / ms)
      await this.move(start.x + (end.x - start.x) * k, start.y + (end.y - start.y) * k)
      await this.page.waitForTimeout(16)
    }
    // Over the drop long enough for it to light up, then a nudge, since some libraries test
    // the target on a move rather than on release.
    await this.move(end.x, end.y)
    await this.page.waitForTimeout(this.quick ? 200 : 350)
    await mouse.move(end.x + 1, end.y)
    await this.move(end.x, end.y)
    await mouse.up()
  }

  /** Types at a person's pace and rhythm, a key at a time, keeping when each was pressed. */
  async type(text: string): Promise<void> {
    if (this.quick) return this.page.keyboard.type(text)
    await this.onTime()
    for (const character of text) {
      await this.page.keyboard.type(character)
      this.keys.push({ t: performance.now(), key: character })
      // Uneven, as a person types: a beat longer after a space.
      await this.page.waitForTimeout(55 + Math.random() * 60 + (character === ' ' ? 40 : 0))
    }
  }

  /** Presses a key or a combination, like Enter or Meta+K. */
  async key(key: string): Promise<void> {
    await this.onTime()
    await this.page.keyboard.press(key)
    if (!this.quick) this.keys.push({ t: performance.now(), key })
  }

  /** Turns the wheel where the pointer is, eased in and out. */
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

/** A point on an element, in page pixels: `at` as fractions of its box, or its middle. */
async function spotOn(target: Locator, at?: Point): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox()
  if (!box) throw new Error('The element has no size on screen.')
  return { x: box.x + box.width * (at?.x ?? 0.5), y: box.y + box.height * (at?.y ?? 0.5) }
}

const ease = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2)

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright-core'
import type { Config } from './config.ts'
import { checkEffect, settle } from './effect.ts'
import { describeStep, type Film, type Step, type Target } from './film.ts'
import { decide, fingerprint, rank } from './similo.ts'
import { launchBrowser } from './tools.ts'

export const VIEWPORT = { width: 1440, height: 900 }

/** What `record` leaves for `cut`: the film it performed and every frame, timed from the start. */
export interface Footage {
  film: Film
  frames: { file: string; at: number }[]
  end: number
  /** Choices made without asking (`just_do_it`), and recoveries, step by step. */
  notes: string[]
}

const CURSOR = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M3 2l17 11.5-7.4 1.4 4.3 8.2-3.2 1.6-4.3-8.3L3 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`

export async function record(film: Film, out: string, config: Config): Promise<Footage> {
  await rm(out, { recursive: true, force: true })
  await mkdir(join(out, 'frames'), { recursive: true })

  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.addInitScript(drawCursor, CURSOR)
    await page.goto(film.app)
    const hand = new Hand(page)
    await hand.rest(VIEWPORT.width / 2, VIEWPORT.height / 2)
    await settle(page, 400)

    const frames: Footage['frames'] = []
    const writes: Promise<void>[] = []
    const start = performance.now()
    const now = () => (performance.now() - start) / 1000
    const session = await page.context().newCDPSession(page)
    session.on('Page.screencastFrame', (event) => {
      void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {})
      const file = join('frames', `${String(frames.length).padStart(6, '0')}.jpg`)
      frames.push({ file, at: now() })
      writes.push(writeFile(join(out, file), Buffer.from(event.data, 'base64')))
    })
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 90,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
    })

    const notes: string[] = []
    for (const [index, step] of film.steps.entries()) {
      const label = `Step ${index + 1} (${describeStep(step)})`
      const finder: Finder = (target) =>
        find(page, target, config, (note) => notes.push(`${label}: ${note}`))
      try {
        await perform(page, hand, film.app, step, finder)
        await settle(page, 400)
        if (step.effect) await checkEffect(page, step.effect)
      } catch (error) {
        await page.screenshot({ path: join(out, 'failed.png') })
        const why = error instanceof Error ? error.message : String(error)
        throw new Error(`${label} failed: ${why}\nThe screen is in ${join(out, 'failed.png')}`)
      }
    }

    const end = now()
    await session.send('Page.stopScreencast')
    await Promise.all(writes)
    const footage: Footage = { film, frames, end, notes }
    await writeFile(join(out, 'footage.json'), JSON.stringify(footage, null, 2))
    return footage
  } finally {
    await browser.close()
  }
}

type Finder = (target: Target) => Promise<Locator>

async function perform(
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
    await hand.press(await find(step.click))
  } else if ('fill' in step) {
    await hand.press(await find(step.fill))
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type(step.text, { delay: 70 })
  } else if ('press' in step) {
    await page.keyboard.press(step.press)
  } else if ('scroll' in step) {
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, step.scroll === 'down' ? 50 : -50)
      await page.waitForTimeout(16)
    }
  } else if (typeof step.wait === 'number') {
    await page.waitForTimeout(step.wait * 1000)
  } else {
    await page.getByText(step.wait.text).first().waitFor({ timeout: 30_000 })
  }
}

/**
 * The element a target names. A pinned target's locator first; when it matches nothing or
 * more than one, its Similo fingerprint. When two elements are equally likely, `ask` stops
 * so the agent can ask the user, and `just_do_it` takes the best and notes it.
 */
async function find(
  page: Page,
  target: Target,
  config: Config,
  note: (note: string) => void,
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
  throw new Error(
    `${candidates.length} elements match it:\n${listed.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}\n` +
      'Ask the user which one they meant, then pin it with `product-demo explore`.',
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
class Hand {
  x = 0
  y = 0
  page: Page
  constructor(page: Page) {
    this.page = page
  }

  /** Puts the pointer somewhere without travelling, so the page draws it there. */
  async rest(x: number, y: number): Promise<void> {
    await this.page.mouse.move(x, y)
    this.x = x
    this.y = y
  }

  async glide(x: number, y: number): Promise<void> {
    const fromX = this.x
    const fromY = this.y
    const distance = Math.hypot(x - fromX, y - fromY)
    const ms = Math.min(900, 250 + distance * 0.5)
    for (let t = 0; t <= ms; t += 16) {
      const k = ease(t / ms)
      await this.page.mouse.move(fromX + (x - fromX) * k, fromY + (y - fromY) * k)
      await this.page.waitForTimeout(16)
    }
    await this.page.mouse.move(x, y)
    this.x = x
    this.y = y
  }

  async press(target: Locator): Promise<void> {
    const box = await target.boundingBox()
    if (!box) throw new Error('The element has no size on screen.')
    await this.glide(box.x + box.width / 2, box.y + box.height / 2)
    await this.page.waitForTimeout(120)
    await this.page.mouse.down()
    await this.page.waitForTimeout(80)
    await this.page.mouse.up()
  }
}

const ease = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2)

/** Runs in the page: a pointer that follows the mouse, since headless Chromium draws none. */
function drawCursor(svg: string): void {
  const draw = () => {
    const cursor = document.createElement('div')
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

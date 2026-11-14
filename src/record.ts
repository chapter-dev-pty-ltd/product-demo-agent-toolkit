import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Locator, type Page } from 'playwright-core'
import type { Film, Step, Target } from './film.ts'

export const VIEWPORT = { width: 1440, height: 900 }

/** What `record` leaves for `cut`: the film it performed and every frame, timed from the start. */
export interface Footage {
  film: Film
  frames: { file: string; at: number }[]
  end: number
}

const CURSOR = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26"><path d="M3 2l17 11.5-7.4 1.4 4.3 8.2-3.2 1.6-4.3-8.3L3 21z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`

export async function record(film: Film, out: string): Promise<Footage> {
  await rm(out, { recursive: true, force: true })
  await mkdir(join(out, 'frames'), { recursive: true })

  const browser = await chromium.launch().catch((error: unknown) => {
    throw new Error(
      `Could not start Chromium. Run: npx playwright-core install chromium-headless-shell\n${String(error)}`,
    )
  })
  try {
    const page = await browser.newPage({ viewport: VIEWPORT })
    await page.addInitScript(drawCursor, CURSOR)
    await page.goto(film.app)
    const hand = new Hand(page)
    await hand.rest(VIEWPORT.width / 2, VIEWPORT.height / 2)
    await settle(page)

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

    for (const [index, step] of film.steps.entries()) {
      try {
        await perform(page, hand, film.app, step)
      } catch (error) {
        await page.screenshot({ path: join(out, 'failed.png') })
        throw new Error(
          `Step ${index + 1} failed: ${JSON.stringify(step)}\n${String(error)}\nThe screen is in ${join(out, 'failed.png')}`,
        )
      }
      await settle(page)
    }

    const end = now()
    await session.send('Page.stopScreencast')
    await Promise.all(writes)
    const footage: Footage = { film, frames, end }
    await writeFile(join(out, 'footage.json'), JSON.stringify(footage, null, 2))
    return footage
  } finally {
    await browser.close()
  }
}

async function perform(page: Page, hand: Hand, app: string, step: Step): Promise<void> {
  if ('visit' in step) {
    await page.goto(new URL(step.visit, app).href)
    await hand.rest(hand.x, hand.y)
  } else if ('click' in step) {
    await hand.press(await find(page, step.click))
  } else if ('fill' in step) {
    await hand.press(await find(page, step.fill))
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

async function find(page: Page, target: Target): Promise<Locator> {
  const locator =
    'role' in target
      ? page.locator(`role=${target.role}[name=${JSON.stringify(target.name)}]`)
      : 'text' in target
        ? page.getByText(target.text)
        : page.locator(target.css)
  const first = locator.first()
  await first.waitFor({ state: 'visible', timeout: 10_000 })
  await first.scrollIntoViewIfNeeded()
  return first
}

/** Lets the page finish what the last step started, and gives the viewer a beat to see it. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(600)
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

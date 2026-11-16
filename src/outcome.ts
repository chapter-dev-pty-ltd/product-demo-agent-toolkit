import type { Page } from 'playwright-core'
import { findDrawn, missingDrawn, type Drawn } from './drawn.ts'
import type { Outcome } from './film.ts'

// A step's outcome: what it changed on the page. `explore` writes down where the page went
// and a line of text that appeared; rehearse and shoot check the same step changes the same
// things, so a step that pressed the wrong element fails instead of filming the wrong thing.
//
// Only the page's content counts as "appeared": a heading first, else a line of text. What
// floats over the page (a fundraising banner, a toast, a cookie bar, a dialog) comes and goes
// on its own, so a check against it fails runs that did nothing wrong.
//
// On a canvas-like surface a step changes no text, so what's drawn there is written down
// too (drawn.ts), and checked the same way.

export interface Before {
  url: string
  content: Content
  drawn: Drawn[]
}

interface Content {
  headings: string[]
  lines: string[]
}

const address = (url: string) => {
  const u = new URL(url)
  return `${u.pathname}${u.search}${u.hash}`
}

const contentOf = (page: Page): Promise<Content> =>
  page.evaluate(readContent).catch(() => ({ headings: [], lines: [] }))

/** The page as it is before a step: its address and its content. */
export async function before(page: Page): Promise<Before> {
  return { url: page.url(), content: await contentOf(page), drawn: await findDrawn(page) }
}

/** What changed since `before`: where the page went, and a new heading or line of content. */
export async function outcomeSince(page: Page, was: Before): Promise<Outcome | undefined> {
  const outcome: Outcome = {}
  const now = await contentOf(page)
  if (page.url() !== was.url) outcome.url = address(page.url())
  const fresh = (seen: string[]) => (text: string) =>
    !seen.includes(text) && text.length >= 3 && text.length <= 80
  const appeared =
    now.headings.find(fresh(was.content.headings)) ?? now.lines.find(fresh(was.content.lines))
  if (appeared) outcome.appeared = appeared
  const drawn = await findDrawn(page)
  const boxes = (all: Drawn[]) => all.map((d) => [d.x, d.y, d.width, d.height])
  const changed =
    drawn.length !== was.drawn.length ||
    missingDrawn(boxes(drawn), was.drawn) ||
    missingDrawn(boxes(was.drawn), drawn)
  if (changed) outcome.drawn = boxes(drawn)
  return outcome.url || outcome.appeared || outcome.drawn ? outcome : undefined
}

/**
 * Checks the page shows what the step changed when it was explored. A different address
 * throws. Missing text throws too, unless the address or the drawing already matched: then
 * the step plainly did what it should, and the text is returned as a warning instead. A
 * drawing that doesn't match is a warning.
 */
export async function checkOutcome(
  page: Page,
  outcome: Outcome,
  pointer?: { x: number; y: number },
): Promise<string | undefined> {
  if (outcome.url) {
    const expected = outcome.url
    await page
      .waitForURL((url) => address(url.href) === expected, { timeout: 5000 })
      .catch(() => {
        throw new Error(
          `It went to ${address(page.url())}, but when explored it went to ${expected}.`,
        )
      })
  }
  // The drawing is checked before the text: when it matches, the step plainly did its job.
  const drawing = outcome.drawn && missingDrawn(outcome.drawn, await findDrawn(page, pointer))
  const drew = outcome.drawn && !drawing
  if (outcome.appeared) {
    const shown = await page
      .getByText(outcome.appeared, { exact: true })
      .first()
      // Already on the right page, the text has had its chance; on camera, waiting is a still.
      .waitFor({ timeout: outcome.url || drew ? 1500 : 5000 })
      .then(() => true)
      .catch(() => false)
    if (!shown) {
      const missing = `"${outcome.appeared}" never appeared, as it did when explored.`
      if (outcome.url)
        return `${missing} The page is the right one (${outcome.url}), so it went on.`
      if (drew) return `${missing} The canvas looks as it did when explored, so it went on.`
      throw new Error(missing)
    }
  }
  if (drawing) {
    return `The canvas doesn't look as it did when explored: nothing is drawn at ${drawing.join(',')} (x,y,width,height).`
  }
  return undefined
}

/** Runs in the page: its headings and lines of text, leaving out what floats over it. */
function readContent(): Content {
  const floats = (el: Element) => {
    if (
      el.closest('dialog,[role=dialog],[role=alertdialog],aside,[role=complementary],[aria-live]')
    ) {
      return true
    }
    for (let node: Element | null = el; node; node = node.parentElement) {
      const position = getComputedStyle(node).position
      if (position === 'fixed' || position === 'sticky') return true
    }
    return false
  }
  const shown = (el: Element) => el.checkVisibility() && !floats(el)
  const clean = (text: string) => text.replace(/\s+/g, ' ').trim()
  const root = document.querySelector('main,[role=main]') ?? document.body
  const headings = Array.from(root.querySelectorAll('h1,h2,h3,[role=heading]'))
    .filter(shown)
    .map((el) => clean(el.textContent ?? ''))
    .filter(Boolean)
  const lines: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    const text = clean(node.textContent ?? '')
    if (text && parent && shown(parent)) lines.push(text)
  }
  return { headings, lines }
}

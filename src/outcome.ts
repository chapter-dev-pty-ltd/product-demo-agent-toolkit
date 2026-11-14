import type { Page } from 'playwright-core'
import type { Outcome } from './film.ts'

// A step's outcome: what it changed on the page. `explore` writes down where the page went
// and a line of text that appeared; `record` checks the same step changes the same things,
// so a step that pressed the wrong element fails instead of filming the wrong thing.

export interface Before {
  url: string
  lines: Set<string>
}

const address = (url: string) => {
  const u = new URL(url)
  return `${u.pathname}${u.search}${u.hash}`
}

const linesOf = async (page: Page) =>
  (
    await page
      .locator('body')
      .innerText()
      .catch(() => '')
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/** The page as it is before a step: its address and its lines of text. */
export async function before(page: Page): Promise<Before> {
  return { url: page.url(), lines: new Set(await linesOf(page)) }
}

/** What changed since `before`: where the page went, and the first new line of text. */
export async function outcomeSince(page: Page, was: Before): Promise<Outcome | undefined> {
  const outcome: Outcome = {}
  const lines = await linesOf(page)
  if (page.url() !== was.url) outcome.url = address(page.url())
  const appeared = lines.find(
    (line) => !was.lines.has(line) && line.length >= 3 && line.length <= 80,
  )
  if (appeared) outcome.appeared = appeared
  return outcome.url || outcome.appeared ? outcome : undefined
}

/** Throws when the page doesn't show what the step changed when it was explored. */
export async function checkOutcome(page: Page, outcome: Outcome): Promise<void> {
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
  if (outcome.appeared) {
    await page
      .getByText(outcome.appeared, { exact: true })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {
        throw new Error(`"${outcome.appeared}" never appeared, as it did when explored.`)
      })
  }
}

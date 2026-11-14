import type { Page } from 'playwright-core'
import type { Effect } from './film.ts'

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

/**
 * Waits for the page to finish what the last action started. An action that navigates
 * (Enter in a search box) only starts doing so a moment later, so wait for that moment
 * before asking whether the page is idle.
 */
export async function settle(page: Page, beat: number): Promise<void> {
  await page.waitForTimeout(250)
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(beat)
}

export async function before(page: Page): Promise<Before> {
  return { url: page.url(), lines: new Set(await linesOf(page)) }
}

/** What changed since `before`: where the page went, and the first new line of text. */
export async function effectSince(page: Page, was: Before): Promise<Effect | undefined> {
  const effect: Effect = {}
  const lines = await linesOf(page)
  if (page.url() !== was.url) effect.url = address(page.url())
  const appeared = lines.find(
    (line) => !was.lines.has(line) && line.length >= 3 && line.length <= 80,
  )
  if (appeared) effect.appeared = appeared
  return effect.url || effect.appeared ? effect : undefined
}

/** Throws when the page doesn't show what the step did when it was explored. */
export async function checkEffect(page: Page, effect: Effect): Promise<void> {
  if (effect.url) {
    const expected = effect.url
    await page
      .waitForURL((url) => address(url.href) === expected, { timeout: 5000 })
      .catch(() => {
        throw new Error(
          `It went to ${address(page.url())}, but when explored it went to ${expected}.`,
        )
      })
  }
  if (effect.appeared) {
    await page
      .getByText(effect.appeared, { exact: true })
      .first()
      .waitFor({ timeout: 5000 })
      .catch(() => {
        throw new Error(`"${effect.appeared}" never appeared, as it did when explored.`)
      })
  }
}

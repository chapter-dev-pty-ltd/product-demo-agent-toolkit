import type { Locator, Page } from 'playwright-core'

// Similo: find the same element again by how alike it is to the one recorded, not by
// one selector. Nass et al., "Similarity-based Web Element Localization for Robust
// Test Automation", ACM TOSEM 32(3), 2023.

/** What Similo writes down about an element. */
export interface Fingerprint {
  tag: string
  id: string
  name: string
  className: string
  href: string
  alt: string
  text: string
  /**
   * The words of the closest container that says more than it does: its row, card or
   * paragraph. The paper uses text within 50px, which in a list is the rows above and below.
   */
  neighbours: string
  xpath: string
  /** The XPath from the nearest ancestor with an id. */
  idXpath: string
  isButton: boolean
  /** Its box in page coordinates, so scrolling doesn't move it. */
  x: number
  y: number
  width: number
  height: number
}

/** The paper's weights: what an element is and says count three times what its shape does. */
const WEIGHTS = {
  tag: 1.5,
  id: 1.5,
  name: 1.5,
  text: 1.5,
  neighbours: 1.5,
  className: 0.5,
  href: 0.5,
  alt: 0.5,
  xpath: 0.5,
  idXpath: 0.5,
  isButton: 0.5,
  location: 0.5,
  area: 0.5,
  shape: 0.5,
}

/** How alike two elements are, from 0 to 1. Only what the recorded element had counts. */
export function similarity(target: Fingerprint, candidate: Fingerprint): number {
  const parts: [weight: number, score: number][] = [
    [WEIGHTS.tag, same(target.tag, candidate.tag)],
    [WEIGHTS.isButton, same(target.isButton, candidate.isButton)],
    [WEIGHTS.location, closeness(target, candidate)],
    [WEIGHTS.area, ratio(target.width * target.height, candidate.width * candidate.height)],
    [
      WEIGHTS.shape,
      ratio(target.width / (target.height || 1), candidate.width / (candidate.height || 1)),
    ],
    [WEIGHTS.xpath, steps(target.xpath, candidate.xpath)],
  ]
  const ifPresent = (weight: number, value: string, score: () => number) => {
    if (value) parts.push([weight, score()])
  }
  ifPresent(WEIGHTS.id, target.id, () => same(target.id, candidate.id))
  ifPresent(WEIGHTS.name, target.name, () => same(target.name, candidate.name))
  ifPresent(WEIGHTS.href, target.href, () => same(target.href, candidate.href))
  ifPresent(WEIGHTS.alt, target.alt, () => same(target.alt, candidate.alt))
  ifPresent(WEIGHTS.text, target.text, () => words(target.text, candidate.text))
  ifPresent(WEIGHTS.neighbours, target.neighbours, () =>
    words(target.neighbours, candidate.neighbours),
  )
  ifPresent(WEIGHTS.className, target.className, () => words(target.className, candidate.className))
  ifPresent(WEIGHTS.idXpath, target.idXpath, () => steps(target.idXpath, candidate.idXpath))

  const total = parts.reduce((sum, [weight]) => sum + weight, 0)
  return parts.reduce((sum, [weight, score]) => sum + weight * score, 0) / total
}

const same = <T>(a: T, b: T) => (a === b ? 1 : 0)

const ratio = (a: number, b: number) =>
  a <= 0 || b <= 0 ? same(a, b) : Math.min(a, b) / Math.max(a, b)

/** 1 in the same place, falling to 0 at 200px away. */
const closeness = (a: Fingerprint, b: Fingerprint) =>
  Math.max(0, 1 - Math.hypot(a.x - b.x, a.y - b.y) / 200)

/** Word overlap, with every number read as the same number: "Inbox 6" is "Inbox 7". */
function words(a: string, b: string): number {
  const bag = (s: string) =>
    new Set(s.toLowerCase().replace(/\d+/g, '#').split(/\s+/).filter(Boolean))
  const x = bag(a)
  const y = bag(b)
  if (x.size === 0 && y.size === 0) return 1
  let shared = 0
  for (const word of x) if (y.has(word)) shared++
  return shared / (x.size + y.size - shared)
}

/** How alike two XPaths are, step by step (edit distance over their steps). */
function steps(a: string, b: string): number {
  const x = a.split('/').filter(Boolean)
  const y = b.split('/').filter(Boolean)
  const longest = Math.max(x.length, y.length)
  if (longest === 0) return 1
  let row = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const next = [i]
    for (let j = 1; j <= y.length; j++) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1),
      )
    }
    row = next
  }
  return 1 - (row[y.length] ?? longest) / longest
}

export async function fingerprint(element: Locator): Promise<Fingerprint> {
  const [found] = await element.evaluate(describe, { mark: '' })
  if (!found) throw new Error('The element is not visible, so it cannot be fingerprinted.')
  return found
}

export interface Candidate {
  locator: Locator
  fingerprint: Fingerprint
  score: number
}

/** Every visible element worth comparing, best match first. */
export async function rank(page: Page, target: Fingerprint): Promise<Candidate[]> {
  const mark = `pd-${Math.random().toString(36).slice(2)}`
  const found = await page.locator('body').evaluate(describe, { mark, tag: target.tag })
  return found
    .map((print, i) => ({
      locator: page.locator(`[data-${mark}="${i}"]`),
      fingerprint: print,
      score: similarity(target, print),
    }))
    .sort((a, b) => b.score - a.score)
}

/** Below this, nothing on the page is the element. Calibrated in similo.test.ts. */
export const MIN_SCORE = 0.7
/** The best must lead the runner-up by this much, or the two can't be told apart. */
export const MIN_LEAD = 0.1

export type Decision =
  { found: Candidate } | { ambiguous: Candidate[] } | { missing: Candidate | undefined }

/** Whether a ranking names one element, can't choose between several, or found none. */
export function decide(ranked: Candidate[]): Decision {
  const [best, second] = ranked
  if (!best || best.score < MIN_SCORE) return { missing: best }
  if (second && best.score - second.score < MIN_LEAD) {
    return { ambiguous: ranked.filter((c) => best.score - c.score < MIN_LEAD) }
  }
  return { found: best }
}

/**
 * Runs in the page. Given one element and no mark, describes that element. Given the
 * body and a mark, describes every visible element of the target's tag or that can be
 * pressed, and marks each with its index so it can be found again.
 */
function describe(root: Element, options: { mark: string; tag?: string }): Fingerprint[] {
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden'
  }
  const pressable = (el: Element) =>
    el.matches('a,button,input,select,textarea,summary,label,[role],[onclick],[tabindex]')
  const textOf = (el: Element) =>
    ((el instanceof HTMLElement ? el.innerText : el.textContent) ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)

  const xpathOf = (el: Element, stopAtId: boolean): string => {
    const path: string[] = []
    for (
      let node: Element | null = el;
      node && node !== document.documentElement;
      node = node.parentElement
    ) {
      if (stopAtId && node !== el && node.id) return `//*[@id="${node.id}"]/${path.join('/')}`
      const tag = node.tagName.toLowerCase()
      const index =
        Array.from(node.parentElement?.children ?? [])
          .filter((s) => s.tagName === node?.tagName)
          .indexOf(node) + 1
      path.unshift(`${tag}[${index}]`)
    }
    return stopAtId ? '' : `/html/${path.join('/')}`
  }

  const neighboursOf = (el: Element) => {
    const own = textOf(el)
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const text = textOf(node)
      if (text !== own) return text
    }
    return ''
  }

  const print = (el: Element): Fingerprint => {
    const box = el.getBoundingClientRect()
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id,
      name: el.getAttribute('name') ?? '',
      className: typeof el.className === 'string' ? el.className : '',
      href: el.getAttribute('href') ?? '',
      alt: el.getAttribute('alt') ?? '',
      text: textOf(el),
      neighbours: neighboursOf(el),
      xpath: xpathOf(el, false),
      idXpath: xpathOf(el, true),
      isButton:
        el.tagName === 'BUTTON' ||
        el.getAttribute('role') === 'button' ||
        (el instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(el.type)),
      x: box.left + scrollX,
      y: box.top + scrollY,
      width: box.width,
      height: box.height,
    }
  }

  if (!options.mark) return visible(root) ? [print(root)] : []
  const found: Fingerprint[] = []
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    if (!visible(el)) continue
    if (el.tagName.toLowerCase() !== options.tag && !pressable(el)) continue
    el.setAttribute(`data-${options.mark}`, String(found.length))
    found.push(print(el))
  }
  return found
}

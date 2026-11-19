import type { Locator, Page } from 'playwright-core'

export interface Fingerprint {
  tag: string
  role: string
  id: string
  testId: string
  name: string
  type: string
  className: string
  href: string
  alt: string
  text: string
  label: string
  neighbours: string
  xpath: string
  idXpath: string
  isButton: boolean
  x: number
  y: number
  width: number
  height: number
}

const WEIGHTS = {
  tag: 1.5,
  id: 1.5,
  testId: 1.5,
  name: 1.5,
  text: 1.5,
  label: 1.5,
  neighbours: 2.5,
  role: 1,
  type: 0.5,
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
  ifPresent(WEIGHTS.role, target.role, () => same(target.role, candidate.role))
  ifPresent(WEIGHTS.id, target.id, () => same(target.id, candidate.id))
  ifPresent(WEIGHTS.testId, target.testId, () => same(target.testId, candidate.testId))
  ifPresent(WEIGHTS.name, target.name, () => same(target.name, candidate.name))
  ifPresent(WEIGHTS.type, target.type, () => same(target.type, candidate.type))
  ifPresent(WEIGHTS.href, target.href, () => same(target.href, candidate.href))
  ifPresent(WEIGHTS.alt, target.alt, () => same(target.alt, candidate.alt))
  ifPresent(WEIGHTS.text, target.text, () => words(target.text, candidate.text))
  ifPresent(WEIGHTS.label, target.label, () => words(target.label, candidate.label))
  ifPresent(
    WEIGHTS.neighbours,
    target.neighbours,
    () => words(target.neighbours, candidate.neighbours, { numbers: true }) ** 2,
  )
  ifPresent(WEIGHTS.className, target.className, () =>
    words(unhashed(target.className), unhashed(candidate.className)),
  )
  ifPresent(WEIGHTS.idXpath, target.idXpath, () => steps(target.idXpath, candidate.idXpath))

  const total = parts.reduce((sum, [weight]) => sum + weight, 0)
  const score = parts.reduce((sum, [weight, part]) => sum + weight * part, 0) / total
  return saysSomethingElse(target, candidate) ? score / 2 : score
}

function saysSomethingElse(target: Fingerprint, candidate: Fingerprint): boolean {
  if (target.id && target.id === candidate.id) return false
  if (target.testId && target.testId === candidate.testId) return false
  const said = [
    [target.text, candidate.text],
    [target.label, candidate.label],
  ].filter(([recorded]) => recorded)
  return said.length > 0 && said.every(([recorded = '', now = '']) => words(recorded, now) === 0)
}

const same = <T>(a: T, b: T) => (a === b ? 1 : 0)

const ratio = (a: number, b: number) =>
  a <= 0 || b <= 0 ? same(a, b) : Math.min(a, b) / Math.max(a, b)

const closeness = (a: Fingerprint, b: Fingerprint) =>
  Math.max(0, 1 - Math.hypot(a.x - b.x, a.y - b.y) / 200)

const unhashed = (classes: string) =>
  classes
    .split(/\s+/)
    .map((name) =>
      name.replace(/(?:[-_]{1,2}[a-zA-Z0-9]{4,})+$/, (hash) => (/\d/.test(hash) ? '' : hash)),
    )
    .join(' ')

function words(a: string, b: string, { numbers = false } = {}): number {
  const bag = (s: string) =>
    new Set((numbers ? s : s.replace(/\d+/g, '#')).toLowerCase().split(/\s+/).filter(Boolean))
  const x = bag(a)
  const y = bag(b)
  if (x.size === 0 && y.size === 0) return 1
  let shared = 0
  for (const word of x) if (y.has(word)) shared++
  return shared / (x.size + y.size - shared)
}

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

export const MIN_SCORE = 0.7
export const MIN_LEAD = 0.1

export type Decision =
  { found: Candidate } | { ambiguous: Candidate[] } | { missing: Candidate | undefined }

export function decide(ranked: Candidate[]): Decision {
  const [best, second] = ranked
  if (!best || best.score < MIN_SCORE) return { missing: best }
  if (second && best.score - second.score < MIN_LEAD) {
    return { ambiguous: ranked.filter((c) => best.score - c.score < MIN_LEAD) }
  }
  return { found: best }
}

function describe(root: Element, options: { mark: string; tag?: string }): Fingerprint[] {
  const parentOf = (el: Element): Element | null => {
    if (el.parentElement) return el.parentElement
    const home = el.getRootNode()
    return home instanceof ShadowRoot ? home.host : null
  }
  const visible = (el: Element) => {
    const box = el.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return false
    if (!el.checkVisibility({ visibilityProperty: true })) return false
    let parent = parentOf(el)
    while (parent && getComputedStyle(parent).display === 'contents') parent = parentOf(parent)
    if (parent && !parent.checkVisibility({ opacityProperty: true })) return false
    return el instanceof HTMLInputElement || getComputedStyle(el).opacity !== '0'
  }
  const pressable = (el: Element) =>
    el.matches('a,button,input,select,textarea,summary,label,[role],[onclick],[tabindex]')
  const clean = (text: string | null | undefined) =>
    (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const textOf = (el: Element) => clean(el instanceof HTMLElement ? el.innerText : el.textContent)

  const IMPLIED: Record<string, string> = {
    A: 'link',
    BUTTON: 'button',
    SELECT: 'combobox',
    TEXTAREA: 'textbox',
    H1: 'heading',
    H2: 'heading',
    H3: 'heading',
    H4: 'heading',
    IMG: 'img',
    NAV: 'navigation',
    LI: 'listitem',
    TR: 'row',
    TD: 'cell',
  }
  const roleOf = (el: Element) => {
    const given = el.getAttribute('role')
    if (given) return given
    if (el instanceof HTMLInputElement) {
      if (['button', 'submit', 'reset'].includes(el.type)) return 'button'
      if (el.type === 'checkbox' || el.type === 'radio') return el.type
      if (el.type === 'search') return 'searchbox'
      return 'textbox'
    }
    return IMPLIED[el.tagName] ?? ''
  }
  const labelOf = (el: Element) => {
    const named = el.getAttribute('aria-labelledby')
    const labelled = named
      ? named
          .split(/\s+/)
          .map((id) => textOf(document.getElementById(id) ?? document.createElement('i')))
          .join(' ')
      : ''
    const labels =
      el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLButtonElement
        ? Array.from(el.labels ?? [])
        : []
    return clean(
      el.getAttribute('aria-label') ||
        labelled ||
        labels.map((label) => textOf(label)).join(' ') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder'),
    )
  }

  const indexes = new WeakMap<Node, Map<Element, number>>()
  const indexOf = (el: Element) => {
    const parent = el.parentNode
    if (!parent) return 1
    let known = indexes.get(parent)
    if (!known) {
      known = new Map()
      const counts = new Map<string, number>()
      for (const child of Array.from(parent.children)) {
        const n = (counts.get(child.tagName) ?? 0) + 1
        counts.set(child.tagName, n)
        known.set(child, n)
      }
      indexes.set(parent, known)
    }
    return known.get(el) ?? 1
  }

  const xpathOf = (el: Element, stopAtId: boolean): string => {
    const path: string[] = []
    for (
      let node: Element | null = el;
      node && node !== document.documentElement;
      node = parentOf(node)
    ) {
      if (stopAtId && node !== el && node.id) return `//*[@id="${node.id}"]/${path.join('/')}`
      path.unshift(`${node.tagName.toLowerCase()}[${indexOf(node)}]`)
    }
    return stopAtId ? '' : `/html/${path.join('/')}`
  }

  const wordsIn = (node: Element) =>
    node.shadowRoot
      ? clean(
          Array.from(node.shadowRoot.children)
            .filter((child) => !['STYLE', 'SCRIPT', 'TEMPLATE', 'LINK'].includes(child.tagName))
            .map((child) => textOf(child))
            .join(' '),
        )
      : textOf(node)
  const neighboursOf = (el: Element) => {
    const own = textOf(el)
    for (let node = parentOf(el); node && node !== document.body; node = parentOf(node)) {
      const text = wordsIn(node)
      if (text !== own) return clean(own ? text.replace(own, ' ') : text)
    }
    return ''
  }

  const print = (el: Element): Fingerprint => {
    const box = el.getBoundingClientRect()
    return {
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      id: el.id,
      testId:
        el.getAttribute('data-testid') ??
        el.getAttribute('data-test') ??
        el.getAttribute('data-cy') ??
        '',
      name: el.getAttribute('name') ?? '',
      type: el instanceof HTMLInputElement ? el.type : '',
      className: typeof el.className === 'string' ? el.className : '',
      href: el.getAttribute('href') ?? '',
      alt: el.getAttribute('alt') ?? '',
      text: textOf(el),
      label: labelOf(el),
      neighbours: neighboursOf(el),
      xpath: xpathOf(el, false),
      idXpath: xpathOf(el, true),
      isButton: roleOf(el) === 'button',
      x: box.left + scrollX,
      y: box.top + scrollY,
      width: box.width,
      height: box.height,
    }
  }

  if (!options.mark) return visible(root) ? [print(root)] : []
  const found: Fingerprint[] = []
  const visit = (scope: Document | ShadowRoot) => {
    for (const el of Array.from(scope.querySelectorAll('*'))) {
      if (el.shadowRoot) visit(el.shadowRoot)
      if (el === document.body || el.closest('[data-product-demo]')) continue
      if (el.tagName.toLowerCase() !== options.tag && !pressable(el)) continue
      if (!visible(el)) continue
      el.setAttribute(`data-${options.mark}`, String(found.length))
      found.push(print(el))
    }
  }
  visit(document)
  return found
}

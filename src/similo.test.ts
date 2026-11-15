import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { Browser, Locator, Page } from 'playwright-core'
import {
  decide,
  fingerprint,
  MIN_SCORE,
  rank,
  similarity,
  type Decision,
  type Fingerprint,
} from './similo.ts'
import { launchBrowser } from './tools.ts'

// Each case records an element on one page, then looks for it on a second page that a
// real app might show instead: re-sorted, restyled, rebuilt, resized, or in another state.

let browser: Browser
beforeAll(async () => {
  browser = await launchBrowser()
})
afterAll(() => browser.close())

const wide = { width: 1280, height: 800 }

async function open(html: string, viewport = wide): Promise<Page> {
  const page = await browser.newPage({ viewport })
  await page.setContent(html)
  return page
}

/** Fingerprints `pick` on the first page, then decides what it is on the second. */
async function refind(
  before: string,
  after: string,
  pick: (page: Page) => Locator,
  options: { viewport?: typeof wide; prepare?: (page: Page) => Promise<void> } = {},
): Promise<{ decision: Decision; page: Page; scores: number[] }> {
  const first = await open(before)
  const print = await fingerprint(pick(first))
  await first.close()
  const page = await open(after, options.viewport)
  await options.prepare?.(page)
  const ranked = await rank(page, print)
  return { decision: decide(ranked), page, scores: ranked.slice(0, 3).map((c) => c.score) }
}

/** The element found, or a failure that says what was decided instead. */
function found(decision: Decision): Locator {
  if ('found' in decision) return decision.found.locator
  throw new Error(`Expected one element, got ${JSON.stringify(Object.keys(decision))}`)
}

const rowOf = (button: Locator) => button.locator('xpath=ancestor::tr[1]').innerText()

describe('similarity', () => {
  const button: Fingerprint = {
    tag: 'button',
    role: 'button',
    id: '',
    testId: '',
    name: '',
    type: '',
    className: 'btn primary',
    href: '',
    alt: '',
    text: 'Inbox 6',
    label: '',
    neighbours: 'Mail Drafts Sent',
    xpath: '/html/body[1]/div[1]/button[1]',
    idXpath: '',
    isButton: true,
    x: 10,
    y: 10,
    width: 80,
    height: 30,
  }

  test('an identical element scores 1', () => {
    expect(similarity(button, button)).toBe(1)
  })

  test('a changed count still scores 1', () => {
    expect(similarity(button, { ...button, text: 'Inbox 7' })).toBe(1)
  })

  test('a rebuilt class hash still scores 1', () => {
    const before = { ...button, className: 'Button_root__x8Kd2 Button_primary__a1B2c' }
    const after = { ...button, className: 'Button_root__q9Zt1 Button_primary__z7Y6x' }
    expect(similarity(before, after)).toBe(1)
  })

  test('the same element moved beats a different one left in its place', () => {
    const moved = { ...button, x: 200, xpath: '/html/body[1]/div[2]/button[1]' }
    const other = { ...button, text: 'Archive', neighbours: 'Settings' }
    expect(similarity(button, moved)).toBeGreaterThan(similarity(button, other))
  })

  test('a button that now says something else is not the same button', () => {
    const publish = { ...button, text: 'Publish', neighbours: 'Draft Publish' }
    const unpublish = { ...publish, text: 'Unpublish', neighbours: 'Live Unpublish' }
    expect(similarity(publish, unpublish)).toBeLessThan(MIN_SCORE)
  })

  test("unless the app's test id says it is", () => {
    const save = { ...button, text: 'Save', testId: 'save-post' }
    expect(similarity(save, { ...save, text: 'Update' })).toBeGreaterThan(MIN_SCORE)
  })
})

describe('rank', () => {
  const article = (cobol = 'COBOL') => `
    <nav aria-label="Contents" style="float:left;width:200px">
      <a href="#Career">Career</a><br><a href="#COBOL">${cobol}</a><br><a href="#Legacy">Legacy</a>
    </nav>
    <main style="margin-left:220px">
      <h2>Career</h2>
      <p>In 1959 she helped design <a href="/wiki/COBOL">${cobol}</a>, a language for business.</p>
    </main>`

  test('tells the article link from the contents link with the same name', async () => {
    const { decision } = await refind(article(), article(), (p) => p.locator('main a'))
    expect(await found(decision).getAttribute('href')).toBe('/wiki/COBOL')
  })

  test('finds the same link after its text changed', async () => {
    const { decision } = await refind(article(), article('COBOL (language)'), (p) =>
      p.locator('main a'),
    )
    expect(await found(decision).getAttribute('href')).toBe('/wiki/COBOL')
  })

  const table = (names: string[]) =>
    `<table>${names.map((n) => `<tr><td>${n}</td><td><button>Delete</button></td></tr>`).join('')}</table>`

  test('finds the same row after a row was added above it', async () => {
    const { decision } = await refind(
      table(['Acme', 'Globex', 'Initech']),
      table(['Umbrella', 'Acme', 'Globex', 'Initech']),
      (p) => p.locator('tr', { hasText: 'Globex' }).getByRole('button'),
    )
    expect(await rowOf(found(decision))).toContain('Globex')
  })

  test('finds the same row after the table was sorted the other way', async () => {
    const names = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Wayne']
    const { decision } = await refind(table(names), table([...names].reverse()), (p) =>
      p.locator('tr', { hasText: 'Globex' }).getByRole('button'),
    )
    expect(await rowOf(found(decision))).toContain('Globex')
  })

  test('finds an icon button by its label after the toolbar was reordered', async () => {
    const toolbar = (labels: string[]) =>
      `<div role="toolbar">${labels.map((l) => `<button aria-label="${l}"><svg width="16" height="16"><rect width="16" height="16"/></svg></button>`).join('')}</div>`
    const { decision } = await refind(
      toolbar(['Bold', 'Italic', 'Underline']),
      toolbar(['Underline', 'Bold', 'Italic', 'Strikethrough']),
      (p) => p.getByRole('button', { name: 'Italic' }),
    )
    expect(await found(decision).getAttribute('aria-label')).toBe('Italic')
  })

  test('finds a field by its <label> when the form was laid out again', async () => {
    const side = `<table><tr><td><label for="a">Email</label></td><td><input id="a"></td></tr>
      <tr><td><label for="b">Password</label></td><td><input id="b" type="password"></td></tr></table>`
    const stacked = `<div><label for="x">Password</label><br><input id="x" type="password"></div>
      <div><label for="y">Email</label><br><input id="y"></div>`
    const { decision } = await refind(side, stacked, (p) => p.getByLabel('Password'))
    expect(await found(decision).getAttribute('type')).toBe('password')
  })

  test('finds a button after a rebuild changed its class hashes and wrapped it', async () => {
    const before = `<div class="Cart_footer__a8f3"><span>Total $42</span>
      <button class="Button_root__x8Kd2">Checkout</button><button class="Button_root__x8Kd2">Back</button></div>`
    const after = `<div class="Cart_footer__k2j9"><span>Total $42</span>
      <div class="Actions_row__p0q1"><button class="Button_root__q9Zt1">Back</button>
      <button class="Button_root__q9Zt1">Checkout</button></div></div>`
    const { decision } = await refind(before, after, (p) =>
      p.getByRole('button', { name: 'Checkout' }),
    )
    expect(await found(decision).innerText()).toBe('Checkout')
  })

  test('does not take "Unpublish" for "Publish" in the same place', async () => {
    const post = (state: string, action: string) =>
      `<article><h1>Launch notes</h1><p>${state}</p><button>${action}</button><button>Preview</button></article>`
    const { decision } = await refind(post('Draft', 'Publish'), post('Live', 'Unpublish'), (p) =>
      p.getByRole('button', { name: 'Publish' }),
    )
    expect('found' in decision).toBe(false)
  })

  test('finds a button inside a web component', async () => {
    const card = (title: string) => `<product-card data-title="${title}"></product-card>`
    const define = `<script>customElements.define('product-card', class extends HTMLElement {
      connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML =
        '<style>h3{color:red}</style><h3>' + this.dataset.title + '</h3><button>Add to cart</button>' } })</script>`
    const { decision } = await refind(
      define + card('Lamp') + card('Chair'),
      define + card('Desk') + card('Chair') + card('Lamp'),
      (p) => p.locator('product-card[data-title="Lamp"]').getByRole('button'),
    )
    const button = found(decision)
    expect('found' in decision && decision.found.fingerprint.neighbours).not.toContain('color')
    expect(await button.evaluate((el) => el.getRootNode() instanceof ShadowRoot)).toBe(true)
    expect(
      await button.evaluate((el) =>
        (el.getRootNode() as ShadowRoot).host.getAttribute('data-title'),
      ),
    ).toBe('Lamp')
  })

  test('finds the right card in a grid that was reordered', async () => {
    const grid = (items: string[]) =>
      `<div style="display:grid;grid-template-columns:repeat(3,200px);gap:16px">${items
        .map(
          (i) =>
            `<div><img alt="${i}" width="200" height="120"><h3>${i}</h3><button>Add to cart</button></div>`,
        )
        .join('')}</div>`
    const { decision } = await refind(
      grid(['Lamp', 'Chair', 'Desk', 'Shelf']),
      grid(['Shelf', 'Desk', 'Lamp', 'Chair', 'Rug']),
      (p) =>
        p
          .locator('div', { has: p.getByRole('heading', { name: 'Desk' }) })
          .last()
          .getByRole('button'),
    )
    expect(await found(decision).locator('xpath=..').locator('h3').innerText()).toBe('Desk')
  })

  test('ignores a hidden copy, like the menu kept for phones', async () => {
    const nav = (banner: string) => `${banner}
      <nav class="mobile" style="display:none"><a href="/pricing">Pricing</a></nav>
      <nav class="desktop"><a href="/">Home</a> <a href="/pricing">Pricing</a></nav>`
    const { decision } = await refind(nav(''), nav('<p>Spring sale</p>'), (p) =>
      p.locator('nav.desktop a', { hasText: 'Pricing' }),
    )
    expect(await found(decision).evaluate((el) => el.closest('nav')?.className)).toBe('desktop')
  })

  test('ignores a copy that is fading out', async () => {
    const page = `<div style="opacity:0"><button>Confirm</button></div><div><button>Confirm</button></div>`
    const { decision } = await refind(page, page, (p) => p.getByRole('button').last())
    expect(await found(decision).evaluate((el) => el.parentElement?.style.opacity)).toBe('')
  })

  test('finds a styled checkbox whose real input is hidden under its label', async () => {
    const list = (items: string[]) =>
      `<style>input{opacity:0;position:absolute;width:20px;height:20px}label{padding-left:28px}</style>
      <ul>${items.map((i) => `<li><input type="checkbox" id="${i}"><label for="${i}">${i}</label></li>`).join('')}</ul>`
    const { decision } = await refind(
      list(['Milk', 'Eggs', 'Bread']),
      list(['Eggs', 'Bread', 'Milk']),
      (p) => p.getByRole('checkbox', { name: 'Bread' }),
    )
    expect(await found(decision).getAttribute('id')).toBe('Bread')
  })

  test('finds a button inside a display: contents wrapper', async () => {
    const bar = (extra: string) =>
      `<div style="display:flex">${extra}<div style="display:contents"><button aria-label="More tools">⋮</button></div><button>Share</button></div>`
    const { decision } = await refind(bar(''), bar('<button>Library</button>'), (p) =>
      p.getByRole('button', { name: 'More tools' }),
    )
    expect(await found(decision).getAttribute('aria-label')).toBe('More tools')
  })

  test('tells the header link from the footer link after a banner pushed both down', async () => {
    const site = (banner: string) => `${banner}
      <header><a href="/">Acme</a> <a href="/pricing">Pricing</a> <a href="/docs">Docs</a></header>
      <main style="height:600px">Welcome</main>
      <footer><a href="/pricing">Pricing</a> <a href="/terms">Terms</a></footer>`
    const { decision } = await refind(
      site(''),
      site('<div style="height:120px;background:#fc0">We have moved offices</div>'),
      (p) => p.locator('header').getByRole('link', { name: 'Pricing' }),
    )
    expect(await found(decision).evaluate((el) => el.parentElement?.tagName)).toBe('HEADER')
  })

  test('finds a button on a narrow screen where the layout stacked', async () => {
    const layout = `<div style="display:flex;flex-wrap:wrap;gap:24px">
      <section style="flex:1 1 400px"><h2>Newsletter</h2><input placeholder="Email">
      <button>Subscribe</button></section>
      <section style="flex:1 1 400px"><h2>Contact</h2><button>Send</button></section></div>`
    const { decision } = await refind(
      layout,
      layout,
      (p) => p.getByRole('button', { name: 'Subscribe' }),
      { viewport: { width: 420, height: 800 } },
    )
    expect(await found(decision).innerText()).toBe('Subscribe')
  })

  test('finds the same element however far the page is scrolled', async () => {
    const long = `<div style="height:3000px"><p>Top</p></div><button>Load more</button><button>Back to top</button>`
    const { decision } = await refind(
      long,
      long,
      (p) => p.getByRole('button', { name: 'Load more' }),
      {
        prepare: (p) => p.evaluate(() => scrollTo(0, 2500)),
      },
    )
    expect(await found(decision).innerText()).toBe('Load more')
  })

  test('trusts a test id when the words changed completely', async () => {
    const { decision } = await refind(
      '<button data-testid="primary-cta">Start free trial</button><button>Talk to sales</button>',
      '<button data-testid="primary-cta">Get started</button><button>Talk to sales</button>',
      (p) => p.getByTestId('primary-cta'),
    )
    expect(await found(decision).getAttribute('data-testid')).toBe('primary-cta')
  })

  test('scores two indistinguishable buttons as a tie', async () => {
    const twins = '<div><button>Save</button></div><div><button>Save</button></div>'
    const { decision } = await refind(twins, twins, (p) => p.getByRole('button').first())
    expect('ambiguous' in decision && decision.ambiguous.length).toBe(2)
  })

  test('finds nothing when the element is gone', async () => {
    const { decision } = await refind(
      '<button>Publish</button><a href="/help">Help</a>',
      '<a href="/help">Help</a><p>Nothing to publish.</p>',
      (p) => p.getByRole('button', { name: 'Publish' }),
    )
    expect('missing' in decision).toBe(true)
  })

  test('finds one row among 3,000 in under a second and a half', async () => {
    const names = Array.from(
      { length: 3000 },
      (_, i) => `Customer ${String(i).padStart(4, '0')} Ltd`,
    )
    const big = table(names)
    const start = performance.now()
    const { decision } = await refind(big, big, (p) =>
      p.locator('tr', { hasText: 'Customer 1234 Ltd' }).getByRole('button'),
    )
    expect(performance.now() - start).toBeLessThan(1500)
    expect(await rowOf(found(decision))).toContain('1234')
  })
})

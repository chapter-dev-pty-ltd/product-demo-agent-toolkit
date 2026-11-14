import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { Browser, Page } from 'playwright-core'
import { decide, fingerprint, rank, similarity, type Fingerprint } from './similo.ts'
import { launchBrowser } from './tools.ts'

let browser: Browser
beforeAll(async () => {
  browser = await launchBrowser()
})
afterAll(() => browser.close())

async function open(html: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.setContent(html)
  return page
}

/** Fingerprints `pick` on the first page, then ranks the second page's elements against it. */
async function refind(
  before: string,
  after: string,
  pick: (page: Page) => ReturnType<Page['locator']>,
) {
  const first = await open(before)
  const print = await fingerprint(pick(first))
  await first.close()
  const second = await open(after)
  const ranked = await rank(second, print)
  return { second, ranked }
}

const article = (cobol = 'COBOL') => `
  <nav aria-label="Contents" style="float:left;width:200px">
    <a href="#Career">Career</a><br><a href="#COBOL">${cobol}</a><br><a href="#Legacy">Legacy</a>
  </nav>
  <main style="margin-left:220px">
    <h2>Career</h2>
    <p>In 1959 she helped design <a href="/wiki/COBOL">${cobol}</a>, a language for business.</p>
  </main>`

describe('similarity', () => {
  const base: Fingerprint = {
    tag: 'button',
    id: '',
    name: '',
    className: 'btn primary',
    href: '',
    alt: '',
    text: 'Inbox 6',
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
    expect(similarity(base, base)).toBe(1)
  })

  test('a changed count still scores 1', () => {
    expect(similarity(base, { ...base, text: 'Inbox 7' })).toBe(1)
  })

  test('a different element in the same place scores lower than the same element moved', () => {
    const moved = { ...base, x: 200, xpath: '/html/body[1]/div[2]/button[1]' }
    const other = { ...base, text: 'Archive', neighbours: 'Settings' }
    expect(similarity(base, moved)).toBeGreaterThan(similarity(base, other))
  })
})

describe('rank', () => {
  test('tells the article link from the contents link with the same name', async () => {
    const { second, ranked } = await refind(article(), article(), (page) => page.locator('main a'))
    const decision = decide(ranked)
    expect('found' in decision && (await decision.found.locator.getAttribute('href'))).toBe(
      '/wiki/COBOL',
    )
    await second.close()
  })

  test('finds the same link after its text changed', async () => {
    const { second, ranked } = await refind(article(), article('COBOL (language)'), (page) =>
      page.locator('main a'),
    )
    const decision = decide(ranked)
    expect('found' in decision && (await decision.found.locator.getAttribute('href'))).toBe(
      '/wiki/COBOL',
    )
    await second.close()
  })

  test('finds the same row button after rows were added above it', async () => {
    const rows = (names: string[]) =>
      `<table>${names.map((n) => `<tr><td>${n}</td><td><button>Delete</button></td></tr>`).join('')}</table>`
    const { second, ranked } = await refind(
      rows(['Acme', 'Globex', 'Initech']),
      rows(['Umbrella', 'Acme', 'Globex', 'Initech']),
      (page) => page.locator('tr', { hasText: 'Globex' }).getByRole('button'),
    )
    const decision = decide(ranked)
    expect(
      'found' in decision && (await decision.found.locator.locator('xpath=../..').innerText()),
    ).toContain('Globex')
    await second.close()
  })

  test('scores two indistinguishable buttons as a tie', async () => {
    const twins = '<div><button>Save</button></div><div><button>Save</button></div>'
    const { second, ranked } = await refind(twins, twins, (page) =>
      page.getByRole('button').first(),
    )
    const decision = decide(ranked)
    expect('ambiguous' in decision && decision.ambiguous.length).toBe(2)
    await second.close()
  })

  test('scores low when the element is gone', async () => {
    const { second, ranked } = await refind(
      '<button>Publish</button><a href="/help">Help</a>',
      '<a href="/help">Help</a><p>Nothing to publish.</p>',
      (page) => page.getByRole('button', { name: 'Publish' }),
    )
    expect('missing' in decide(ranked)).toBe(true)
    await second.close()
  })
})

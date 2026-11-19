import { resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Browser } from 'playwright-core'
import type { Footage } from '../perform.ts'
import { launchBrowser } from '../tools.ts'
import { openStage } from './stage.ts'

let browser: Browser
beforeAll(async () => {
  browser = await launchBrowser()
})
afterAll(async () => {
  await browser?.close()
})

test('clicks animate after idle frames, repeated clicks, and backwards seeks', async () => {
  const footage: Footage = {
    film: { app: 'http://localhost', steps: [] },
    source: '',
    frames: [],
    pointer: [{ at: 0, x: 100, y: 100 }],
    clicks: [
      { at: 1, x: 100, y: 100 },
      { at: 2, x: 100, y: 100 },
    ],
    keys: [],
    addresses: [],
    lines: [],
    highlights: [],
    warnings: [],
    viewport: { width: 1440, height: 900 },
    end: 3,
  }
  const page = await openStage(
    browser,
    '.',
    footage,
    [],
    {
      backdrop: '#ffffff',
      display: 'none',
      window: { width: 1440, height: 900, fill: 0.9 },
      cursor: { style: { file: resolve('library/cursors/arrow.svg') }, size: 1 },
    },
    3,
    '',
  )
  try {
    const scaleAt = (time: number) =>
      page.evaluate(async (t) => {
        await (window as unknown as { stage: { seek(t: number): Promise<void> } }).stage.seek(t)
        const cursor = document.querySelector('#cursor > :first-child')!
        return new DOMMatrix(getComputedStyle(cursor).transform).a
      }, time)
    expect(await scaleAt(0)).toBeCloseTo(1)
    expect(await scaleAt(1.09)).toBeCloseTo(0.9)
    expect(await scaleAt(1.17)).toBeCloseTo(1.03)
    expect(await scaleAt(1.5)).toBeCloseTo(1)
    expect(await scaleAt(2.09)).toBeCloseTo(0.9)
    expect(await scaleAt(3)).toBeCloseTo(1)
    expect(await scaleAt(1.09)).toBeCloseTo(0.9)
  } finally {
    await page.close()
  }
})

import { mkdtempSync } from 'node:fs'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { launchBrowser } from './tools.ts'

vi.mock('./cut/export.ts', () => ({ convertExport: vi.fn() }))

vi.mock('./cut/cut.ts', async (original) => ({
  ...(await original<typeof import('./cut/cut.ts')>()),
  cut: vi.fn(),
}))

const home = mkdtempSync(join(tmpdir(), 'studio-export-'))
process.env.PRODUCT_DEMO_HOME = home
const { filesOf, newRun, newVideo } = await import('./videos.ts')
const { studio, stopStudio } = await import('./studio.ts')
const { cut } = await import('./cut/cut.ts')
const { convertExport } = await import('./cut/export.ts')
const video = await newVideo('Export test')
let address: string
let take: string

beforeAll(async () => {
  take = await newRun(video, 'takes')
  const film = { app: 'http://localhost', steps: [{ wait: 1 }], ending: { hold: 1 } }
  await writeFile(filesOf(video).film, JSON.stringify(film))
  await writeFile(
    filesOf(video).look,
    JSON.stringify({
      backdrop: '#ffffff',
      cursor: resolve('library/cursors/arrow.svg'),
      sound: false,
    }),
  )
  await writeFile(
    join(take, 'footage.json'),
    JSON.stringify({
      film,
      source: filesOf(video).film,
      frames: [{ at: 0, file: 'frame.svg' }],
      pointer: [],
      clicks: [],
      keys: [],
      addresses: [],
      lines: [],
      highlights: [],
      end: 0,
    }),
  )
  await writeFile(
    join(take, 'frame.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>',
  )
  address = (
    await studio(
      video,
      take,
      Array.from({ length: 100 }, (_, i) => 18000 + i),
    )
  ).replace('/studio', '')
})
afterAll(async () => {
  await stopStudio(video)
  await rm(home, { recursive: true, force: true })
})

const exportVideo = () =>
  fetch(address + '/studio/export', {
    method: 'POST',
    body: JSON.stringify({ fill: 0.73 }),
  })

test('exports the requested look, rejects overlapping renders, and preserves a previous export on failure', async () => {
  let release!: () => void
  const held = new Promise<void>((done) => {
    release = done
  })
  vi.mocked(cut).mockImplementationOnce(async (_, output, config) => {
    expect(config.window.fill).toBe(0.73)
    expect(config.sound).toBe(false)
    await held
    await writeFile(output, 'rendered mp4')
    return 1
  })
  const first = exportVideo()
  await vi.waitFor(() => expect(cut).toHaveBeenCalledOnce())
  const busy = await exportVideo()
  expect(busy.status).toBe(409)
  release()
  const response = await first
  expect(response.headers.get('content-type')).toBe('video/mp4')
  expect(response.headers.get('content-disposition')).toContain(video.id + '.mp4')
  expect(await response.text()).toBe('rendered mp4')

  vi.mocked(cut).mockImplementationOnce(async (_, output) => {
    await writeFile(output, 'partial file')
    throw new Error('encoder failed')
  })
  expect((await exportVideo()).ok).toBe(false)
  expect(await readFile(filesOf(video).cut, 'utf8')).toBe('rendered mp4')
  expect((await readdir(filesOf(video).studio)).filter((name) => name.endsWith('.mp4'))).toEqual([])
})

test('the export button downloads the rendered file and recovers from a failed request', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ acceptDownloads: true })
    await page.goto(address + '/studio')
    vi.mocked(cut).mockRejectedValueOnce(new Error('try again'))
    await page.locator('#export').click()
    await page
      .getByRole('dialog', { name: 'Export video' })
      .getByRole('button', { name: 'Export MP4', exact: true })
      .click()
    await page.waitForFunction(() =>
      document.getElementById('export-status')?.textContent?.includes('Export failed'),
    )
    expect(await page.getByRole('button', { name: 'Export', exact: true }).isEnabled()).toBe(true)
    vi.mocked(cut).mockImplementationOnce(async (_, output) => {
      await writeFile(output, 'downloaded mp4')
      return 1
    })
    vi.mocked(convertExport).mockImplementationOnce(async (_, output, format) => {
      expect(format).toBe('gif')
      await writeFile(output, 'downloaded gif')
    })
    const downloaded = page.waitForEvent('download')
    await page.locator('#export').click()
    await page.getByRole('combobox', { name: 'File format' }).selectOption('gif')
    await page.getByRole('button', { name: 'Export GIF', exact: true }).click()
    const download = await downloaded
    expect(download.suggestedFilename()).toBe(video.id + '.gif')
    expect(await readFile((await download.path())!, 'utf8')).toBe('downloaded gif')
  } finally {
    await browser.close()
  }
})

test.each(['webm', 'gif'] as const)(
  'exports %s with the matching filename and media type',
  async (format) => {
    vi.mocked(cut).mockImplementationOnce(async (_, output) => {
      await writeFile(output, 'master mp4')
      return 1
    })
    vi.mocked(convertExport).mockImplementationOnce(async (input, output, selected) => {
      expect(await readFile(input, 'utf8')).toBe('master mp4')
      expect(selected).toBe(format)
      await writeFile(output, 'converted ' + format)
    })
    const response = await fetch(address + '/studio/export', {
      method: 'POST',
      body: JSON.stringify({ format }),
    })
    expect(response.headers.get('content-type')).toBe(format === 'gif' ? 'image/gif' : 'video/webm')
    expect(response.headers.get('content-disposition')).toContain(video.id + '.' + format)
    expect(await response.text()).toBe('converted ' + format)
    expect(await readFile(filesOf(video).cut, 'utf8')).toBe('master mp4')
    expect(await readFile(join(video.dir, 'video.' + format), 'utf8')).toBe('converted ' + format)
  },
)

test('rejects unsupported formats before rendering', async () => {
  const before = vi.mocked(cut).mock.calls.length
  const response = await fetch(address + '/studio/export', {
    method: 'POST',
    body: JSON.stringify({ format: '../../outside' }),
  })
  expect(response.status).toBe(400)
  expect(vi.mocked(cut).mock.calls).toHaveLength(before)
})

test('finishes the download when another tab changes settings during a render', async () => {
  const browser = await launchBrowser()
  let release!: () => void
  const held = new Promise<void>((done) => {
    release = done
  })
  try {
    const page = await browser.newPage({ acceptDownloads: true })
    await page.goto(address + '/studio')
    let started = false
    vi.mocked(cut).mockImplementationOnce(async (_, output) => {
      started = true
      await held
      await writeFile(output, 'finished export')
      return 1
    })
    const downloaded = page.waitForEvent('download')
    await page.locator('#export').click()
    await page.locator('#start-export').click()
    await vi.waitFor(() => expect(started).toBe(true))
    const changed = page.evaluate(
      () =>
        new Promise<void>((done) => {
          const events = new EventSource('/studio/events')
          events.onmessage = (event) => {
            if (JSON.parse(event.data).type !== 'config') return
            events.close()
            done()
          }
        }),
    )
    const look = JSON.parse(await readFile(filesOf(video).look, 'utf8'))
    await writeFile(filesOf(video).look, JSON.stringify({ ...look, backdrop: '#123456' }))
    await changed
    expect(page.url()).toBe(address + '/studio')
    release()
    const download = await downloaded
    expect(await readFile((await download.path())!, 'utf8')).toBe('finished export')
  } finally {
    release()
    await browser.close()
  }
})

import { mkdtempSync } from 'node:fs'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { launchBrowser } from './tools.ts'

vi.mock('./cut/cut.ts', async (original) => ({
  ...(await original<typeof import('./cut/cut.ts')>()),
  cut: vi.fn(),
}))

const home = mkdtempSync(join(tmpdir(), 'studio-export-'))
process.env.PRODUCT_DEMO_HOME = home
const { filesOf, newRun, newVideo } = await import('./videos.ts')
const { studio, stopStudio } = await import('./studio.ts')
const { cut } = await import('./cut/cut.ts')
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
    await page.getByRole('button', { name: 'Export MP4' }).click()
    await page.waitForFunction(() =>
      document.getElementById('export-status')?.textContent?.includes('Export failed'),
    )
    expect(await page.getByRole('button', { name: 'Export MP4' }).isEnabled()).toBe(true)
    vi.mocked(cut).mockImplementationOnce(async (_, output) => {
      await writeFile(output, 'downloaded mp4')
      return 1
    })
    const downloaded = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export MP4' }).click()
    const download = await downloaded
    expect(download.suggestedFilename()).toBe(video.id + '.mp4')
    expect(await readFile((await download.path())!, 'utf8')).toBe('downloaded mp4')
  } finally {
    await browser.close()
  }
})

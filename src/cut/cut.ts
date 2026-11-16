import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Config } from '../config.ts'
import { readFilm } from '../film.ts'
import { VIEWPORT, type Footage } from '../perform.ts'
import { drawCursor, trackCursor } from './cursor.ts'
import { findFfmpeg, launchBrowser, run } from '../tools.ts'

const CANVAS = { width: 1920, height: 1080 }
const AT = { x: (CANVAS.width - VIEWPORT.width) / 2, y: (CANVAS.height - VIEWPORT.height) / 2 }
const RADIUS = 14

export async function readFootage(footageDir: string): Promise<Footage> {
  return JSON.parse(await readFile(join(footageDir, 'footage.json'), 'utf8'))
}

/** How long the cut of this footage runs, in seconds: the footage plus the ending's hold. */
export function videoLength(footage: Footage): number {
  return footage.end + (footage.film.ending?.hold ?? 2) - (footage.frames[0]?.at ?? 0)
}

/**
 * Cuts footage into an mp4: the app framed on a backdrop, the cursor drawn over it, the
 * ending held. Returns its length. The film's directions are read from its file as it is
 * now, so changing them only needs another cut.
 */
export async function cut(footageDir: string, out: string, config: Config): Promise<number> {
  const footage = await readFootage(footageDir)
  if (footage.frames.length === 0) throw new Error(`${footageDir} has no frames.`)
  const film = existsSync(footage.source) ? await readFilm(footage.source) : footage.film

  const work = resolve(footageDir, 'cut')
  await mkdir(work, { recursive: true })
  await drawLayers(work, config.backdrop, film.cursor ?? config.cursor)

  const hold = footage.film.ending?.hold ?? 2
  const lines = footage.frames.map((frame, i) => {
    const next = footage.frames[i + 1]?.at ?? footage.end + hold
    return `file '${resolve(footageDir, frame.file)}'\nduration ${(next - frame.at).toFixed(4)}`
  })
  const last = footage.frames.at(-1)
  if (last) lines.push(`file '${resolve(footageDir, last.file)}'`)
  await writeFile(join(work, 'frames.txt'), lines.join('\n'))
  // The backdrop and mask loop forever, so the video's length has to be said.
  const length = videoLength(footage)
  const cursor = await trackCursor(footage, work, AT, length)

  await run(
    await findFfmpeg(),
    [
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      join(work, 'frames.txt'),
      '-framerate',
      '60',
      '-loop',
      '1',
      '-i',
      join(work, 'backdrop.png'),
      '-framerate',
      '60',
      '-loop',
      '1',
      '-i',
      join(work, 'mask.png'),
      '-f',
      'concat',
      '-i',
      join(work, 'ripple.txt'),
      '-framerate',
      '60',
      '-loop',
      '1',
      '-i',
      join(work, 'cursor.png'),
      '-filter_complex',
      `[0:v]fps=60,format=rgba[app];[2:v]format=gray[mask];[app][mask]alphamerge[framed];` +
        `[1:v][framed]overlay=${AT.x}:${AT.y}:shortest=1[scene];${cursor},format=yuv420p`,
      '-t',
      length.toFixed(3),
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-preset',
      'medium',
      '-movflags',
      '+faststart',
      resolve(out),
    ],
    work,
  )
  return length
}

/** The still layers: the backdrop with the app's shadow on it, the rounded mask, the cursor. */
async function drawLayers(
  dir: string,
  backdrop: Config['backdrop'],
  cursor: Config['cursor'],
): Promise<void> {
  const picture = await readFile(new URL(`../library/backdrops/${backdrop}.jpg`, import.meta.url))
  const background = `url(data:image/jpeg;base64,${picture.toString('base64')}) center / cover`
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: CANVAS })
    const box = `position:absolute;left:${AT.x}px;top:${AT.y}px;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;border-radius:${RADIUS}px`
    await page.setContent(
      `<body style="margin:0;background:${background}"><div style="${box};background:#fff;box-shadow:0 30px 80px rgb(20 20 60 / 0.28),0 6px 18px rgb(20 20 60 / 0.16)"></div></body>`,
    )
    await page.screenshot({ path: join(dir, 'backdrop.png') })
    await page.setViewportSize(VIEWPORT)
    await page.setContent(
      `<body style="margin:0;background:#000"><div style="width:100vw;height:100vh;background:#fff;border-radius:${RADIUS}px"></div></body>`,
    )
    await page.screenshot({ path: join(dir, 'mask.png') })
    await drawCursor(page, dir, cursor)
  } finally {
    await browser.close()
  }
}

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import type { Config } from '../config.ts'
import { readFilm } from '../film.ts'
import type { Footage } from '../perform.ts'
import { findFfmpeg, launchBrowser } from '../tools.ts'
import { openStage } from './stage.ts'

// The cut renders the stage (stage.ts) one frame at a time: seek it to the frame's time,
// photograph it, and stream the photographs into ffmpeg, which only encodes the video.

const FPS = 60

export async function readFootage(footageDir: string): Promise<Footage> {
  return JSON.parse(await readFile(join(footageDir, 'footage.json'), 'utf8'))
}

/** How long the cut of this footage runs, in seconds: the footage plus the ending's hold. */
export function videoLength(footage: Footage): number {
  return footage.end + (footage.film.ending?.hold ?? 2) - (footage.frames[0]?.at ?? 0)
}

/**
 * Cuts footage into an mp4 and returns its length. The film's directions are read from its
 * file as it is now, so changing them only needs another cut. `extra` is HTML put on the
 * stage over everything else.
 */
export async function cut(
  footageDir: string,
  out: string,
  config: Config,
  extra = '',
): Promise<number> {
  const footage = await readFootage(footageDir)
  if (footage.frames.length === 0) throw new Error(`${footageDir} has no frames.`)
  const film = existsSync(footage.source) ? await readFilm(footage.source) : footage.film
  const length = videoLength(footage)
  const look = { backdrop: config.backdrop, cursor: film.cursor ?? config.cursor }
  const title = film.notes?.split(/(?<=\.)\s/)[0] ?? ''

  const browser = await launchBrowser()
  try {
    const page = await openStage(browser, footageDir, footage, look, length, title, extra)
    const camera = await page.context().newCDPSession(page)
    const encoder = spawn(
      await findFfmpeg(),
      // prettier-ignore
      ['-loglevel', 'error', '-y',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(FPS), '-i', '-',
        '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', resolve(out)],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    )
    const done = once(encoder, 'exit')
    const frames = Math.ceil(length * FPS)
    for (let i = 0; i < frames; i++) {
      await page.evaluate(`stage.seek(${i / FPS})`)
      const { data } = await camera.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 92,
        optimizeForSpeed: true,
      })
      if (!encoder.stdin.write(Buffer.from(data, 'base64'))) await once(encoder.stdin, 'drain')
    }
    encoder.stdin.end()
    const [code] = await done
    if (code !== 0) throw new Error(`ffmpeg failed with code ${code}.`)
  } finally {
    await browser.close()
  }
  return length
}

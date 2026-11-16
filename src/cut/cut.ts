import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { soundOn, type Config } from '../config.ts'
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
  // How each highlight looks comes from the film as it is now; when it held, from the shoot.
  const highlights = footage.highlights.flatMap((held) => {
    const now = film.steps[held.step]?.highlight
    if (!now) return []
    return [
      {
        at: held.at,
        until: held.until,
        box: now.box ?? held.box,
        zoom: now.zoom ?? 0,
        style: now.style ?? 'box',
        colour: now.colour ?? '#ff3b30',
      },
    ]
  })

  const browser = await launchBrowser()
  try {
    const page = await openStage(
      browser,
      footageDir,
      footage,
      highlights,
      look,
      length,
      title,
      extra,
    )
    const camera = await page.context().newCDPSession(page)
    const start = footage.frames[0]?.at ?? 0
    const sound = soundOn('click', film.sound, config.sound)
      ? clickSounds(
          footage.clicks.map((c) => c.at - start),
          length,
        )
      : []
    const encoder = spawn(
      await findFfmpeg(),
      // prettier-ignore
      ['-loglevel', 'error', '-y',
        '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(FPS), '-i', '-',
        ...sound,
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

/** The clicks, one picked at random for each, so they don't all sound the same. */
const CLICKS = ['click-1.wav', 'click-2.wav']

/** ffmpeg's arguments for the sound: a click at each of these times, for the video's length. */
function clickSounds(times: number[], length: number): string[] {
  if (times.length === 0) return []
  const inputs = CLICKS.flatMap((file) => [
    '-i',
    fileURLToPath(new URL(`../library/sounds/${file}`, import.meta.url)),
  ])
  // Random, but seeded by the click's time, so cutting the same footage again sounds the same.
  const pick = (t: number) =>
    (Math.imul(Math.round(t * 1000) + 1, 2654435761) >>> 0) % CLICKS.length
  // Each sound is split into as many copies as it plays, then each copy is delayed to its time.
  const splits = CLICKS.map((_, k) => {
    const mine = times.flatMap((t, i) => (pick(t) === k ? [`[c${i}]`] : []))
    return mine.length
      ? `[${k + 1}:a]asplit=${mine.length}${mine.join('')}`
      : `[${k + 1}:a]anullsink`
  })
  const each = times.map((t, i) => `[c${i}]adelay=${Math.round(t * 1000)}:all=1[d${i}]`)
  // A silent track the video's length leads the mix, so the sound runs to the end.
  const silence = `anullsrc=r=48000:cl=mono:d=${length.toFixed(3)}[q]`
  const mix = `[q]${times.map((_, i) => `[d${i}]`).join('')}amix=inputs=${times.length + 1}:normalize=0:duration=first[a]`
  // prettier-ignore
  return [...inputs, '-filter_complex', [...splits, ...each, silence, mix].join(';'),
    '-map', '0:v', '-map', '[a]', '-c:a', 'aac', '-b:a', '160k']
}

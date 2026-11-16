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
    const sound = soundArgs(
      [
        {
          files: CLICKS,
          times: soundOn('click', film.sound, config.sound)
            ? footage.clicks.map((c) => c.at - start)
            : [],
          volume: 1,
        },
        ...Object.entries(KEYS).map(([kind, file]) => ({
          files: [file],
          times: soundOn('typing', film.sound, config.sound)
            ? (footage.keys ?? []).filter((k) => keyKind(k.key) === kind).map((k) => k.at - start)
            : [],
          volume: 0.7,
        })),
      ],
      length,
    )
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

// The sounds the cut plays: a click picked at random for each click, so they don't all sound
// the same, and a key sound for each key, with space and Enter their own.
const CLICKS = ['click-1.wav', 'click-2.wav']
const KEYS: Record<'key' | 'space' | 'enter', string> = {
  key: 'key.wav',
  space: 'space.wav',
  enter: 'enter.wav',
}

/** Which key sound a key gets: Enter and space have their own. */
const keyKind = (key: string): keyof typeof KEYS =>
  key === ' ' || key === 'Space' ? 'space' : key.split('+').at(-1) === 'Enter' ? 'enter' : 'key'

/** A set of sounds, the times to play one of them, and how loud. */
interface Track {
  files: string[]
  times: number[]
  volume: number
}

/** Random, but seeded by the time, so cutting the same footage again sounds the same. */
function pick(t: number, of: number): number {
  let h = Math.round(t * 1000)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return ((h ^ (h >>> 16)) >>> 0) % of
}

/** ffmpeg's arguments for the sound: each track's sounds at its times, for the video's length. */
function soundArgs(tracks: Track[], length: number): string[] {
  const inputs: string[] = []
  const graph: string[] = []
  const played: string[] = []
  for (const [n, track] of tracks.entries()) {
    if (track.times.length === 0) continue
    // Each sound is split into as many copies as it plays, then each copy delayed to its time.
    for (const [k, file] of track.files.entries()) {
      inputs.push('-i', fileURLToPath(new URL(`../library/sounds/${file}`, import.meta.url)))
      const input = inputs.length / 2
      const mine = track.times.flatMap((t, i) =>
        pick(t, track.files.length) === k ? [`[s${n}_${i}]`] : [],
      )
      graph.push(
        mine.length
          ? `[${input}:a]volume=${track.volume},asplit=${mine.length}${mine.join('')}`
          : `[${input}:a]anullsink`,
      )
    }
    for (const [i, t] of track.times.entries()) {
      graph.push(`[s${n}_${i}]adelay=${Math.round(t * 1000)}:all=1[p${n}_${i}]`)
      played.push(`[p${n}_${i}]`)
    }
  }
  if (played.length === 0) return []
  // A silent track the video's length leads the mix, so the sound runs to the end.
  graph.push(`anullsrc=r=48000:cl=mono:d=${length.toFixed(3)}[q]`)
  graph.push(`[q]${played.join('')}amix=inputs=${played.length + 1}:normalize=0:duration=first[a]`)
  // prettier-ignore
  return [...inputs, '-filter_complex', graph.join(';'),
    '-map', '0:v', '-map', '[a]', '-c:a', 'aac', '-b:a', '160k']
}

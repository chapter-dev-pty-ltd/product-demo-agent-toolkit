import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { soundOn, type Config, type Music } from '../config.ts'
import { readFilm } from '../film.ts'
import type { Footage } from '../perform.ts'
import { findFfmpeg, launchBrowser } from '../tools.ts'
import { openStage } from './stage.ts'

const FPS = 60

export async function readFootage(footageDir: string): Promise<Footage> {
  return JSON.parse(await readFile(join(footageDir, 'footage.json'), 'utf8'))
}

export function videoLength(footage: Footage): number {
  return footage.end + (footage.film.ending?.hold ?? 2) - (footage.frames[0]?.at ?? 0)
}

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
  const look = {
    backdrop: config.backdrop,
    cursor: config.cursor,
    display: config.display,
    window: config.window,
  }
  const title = film.notes?.split(/(?<=\.)\s/)[0] ?? ''
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
    const ffmpeg = await findFfmpeg()
    const music = config.music ? await musicTrack(ffmpeg, config.music) : undefined
    const sound = soundArgs(
      [
        {
          files: CLICKS,
          times: soundOn('click', config.sound) ? footage.clicks.map((c) => c.at - start) : [],
          volume: 1,
        },
        ...Object.entries(KEYS).map(([kind, files]) => ({
          files,
          times: soundOn('typing', config.sound)
            ? (footage.keys ?? []).filter((k) => keyKind(k.key) === kind).map((k) => k.at - start)
            : [],
          volume: 0.7,
        })),
        ...(footage.lines ?? []).map((l) => ({
          files: [l.file],
          times: [l.at - start],
          volume: 1.6,
          vary: false,
        })),
      ],
      length,
      music && { ...music, fade: Math.max(1, footage.film.ending?.hold ?? 2) },
    )
    const encoder = spawn(
      ffmpeg,
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

const CLICKS = ['click-1.wav', 'click-2.wav']
const KEYS: Record<'key' | 'space' | 'enter', string[]> = {
  key: Array.from({ length: 8 }, (_, i) => `key-${i + 1}.wav`),
  space: ['space.wav'],
  enter: ['enter.wav'],
}

const keyKind = (key: string): keyof typeof KEYS =>
  key === ' ' || key === 'Space' ? 'space' : key.split('+').at(-1) === 'Enter' ? 'enter' : 'key'

interface Track {
  files: string[]
  times: number[]
  volume: number
  vary?: boolean
}

function pick(t: number, of: number): number {
  return Math.floor(chance(t) * of)
}

function chance(t: number): number {
  let h = Math.round(t * 1000)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32
}

interface MusicTrack {
  file: string
  length: number
  volume: number
  fade?: number
}

async function musicTrack(ffmpeg: string, music: Music): Promise<MusicTrack> {
  const file =
    typeof music.track === 'string'
      ? fileURLToPath(new URL(`../library/music/${music.track}.mp3`, import.meta.url))
      : music.track.file
  const probe = spawn(ffmpeg, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] })
  let said = ''
  probe.stderr.on('data', (chunk) => (said += chunk))
  await once(probe, 'exit')
  const [, h, m, s] = said.match(/Duration: (\d+):(\d+):([\d.]+)/) ?? []
  const length = Number(h) * 3600 + Number(m) * 60 + Number(s)
  if (!(length > 0)) throw new Error(`The music, ${file}, isn't audio ffmpeg can read.`)
  return { file, length, volume: music.volume }
}

export function musicGraph(music: MusicTrack, input: number, length: number): string[] {
  const overlap = Math.min(1, music.length / 4)
  const copies =
    music.length >= length ? 1 : Math.ceil((length - overlap) / (music.length - overlap))
  const graph: string[] = []
  let looped = `[${input}:a]`
  if (copies > 1) {
    const parts = Array.from({ length: copies }, (_, i) => `[m${i}]`)
    graph.push(`${looped}asplit=${copies}${parts.join('')}`)
    looped = '[m0]'
    for (let i = 1; i < copies; i++) {
      graph.push(`${looped}[m${i}]acrossfade=d=${overlap}:c1=tri:c2=tri[l${i}]`)
      looped = `[l${i}]`
    }
  }
  const fade = Math.min(music.fade ?? 2, length)
  graph.push(
    `${looped}aformat=sample_rates=48000:channel_layouts=stereo,volume=${music.volume},` +
      `atrim=0:${length.toFixed(3)},afade=t=out:st=${(length - fade).toFixed(3)}:d=${fade}[music]`,
  )
  return graph
}

function soundArgs(tracks: Track[], length: number, music?: MusicTrack): string[] {
  const inputs: string[] = []
  const graph: string[] = []
  const played: string[] = []
  if (music) {
    inputs.push('-i', music.file)
    graph.push(...musicGraph(music, inputs.length / 2, length))
    played.push('[music]')
  }
  for (const [n, track] of tracks.entries()) {
    if (track.times.length === 0) continue
    const picks: number[] = []
    for (const t of track.times) {
      const before = picks.at(-1)
      const k =
        track.files.length > 1 && before !== undefined
          ? pick(t, track.files.length - 1)
          : pick(t, track.files.length)
      picks.push(before !== undefined && track.files.length > 1 && k >= before ? k + 1 : k)
    }
    for (const [k, file] of track.files.entries()) {
      const path = isAbsolute(file)
        ? file
        : fileURLToPath(new URL(`../library/sounds/${file}`, import.meta.url))
      inputs.push('-i', path)
      const input = inputs.length / 2
      const mine = track.times.flatMap((_, i) => (picks[i] === k ? [`[s${n}_${i}]`] : []))
      graph.push(
        mine.length
          ? `[${input}:a]volume=${track.volume},asplit=${mine.length}${mine.join('')}`
          : `[${input}:a]anullsink`,
      )
    }
    for (const [i, t] of track.times.entries()) {
      const pitch = 1 + (chance(t + 0.1) - 0.5) * 0.06
      const gain = (chance(t + 0.2) - 0.5) * 4
      const varied = `asetrate=${Math.round(48000 * pitch)},aresample=48000,volume=${gain.toFixed(2)}dB,`
      graph.push(
        `[s${n}_${i}]${(track.vary ?? true) ? varied : ''}adelay=${Math.max(0, Math.round(t * 1000))}:all=1[p${n}_${i}]`,
      )
      played.push(`[p${n}_${i}]`)
    }
  }
  if (played.length === 0) return []
  graph.push(`anullsrc=r=48000:cl=stereo:d=${length.toFixed(3)}[q]`)
  graph.push(
    `[q]${played.join('')}amix=inputs=${played.length + 1}:normalize=0:duration=first,alimiter=limit=0.89[a]`,
  )
  // prettier-ignore
  return [...inputs, '-filter_complex', graph.join(';'),
    '-map', '0:v', '-map', '[a]', '-c:a', 'aac', '-b:a', '160k']
}

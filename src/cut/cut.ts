import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rename } from 'node:fs/promises'
import { once } from 'node:events'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { soundOn, type Config, type Music, type Sound } from '../config.ts'
import { readFilm, type Film } from '../film.ts'
import type { Footage } from '../perform.ts'
import { findFfmpeg, launchBrowser } from '../tools.ts'
import { editsKey, filmEdits, retime, staleTake, stepAt, type Edit } from './edits.ts'
import { openStage, type Highlighted } from './stage.ts'
import type { Stem } from '../../studio/api.ts'

const FPS = 60

export async function readFootage(footageDir: string): Promise<Footage> {
  return JSON.parse(await readFile(join(footageDir, 'footage.json'), 'utf8'))
}

export function videoLength(footage: Footage): number {
  return footage.end + (footage.film.ending?.hold ?? 2) - (footage.frames[0]?.at ?? 0)
}

export async function prepare(footageDir: string): Promise<{
  footage: Footage
  recorded: Footage
  film: Film
  edits: Edit[]
  warnings: string[]
  highlights: Highlighted[]
  recordedHighlights: Highlighted[]
  length: number
  title: string
}> {
  const read = await readFootage(footageDir)
  if (read.frames.length === 0) throw new Error(`${footageDir} has no frames.`)
  const film = existsSync(read.source) ? await readFilm(read.source) : read.film
  const quiet = (kind: 'click' | 'typing') => (at: number) => {
    const step = stepAt(read, at)
    const sound = step === undefined ? undefined : film.steps[step]?.sound
    return sound !== undefined && !soundOn(kind, sound)
  }
  const recorded: Footage = {
    ...read,
    clicks: read.clicks.map((c) => ({ ...c, muted: quiet('click')(c.at) })),
    keys: (read.keys ?? []).map((k) => ({ ...k, muted: quiet('typing')(k.at) })),
  }
  const edits = filmEdits(film, recorded)
  const footage = retime(recorded, edits)
  const stale = staleTake(film, recorded)
  const length = videoLength(footage)
  const title = film.notes?.split(/(?<=\.)\s/)[0] ?? ''
  const highlightsOf = (of: Footage): Highlighted[] =>
    of.highlights.flatMap((held) => {
      const now = film.steps[held.step]?.highlight
      if (!now) return []
      return [
        {
          step: held.step,
          at: held.at,
          until: held.until,
          box: now.box ?? held.box,
          zoom: now.zoom ?? 0,
          style: now.style ?? 'box',
          colour: now.colour ?? '#ff3b30',
        },
      ]
    })

  return {
    footage,
    recorded,
    film,
    edits,
    warnings: stale ? [stale] : [],
    highlights: highlightsOf(footage),
    recordedHighlights: highlightsOf(recorded),
    length,
    title,
  }
}

export async function cut(
  footageDir: string,
  out: string,
  config: Config,
  extra = '',
): Promise<{ length: number; warnings: string[] }> {
  const { footage, highlights, length, title, warnings } = await prepare(footageDir)
  const browser = await launchBrowser()
  try {
    const page = await openStage(
      browser,
      footageDir,
      footage,
      highlights,
      config,
      length,
      title,
      extra,
    )
    const camera = await page.context().newCDPSession(page)
    const ffmpeg = await findFfmpeg()
    const music = config.music ? await musicTrack(ffmpeg, config.music) : undefined
    const sound = soundArgs(
      Object.values(soundTracks(footage, config.sound)).flat(),
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
  return { length, warnings }
}

const CLICKS = ['click-1.wav', 'click-2.wav']
const KEYS: Record<'key' | 'space' | 'enter', string[]> = {
  key: Array.from({ length: 8 }, (_, i) => `key-${i + 1}.wav`),
  space: ['space.wav'],
  enter: ['enter.wav'],
}

const keyKind = (key: string): keyof typeof KEYS =>
  key === ' ' || key === 'Space' ? 'space' : key.split('+').at(-1) === 'Enter' ? 'enter' : 'key'

export interface Track {
  files: string[]
  times: number[]
  volume: number
  vary?: boolean
}

export type { Stem }

function soundTracks(footage: Footage, sound: Sound): Record<Stem, Track[]> {
  const start = footage.frames[0]?.at ?? 0
  return {
    click: [
      {
        files: CLICKS,
        times: soundOn('click', sound)
          ? footage.clicks.filter((c) => !c.muted).map((c) => c.at - start)
          : [],
        volume: 1,
      },
    ],
    typing: Object.entries(KEYS).map(([kind, files]) => ({
      files,
      times: soundOn('typing', sound)
        ? (footage.keys ?? [])
            .filter((k) => !k.muted && keyKind(k.key) === kind)
            .map((k) => k.at - start)
        : [],
      volume: 0.7,
    })),
    voice: (footage.lines ?? []).map((l) => ({
      files: [l.file],
      times: [l.at - start],
      volume: 1.6,
      vary: false,
    })),
  }
}

export function stemsOf(footage: Footage): Stem[] {
  return (Object.entries(soundTracks(footage, true)) as [Stem, Track[]][])
    .filter(([, tracks]) => tracks.some((track) => track.times.length > 0))
    .map(([stem]) => stem)
}

// A stem can't be trusted to keep samples past full scale, so stems leave this headroom and
// the studio turns them back up ahead of one limiter over everything, as cut's mix does.
export const STEM_GAIN = 0.5
export const LIMIT = 0.89

export async function stems(
  footageDir: string,
  footage: Footage,
  length: number,
  edits: Edit[] = [],
): Promise<Partial<Record<Stem, string>>> {
  const ffmpeg = await findFfmpeg()
  const tracks = soundTracks(footage, true)
  const made = await Promise.all(
    stemsOf(footage).map(async (stem) => {
      const muted = [...footage.clicks, ...(footage.keys ?? [])].flatMap((c, i) =>
        c.muted ? [i] : [],
      )
      const key = editsKey(edits) + (muted.length ? `m${muted.join('.')}` : '')
      const out = join(footageDir, `sound-${stem}${key && `-${key}`}.m4a`)
      if (existsSync(out)) return [stem, out] as const
      const part = `${out}.part`
      const args = soundArgs(tracks[stem], length, undefined, true)
      const run = spawn(ffmpeg, ['-loglevel', 'error', '-y', ...args, '-f', 'mp4', part], {
        stdio: ['ignore', 'ignore', 'inherit'],
      })
      const [code] = await once(run, 'exit')
      if (code !== 0) {
        console.log(`ffmpeg failed with code ${code} making the ${stem} sound.`)
        return [stem, undefined] as const
      }
      await rename(part, out)
      return [stem, out] as const
    }),
  )
  return Object.fromEntries(made.filter(([, out]) => out)) as Partial<Record<Stem, string>>
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

export function soundArgs(
  tracks: Track[],
  length: number,
  music?: MusicTrack,
  stem = false,
): string[] {
  const inputs: string[] = []
  const graph: string[] = []
  const played: string[] = []
  const last = () => inputs.length / 2 - (stem ? 1 : 0)
  if (music) {
    inputs.push('-i', music.file)
    graph.push(...musicGraph(music, last(), length))
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
      const input = last()
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
    `[q]${played.join('')}amix=inputs=${played.length + 1}:normalize=0:duration=first,` +
      (stem ? `volume=${STEM_GAIN}[a]` : `alimiter=limit=${LIMIT}[a]`),
  )
  // prettier-ignore
  return [...inputs, '-filter_complex', graph.join(';'),
    ...(stem ? [] : ['-map', '0:v']), '-map', '[a]', '-c:a', 'aac', '-b:a', '160k']
}

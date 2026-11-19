import { randomInt } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { lookToRaw, readConfig } from './config.ts'
import { HOME } from './home.ts'

export const VIDEOS: string = join(HOME, 'videos')

export interface Video {
  id: string
  title: string
  created: string
  session?: string | undefined
  dir: string
}

export function filesOf(
  video: Video,
): Record<'film' | 'look' | 'chat' | 'cut' | 'explore' | 'studio', string> {
  return {
    film: join(video.dir, 'film.json'),
    look: join(video.dir, 'look.json'),
    chat: join(video.dir, 'chat.json'),
    cut: join(video.dir, 'video.mp4'),
    explore: join(video.dir, 'explore'),
    studio: join(video.dir, 'studio'),
  }
}

export async function newVideo(title?: string, session?: string): Promise<Video> {
  await mkdir(VIDEOS, { recursive: true })
  let id: string
  do id = newId()
  while (existsSync(join(VIDEOS, id)))
  const video: Video = {
    id,
    title: title?.trim() || session?.trim() || 'Untitled video',
    created: new Date().toISOString(),
    ...(session ? { session } : {}),
    dir: join(VIDEOS, id),
  }
  await mkdir(video.dir)
  const { dir: _, ...about } = video
  await writeFile(join(video.dir, 'video.json'), `${JSON.stringify(about, null, 2)}\n`)
  await writeFile(
    filesOf(video).look,
    `${JSON.stringify(lookToRaw(await readConfig()), null, 2)}\n`,
  )
  return video
}

function newId(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const all = `${letters}0123456789`
  // randomInt, not a random byte modulo 26 or 36, which favours some characters.
  const pick = (from: string) => from[randomInt(from.length)]
  return pick(letters) + Array.from({ length: 5 }, () => pick(all)).join('')
}

export async function listVideos(): Promise<Video[]> {
  const ids = await readdir(VIDEOS).catch(() => [] as string[])
  const videos = await Promise.all(ids.map((id) => readVideo(id).catch(() => undefined)))
  const dated = await Promise.all(
    videos
      .filter((video): video is Video => Boolean(video))
      .map(async (video) => ({ video, at: await lastWorkedOn(video) })),
  )
  return dated.sort((a, b) => b.at - a.at).map(({ video }) => video)
}

async function readVideo(id: string): Promise<Video> {
  const dir = join(VIDEOS, id)
  const about = JSON.parse(await readFile(join(dir, 'video.json'), 'utf8'))
  return { ...about, id, dir }
}

async function lastWorkedOn(video: Video): Promise<number> {
  const files = filesOf(video)
  const times = await Promise.all(
    [video.dir, files.film, files.look, files.chat, join(video.dir, 'takes')].map((file) =>
      stat(file).then(
        (s) => s.mtimeMs,
        () => 0,
      ),
    ),
  )
  return Math.max(...times)
}

export async function findVideo(ref: string): Promise<Video> {
  if (/^[a-z][a-z0-9]{5}$/.test(ref) && existsSync(join(VIDEOS, ref, 'video.json'))) {
    return readVideo(ref)
  }
  const videos = await listVideos()
  const words = ref.toLowerCase().split(/\s+/).filter(Boolean)
  const matches = videos.filter((video) => {
    const title = video.title.toLowerCase()
    return words.every((word) => title.includes(word))
  })
  const [only] = matches
  if (matches.length === 1 && only) return only
  const list = (some: Video[]) => some.map((v) => `  ${v.id}  ${v.title}`).join('\n')
  if (matches.length > 1) {
    throw new Error(`Several videos match "${ref}". Use one's id:\n${list(matches)}`)
  }
  throw new Error(
    videos.length
      ? `No video matches "${ref}". There's:\n${list(videos)}`
      : 'There are no videos yet. Make one with: product-demo-agent-toolkit new "<title>"',
  )
}

export type RunKind = 'takes' | 'rehearsals'

export async function newRun(video: Video, kind: RunKind): Promise<string> {
  const dir = join(video.dir, kind)
  await mkdir(dir, { recursive: true })
  const next = ((await runNumbers(dir)).at(-1) ?? 0) + 1
  const run = join(dir, String(next))
  await mkdir(run)
  return run
}

export async function pruneRuns(video: Video, kind: RunKind, keep: number): Promise<void> {
  const dir = join(video.dir, kind)
  const numbers = await runNumbers(dir)
  for (const n of numbers.slice(0, Math.max(0, numbers.length - keep))) {
    await rm(join(dir, String(n)), { recursive: true, force: true })
  }
}

async function runNumbers(dir: string): Promise<number[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .sort((a, b) => a - b)
}

export async function latestTake(video: Video): Promise<{ dir: string; n: number }> {
  const dir = join(video.dir, 'takes')
  for (const n of (await runNumbers(dir)).reverse()) {
    if (existsSync(join(dir, String(n), 'footage.json'))) return { dir: join(dir, String(n)), n }
  }
  throw new Error(
    `"${video.title}" (${video.id}) has no takes yet. Shoot it: product-demo-agent-toolkit shoot ${video.id}`,
  )
}

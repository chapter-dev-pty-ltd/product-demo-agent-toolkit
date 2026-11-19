import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { findFfmpeg, run } from './tools.ts'

const ACROSS = 4
const DOWN = 6

export async function review(video: string, seconds?: number): Promise<string> {
  const out = join(video, '..', 'review.jpg')
  seconds ??= await length(video)
  const every = Math.max(seconds / (ACROSS * DOWN), 0.1)
  await run(await findFfmpeg(), [
    '-loglevel',
    'error',
    '-y',
    '-i',
    video,
    '-vf',
    `fps=1/${every.toFixed(3)},scale=480:-1,tile=${ACROSS}x${DOWN}`,
    '-frames:v',
    '1',
    out,
  ])
  return out
}

async function length(video: string): Promise<number> {
  const said = spawnSync(await findFfmpeg(), ['-i', video], { encoding: 'utf8' }).stderr
  const [, h, m, s] = said.match(/Duration: (\d+):(\d+):([\d.]+)/) ?? []
  if (s === undefined) throw new Error(`Can't read ${video} as a video.`)
  return Number(h) * 3600 + Number(m) * 60 + Number(s)
}

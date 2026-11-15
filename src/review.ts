import { join } from 'node:path'
import { findFfmpeg, run } from './tools.ts'

// Reviewing a video: an agent can't watch one, so this lays frames from across it out in
// one image the agent can look at. Basic for now: 24 frames, evenly spaced, 6 rows of 4.

const ACROSS = 4
const DOWN = 6

/** Writes `review.jpg` beside the video and returns its path. */
export async function review(video: string, seconds: number): Promise<string> {
  const out = join(video, '..', 'review.jpg')
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

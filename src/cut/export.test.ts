import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'
import { findFfmpeg } from '../tools.ts'
import { convertExport } from './export.ts'

const execute = promisify(execFile)

test('converts a video with audio to playable WebM and a silent looping GIF', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-formats-'))
  try {
    const ffmpeg = await findFfmpeg()
    const input = join(dir, 'input.mp4')
    await execute(ffmpeg, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x180:r=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '0.4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      input,
    ])
    const webm = join(dir, 'video.webm')
    await convertExport(input, webm, 'webm')
    const decoded = await execute(ffmpeg, ['-hide_banner', '-i', webm, '-f', 'null', '-'])
    expect(decoded.stderr).toContain('Video: vp9')
    expect(decoded.stderr).toContain('Audio: opus')
    const gif = join(dir, 'video.gif')
    await convertExport(input, gif, 'gif')
    const bytes = await readFile(gif)
    expect(bytes.subarray(0, 6).toString()).toBe('GIF89a')
    expect(bytes.readUInt16LE(6)).toBe(960)
    expect(bytes.includes(Buffer.from('NETSCAPE2.0'))).toBe(true)
    const animation = await execute(ffmpeg, ['-hide_banner', '-i', gif, '-f', 'null', '-'])
    expect(animation.stderr).not.toContain('Audio:')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)

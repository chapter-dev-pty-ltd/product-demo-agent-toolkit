import { mkdtempSync } from 'node:fs'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'product-demo-home-'))
process.env.PRODUCT_DEMO_HOME = home
const { findVideo, filesOf, latestTake, newRun, newVideo, pruneRuns } = await import('./videos.ts')
const { readConfig } = await import('./config.ts')

beforeAll(async () => {
  await writeFile(join(home, 'config.json'), JSON.stringify({ backdrop: 'violet', cursor: 'lime' }))
})

describe('a new video', () => {
  test('gets a short id that is safe in a path, and a folder of its own', async () => {
    const video = await newVideo('Change the volume')
    expect(video.id).toMatch(/^[a-z][a-z0-9]{5}$/)
    expect(video.dir).toBe(join(home, 'videos', video.id))
    const about = JSON.parse(await readFile(join(video.dir, 'video.json'), 'utf8'))
    expect(about.title).toBe('Change the volume')
  })

  test("is titled by the session when it isn't given a title", async () => {
    expect((await newVideo(undefined, 'Studio tool')).title).toBe('Studio tool')
    expect((await newVideo()).title).toBe('Untitled video')
  })

  test('keeps a copy of the default look, which later changes to the default leave alone', async () => {
    const video = await newVideo('Copied look')
    await writeFile(join(home, 'config.json'), JSON.stringify({ backdrop: 'sky' }))
    const look = await readConfig(filesOf(video).look)
    expect(look.backdrop).toBe('violet')
    expect(look.cursor.style).toBe('lime')
    expect((await readConfig()).backdrop).toBe('sky')
  })
})

describe('finding a video', () => {
  test('by its id, or by words from its title', async () => {
    const video = await newVideo('Export a monthly report')
    expect((await findVideo(video.id)).dir).toBe(video.dir)
    expect((await findVideo('monthly REPORT')).id).toBe(video.id)
  })

  test('says which ones match when several do, and what there is when none does', async () => {
    await newVideo('Invite a teammate')
    await newVideo('Invite a guest')
    await expect(findVideo('invite')).rejects.toThrow(/Several videos match "invite"/)
    await expect(findVideo('nothing like it')).rejects.toThrow(/No video matches/)
  })
})

describe('takes', () => {
  test('are numbered, and only the last few are kept', async () => {
    const video = await newVideo('Takes')
    for (let i = 0; i < 4; i++) {
      const dir = await newRun(video, 'takes')
      await writeFile(join(dir, 'footage.json'), '{}')
      await pruneRuns(video, 'takes', 3)
    }
    expect((await readdir(join(video.dir, 'takes'))).sort()).toEqual(['2', '3', '4'])
    expect((await latestTake(video)).n).toBe(4)
  })

  test("aren't lost to a new one that never finishes, even keeping only one", async () => {
    const video = await newVideo('Keep one')
    const good = await newRun(video, 'takes')
    await writeFile(join(good, 'footage.json'), '{}')
    await pruneRuns(video, 'takes', 1)
    await newRun(video, 'takes')
    expect((await latestTake(video)).n).toBe(1)
  })

  test("skip a take that never finished, and say when there isn't one", async () => {
    const video = await newVideo('Unfinished')
    await expect(latestTake(video)).rejects.toThrow(/has no takes yet/)
    const done = await newRun(video, 'takes')
    await writeFile(join(done, 'footage.json'), '{}')
    await mkdir(join(video.dir, 'takes', '2'))
    expect((await latestTake(video)).n).toBe(1)
  })
})

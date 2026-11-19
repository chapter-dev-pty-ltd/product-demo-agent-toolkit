import { describe, expect, test } from 'vitest'
import { musicGraph } from './cut.ts'

const track = { file: 'track.mp3', length: 120, volume: 0.25 }

describe('musicGraph', () => {
  test('a track longer than the video plays once, cut to the video and faded out', () => {
    expect(musicGraph({ ...track, fade: 2 }, 1, 25)).toEqual([
      '[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.25,atrim=0:25.000,afade=t=out:st=23.000:d=2[music]',
    ])
  })

  test('a video longer than the track loops it, crossfading a second at each join', () => {
    const graph = musicGraph(track, 3, 300)
    expect(graph[0]).toBe('[3:a]asplit=3[m0][m1][m2]')
    expect(graph[1]).toBe('[m0][m1]acrossfade=d=1:c1=tri:c2=tri[l1]')
    expect(graph[2]).toBe('[l1][m2]acrossfade=d=1:c1=tri:c2=tri[l2]')
    expect(graph[3]).toMatch(/^\[l2\].*atrim=0:300\.000,afade=t=out:st=298\.000:d=2\[music\]$/)
  })

  test('a fade longer than the video fades over the whole video', () => {
    expect(musicGraph({ ...track, fade: 5 }, 1, 3)[0]).toContain('afade=t=out:st=0.000:d=3')
  })
})

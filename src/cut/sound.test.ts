import { describe, expect, test } from 'vitest'
import { soundArgs, type Track } from './cut.ts'

const click: Track = { files: ['/sounds/click.wav'], times: [1], volume: 1, vary: false }
const music = { file: '/music/lofi.mp3', length: 60, volume: 0.4 }
const graph = (args: string[]) => args[args.indexOf('-filter_complex') + 1]

describe('soundArgs', () => {
  test('counts inputs after the video in a cut', () => {
    const args = soundArgs([click], 10)
    expect(graph(args)).toContain('[1:a]volume=1,asplit=1[s0_0]')
    expect(args).toEqual(expect.arrayContaining(['-map', '0:v']))
    expect(graph(args)).toContain('alimiter=limit=0.89[a]')
  })

  test('counts inputs from the first in a stem, which has no video', () => {
    const args = soundArgs([click], 10, undefined, true)
    expect(graph(args)).toContain('[0:a]volume=1,asplit=1[s0_0]')
    expect(args).not.toContain('0:v')
    expect(graph(args)).toContain('volume=0.5[a]')
    expect(graph(args)).not.toContain('alimiter')
  })

  test('puts the music first and the sounds after it', () => {
    expect(graph(soundArgs([click], 10, music))).toContain('[2:a]volume=1')
    expect(graph(soundArgs([click], 10, music))).toMatch(/^\[1:a\]/)
    expect(graph(soundArgs([click], 10, music, true))).toContain('[1:a]volume=1')
    expect(graph(soundArgs([click], 10, music, true))).toMatch(/^\[0:a\]/)
  })

  test('nothing to play is no sound at all', () => {
    expect(soundArgs([{ ...click, times: [] }], 10, undefined, true)).toEqual([])
  })
})

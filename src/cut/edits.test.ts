import { expect, test } from 'vitest'
import type { Film } from '../film.ts'
import type { Footage } from '../perform.ts'
import { filmEdits, planEdit, retime, toTake, toVideo, type Edit } from './edits.ts'
import { fromTrack, trackToVideo, videoToTrack } from '../../studio/time.ts'

const cut: Edit = { from: 10, to: 15, step: 0, speed: 'cut' }
const fast: Edit = { from: 20, to: 30, step: 1, speed: 4 }

const footage: Footage = {
  film: { app: 'http://localhost', steps: [] },
  source: '',
  frames: [
    { file: 'a.jpg', at: 100 },
    { file: 'b.jpg', at: 111 },
    { file: 'c.jpg', at: 116 },
  ],
  pointer: [{ at: 100, x: 0, y: 0 }],
  clicks: [
    { at: 112, x: 0, y: 0 },
    { at: 124, x: 0, y: 0 },
  ],
  keys: [{ at: 113, key: 'a' }],
  addresses: [],
  lines: [],
  highlights: [{ step: 0, at: 110, until: 115, box: [0, 0, 1, 1] }],
  steps: [{ at: 100 }, { at: 105 }, { at: 112 }, { at: 120 }],
  viewport: { width: 1440, height: 900 },
  end: 140,
  warnings: [],
}

test('take time to video time and back, with a cut join ending before the cut and starting after it', () => {
  const takeTimes = [5, 18, 24, 40]
  const videoTimes = takeTimes.map((at) => toVideo([cut, fast], at))
  expect(videoTimes).toEqual([5, 13, 16, 27.5])
  expect(videoTimes.map((at) => toTake([cut, fast], at))).toEqual(takeTimes)
  expect(toTake([cut], 10)).toBe(15)
  expect(toTake([cut], 10, true)).toBe(10)
})

test('a cover holds the video at its moment of the take, and maps back to that moment', () => {
  const holds = [{ at: 12, hold: 2 }]
  expect(toVideo([cut], 12, holds)).toBe(12)
  expect(toVideo([cut], 20, holds)).toBe(17)
  expect(toTake([cut], 11, false, holds)).toBe(12)
  expect(toTake([cut], 17, false, holds)).toBe(20)
})

test("the studio's timeline gives a cover its own length, and maps through it both ways", () => {
  const holds = [
    { at: 0, hold: 2 },
    { at: 18, hold: 3 },
  ]
  expect([0, 1, 2, 22, 25].map((x) => trackToVideo([cut], holds, x))).toEqual([0, 1, 2, 17, 20])
  expect([0, 1, 2, 17, 20].map((t) => videoToTrack([cut], holds, t))).toEqual([0, 1, 2, 22, 25])
  expect(fromTrack(holds, 21)).toBe(18)
})

test('retiming moves what is kept and drops sounds and highlights inside a cut', () => {
  const out = retime(footage, [cut, fast])
  expect(out.frames.map((f) => f.at)).toEqual([100, 110, 111])
  expect(out.clicks.map((c) => c.at)).toEqual([116])
  expect(out.keys).toEqual([])
  expect(out.highlights).toEqual([])
  expect(out.end).toBe(127.5)
})

test('a part of the video becomes edits on the steps it spans, read back to the same part', () => {
  const steps = [{ wait: 1 }, { wait: 1 }, { wait: 1 }, { wait: 1 }]
  const film: Film = { app: 'http://localhost', steps }
  const plan = planEdit(film, footage, { from: 3, to: 14, cut: true })
  expect([...plan]).toEqual([
    [0, { cut: { from: 3 } }],
    [1, { cut: true }],
    [2, { cut: { to: 2 } }],
  ])
  const edited = { ...film, steps: steps.map((s, i) => ({ ...s, ...plan.get(i) })) }
  const edits = filmEdits(edited, footage)
  expect(edits.map((e) => [e.from, e.to])).toEqual([
    [3, 5],
    [5, 12],
    [12, 14],
  ])
  expect(toVideo(edits, 14)).toBe(3)
})

test('moving an edit keeps how much of the take it covers, and stops short of another edit', () => {
  const film: Film = {
    app: 'http://localhost',
    steps: [
      { wait: 1, speed: { by: 4, from: 1, to: 3 } },
      { wait: 1 },
      { wait: 1, cut: true },
      { wait: 1 },
    ],
  }
  expect([...planEdit(film, footage, { steps: [0], by: 5 })]).toEqual([
    [0, undefined],
    [1, { speed: { by: 4, from: 1, to: 3 } }],
  ])
  expect(() => planEdit(film, footage, { steps: [0], by: 10 })).toThrow(/Step 3 already has/)
})

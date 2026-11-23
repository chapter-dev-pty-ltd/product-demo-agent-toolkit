// A take's recording, and the video made from it, which its cuts and speed-ups shorten.
// Shared by the server and the studio page, so the two always agree on where a moment is.

export interface Span {
  from: number
  to: number
  speed: number | 'cut'
}

const SAME = 1e-3
const rate = (span: Span) => (span.speed === 'cut' ? Infinity : span.speed)

// Time the video has that the take doesn't: a scene's cover, held at a moment of the take.
export interface Hold {
  at: number
  hold: number
  title?: string
}

export function toVideo(spans: Span[], at: number, holds: Hold[] = []): number {
  let removed = 0
  for (const s of spans) {
    if (at <= s.from) break
    removed += (Math.min(at, s.to) - s.from) * (1 - 1 / rate(s))
  }
  return holds.reduce((t, h) => (h.at <= at ? t + h.hold : t), at - removed)
}

// A moment on a cut's join is both the end of what's before it and the start of what's after:
// a range ending there keeps the cut, one starting there begins after it.
export function toTake(spans: Span[], at: number, end = false, holds: Hold[] = []): number {
  let held = 0
  for (const h of holds) {
    const from = toVideo(spans, h.at) + held
    if (at < from) break
    if (at < from + h.hold) return h.at
    held += h.hold
  }
  at -= held
  let shift = 0
  for (const s of spans) {
    const from = s.from - shift
    const length = (s.to - s.from) / rate(s)
    if (at < from - SAME || (end && at <= from + SAME)) return Math.min(at + shift, s.from)
    if (at < from + length) return s.from + (at - from) * rate(s)
    shift += s.to - s.from - length
  }
  return at + shift
}

// The studio's timeline: the take, with each cover given its own length where it's held, so the
// playhead moves through a cover as it plays. A moment inside a cover is the take's at that cover.
export function toTrack(holds: Hold[], at: number): number {
  return holds.reduce((x, h) => (h.at <= at ? x + h.hold : x), at)
}

export function fromTrack(holds: Hold[], x: number): number {
  let held = 0
  for (const h of holds) {
    const from = h.at + held
    if (x < from) break
    if (x < from + h.hold) return h.at
    held += h.hold
  }
  return x - held
}

export function videoToTrack(spans: Span[], holds: Hold[], at: number): number {
  let held = 0
  for (const h of holds) {
    const from = toVideo(spans, h.at, holds) - h.hold
    if (at < from) break
    if (at < from + h.hold) return h.at + held + (at - from)
    held += h.hold
  }
  return toTrack(holds, toTake(spans, at, false, holds))
}

export function trackToVideo(spans: Span[], holds: Hold[], x: number): number {
  let held = 0
  for (const h of holds) {
    const from = h.at + held
    if (x < from) break
    if (x < from + h.hold) return toVideo(spans, h.at, holds) - h.hold + (x - from)
    held += h.hold
  }
  return toVideo(spans, x - held, holds)
}

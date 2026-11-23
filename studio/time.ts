// A take's recording, and the video made from it, which its cuts and speed-ups shorten.
// Shared by the server and the studio page, so the two always agree on where a moment is.

export interface Span {
  from: number
  to: number
  speed: number | 'cut'
}

const SAME = 1e-3
const rate = (span: Span) => (span.speed === 'cut' ? Infinity : span.speed)

export function toVideo(spans: Span[], at: number): number {
  let removed = 0
  for (const s of spans) {
    if (at <= s.from) break
    removed += (Math.min(at, s.to) - s.from) * (1 - 1 / rate(s))
  }
  return at - removed
}

// A moment on a cut's join is both the end of what's before it and the start of what's after:
// a range ending there keeps the cut, one starting there begins after it.
export function toTake(spans: Span[], at: number, end = false): number {
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

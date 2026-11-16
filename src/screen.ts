import { inflateSync } from 'node:zlib'
import type { CDPSession, Page } from 'playwright-core'

// Watching the screen itself, the way a viewer does: a tiny copy of the screen, split into a
// grid of cells, each compared with the one before. A cell changed when its average brightness
// moved. It sees what the page's code doesn't say: an animated loading image, a picture
// popping in, a panel sliding open. The copies come from a screencast of their own, which
// sends one whenever the page repaints and, unlike a screenshot, never disturbs the page.

/** How many page pixels a cell is across: the copy is an eighth of the size, 6px a cell. */
export const CELL = 48
const SCALE = 1 / 8
/** How often the newest copy is looked at. */
const TICK_MS = 100
/** How long samples are kept: enough to see what was changing before an action. */
const KEEP_MS = 3000

/** One look: when, and which cells changed since the last. */
export interface Sample {
  at: number
  changed: Set<number>
}

export interface ScreenWatch {
  samples: Sample[]
  /** How many cells there are across and down, for working out which cells a box covers. */
  cols: number
  rows: number
}

/** Watches the screen for as long as the page is open. */
export function watchScreen(page: Page): ScreenWatch {
  const size = page.viewportSize() ?? { width: 1440, height: 900 }
  const watched: ScreenWatch = {
    samples: [],
    cols: Math.floor(size.width / CELL),
    rows: Math.floor(size.height / CELL),
  }
  let before: number[] | undefined
  // The newest copy not yet looked at: looked at on the next tick, so the last change is
  // always seen, however fast they come.
  let newest: string | undefined
  const look = (data: string) => {
    const now = performance.now()
    const cells = brightness(decodePng(Buffer.from(data, 'base64')), CELL * SCALE)
    const changed = new Set<number>()
    if (before) cells.forEach((v, i) => Math.abs(v - (before?.[i] ?? v)) > 4 && changed.add(i))
    before = cells
    watched.samples.push({ at: now, changed })
    const old = watched.samples.findIndex((s) => now - s.at < KEEP_MS)
    if (old > 0) watched.samples.splice(0, old)
  }
  void (async () => {
    const session: CDPSession = await page.context().newCDPSession(page)
    session.on('Page.screencastFrame', (frame) => {
      void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      newest = frame.data
    })
    await session.send('Page.startScreencast', {
      format: 'png',
      maxWidth: Math.round(size.width * SCALE),
      maxHeight: Math.round(size.height * SCALE),
    })
    while (!page.isClosed()) {
      if (newest) {
        const data = newest
        newest = undefined
        try {
          look(data)
        } catch {}
      }
      await new Promise((done) => setTimeout(done, TICK_MS))
    }
  })().catch(() => {})
  return watched
}

/** The cells a box covers, in page pixels. */
export function cellsIn(box: number[], cols: number, rows: number): number[] {
  const [x = 0, y = 0, width = 0, height = 0] = box
  const out: number[] = []
  for (
    let row = Math.max(0, Math.floor(y / CELL));
    row <= Math.min(rows - 1, Math.floor((y + height) / CELL));
    row++
  ) {
    for (
      let col = Math.max(0, Math.floor(x / CELL));
      col <= Math.min(cols - 1, Math.floor((x + width) / CELL));
      col++
    ) {
      out.push(row * cols + col)
    }
  }
  return out
}

interface Picture {
  width: number
  height: number
  channels: number
  pixels: Buffer
}

/** Each cell's average brightness, row by row. */
function brightness(picture: Picture, size: number): number[] {
  const cols = Math.floor(picture.width / size)
  const rows = Math.floor(picture.height / size)
  const out: number[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let sum = 0
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = ((row * size + y) * picture.width + col * size + x) * picture.channels
          sum +=
            (picture.pixels[i] ?? 0) + (picture.pixels[i + 1] ?? 0) + (picture.pixels[i + 2] ?? 0)
        }
      }
      out.push(sum / (3 * size * size))
    }
  }
  return out
}

/** Reads the 8-bit RGB or RGBA PNG Chrome takes screenshots as. */
export function decodePng(file: Buffer): Picture {
  let at = 8
  let width = 0
  let height = 0
  let channels = 4
  const data: Buffer[] = []
  while (at < file.length) {
    const length = file.readUInt32BE(at)
    const type = file.toString('ascii', at + 4, at + 8)
    const chunk = file.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      channels = chunk[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') data.push(chunk)
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  // Each row is filtered against the one above and the pixel to its left; undo that.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0
      const up = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0
      const corner = x >= channels && y > 0 ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0
      let value = raw[y * (stride + 1) + 1 + x] ?? 0
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const guess = left + up - corner
        const [a, b, c] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - corner)]
        value += a <= b && a <= c ? left : b <= c ? up : corner
      }
      pixels[y * stride + x] = value & 255
    }
  }
  return { width, height, channels, pixels }
}

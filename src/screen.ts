import { inflateSync } from 'node:zlib'
import type { CDPSession, Page } from 'playwright-core'

export const CELL = 48
const SCALE = 1 / 8
const TICK_MS = 100
const KEEP_MS = 3000

export interface Sample {
  at: number
  changed: Set<number>
}

export interface ScreenWatch {
  samples: Sample[]
  cols: number
  rows: number
}

export function watchScreen(page: Page): ScreenWatch {
  const size = page.viewportSize() ?? { width: 1440, height: 900 }
  const watched: ScreenWatch = {
    samples: [],
    cols: Math.floor(size.width / CELL),
    rows: Math.floor(size.height / CELL),
  }
  let before: number[] | undefined
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

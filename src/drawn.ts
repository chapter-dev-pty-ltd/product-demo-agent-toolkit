import type { Page } from 'playwright-core'

export interface Drawn {
  x: number
  y: number
  width: number
  height: number
  colour: string
  grip: { x: number; y: number }
}

export async function findDrawn(page: Page): Promise<Drawn[]> {
  const surfaces = await page.evaluate(scan, null).catch(() => [])
  if (!surfaces.length) return []
  const png = (await page.screenshot()).toString('base64')
  return page.evaluate(scan, png).catch(() => [])
}

async function scan(png: string | null): Promise<Drawn[]> {
  const W = innerWidth
  const H = innerHeight
  const CELL = 4
  const large = (el: Element) => {
    const r = el.getBoundingClientRect()
    const w = Math.min(r.right, W) - Math.max(r.left, 0)
    const h = Math.min(r.bottom, H) - Math.max(r.top, 0)
    return w > 0 && h > 0 && w * h >= W * H * 0.1
  }
  const candidates = [...document.querySelectorAll('body *')].filter(
    (el) =>
      !el.closest('[data-product-demo]') &&
      (el.tagName === 'CANVAS' || getComputedStyle(el).touchAction === 'none') &&
      large(el),
  )
  const surfaces = candidates.filter((el) => !candidates.some((o) => o !== el && o.contains(el)))
  const none = { x: 0, y: 0, width: 0, height: 0, colour: '', grip: { x: 0, y: 0 } }
  if (!png) return surfaces.map(() => none)

  const CONTROLS =
    'button,a[href],input,select,textarea,[role=button],[role=toolbar],[role=menu],[role=dialog],[role=tablist],[role=listbox],[role=radiogroup],[role=slider]'
  const hits = new Map<number, Element | null>()
  const hitAt = (x: number, y: number) => {
    const key = Math.floor(y / 8) * 10_000 + Math.floor(x / 8)
    if (!hits.has(key))
      hits.set(
        key,
        document.elementFromPoint((key % 10_000) * 8 + 4, Math.floor(key / 10_000) * 8 + 4),
      )
    return hits.get(key) ?? null
  }
  const known = new Map<Element, boolean>()
  const drawnOn = (hit: Element | null) => {
    if (!hit) return false
    const seen = known.get(hit)
    if (seen !== undefined) return seen
    let result = false
    for (let node: Element | null = hit; node; node = node.parentElement) {
      if (surfaces.includes(node)) {
        result = true
        break
      }
      if (node.matches(CONTROLS) || node.querySelector(CONTROLS)) break
    }
    known.set(hit, result)
    return result
  }

  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const context = canvas.getContext('2d')
  if (!context) return []
  context.drawImage(bitmap, 0, 0)
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
  const scale = bitmap.width / W
  const rgb = (x: number, y: number) => {
    const i = (Math.floor(y * scale) * bitmap.width + Math.floor(x * scale)) * 4
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0] as const
  }
  const key = ([r, g, b]: readonly number[]) =>
    ((r ?? 0) >> 4) * 256 + ((g ?? 0) >> 4) * 16 + ((b ?? 0) >> 4)

  const cols = Math.ceil(W / CELL)
  const rows = Math.ceil(H / CELL)
  const on = new Uint8Array(cols * rows)
  const blocked = new Uint8Array(cols * rows)
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[data-product-demo]') || surfaces.some((s) => s.contains(el) || el.contains(s)))
      continue
    const own =
      el.matches(CONTROLS) ||
      el.tagName === 'IMG' ||
      el.tagName.toLowerCase() === 'svg' ||
      [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
    const r = el.getBoundingClientRect()
    if (!own || r.width * r.height > W * H * 0.25 || !el.checkVisibility()) continue
    for (
      let row = Math.max(0, Math.floor((r.top - 6) / CELL));
      row <= Math.min(rows - 1, (r.bottom + 6) / CELL);
      row++
    )
      for (
        let col = Math.max(0, Math.floor((r.left - 6) / CELL));
        col <= Math.min(cols - 1, (r.right + 6) / CELL);
        col++
      )
        blocked[row * cols + col] = 1
  }
  const counts = new Map<number, { n: number; colour: readonly number[] }>()
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * CELL + CELL / 2
      const y = row * CELL + CELL / 2
      if (blocked[row * cols + col] || !drawnOn(hitAt(x, y))) continue
      on[row * cols + col] = 1
      const colour = rgb(x, y)
      const count = counts.get(key(colour)) ?? { n: 0, colour }
      count.n++
      counts.set(key(colour), count)
    }
  }
  const background = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.colour
  if (!background) return []
  const away = (c: readonly number[]) =>
    Math.abs((c[0] ?? 0) - (background[0] ?? 0)) +
    Math.abs((c[1] ?? 0) - (background[1] ?? 0)) +
    Math.abs((c[2] ?? 0) - (background[2] ?? 0))

  const ink = new Map<number, { colour: readonly number[]; x: number; y: number }>()
  for (let i = 0; i < on.length; i++) {
    if (!on[i]) continue
    const left = (i % cols) * CELL
    const top = Math.floor(i / cols) * CELL
    let most: { colour: readonly number[]; x: number; y: number } | undefined
    let far = 60
    for (let y = top; y < Math.min(top + CELL, H); y++) {
      for (let x = left; x < Math.min(left + CELL, W); x++) {
        const c = rgb(x, y)
        if (away(c) > far) {
          far = away(c)
          most = { colour: c, x, y }
        }
      }
    }
    if (most) ink.set(i, most)
  }

  const found: Drawn[] = []
  const done = new Set<number>()
  for (const start of ink.keys()) {
    if (done.has(start)) continue
    const cells = [start]
    done.add(start)
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k] ?? 0
      const col = i % cols
      for (const d of [-cols - 1, -cols, -cols + 1, -1, 1, cols - 1, cols, cols + 1]) {
        const j = i + d
        if (Math.abs((j % cols) - col) > 1 || done.has(j) || !ink.has(j)) continue
        done.add(j)
        cells.push(j)
      }
    }
    const xs = cells.map((i) => (i % cols) * CELL)
    const ys = cells.map((i) => Math.floor(i / cols) * CELL)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    const width = Math.min(Math.max(...xs) + CELL, W) - x
    const height = Math.min(Math.max(...ys) + CELL, H) - y
    if (width < 16 && height < 16) continue
    const tally = new Map<number, { n: number; colour: readonly number[] }>()
    for (const i of cells) {
      const colour = ink.get(i)?.colour ?? []
      const t = tally.get(key(colour)) ?? { n: 0, colour }
      t.n++
      tally.set(key(colour), t)
    }
    const [r = 0, g = 0, b = 0] = [...tally.values()].sort((p, q) => q.n - p.n)[0]?.colour ?? []
    const middle = { x: x + width / 2, y: y + height / 2 }
    const nearest = cells.reduce(
      (best, i) => {
        const at = ink.get(i) ?? best
        return Math.hypot(at.x - middle.x, at.y - middle.y) <
          Math.hypot(best.x - middle.x, best.y - middle.y)
          ? { x: at.x, y: at.y }
          : best
      },
      { x: Infinity, y: Infinity },
    )
    const colour = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
    found.push({ x, y, width, height, colour, grip: nearest })
  }
  return found.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 40)
}

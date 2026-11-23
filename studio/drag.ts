import type { StudioState } from './api.ts'
import type { Player } from './player.ts'
import { $ } from './ui.ts'

const SNAP = 16

type Point = { x: number; y: number }

export function createDrag(
  state: StudioState,
  player: Player,
  drop: (x: number | null, y: number | null) => void,
): void {
  const { width, height } = state.canvas
  const grab = document.createElement('div')
  grab.id = 'grab'
  grab.innerHTML = '<i class="guide v"></i><i class="guide h"></i>'
  $('screen').appendChild(grab)
  const [vertical, horizontal] = grab.querySelectorAll('.guide')

  const parts = () => {
    const doc = player.frame?.contentDocument
    const app = doc?.getElementById('window')
    if (!doc || !app) return
    const glass = doc.getElementById('glass')
    return {
      app,
      glass,
      frost: doc.getElementById('frost'),
      box: (glass ?? app).getBoundingClientRect(),
    }
  }
  const toCanvas = (e: PointerEvent): Point => {
    const r = grab.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) / r.width) * width,
      y: ((e.clientY - r.top) / r.height) * height,
    }
  }
  const inside = (p: Point, b: DOMRect) =>
    p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom
  const clamp = (n: number, max: number) => Math.max(-max, Math.min(max, n))

  let drag:
    | (NonNullable<ReturnType<typeof parts>> & {
        from: Point
        at: Point
        centred: { x: boolean; y: boolean }
        moved: boolean
      })
    | undefined

  grab.onpointerdown = (e) => {
    const found = parts()
    const from = toCanvas(e)
    if (!found || !inside(from, found.box)) return
    e.preventDefault()
    const at = { x: found.box.left, y: found.box.top }
    drag = { ...found, from, at, centred: { x: false, y: false }, moved: false }
    grab.setPointerCapture(e.pointerId)
    grab.style.cursor = 'grabbing'
    grab.classList.add('dragging')
  }
  grab.ondragstart = (e) => e.preventDefault()
  grab.onpointermove = (e) => {
    const p = toCanvas(e)
    if (!drag) {
      const found = parts()
      grab.style.cursor = found && inside(p, found.box) ? 'grab' : ''
      return
    }
    const { box } = drag
    const mid = { x: (width - box.width) / 2, y: (height - box.height) / 2 }
    let x = clamp(box.left + p.x - drag.from.x, width)
    let y = clamp(box.top + p.y - drag.from.y, height)
    drag.centred = { x: Math.abs(x - mid.x) < SNAP, y: Math.abs(y - mid.y) < SNAP }
    if (drag.centred.x) x = mid.x
    if (drag.centred.y) y = mid.y
    vertical?.classList.toggle('snapped', drag.centred.x)
    horizontal?.classList.toggle('snapped', drag.centred.y)
    drag.at = { x, y }
    drag.moved = true
    const dx = x - box.left
    const dy = y - box.top
    drag.app.style.translate = `${dx}px ${dy}px`
    if (drag.glass) drag.glass.style.translate = `${dx}px ${dy}px`
    // The frost is the backdrop blurred behind the glass, so it stays put as the glass moves.
    if (drag.frost) drag.frost.style.translate = `${-dx}px ${-dy}px`
  }
  const end = () => {
    const was = drag
    drag = undefined
    grab.style.cursor = 'grab'
    grab.classList.remove('dragging')
    return was
  }
  grab.onpointercancel = () => {
    const was = end()
    for (const el of [was?.app, was?.glass, was?.frost]) el?.style.removeProperty('translate')
  }
  grab.onpointerup = () => {
    const was = end()
    if (!was) return
    const { at, centred, moved } = was
    if (moved) drop(centred.x ? null : Math.round(at.x), centred.y ? null : Math.round(at.y))
  }
}

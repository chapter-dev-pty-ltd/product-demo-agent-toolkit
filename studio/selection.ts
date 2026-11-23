import type {
  CoverRequest,
  EditRequest,
  HighlightRequest,
  PageSettings,
  ShownCover,
  ShownEdit,
  SoundRequest,
  StudioState,
} from './api.ts'
import type { Player } from './player.ts'
import { createPopover, type Target } from './popover.ts'
import { toVideo } from './time.ts'
import type { View } from './timeline.ts'
import { $ } from './ui.ts'

export interface Selection {
  drag(down: PointerEvent, clip: HTMLElement, edit: ShownEdit): void
  resize(down: PointerEvent, clip: HTMLElement, cover: ShownCover): void
  clear(): void
  // Called before the lanes are redrawn; what it returns selects the same item again after.
  keep(): () => void
  musicChanged(): void
}

interface MusicControl {
  get(): PageSettings['music']
  set(music: PageSettings['music']): void
}

// A selected cover opens its page, and unselecting it closes the page.
export interface CoverPages {
  open(scene: number): void
  close(): void
}

// What's selected on the timeline (an item, or a range shift-dragged across it), its popover,
// and the changes made from there.
export function createSelection(
  view: View,
  player: Player,
  state: StudioState,
  music: MusicControl,
  cover: CoverPages,
): Selection {
  const { el } = view
  const video = (at: number) => toVideo(view.data.edits, at, view.data.holds)

  const post = async (
    path: string,
    request: EditRequest | HighlightRequest | SoundRequest | CoverRequest,
  ) => {
    const res = await fetch(path, { method: 'POST', body: JSON.stringify(request) })
    if (res.ok) return !($('export-status').textContent = '')
    const message = await res.text()
    if (popover.target) popover.note(message)
    else $('export-status').textContent = message
    return false
  }
  const edit = (request: EditRequest) => {
    if ('from' in request && 'cut' in request) void player.seek(video(request.from))
    return post('/studio/edits', request)
  }
  const popover = createPopover(el, state, {
    edit: (request) => void edit(request),
    highlight: (request) => void post('/studio/highlight', request),
    sound: (request) => void post('/studio/sound', request),
    music: music.get,
    setMusic: music.set,
  })

  let range: { a: number; b: number } | null = null
  let picked: string | null = null
  // A wide item, like the music, points its popover at the moment it was clicked, not its middle.
  let pickedAt: number | undefined
  const ranged = () =>
    range && Math.abs(range.b - range.a) > 0.05
      ? { from: Math.min(range.a, range.b), to: Math.max(range.a, range.b) }
      : null
  const showPicked = () => {
    for (const item of el.querySelectorAll<HTMLElement>('[data-key]'))
      item.classList.toggle('picked', item.dataset.key === picked)
  }
  const placeRange = () => {
    const at = ranged()
    $('selection').hidden = !at
    if (!at) return
    const lane = $('ruler').getBoundingClientRect()
    const box = el.getBoundingClientRect()
    $('selection').style.left = lane.left - box.left + view.frac(at.from) * lane.width + 'px'
    $('selection').style.width = (view.frac(at.to) - view.frac(at.from)) * lane.width + 'px'
  }
  window.addEventListener('resize', placeRange)
  // Not closing a cover's page just to redraw the lanes.
  const clear = (closing = true) => {
    const was = picked
    range = null
    picked = null
    placeRange()
    showPicked()
    popover.hide()
    if (closing && was?.startsWith('cover:')) cover.close()
  }
  const setRange = (next: { a: number; b: number }, open: boolean) => {
    clear()
    range = next
    placeRange()
    const at = ranged()
    if (open && at)
      popover.show({ kind: 'range', ...at }, () => $('selection').getBoundingClientRect())
  }

  const targetOf = (key: string): Target | undefined => {
    const { data } = view
    const [kind, id = ''] = key.split(':')
    if (kind === 'music') return { kind: 'music' }
    if (kind === 'click') {
      const c = data.clicks[Number(id)]
      return c?.step === undefined ? undefined : { kind: 'click', step: c.step, muted: c.muted }
    }
    if (kind === 'highlight') {
      const highlight = data.highlights.find((h) => String(h.step) === id)
      return highlight && { kind: 'highlight', highlight }
    }
    const shown = data.edits.find((e) => e.steps.join(',') === id)
    return shown && { kind: 'edit', edit: shown }
  }
  const pick = (item: HTMLElement, at?: number) => {
    const key = item.dataset.key
    if (key?.startsWith('cover:')) {
      clear(false)
      picked = key
      showPicked()
      return cover.open(Number(key.slice(6)))
    }
    const target = key && targetOf(key)
    if (!key || !target) return clear()
    clear()
    picked = key
    pickedAt = at
    showPicked()
    popover.show(target, () => {
      if (!item.isConnected) return undefined
      const box = item.getBoundingClientRect()
      if (at === undefined || !view.length) return box
      const lane = $('ruler').getBoundingClientRect()
      const x = lane.left + view.frac(at) * lane.width
      return new DOMRect(Math.min(Math.max(x, box.left), box.right), box.top, 0, box.height)
    })
  }

  const drag = (down: PointerEvent, clip: HTMLElement, e: ShownEdit) => {
    down.stopPropagation()
    const end = (down.target as HTMLElement).dataset.end
    const perSecond = $('ruler').getBoundingClientRect().width / view.span
    const was = { left: clip.style.left, width: clip.style.width }
    const back = () => Object.assign(clip.style, was)
    const fit = (by: number, low: number, high: number) => Math.min(Math.max(by, low), high)
    let by = 0
    clip.setPointerCapture(down.pointerId)
    clip.classList.add('dragging')
    clip.onpointermove = (move) => {
      by = (move.clientX - down.clientX) / perSecond
      if (Math.abs(by * perSecond) >= 3) popover.hide()
      if (end === 'from') by = fit(by, -e.from, e.to - e.from - 0.1)
      else if (end === 'to') by = fit(by, e.from - e.to + 0.1, view.length - e.to)
      else by = fit(by, -e.from, view.length - e.to)
      const from = end === 'to' ? e.from : e.from + by
      clip.style.left = view.pct(from)
      clip.style.width = view.width(from, end === 'from' ? e.to : e.to + by)
    }
    clip.onpointerup = () => {
      clip.onpointermove = clip.onpointerup = null
      clip.classList.remove('dragging')
      if (Math.abs(by * perSecond) < 3) {
        back()
        void player.seek(video(e.from))
        return pick(clip)
      }
      const request: EditRequest = end
        ? {
            steps: e.steps,
            from: e.from + (end === 'from' ? by : 0),
            to: e.to + (end === 'to' ? by : 0),
          }
        : { steps: e.steps, by }
      void edit(request).then((ok) => ok || back())
    }
  }

  // A press on a cover's end that doesn't move picks the cover.
  const resize = (down: PointerEvent, clip: HTMLElement, cover: ShownCover) => {
    down.stopPropagation()
    const perSecond = $('ruler').getBoundingClientRect().width / view.span
    const was = clip.style.width
    let hold = cover.hold
    clip.setPointerCapture(down.pointerId)
    clip.classList.add('dragging')
    clip.onpointermove = (move) => {
      const by = (move.clientX - down.clientX) / perSecond
      hold = Math.min(10, Math.max(0.5, Math.round((cover.hold + by) * 10) / 10))
      clip.style.width = `calc(${view.along(hold)} - 2px)`
    }
    clip.onpointerup = () => {
      clip.onpointermove = clip.onpointerup = null
      clip.classList.remove('dragging')
      if (hold === cover.hold) return pick(clip)
      void post('/studio/cover', { scene: cover.scene, hold }).then(
        (ok) => ok || void (clip.style.width = was),
      )
    }
  }

  document.addEventListener('keydown', (e) => {
    // Only keys meant for the timeline: not ones typed in the chat, the export dialog or elsewhere.
    if (e.target !== document.body && !el.contains(e.target as Node)) return
    if (!popover.target && !ranged() && !picked) return
    if (e.code === 'Escape') clear()
    if (e.code === 'Backspace' || e.code === 'Delete') {
      e.preventDefault()
      popover.remove()
    }
  })

  // What the press that's down started on; a release only acts on a press the timeline took.
  let pressedOn: 'range' | { x: number; item: HTMLElement | null } | null = null
  const scrubTo = (e: PointerEvent) => void player.seek(view.videoAt(e))
  // A press on the timeline is where keys go next, even when it lands on an item that can't take
  // focus; caught before an edit's own handler, which stops the press going further.
  el.addEventListener(
    'pointerdown',
    () => {
      if (!el.contains(document.activeElement))
        (document.activeElement as HTMLElement | null)?.blur()
    },
    true,
  )
  el.addEventListener('pointerdown', (e) => {
    pressedOn = null
    const target = e.target as HTMLElement
    if (target.closest('#popover')) return
    if (e.clientX < $('ruler').getBoundingClientRect().left) return
    el.setPointerCapture(e.pointerId)
    if (e.shiftKey) {
      const at = view.timeAt(e)
      setRange({ a: at, b: at }, false)
      el.onpointermove = (m) => setRange({ a: at, b: view.timeAt(m) }, false)
      pressedOn = 'range'
      return
    }
    const item = target.closest<HTMLElement>('[data-key]')
    pressedOn = { x: e.clientX, item }
    if (!item) clear()
    scrubTo(e)
    el.onpointermove = scrubTo
  })
  el.addEventListener('pointerup', (e) => {
    el.onpointermove = null
    const pressed = pressedOn
    pressedOn = null
    if (!pressed) return
    if (pressed === 'range') {
      if (range && ranged()) setRange(range, true)
      return
    }
    const { x, item } = pressed
    if (item && Math.abs(e.clientX - x) < 3) pick(item, view.timeAt(e))
    else if (item) clear()
  })

  return {
    drag,
    resize,
    clear: () => clear(),
    keep: () => {
      const [key, at] = [picked, pickedAt]
      clear(false)
      return () => {
        const again = key ? el.querySelector<HTMLElement>(`[data-key="${key}"]`) : null
        if (again) pick(again, at)
      }
    },
    musicChanged: () => {
      if (popover.target?.kind === 'music') popover.refresh()
    },
  }
}

import type { Stage, StageData, StudioState } from './api.ts'
import type { Mixer } from './audio.ts'
import { $, clock, pressed } from './ui.ts'

const ICON_PLAY =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.3-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z"/></svg>'
const ICON_PAUSE =
  '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" rx=".8"/><rect x="9.5" y="2.5" width="3" height="11" rx=".8"/></svg>'

export interface Player {
  readonly t: number
  readonly length: number
  readonly frame: HTMLIFrameElement | undefined
  seek(to: number): Promise<void>
  reload(fresh?: boolean): void
  sound(): void
  onLoad(fn: (data: StageData) => void): void
  onShow(fn: () => void): void
}

const stageOf = (frame: HTMLIFrameElement): Stage =>
  (frame.contentWindow as unknown as { stage: Stage }).stage

export function createPlayer(state: StudioState, mixer: Mixer, from: number): Player {
  const { width, height } = state.canvas
  const viewer = $('viewer')
  const screen = $('screen')
  const loaded: ((data: StageData) => void)[] = []
  const shown: (() => void)[] = []
  let frame: HTMLIFrameElement | undefined
  let data: StageData | undefined
  let length = 0
  let t = from
  let playing = false

  const fit = () => {
    const k = Math.max(
      0.05,
      Math.min((viewer.clientWidth - 48) / width, (viewer.clientHeight - 32) / height),
    )
    // Whole, even pixels: a fractional box shows what's behind it at its edges.
    const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
    const boxWidth = even(width * k)
    const boxHeight = even(height * k)
    screen.style.width = boxWidth + 'px'
    screen.style.height = boxHeight + 'px'
    const sx = boxWidth / width
    const sy = boxHeight / height
    for (const f of screen.querySelectorAll('iframe')) {
      f.style.transform = `scale(${sx},${sy})`
      f.style.clipPath = `inset(0 round ${10 / sx}px / ${10 / sy}px)`
    }
  }
  new ResizeObserver(fit).observe(viewer)

  const show = () => {
    $('time').innerHTML = clock(t) + ' <span>/ ' + clock(length) + '</span>'
    const button = $('play')
    // The icon is only swapped when it changes: swapped between press and release, the click is lost.
    if (button.dataset.icon !== String(playing)) {
      button.dataset.icon = String(playing)
      button.innerHTML = playing ? ICON_PAUSE : ICON_PLAY
    }
    for (const fn of shown) fn()
  }
  window.addEventListener('resize', show)

  let loading = false
  let again = false
  let freshAgain = false
  const reload = (fresh = false) => {
    if (loading) {
      freshAgain ||= fresh
      return void (again = true)
    }
    loading = true
    const next = document.createElement('iframe')
    next.className = 'loading'
    next.style.width = width + 'px'
    next.style.height = height + 'px'
    next.src = '/?v=' + Date.now()
    next.onload = async () => {
      await stageOf(next).seek(t)
      if (!data || fresh) {
        data = stageOf(next).data
        length = data.length
        t = Math.min(t, length)
        for (const fn of loaded) fn(data)
        if (playing) void mixer.start(t, length)
      }
      frame?.remove()
      frame = next
      next.className = ''
      loading = false
      show()
      if (again) {
        again = false
        const nextFresh = freshAgain
        freshAgain = false
        reload(nextFresh)
      }
    }
    screen.appendChild(next)
    fit()
  }

  const seek = async (to: number) => {
    t = Math.max(0, Math.min(length, to))
    if (playing) void mixer.start(t, length)
    if (frame) await stageOf(frame).seek(t)
    show()
  }

  const tick = async () => {
    if (!playing) return
    t = mixer.now()
    if (t >= length) {
      t = length
      playing = false
      mixer.stop()
    }
    if (frame) await stageOf(frame).seek(t)
    show()
    if (playing) requestAnimationFrame(tick)
  }

  const toggle = () => {
    if (!playing && t >= length) t = 0
    playing = !playing
    show()
    if (playing) {
      void mixer.start(t, length)
      requestAnimationFrame(tick)
    } else mixer.stop()
  }

  $('play').onclick = toggle
  $('restart').onclick = () => void seek(0)
  let heard = true
  $('sound').onclick = () => {
    heard = !heard
    pressed($('sound'), heard)
    $('sound').title = heard ? 'Sound on' : 'Sound off'
    $('waves').style.display = heard ? '' : 'none'
    mixer.setHeard(heard)
  }
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement
    if (document.querySelector('dialog[open]') || target.closest('button')) return
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
    if (e.code === 'Space') {
      e.preventDefault()
      toggle()
    }
    if (e.code === 'ArrowLeft') void seek(t - 1)
    if (e.code === 'ArrowRight') void seek(t + 1)
  })

  return {
    get t() {
      return t
    },
    get length() {
      return length
    },
    get frame() {
      return frame
    },
    seek,
    reload,
    sound: () => {
      if (playing) mixer.update()
    },
    onLoad: (fn) => void loaded.push(fn),
    onShow: (fn) => void shown.push(fn),
  }
}

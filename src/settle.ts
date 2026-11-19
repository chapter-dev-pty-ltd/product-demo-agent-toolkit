import type { Page, Request } from 'playwright-core'
import { cellsIn, watchScreen } from './screen.ts'

const QUIET_MS = 300
const BEFORE_MS = 2000
const STARTED_MS = 1000
const LOOPING = 4
const MOVING_CAP_MS = 3000
const LONG_REQUEST_MS = 5000
const STREAMS = new Set(['websocket', 'eventsource', 'media'])
const DATA = new Set(['document', 'xhr', 'fetch'])

export interface Settled {
  settled: boolean
  waitingOn: string[]
}

export interface Settler {
  mark(): Promise<void>
  settled(options?: { beat?: number; cap?: number }): Promise<Settled>
}

export function watch(page: Page): Settler {
  const inFlight = new Map<Request, { at: number; address: string; data: boolean }>()
  let marked = performance.now()
  let navigatedAt = 0
  let asked: { address: string; at: number }[] = []
  let repeating = new Set<string>()
  const addressOf = (request: Request) => request.url().split(/[?#]/)[0] ?? ''
  const screen = watchScreen(page)
  let restless = new Set<number>()

  page.on('request', (request) => {
    if (STREAMS.has(request.resourceType())) return
    const now = performance.now()
    const address = addressOf(request)
    asked = asked.filter((a) => now - a.at < BEFORE_MS)
    asked.push({ address, at: now })
    inFlight.set(request, { at: now, address, data: DATA.has(request.resourceType()) })
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigatedAt = performance.now()
    }
  })
  const done = (request: Request) => inFlight.delete(request)
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  void page.addInitScript(watchPage)

  return {
    mark: async () => {
      marked = performance.now()
      const counts = new Map<string, number>()
      for (const { address, at } of asked) {
        if (marked - at < BEFORE_MS) counts.set(address, (counts.get(address) ?? 0) + 1)
      }
      repeating = new Set([...counts].filter(([, n]) => n >= 2).map(([address]) => address))
      const changes = new Map<number, number>()
      for (const sample of screen.samples) {
        if (marked - sample.at > BEFORE_MS) continue
        for (const cell of sample.changed) changes.set(cell, (changes.get(cell) ?? 0) + 1)
      }
      restless = new Set([...changes].filter(([, n]) => n >= 2).map(([cell]) => cell))
      await page.evaluate(markPage).catch(() => {})
    },
    settled: async ({ beat = 0, cap = 10_000 } = {}) => {
      const start = performance.now()
      let waitingOn: string[] = []
      let lastMoved = start
      let loadedAt = start
      for (;;) {
        waitingOn = []
        const now = performance.now()
        if (navigatedAt >= marked)
          await page.waitForLoadState('load', { timeout: cap }).catch(() => {})
        const pending = [...inFlight.values()].filter(
          (sent) =>
            sent.data &&
            sent.at >= marked &&
            sent.at - marked < STARTED_MS &&
            now - sent.at < LONG_REQUEST_MS &&
            !repeating.has(sent.address),
        )
        if (pending.length > 0) waitingOn.push(`${pending.length} requests`)
        const look = await page
          .evaluate(lookAtScreen)
          .catch(() => ({ loading: ['a page loading'], moving: [], videos: [], says: false }))
        waitingOn.push(...look.loading, ...look.moving)
        const loading = pending.length > 0 || look.loading.length > 0

        const ignored = new Set([
          ...restless,
          ...look.videos.flatMap((box) => cellsIn(box, screen.cols, screen.rows)),
        ])
        const recent = screen.samples.filter((s) => s.at > marked && now - s.at < 1500)
        const times = new Map<number, { count: number; first: number }>()
        for (const sample of recent) {
          for (const cell of sample.changed) {
            const seen = times.get(cell)
            times.set(cell, { count: (seen?.count ?? 0) + 1, first: seen?.first ?? sample.at })
          }
        }
        const looping = (cell: number) => {
          const seen = times.get(cell)
          return seen !== undefined && seen.count >= LOOPING && now - seen.first > 1200
        }
        const counts = (cell: number) => !ignored.has(cell) && (look.says || !looping(cell))
        for (const sample of recent) {
          if (sample.at > lastMoved && [...sample.changed].some(counts)) lastMoved = sample.at
        }
        if (now - lastMoved < QUIET_MS) waitingOn.push('the screen changing')

        if (waitingOn.length === 0) break
        if (loading) loadedAt = now
        const waited = performance.now()
        if (waited - start >= cap || (!loading && waited - loadedAt >= MOVING_CAP_MS)) break
        await page.waitForTimeout(100)
      }
      if (beat > 0) await page.waitForTimeout(beat)
      return { settled: waitingOn.length === 0, waitingOn }
    },
  }
}

interface Timer {
  created: number
}

type Watched = Window & {
  __pdMark?: number
  __pdTimers?: Map<number, Timer>
}

function watchPage(): void {
  const view: Watched = window
  if (view.__pdTimers) return
  const timers = new Map<number, Timer>()
  view.__pdTimers = timers
  const later = window.setTimeout.bind(window)
  const cancel = window.clearTimeout.bind(window)
  const every = window.setInterval.bind(window)
  const stop = window.clearInterval.bind(window)
  const short = (ms: unknown) => typeof ms !== 'number' || ms <= 2000
  const forget = (id: unknown) => {
    if (typeof id === 'number') timers.delete(id)
  }
  // Set through Reflect: the DOM's and Node's timer types disagree, and this is the page.
  Reflect.set(window, 'setTimeout', (run: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (typeof run !== 'function' || !short(ms)) return later(run, ms, ...args)
    const id = later(
      (...given: unknown[]) => {
        timers.delete(id)
        run(...given)
      },
      ms,
      ...args,
    )
    timers.set(id, { created: performance.now() })
    return id
  })
  Reflect.set(window, 'clearTimeout', (id?: number) => {
    forget(id)
    cancel(id)
  })
  Reflect.set(window, 'setInterval', (run: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = every(run, ms, ...args)
    if (typeof run === 'function' && short(ms)) timers.set(id, { created: performance.now() })
    return id
  })
  Reflect.set(window, 'clearInterval', (id?: number) => {
    forget(id)
    stop(id)
  })
}

function markPage(): void {
  const view: Watched = window
  view.__pdMark = performance.now()
}

interface Look {
  loading: string[]
  moving: string[]
  videos: number[][]
  says: boolean
}

function lookAtScreen(): Look {
  const view: Watched = window
  const loading: string[] = []
  const moving: string[] = []
  if (document.readyState !== 'complete') loading.push('the page loading')

  const mark = view.__pdMark ?? 0
  const scheduled = [...(view.__pdTimers?.values() ?? [])].filter(
    (timer) =>
      timer.created >= mark &&
      timer.created <= mark + 1000 &&
      performance.now() - timer.created < 2000,
  )
  if (scheduled.length > 0) moving.push(`${scheduled.length} timers`)

  // Only what a viewer could see counts: on screen, big enough to notice, and not hidden by
  // visibility or opacity anywhere up its tree. GitHub keeps its spinners in the page after
  // loading, out of sight; they mustn't count.
  const onScreen = (el: Element) => {
    const box = el.getBoundingClientRect()
    return (
      box.width >= 4 &&
      box.height >= 4 &&
      box.bottom > 0 &&
      box.top < innerHeight &&
      box.right > 0 &&
      box.left < innerWidth &&
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    )
  }
  const named = (el: Element) => {
    const label = el.getAttribute('aria-label') ?? el.getAttribute('class') ?? ''
    return `${el.tagName.toLowerCase()}${label ? ` "${label.slice(0, 40)}"` : ''}`
  }
  if (document.fonts.status !== 'loaded') moving.push('fonts')
  const ending = document.getAnimations().filter((animation) => {
    const timing = animation.effect?.getComputedTiming()
    const target = animation.effect instanceof KeyframeEffect ? animation.effect.target : null
    return (
      animation.playState === 'running' &&
      animation.timeline === document.timeline &&
      typeof timing?.duration === 'number' &&
      timing.iterations !== Infinity &&
      (!target || onScreen(target))
    )
  })
  if (ending.length > 0) moving.push('animations')
  const images = Array.from(document.images).filter((img) => !img.complete && onScreen(img))
  if (images.length > 0) moving.push(`${images.length} images`)

  // The app saying it's busy: aria-busy, or a progress bar with no value. A class like
  // "spinner" or "skeleton" only counts when something in it is visibly moving: GitHub keeps
  // a SpinnerVisible container on screen whose spinner is long gone.
  const moved = document
    .getAnimations()
    .map((a) => (a.effect instanceof KeyframeEffect ? a.effect.target : null))
    .filter((target): target is Element => target !== null && onScreen(target))
  const declared = Array.from(
    document.querySelectorAll('[aria-busy="true"],[role="progressbar"]:not([aria-valuenow])'),
  ).filter(onScreen)
  const looksBusy = Array.from(
    document.querySelectorAll('[class*="spinner" i],[class*="skeleton" i],[class*="shimmer" i]'),
  ).filter((el) => onScreen(el) && moved.some((target) => el === target || el.contains(target)))
  const busy = declared[0] ?? looksBusy[0]
  if (busy) loading.push(`something on screen saying it is busy (${named(busy)})`)

  let says = ''
  const walker = document.createTreeWalker(
    document.body ?? document.documentElement,
    NodeFilter.SHOW_TEXT,
  )
  for (let node = walker.nextNode(); node && !says; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? ''
    if (
      text.length < 40 &&
      /^(loading|please wait|wait for it|one moment|fetching|searching)\b|\b(loading|searching)(\.\.\.|…)$/i.test(
        text,
      ) &&
      node.parentElement &&
      !node.parentElement.closest('code, pre, kbd, samp, textarea, [contenteditable]') &&
      onScreen(node.parentElement)
    ) {
      says = text
    }
  }
  const loader = Array.from(document.images).find(
    (img) =>
      /(^|[\W_])(load|loading|loader|spinner|spin|busy)([\W_]|$)/i.test(img.src) && onScreen(img),
  )
  if (says) loading.push(`"${says}" on screen`)
  else if (loader) loading.push('a loader image on screen')

  const videos = Array.from(document.querySelectorAll('video'))
    .filter((video) => !video.paused && !video.ended && onScreen(video))
    .map((video) => {
      const box = video.getBoundingClientRect()
      return [box.x, box.y, box.width, box.height]
    })

  const showroom: unknown = Reflect.get(window, '__SHOWROOM__')
  if (
    showroom &&
    typeof showroom === 'object' &&
    'status' in showroom &&
    showroom.status === 'loading'
  ) {
    loading.push('the Showroom loading')
  }
  return { loading, moving, videos, says: Boolean(says || loader) }
}

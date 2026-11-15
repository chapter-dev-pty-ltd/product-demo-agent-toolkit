import type { Page, Request } from 'playwright-core'

// Knowing when the page has finished what an action started. Not a fixed wait: the page
// is settled when every one of these says so, checked every 100ms.
//
//  - A navigation the action started has loaded. Actions that navigate often only start
//    to a moment later (Enter in a search box), so requests are watched from before the
//    action, not after it.
//  - No request the page is waiting on is in flight, and none has been for 300ms. Streams
//    (websockets, server-sent events, media) and requests open for over 5s (long polling)
//    are left out: the page isn't waiting on them.
//  - Every timer the action scheduled in its first second (up to 2s long) has fired, so
//    "do this in a moment" (a debounce, a delayed navigation, a staged render) is waited
//    for. A clock that ticks forever, or polling started long before, isn't.
//  - The DOM hasn't changed for 300ms since the action, ignoring our own pointer.
//  - No finite animation or transition is running. Endless ones (a pulsing dot) and scroll-
//    driven ones (a fade tied to how far a list is scrolled) don't count.
//  - Fonts are loaded and the images on screen have loaded or failed.
//  - Nothing on screen says it is busy: aria-busy, a progressbar, a spinner or skeleton.
//  - A Showroom that reports its own status says it isn't loading.
//
// After `cap` it gives up waiting and says what was still going, so a page with a spinner
// that never stops is filmed and noted rather than waited on forever.

const QUIET_MS = 300
const LONG_REQUEST_MS = 5000
const STREAMS = new Set(['websocket', 'eventsource', 'media'])

export interface Settled {
  settled: boolean
  /** What was still going when it stopped waiting. */
  waitingOn: string[]
}

export interface Settler {
  /** Call just before an action, so what it starts later (a navigation, a timer) is caught. */
  mark(): Promise<void>
  /** Resolves once the page has settled, then holds for `beat` ms so a viewer sees it. */
  settled(options?: { beat?: number; cap?: number }): Promise<Settled>
}

/** Watches a page's requests for as long as it lives. */
export function watch(page: Page): Settler {
  const inFlight = new Map<Request, number>()
  let lastNetwork = performance.now()
  let marked = performance.now()
  let navigatedAt = 0

  page.on('request', (request) => {
    if (STREAMS.has(request.resourceType())) return
    inFlight.set(request, performance.now())
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigatedAt = performance.now()
    }
  })
  const done = (request: Request) => {
    if (inFlight.delete(request)) lastNetwork = performance.now()
  }
  page.on('requestfinished', done)
  page.on('requestfailed', done)
  void page.addInitScript(watchTimers)

  return {
    mark: async () => {
      marked = performance.now()
      await page
        .evaluate(() => {
          const view: Window & { __pdMark?: number; __pdLastChange?: number } = window
          view.__pdMark = performance.now()
          view.__pdLastChange = performance.now()
        })
        .catch(() => {})
    },
    settled: async ({ beat = 0, cap = 10_000 } = {}) => {
      const start = performance.now()
      let waitingOn: string[] = []
      while (performance.now() - start < cap) {
        waitingOn = []
        const now = performance.now()
        if (navigatedAt >= marked) {
          await page.waitForLoadState('load', { timeout: cap }).catch(() => {})
        }
        const pending = [...inFlight.values()].filter((at) => now - at < LONG_REQUEST_MS)
        if (pending.length > 0) waitingOn.push(`${pending.length} requests`)
        else if (now - lastNetwork < QUIET_MS) waitingOn.push('requests just finished')
        const screen = await page.evaluate(lookAtScreen, QUIET_MS).catch(() => ['a page loading'])
        waitingOn.push(...screen)
        if (waitingOn.length === 0) break
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
  __pdLastChange?: number
  __pdMark?: number
  __pdTimers?: Map<number, Timer>
}

/** Runs in the page before its own scripts: keeps a list of the timers it has pending. */
function watchTimers(): void {
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

/** Runs in the page: what on screen is still going. Empty when nothing is. */
function lookAtScreen(quietMs: number): string[] {
  const view: Watched = window
  if (view.__pdLastChange === undefined) {
    view.__pdLastChange = performance.now()
    new MutationObserver((changes) => {
      const ours = changes.every((c) => {
        const node = c.target instanceof Element ? c.target : c.target.parentElement
        return node?.closest('[data-product-demo]')
      })
      if (!ours) view.__pdLastChange = performance.now()
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
  }

  const going: string[] = []
  if (document.readyState !== 'complete') going.push('the page loading')
  if (performance.now() - view.__pdLastChange < quietMs) going.push('the page changing')
  if (document.fonts.status !== 'loaded') going.push('fonts')

  const mark = view.__pdMark ?? 0
  const scheduled = [...(view.__pdTimers?.values() ?? [])].filter(
    (timer) => timer.created >= mark && timer.created <= mark + 1000,
  )
  if (scheduled.length > 0) going.push(`${scheduled.length} timers`)

  // Only what a viewer could see holds the page up: on screen, big enough to notice, and
  // not hidden by visibility or opacity anywhere up its tree. GitHub keeps its spinners in
  // the page after loading, out of sight; they mustn't count.
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
  const images = Array.from(document.images).filter((img) => !img.complete && onScreen(img))
  if (images.length > 0) going.push(`${images.length} images`)

  // Only animations on the page's clock that will end. A scroll-driven one (a fade tied to
  // a scroll position) reports "running" forever, and an endless one never finishes.
  const running = document.getAnimations().filter((animation) => {
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
  if (running.length > 0) {
    const names = running.map((a) =>
      a instanceof CSSAnimation
        ? a.animationName
        : a instanceof CSSTransition
          ? a.transitionProperty
          : 'script',
    )
    going.push(`animations (${[...new Set(names)].slice(0, 3).join(', ')})`)
  }

  // The app saying it's busy: aria-busy, or a progress bar with no value. A class like
  // "spinner" or "skeleton" only counts when something in it is visibly moving: GitHub keeps
  // a SpinnerVisible container on screen whose spinner is long gone.
  const moving = document
    .getAnimations()
    .map((a) => (a.effect instanceof KeyframeEffect ? a.effect.target : null))
    .filter((target): target is Element => target !== null && onScreen(target))
  const declared = Array.from(
    document.querySelectorAll('[aria-busy="true"],[role="progressbar"]:not([aria-valuenow])'),
  ).filter(onScreen)
  const looksBusy = Array.from(
    document.querySelectorAll('[class*="spinner" i],[class*="skeleton" i],[class*="shimmer" i]'),
  ).filter((el) => onScreen(el) && moving.some((target) => el === target || el.contains(target)))
  const busy = declared[0] ?? looksBusy[0]
  if (busy) going.push(`something on screen saying it is busy (${named(busy)})`)

  const showroom: unknown = Reflect.get(window, '__SHOWROOM__')
  if (
    showroom &&
    typeof showroom === 'object' &&
    'status' in showroom &&
    showroom.status === 'loading'
  ) {
    going.push('the Showroom loading')
  }
  return going
}

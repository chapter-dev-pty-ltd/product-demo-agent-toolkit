import type { Page, Request } from 'playwright-core'

// Knowing when the page has finished what an action started. Not a fixed wait: the page
// is settled when every one of these says so, checked every 100ms.
//
//  - A navigation the action started has loaded. Actions that navigate often only start
//    to a moment later (Enter in a search box), so requests are watched from before the
//    action, not after it.
//  - No request the page is waiting on is in flight, and none has been for 300ms. Streams
//    (websockets, server-sent events, media) and requests open for over 5s (long polling)
//    are left out: the page isn't waiting on them, and so are requests to an address the
//    page was already asking for again and again before the action (a playing video's
//    chunks, analytics pings, polling).
//  - Every timer the action scheduled in its first second (up to 2s long) has fired, so
//    "do this in a moment" (a debounce, a delayed navigation, a staged render) is waited
//    for. A clock that ticks forever, or polling started long before, isn't.
//  - The DOM hasn't changed for 300ms since the action, ignoring anything we put on the page
//    ourselves and anything that was already changing over and over before the action (a
//    playing video's clock and progress bar).
//  - No finite animation or transition is running. Endless ones (a pulsing dot) and scroll-
//    driven ones (a fade tied to how far a list is scrolled) don't count.
//  - Fonts are loaded and the images on screen have loaded or failed.
//  - Nothing on screen says it is busy: aria-busy, a progressbar, a spinner or skeleton.
//  - A Showroom that reports its own status says it isn't loading.
//
// After `cap` it gives up waiting and says what was still going, so a page with a spinner
// that never stops is filmed and noted rather than waited on forever. When nothing is
// loading (no navigation, no request in flight, nothing saying it's busy) it gives up after
// 3s: the page is only moving, not loading.

const QUIET_MS = 300
/** How long before an action something has to keep changing to count as always changing. */
const BEFORE_MS = 2000
const MOVING_CAP_MS = 3000
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
  const inFlight = new Map<Request, { at: number; address: string }>()
  let lastNetwork = performance.now()
  let marked = performance.now()
  let navigatedAt = 0
  // Addresses asked for, recently, and those the page kept asking for before the action.
  let asked: { address: string; at: number }[] = []
  let repeating = new Set<string>()
  const addressOf = (request: Request) => request.url().split(/[?#]/)[0] ?? ''

  page.on('request', (request) => {
    if (STREAMS.has(request.resourceType())) return
    const now = performance.now()
    const address = addressOf(request)
    asked = asked.filter((a) => now - a.at < BEFORE_MS)
    asked.push({ address, at: now })
    inFlight.set(request, { at: now, address })
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigatedAt = performance.now()
    }
  })
  const done = (request: Request) => {
    const sent = inFlight.get(request)
    inFlight.delete(request)
    if (sent && !repeating.has(sent.address)) lastNetwork = performance.now()
  }
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
      await page.evaluate(markPage, BEFORE_MS).catch(() => {})
    },
    settled: async ({ beat = 0, cap = 10_000 } = {}) => {
      const start = performance.now()
      let waitingOn: string[] = []
      for (;;) {
        waitingOn = []
        const now = performance.now()
        const navigated = navigatedAt >= marked
        if (navigated) await page.waitForLoadState('load', { timeout: cap }).catch(() => {})
        const pending = [...inFlight.values()].filter(
          (sent) => now - sent.at < LONG_REQUEST_MS && !repeating.has(sent.address),
        )
        if (pending.length > 0) waitingOn.push(`${pending.length} requests`)
        else if (now - lastNetwork < QUIET_MS) waitingOn.push('requests just finished')
        const screen = await page.evaluate(lookAtScreen, QUIET_MS).catch(() => ['a page loading'])
        waitingOn.push(...screen)
        if (waitingOn.length === 0) break
        const loading =
          pending.length > 0 || screen.some((s) => s.includes('loading') || s.includes('busy'))
        if (performance.now() - start >= (loading ? cap : Math.min(cap, MOVING_CAP_MS))) break
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
  __pdChanges?: { node: Node; at: number }[]
  __pdRepeating?: Set<Node>
}

/**
 * Runs in the page before its own scripts: keeps a list of the timers it has pending, and
 * when the page last changed.
 */
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

  // Every change, kept for a few seconds, so the moment before an action can tell what was
  // already changing over and over. Those changes don't count as the page changing.
  const changes: { node: Node; at: number }[] = []
  view.__pdChanges = changes
  view.__pdLastChange = performance.now()
  new MutationObserver((records) => {
    const now = performance.now()
    for (const record of records) {
      const node = record.target
      const element = node instanceof Element ? node : node.parentElement
      if (element?.closest('[data-product-demo]')) continue
      changes.push({ node, at: now })
      if (!view.__pdRepeating?.has(node)) view.__pdLastChange = now
    }
    const old = changes.findIndex((c) => now - c.at < 5000)
    changes.splice(0, old === -1 ? changes.length : old)
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
}

/** Runs in the page just before an action: notes the time, and what keeps changing. */
function markPage(beforeMs: number): void {
  const view: Watched = window
  const now = performance.now()
  view.__pdMark = now
  view.__pdLastChange = now
  const counts = new Map<Node, number>()
  for (const { node, at } of view.__pdChanges ?? []) {
    if (now - at < beforeMs) counts.set(node, (counts.get(node) ?? 0) + 1)
  }
  view.__pdRepeating = new Set([...counts].filter(([, n]) => n >= 2).map(([node]) => node))
}

/** Runs in the page: what on screen is still going. Empty when nothing is. */
function lookAtScreen(quietMs: number): string[] {
  const view: Watched = window
  const going: string[] = []
  if (document.readyState !== 'complete') going.push('the page loading')
  if (performance.now() - (view.__pdLastChange ?? 0) < quietMs) going.push('the page changing')
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

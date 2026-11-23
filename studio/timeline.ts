import type {
  EditRequest,
  HighlightRequest,
  Highlighted,
  SoundRequest,
  PageSettings,
  ShownEdit,
  StudioState,
  TimelineData,
} from './api.ts'
import { musicSrc } from './audio.ts'
import type { Player } from './player.ts'
import { createPopover, stepsName, type Target } from './popover.ts'
import { toTake, toVideo } from './time.ts'
import type { Patch } from './settings.ts'
import { $, clock, fileName, pretty } from './ui.ts'

const GLOBE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>'
const POINTER =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="m3 3 10 3.6-4.6 1.8L6.6 13z"/></svg>'
const SPARK =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="4" width="11" height="8" rx="2"/></svg>'
const NOTE =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12V3.5l7-1.5V10.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="10.5" r="1.5"/></svg>'
const LENS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14M5 7h4M7 5v4"/></svg>'
const SCISSORS =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><path d="M5.6 5.2 14 12M5.6 10.8 14 4"/></svg>'
const STYLES: Record<Highlighted['style'], string> = { magnify: LENS, box: SPARK, cursor: POINTER }

export interface Timeline {
  look(l: PageSettings): void
  update(next: TimelineData): void
}

export interface LookControl {
  look(): PageSettings
  change(patch: Patch): void
}

export function createTimeline(player: Player, state: StudioState, control: LookControl): Timeline {
  const ownedMusic = state.owned.music
  const el = document.querySelector<HTMLElement>('.timeline')!
  let length = 0
  // Drawn in the take's own time, so a cut keeps its length; the player runs on the video's.
  let data = state.timeline
  let musicClip: HTMLElement | undefined
  let look = state.look
  const pct = (s: number) => (s / length) * 100 + '%'

  const track = (name: string, sub: string, icon: string) => {
    const row = document.createElement('div')
    row.className = 'track'
    row.innerHTML = `<div class="name">${icon}<span>${name}${sub ? ` <small>${sub}</small>` : ''}</span></div><div class="lane"></div>`
    $('tracks').appendChild(row)
    return row.querySelector<HTMLElement>('.lane')!
  }

  const ruler = () => {
    const step = [1, 2, 5, 10, 15, 30, 60].find((s) => length / s <= 12) ?? 60
    const per = step % 5 === 0 ? 5 : 2
    for (let i = 0; (i * step) / per <= length; i++) {
      const s = (i * step) / per
      const tick = document.createElement('div')
      const major = i % per === 0
      tick.className = 'tick' + (major ? '' : ' minor')
      tick.style.left = pct(s)
      if (major) tick.innerHTML = '<span>' + clock(s).slice(0, 5) + '</span>'
      $('ruler').appendChild(tick)
    }
  }

  const pages = (data: TimelineData) => {
    const lane = track('Page', '', GLOBE)
    const addresses = (
      data.addresses.length ? data.addresses : [{ at: 0, label: 'Screen' }]
    ).filter((a, i, all) => i === 0 || a.label !== all[i - 1]?.label)
    addresses.forEach((a, i) => {
      const end = addresses[i + 1]?.at ?? length
      const clip = document.createElement('div')
      clip.className = 'clip page'
      clip.style.left = `calc(${pct(a.at)} + 1px)`
      clip.style.width = `calc(${pct(end - a.at)} - 2px)`
      clip.title = a.label
      const slash = a.label.indexOf('/')
      const host = slash < 0 ? a.label : a.label.slice(0, slash)
      const name = document.createElement('span')
      name.textContent = host.replace(/^www\./, '')
      if (slash >= 0) {
        const rest = document.createElement('small')
        rest.textContent = ' ' + a.label.slice(slash)
        name.appendChild(rest)
      }
      if (host.includes('.') || host.startsWith('localhost')) {
        const icon = document.createElement('img')
        icon.alt = ''
        icon.referrerPolicy = 'no-referrer'
        icon.src = '//' + host + '/favicon.ico'
        icon.onerror = () => void (icon.outerHTML = GLOBE)
        clip.appendChild(icon)
      }
      clip.appendChild(name)
      lane.appendChild(clip)
    })
  }

  let clickLane: HTMLElement | undefined
  const clicks = (data: TimelineData) => {
    clickLane = track('Clicks', String(data.clicks.length), POINTER)
    for (const [i, c] of data.clicks.entries()) {
      const mark = document.createElement('div')
      mark.className = 'mark' + (c.muted ? ' muted' : '')
      if (c.step !== undefined) {
        mark.dataset.key = `click:${i}`
        mark.title = `Step ${c.step + 1} click${c.muted ? ', muted' : ''}`
      }
      mark.style.left = pct(c.at)
      clickLane.appendChild(mark)
    }
  }
  const showClicks = () => {
    const row = clickLane?.parentElement
    if (!row) return
    const muted = !look.sound.click
    row.classList.toggle('muted', muted)
    row.querySelector('small')!.textContent = `${data.clicks.length}${muted ? ' · muted' : ''}`
  }

  const highlights = (data: TimelineData) => {
    const lane = track('Highlights', '', SPARK)
    if (!data.highlights.length) lane.innerHTML = '<span class="empty">None in this take</span>'
    for (const h of data.highlights) {
      const clip = document.createElement('div')
      clip.className = 'clip highlight'
      clip.dataset.key = `highlight:${h.step}`
      clip.title = `Step ${h.step + 1}: ${pretty(h.style)}`
      clip.style.left = pct(h.at)
      clip.style.width = pct(h.until - h.at)
      clip.innerHTML = STYLES[h.style]
      const name = document.createElement('span')
      name.textContent = pretty(h.style)
      clip.appendChild(name)
      lane.appendChild(clip)
    }
  }

  const cuts = (list: ShownEdit[]) => {
    const lane = track('Edits', '', SCISSORS)
    if (!list.length)
      lane.innerHTML =
        '<span class="empty">Shift-drag across the timeline to cut or speed up a part</span>'
    // The ending holds the last frame after the steps; it isn't a step, so it can't be edited.
    if (data.length - data.stepsEnd > 0.05) {
      const hold = document.createElement('div')
      hold.className = 'hold'
      hold.style.left = `calc(${pct(data.stepsEnd)} + 1px)`
      hold.style.width = `calc(${pct(data.length - data.stepsEnd)} - 1px)`
      hold.title = `The ending holds the last frame for ${(data.length - data.stepsEnd).toFixed(1)}s. Cuts and speed-ups stop before it; set how long it holds with "ending" in the film.`
      hold.textContent = 'End'
      lane.appendChild(hold)
    }
    for (const e of list) {
      const cut = e.speed === 'cut'
      const el = document.createElement('div')
      el.dataset.key = `edit:${e.steps.join(',')}`
      el.title = `${stepsName(e.steps)}, ${cut ? 'cut' : `${e.speed}×`}: ${(e.to - e.from).toFixed(1)}s of the take. Drag to move, or drag an end to change it.`
      el.className = cut ? 'clip cut' : 'clip speed'
      el.style.left = pct(e.from)
      el.style.width = pct(e.to - e.from)
      el.innerHTML = `<i class="handle" data-end="from"></i>${cut ? SCISSORS : ''}<span>${cut ? 'Cut' : `${e.speed}×`}</span><i class="handle" data-end="to"></i>`
      el.onpointerdown = (down) => drag(down, el, e)
      lane.appendChild(el)
    }
  }
  // What a cut removes stays on the timeline, faded in every lane, so it's clear what goes.
  const shadeCuts = () => {
    for (const lane of $('tracks').querySelectorAll<HTMLElement>('.lane')) {
      for (const e of data.edits) {
        if (e.speed !== 'cut') continue
        const shade = document.createElement('div')
        shade.className = 'shade'
        shade.style.left = pct(e.from)
        shade.style.width = pct(e.to - e.from)
        lane.appendChild(shade)
      }
    }
  }

  const wave = async (clip: HTMLElement, src: string | null) => {
    if (clip.dataset.wave === (src ?? '')) return
    clip.dataset.wave = src ?? ''
    clip.querySelector('svg')?.remove()
    if (!src) return
    try {
      const response = await fetch(src)
      const sound = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(
        await response.arrayBuffer(),
      )
      if (clip.dataset.wave !== src) return
      const samples = sound.getChannelData(0)
      const rate = sound.sampleRate
      const n = Math.max(40, Math.floor(clip.clientWidth / 4))
      const peaks: number[] = []
      for (let i = 0; i < n; i++) {
        const from = Math.floor((i / n) * length * rate)
        const to = Math.floor(((i + 1) / n) * length * rate)
        let peak = 0
        for (let s = from; s < to; s += Math.max(1, Math.floor((to - from) / 256)))
          peak = Math.max(peak, Math.abs(samples[s % samples.length] ?? 0))
        peaks.push(peak)
      }
      const top = Math.max(...peaks) || 1
      const bars = peaks.map((p, i) => {
        const h = 3 + (p / top) * 17
        return `<rect x="${i * 4}" y="${10 - h / 2}" width="2" height="${h}" rx="1"/>`
      })
      clip.insertAdjacentHTML(
        'afterbegin',
        `<svg viewBox="0 0 ${n * 4} 20" preserveAspectRatio="none" fill="currentColor">${bars.join('')}</svg>`,
      )
    } catch {}
  }

  const showMusic = () => {
    if (!musicClip) return
    const m = look.music
    musicClip.className = 'clip music' + (m ? '' : ' off')
    musicClip.querySelector('span')!.textContent = m
      ? `${m.track === 'own' ? fileName(ownedMusic) : pretty(m.track)} · ${Math.round(m.volume * 100)}%`
      : 'No music'
    void wave(musicClip, m ? musicSrc(m) : null)
  }

  const timeAt = (e: PointerEvent) => {
    const lane = $('ruler').getBoundingClientRect()
    return Math.min(length, Math.max(0, ((e.clientX - lane.left) / lane.width) * length))
  }
  const video = (at: number) => toVideo(data.edits, at)
  const scrubTo = (e: PointerEvent) => void player.seek(video(timeAt(e)))

  const post = async (path: string, request: EditRequest | HighlightRequest | SoundRequest) => {
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
    look: () => look,
    change: (patch) => control.change(patch),
  })

  let range: { a: number; b: number } | null = null
  let picked: string | null = null
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
    $('selection').style.left = lane.left - box.left + (at.from / length) * lane.width + 'px'
    $('selection').style.width = ((at.to - at.from) / length) * lane.width + 'px'
  }
  const clear = () => {
    range = null
    picked = null
    placeRange()
    showPicked()
    popover.hide()
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
    if (key === 'music') return { kind: 'music' }
    if (key.startsWith('click:')) {
      const c = data.clicks[Number(key.slice(6))]
      return c?.step === undefined ? undefined : { kind: 'click', step: c.step, muted: c.muted }
    }
    const [kind, id = ''] = key.split(':')
    if (kind === 'highlight') {
      const highlight = data.highlights.find((h) => String(h.step) === id)
      return highlight && { kind: 'highlight', highlight }
    }
    const shown = data.edits.find((e) => e.steps.join(',') === id)
    return shown && { kind: 'edit', edit: shown }
  }
  // A wide item, like the music, points its popover at the moment it was clicked, not its middle.
  let pickedAt: number | undefined
  const pick = (item: HTMLElement, at?: number) => {
    const key = item.dataset.key
    const target = key && targetOf(key)
    if (!key || !target) return clear()
    clear()
    picked = key
    pickedAt = at
    showPicked()
    popover.show(target, () => {
      if (!item.isConnected) return undefined
      const box = item.getBoundingClientRect()
      if (at === undefined || !length) return box
      const lane = $('ruler').getBoundingClientRect()
      const x = Math.min(Math.max(lane.left + (at / length) * lane.width, box.left), box.right)
      return new DOMRect(x, box.top, 0, box.height)
    })
  }
  window.addEventListener('resize', placeRange)

  const drag = (down: PointerEvent, clip: HTMLElement, e: ShownEdit) => {
    down.stopPropagation()
    const end = (down.target as HTMLElement).dataset.end
    const perSecond = $('ruler').getBoundingClientRect().width / length
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
      else if (end === 'to') by = fit(by, e.from - e.to + 0.1, data.stepsEnd - e.to)
      else by = fit(by, -e.from, data.stepsEnd - e.to)
      const from = end === 'to' ? e.from : e.from + by
      clip.style.left = pct(from)
      clip.style.width = pct((end === 'from' ? e.to : e.to + by) - from)
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

  player.onLoad(() => {
    const was = picked
    const wasAt = pickedAt
    length = data.length
    $('ruler').replaceChildren()
    $('tracks').replaceChildren()
    clear()
    ruler()
    pages(data)
    clicks(data)
    musicClip = document.createElement('div')
    musicClip.className = 'clip music'
    musicClip.dataset.key = 'music'
    musicClip.title = 'Music'
    musicClip.style.left = '1px'
    musicClip.style.width = 'calc(100% - 2px)'
    musicClip.innerHTML = '<span></span>'
    track('Music', '', NOTE).appendChild(musicClip)
    highlights(data)
    shadeCuts()
    cuts(data.edits)
    showMusic()
    showClicks()
    const again = was ? el.querySelector<HTMLElement>(`[data-key="${was}"]`) : null
    if (again) pick(again, wasAt)
  })

  player.onShow(() => {
    $('playhead-time').textContent = clock(player.t)
    const lane = $('ruler').getBoundingClientRect()
    const box = el.getBoundingClientRect()
    if (length)
      $('playhead').style.left =
        lane.left - box.left + (toTake(data.edits, player.t) / length) * lane.width + 'px'
  })

  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement
    if (target.matches('input, textarea, select')) return
    if (!popover.target && !ranged()) return
    if (e.code === 'Escape') clear()
    if (e.code === 'Backspace' || e.code === 'Delete') {
      e.preventDefault()
      popover.remove()
    }
  })

  // What the press that's down started on; a release only acts on a press the timeline took.
  let pressedOn: 'range' | { x: number; item: HTMLElement | null } | null = null
  el.addEventListener('pointerdown', (e) => {
    pressedOn = null
    const target = e.target as HTMLElement
    if (target.closest('#popover')) return
    if (e.clientX < $('ruler').getBoundingClientRect().left) return
    el.setPointerCapture(e.pointerId)
    if (e.shiftKey) {
      const at = timeAt(e)
      setRange({ a: at, b: at }, false)
      el.onpointermove = (m) => setRange({ a: at, b: timeAt(m) }, false)
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
      const at = ranged()
      if (range && at) setRange(range, true)
      return
    }
    const { x, item } = pressed
    if (item && Math.abs(e.clientX - x) < 3) pick(item, timeAt(e))
    else if (item) clear()
  })

  return {
    update: (next) => void (data = next),
    look: (next) => {
      look = next
      showMusic()
      showClicks()
      const kind = popover.target?.kind
      if (kind === 'music') popover.refresh()
    },
  }
}

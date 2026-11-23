import type { Highlighted, PageSettings, ShownEdit, StudioState, TimelineData } from './api.ts'
import { musicSrc } from './audio.ts'
import type { Player } from './player.ts'
import { stepsName } from './steps.ts'
import { createSelection } from './selection.ts'
import { fromTrack, toTrack, trackToVideo, videoToTrack } from './time.ts'
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
  music(m: PageSettings['music']): void
  update(next: TimelineData): void
}

// The timeline is drawn in the take's own time, so a cut keeps its length, with each cover given
// its own length (time.ts, toTrack); the player runs on the video's. Times given and taken here
// are the take's.
export interface View {
  readonly el: HTMLElement
  readonly length: number
  // The timeline's own length: the take's, and every cover's.
  readonly span: number
  readonly data: TimelineData
  frac(at: number): number
  pct(at: number): string
  width(from: number, to: number): string
  timeAt(e: PointerEvent): number
  videoAt(e: PointerEvent): number
  openCover(scene: number): void
}

export function createTimeline(
  player: Player,
  state: StudioState,
  setMusic: (music: PageSettings['music']) => void,
  openCover: (scene: number) => void,
): Timeline {
  const ownedMusic = state.owned.music
  const el = document.querySelector<HTMLElement>('.timeline')!
  let length = 0
  let data = state.timeline
  let musicClip: HTMLElement | undefined
  let music: PageSettings['music'] = false
  let span = 0
  const along = (x: number) => (x / span) * 100 + '%'
  const frac = (at: number) => toTrack(data.holds, at) / span
  const pct = (at: number) => frac(at) * 100 + '%'
  const width = (from: number, to: number) => (frac(to) - frac(from)) * 100 + '%'
  const trackAt = (e: PointerEvent) => {
    const lane = $('ruler').getBoundingClientRect()
    return Math.min(span, Math.max(0, ((e.clientX - lane.left) / lane.width) * span))
  }
  const timeAt = (e: PointerEvent) => fromTrack(data.holds, trackAt(e))
  const videoAt = (e: PointerEvent) => trackToVideo(data.edits, data.holds, trackAt(e))
  const view: View = {
    el,
    get length() {
      return length
    },
    get span() {
      return span
    },
    get data() {
      return data
    },
    frac,
    pct,
    width,
    timeAt,
    videoAt,
    openCover,
  }
  const selection = createSelection(view, player, state, { get: () => music, set: setMusic })

  const track = (name: string, sub: string, icon: string) => {
    const row = document.createElement('div')
    row.className = 'track'
    row.innerHTML = `<div class="name">${icon}<span>${name}${sub ? ` <small>${sub}</small>` : ''}</span></div><div class="lane"></div>`
    $('tracks').appendChild(row)
    return row.querySelector<HTMLElement>('.lane')!
  }

  const ruler = () => {
    const step = [1, 2, 5, 10, 15, 30, 60].find((s) => span / s <= 12) ?? 60
    const per = step % 5 === 0 ? 5 : 2
    for (let i = 0; (i * step) / per <= span; i++) {
      const s = (i * step) / per
      const tick = document.createElement('div')
      const major = i % per === 0
      tick.className = 'tick' + (major ? '' : ' minor')
      tick.style.left = along(s)
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
      // From the take's start, not the address before it: an opening cover comes first.
      const from = Math.max(0, a.at)
      clip.style.left = `calc(${pct(from)} + 1px)`
      clip.style.width = `calc(${width(from, end)} - 2px)`
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

  const clicks = (data: TimelineData) => {
    const lane = track('Clicks', String(data.clicks.length), POINTER)
    for (const [i, c] of data.clicks.entries()) {
      const mark = document.createElement('div')
      mark.className = 'mark' + (c.muted ? ' muted' : '')
      if (c.step !== undefined) {
        mark.dataset.key = `click:${i}`
        mark.title = `Step ${c.step + 1} click${c.muted ? ', muted' : ''}`
      }
      mark.style.left = pct(c.at)
      lane.appendChild(mark)
    }
  }

  const covers = (data: TimelineData) => {
    if (!data.holds.length) return
    const lane = track('Covers', String(data.holds.length), SPARK)
    for (const h of data.holds) {
      const clip = document.createElement('div')
      const from = toTrack(data.holds, h.at) - h.hold
      clip.className = 'clip cover'
      clip.dataset.key = `cover:${h.scene}`
      clip.title = `${h.title}: ${h.hold}s. Click to change it.`
      clip.style.left = `calc(${along(from)} + 1px)`
      clip.style.width = `calc(${along(h.hold)} - 2px)`
      clip.innerHTML = SPARK
      const name = document.createElement('span')
      name.textContent = h.title
      clip.appendChild(name)
      lane.appendChild(clip)
    }
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
      clip.style.width = width(h.at, h.until)
      clip.innerHTML = STYLES[h.style]
      const name = document.createElement('span')
      name.textContent = pretty(h.style)
      clip.appendChild(name)
      lane.appendChild(clip)
    }
  }

  const edits = (list: ShownEdit[]) => {
    const lane = track('Edits', '', SCISSORS)
    if (!list.length)
      lane.innerHTML =
        '<span class="empty">Shift-drag across the timeline to cut or speed up a part</span>'
    for (const e of list) {
      const cut = e.speed === 'cut'
      const clip = document.createElement('div')
      clip.className = cut ? 'clip cut' : 'clip speed'
      clip.dataset.key = `edit:${e.steps.join(',')}`
      clip.title = `${stepsName(e.steps)}, ${cut ? 'cut' : `${e.speed}×`}: ${(e.to - e.from).toFixed(1)}s of the take. Drag to move, or drag an end to change it.`
      clip.style.left = pct(e.from)
      clip.style.width = width(e.from, e.to)
      clip.innerHTML = `<i class="handle" data-end="from"></i>${cut ? SCISSORS : ''}<span>${cut ? 'Cut' : `${e.speed}×`}</span><i class="handle" data-end="to"></i>`
      clip.onpointerdown = (down) => selection.drag(down, clip, e)
      lane.appendChild(clip)
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
        shade.style.width = width(e.from, e.to)
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
    const m = music
    musicClip.className = 'clip music' + (m ? '' : ' off')
    musicClip.querySelector('span')!.textContent = m
      ? `${m.track === 'own' ? fileName(ownedMusic) : pretty(m.track)} · ${Math.round(m.volume * 100)}%`
      : 'No music'
    void wave(musicClip, m ? musicSrc(m) : null)
  }

  player.onLoad(() => {
    const reselect = selection.keep()
    length = data.length
    span = toTrack(data.holds, length)
    $('ruler').replaceChildren()
    $('tracks').replaceChildren()
    ruler()
    pages(data)
    covers(data)
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
    edits(data.edits)
    showMusic()
    reselect()
  })

  player.onShow(() => {
    $('playhead-time').textContent = clock(player.t)
    const lane = $('ruler').getBoundingClientRect()
    const box = el.getBoundingClientRect()
    if (length)
      $('playhead').style.left =
        lane.left -
        box.left +
        (videoToTrack(data.edits, data.holds, player.t) / span) * lane.width +
        'px'
  })

  return {
    music: (m) => {
      music = m
      showMusic()
      selection.musicChanged()
    },
    update: (next) => void (data = next),
  }
}

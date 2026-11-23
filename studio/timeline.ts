import type {
  EditRequest,
  Highlighted,
  PageSettings,
  ShownEdit,
  StageData,
  StudioState,
} from './api.ts'
import { musicSrc } from './audio.ts'
import type { Player } from './player.ts'
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
}

export function createTimeline(player: Player, state: StudioState): Timeline {
  const ownedMusic = state.owned.music
  const el = document.querySelector<HTMLElement>('.timeline')!
  let length = 0
  let musicClip: HTMLElement | undefined
  let music: PageSettings['music'] = false
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

  const pages = (data: StageData) => {
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

  const clicks = (data: StageData) => {
    const lane = track('Clicks', String(data.clicks.length), POINTER)
    for (const c of data.clicks) {
      const mark = document.createElement('div')
      mark.className = 'mark'
      mark.style.left = pct(c.at)
      lane.appendChild(mark)
    }
  }

  const highlights = (data: StageData) => {
    const lane = track('Highlights', '', SPARK)
    if (!data.highlights.length) lane.innerHTML = '<span class="empty">None in this take</span>'
    for (const h of data.highlights) {
      const clip = document.createElement('div')
      clip.className = 'clip highlight'
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
    for (const e of list) {
      const el = document.createElement('div')
      el.dataset.edit = String(e.step)
      el.title = `Step ${e.step + 1}, ${e.speed === 'cut' ? 'cut' : `${e.speed}×`}: ${e.taken.toFixed(1)}s of the take. Click to take it back.`
      el.style.left = pct(e.from)
      if (e.speed === 'cut') {
        el.className = 'mark cut'
        el.innerHTML = SCISSORS
      } else {
        el.className = 'clip speed'
        el.style.width = pct(e.to - e.from)
        el.innerHTML = `<span>${e.speed}×</span>`
      }
      el.onclick = () => void edit({ remove: e.step })
      lane.appendChild(el)
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

  player.onLoad((data) => {
    length = data.length
    ruler()
    pages(data)
    clicks(data)
    musicClip = document.createElement('div')
    musicClip.className = 'clip music'
    musicClip.style.left = '1px'
    musicClip.style.width = 'calc(100% - 2px)'
    musicClip.innerHTML = '<span></span>'
    track('Music', '', NOTE).appendChild(musicClip)
    highlights(data)
    cuts(state.edits)
    showMusic()
  })

  player.onShow(() => {
    $('playhead-time').textContent = clock(player.t)
    const lane = $('ruler').getBoundingClientRect()
    const box = el.getBoundingClientRect()
    if (length)
      $('playhead').style.left = lane.left - box.left + (player.t / length) * lane.width + 'px'
  })

  const timeAt = (e: PointerEvent) => {
    const lane = $('ruler').getBoundingClientRect()
    return Math.min(length, Math.max(0, ((e.clientX - lane.left) / lane.width) * length))
  }
  const scrubTo = (e: PointerEvent) => void player.seek(timeAt(e))

  let selection: { a: number; b: number } | null = null
  const selected = () =>
    selection && Math.abs(selection.b - selection.a) > 0.05
      ? { from: Math.min(selection.a, selection.b), to: Math.max(selection.a, selection.b) }
      : null
  const showSelection = () => {
    const range = selected()
    $('selection').hidden = $('edit-bar').hidden = !range
    if (!range) return
    const lane = $('ruler').getBoundingClientRect()
    const box = el.getBoundingClientRect()
    $('selection').style.left = lane.left - box.left + (range.from / length) * lane.width + 'px'
    $('selection').style.width = ((range.to - range.from) / length) * lane.width + 'px'
    $('edit-range').textContent = `${clock(range.from)} – ${clock(range.to)}`
  }
  const select = (next: typeof selection) => {
    selection = next
    showSelection()
  }
  window.addEventListener('resize', showSelection)

  const edit = async (request: EditRequest) => {
    select(null)
    const res = await fetch('/studio/edits', { method: 'POST', body: JSON.stringify(request) })
    if (!res.ok) $('export-status').textContent = await res.text()
  }
  const editSelected = (change: { cut: true } | { speed: number }) => {
    const range = selected()
    if (!range) return
    void player.seek(range.from)
    void edit({ ...range, ...change })
  }
  $('edit-bar').onclick = (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('button')
    if (!button) return
    if ('clear' in button.dataset) return select(null)
    editSelected('cut' in button.dataset ? { cut: true } : { speed: Number(button.dataset.speed) })
  }
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || !selected()) return
    if (e.code === 'Escape') select(null)
    if (e.code === 'Backspace' || e.code === 'Delete') editSelected({ cut: true })
  })

  el.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement
    if (e.clientX < $('ruler').getBoundingClientRect().left || target.closest('[data-edit]')) return
    el.setPointerCapture(e.pointerId)
    if (e.shiftKey) {
      const at = timeAt(e)
      select({ a: at, b: at })
      el.onpointermove = (m) => select({ a: at, b: timeAt(m) })
      return
    }
    select(null)
    scrubTo(e)
    el.onpointermove = scrubTo
  })
  el.addEventListener('pointerup', () => (el.onpointermove = null))

  return {
    music: (m) => {
      music = m
      showMusic()
    },
  }
}

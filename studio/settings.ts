import type { PageSettings, StudioState } from './api.ts'
import type { Player } from './player.ts'
import type { Timeline } from './timeline.ts'
import { $, fileName, pressed, pretty } from './ui.ts'

const CURSORS = {
  black: '#111111',
  pink: '#ff7ccb',
  lime: '#b6f24f',
  macos: 'linear-gradient(135deg,#000 50%,#fff 50%)',
}

type Patch = Partial<Omit<PageSettings, 'cursor'>> & { cursor?: Partial<PageSettings['cursor']> }

export interface Settings {
  readonly look: PageSettings
  place(x: number | null, y: number | null): void
  setMusic(music: PageSettings['music']): void
}

export function createSettings(state: StudioState, player: Player, timeline: Timeline): Settings {
  const { owned } = state
  let look = state.look

  const thumb = (name: string) =>
    name === 'own'
      ? 'url(/studio/own/backdrop)'
      : name.startsWith('#')
        ? `linear-gradient(${name},${name})`
        : `url(/studio/backdrops/${name}.jpg)`
  const backdropName = (name: string) =>
    name === 'own' ? fileName(owned.backdrop) : name.startsWith('#') ? name : pretty(name)
  const cursorName = (style: string) =>
    style.startsWith('#')
      ? style
      : style === 'own'
        ? fileName(owned.cursor)
        : style === 'macos'
          ? 'macOS'
          : pretty(style)

  const make = <K extends 'button' | 'label'>(
    parent: HTMLElement,
    name: string,
    tag: K,
    init: (el: HTMLElementTagNameMap[K]) => void,
  ) => {
    const el = document.createElement(tag)
    el.dataset.name = name
    el.title = pretty(name)
    init(el)
    parent.appendChild(el)
    return el
  }

  const visual = (l: PageSettings) =>
    JSON.stringify([l.backdrop, l.display, l.fill, l.x, l.y, l.cursor])
  let shown = visual(look)
  let edits = 0
  const save = async () => {
    const edit = ++edits
    const res = await fetch('/studio/settings', { method: 'POST', body: JSON.stringify(look) })
    if (!res.ok) throw new Error(await res.text())
    const saved: PageSettings = await res.json()
    // A newer edit is on its way; this older reply would undo it.
    if (edit !== edits) return
    look = saved
    render()
    if (visual(look) !== shown) {
      shown = visual(look)
      player.reload()
    }
  }
  const change = (patch: Patch) => {
    look = { ...look, ...patch, cursor: { ...look.cursor, ...patch.cursor } }
    render()
    player.sound()
    void save()
  }

  $('backdrop-picker').onclick = () => {
    const open = $('backdrops').hidden
    $('backdrops').hidden = !open
    $('backdrop-picker').setAttribute('aria-expanded', String(open))
  }
  if (owned.backdrop) {
    const file = owned.backdrop
    make($('backdrops'), 'own', 'button', (b) => {
      b.className = 'own'
      b.title = file
      b.style.backgroundImage = thumb('own')
      b.onclick = () => change({ backdrop: 'own' })
    })
  }
  for (const name of state.backdrops) {
    make($('backdrops'), name, 'button', (b) => {
      b.style.backgroundImage = thumb(name)
      b.onclick = () => change({ backdrop: name })
    })
  }
  const flatTile = make($('backdrops'), 'colour', 'label', (l) => {
    l.className = 'colour'
    l.title = 'Any colour'
    l.innerHTML = '<input type="color" value="#f4f1ea">'
  })
  const flatPicker = flatTile.querySelector('input')!
  flatPicker.oninput = () => change({ backdrop: flatPicker.value })

  for (const name of ['none', 'browser']) {
    make($('display'), name, 'button', (b) => {
      b.textContent = name === 'none' ? 'None' : 'Browser'
      b.onclick = () => change({ display: name })
    })
  }

  for (const [name, fill] of Object.entries(CURSORS)) {
    make($('cursor'), name, 'button', (b) => {
      b.style.background = fill
      b.onclick = () => change({ cursor: { style: name } })
    })
  }
  if (owned.cursor) {
    const file = owned.cursor
    make($('cursor'), 'own', 'button', (b) => {
      b.className = 'own'
      b.title = file
      b.style.backgroundImage = 'url(/studio/own/cursor)'
      b.onclick = () => change({ cursor: { style: 'own' } })
    })
  }
  const custom = make($('cursor'), 'custom', 'label', (l) => {
    l.title = 'Any colour'
    l.innerHTML = '<input type="color" value="#8fd3ff">'
  })
  const colour = custom.querySelector('input')!
  colour.oninput = () => change({ cursor: { style: colour.value } })

  for (const name of ['none', ...state.tracks, ...(owned.music ? ['own'] : [])]) {
    make($('music'), name, 'button', (b) => {
      b.textContent =
        name === 'none' ? 'None' : name === 'own' ? fileName(owned.music) : pretty(name)
      b.onclick = () =>
        change({
          music:
            name === 'none'
              ? false
              : { track: name, volume: look.music ? look.music.volume : 0.25 },
        })
    })
  }

  const volume = $<HTMLInputElement>('volume')
  volume.oninput = () => {
    if (look.music) change({ music: { ...look.music, volume: Number(volume.value) } })
  }
  const fill = $<HTMLInputElement>('fill')
  fill.oninput = () => change({ fill: Number(fill.value) })
  const size = $<HTMLInputElement>('size')
  size.oninput = () => change({ cursor: { size: Number(size.value) } })
  const label = $<HTMLInputElement>('label')
  label.oninput = () => change({ cursor: { label: label.value } })

  const render = () => {
    $('backdrop-thumb').style.backgroundImage = thumb(look.backdrop)
    $('backdrop-name').textContent = backdropName(look.backdrop)
    for (const b of document.querySelectorAll<HTMLElement>('#backdrops button'))
      pressed(b, b.dataset.name === look.backdrop)
    const flat = look.backdrop.startsWith('#')
    pressed(flatTile, flat)
    if (flat) flatPicker.value = look.backdrop
    for (const b of document.querySelectorAll<HTMLElement>('#display button'))
      pressed(b, b.dataset.name === look.display)

    const style = look.cursor.style
    const hex = style.startsWith('#')
    for (const b of document.querySelectorAll<HTMLElement>('#cursor button'))
      pressed(b, b.dataset.name === style)
    pressed(custom, hex)
    custom.style.background = hex ? style : ''
    if (hex) colour.value = style
    $('cursor-name').textContent = cursorName(style)

    const m = look.music
    for (const b of document.querySelectorAll<HTMLElement>('#music button'))
      pressed(b, m ? b.dataset.name === m.track : b.dataset.name === 'none')
    $('volume-field').hidden = !m
    if (m) {
      volume.value = String(m.volume)
      volume.style.setProperty('--fill', m.volume * 100 + '%')
      $('volume-value').textContent = Math.round(m.volume * 100) + '%'
    }
    timeline.music(m)

    fill.value = String(look.fill)
    fill.style.setProperty('--fill', ((look.fill - 0.5) / 0.5) * 100 + '%')
    $('fill-value').textContent = Math.round(look.fill * 100) + '%'
    size.value = String(look.cursor.size)
    size.style.setProperty('--fill', ((look.cursor.size - 0.5) / 2.5) * 100 + '%')
    $('size-value').textContent = look.cursor.size.toFixed(2) + '×'
    if (document.activeElement !== label) label.value = look.cursor.label ?? ''
  }
  render()

  return {
    get look() {
      return look
    },
    place: (x, y) => change({ x, y }),
    setMusic: (music) => change({ music }),
  }
}

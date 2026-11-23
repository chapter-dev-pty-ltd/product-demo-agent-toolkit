import type {
  CoverRequest,
  EditRequest,
  HighlightRequest,
  Highlighted,
  PageSettings,
  ShownCover,
  ShownEdit,
  SoundRequest,
  StudioState,
} from './api.ts'
import { createMenu, type Menu } from './menu.ts'
import { stepsName } from './steps.ts'
import { clock, fileName, pressed, pretty } from './ui.ts'

export type Target =
  | { kind: 'range'; from: number; to: number }
  | { kind: 'edit'; edit: ShownEdit }
  | { kind: 'highlight'; highlight: Highlighted }
  | { kind: 'music' }
  | { kind: 'click'; step: number; muted: boolean }
  | { kind: 'cover'; cover: ShownCover }

export interface Actions {
  edit(request: EditRequest): void
  highlight(request: HighlightRequest): void
  sound(request: SoundRequest): void
  cover(request: CoverRequest): void
  music(): PageSettings['music']
  setMusic(music: PageSettings['music']): void
}

export interface Popover {
  readonly target: Target | null
  show(target: Target, anchor: () => DOMRect | undefined): void
  hide(): void
  // Shows the music as it is now, keeping a slider that's being dragged.
  refresh(): void
  note(message: string): void
  remove(): void
}

const SPEEDS = [2, 4, 8]
const STYLES: Highlighted['style'][] = ['box', 'magnify', 'cursor']
const icon = (paths: string) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const SCISSORS = icon(
  '<circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><path d="M5.6 5.2 14 12M5.6 10.8 14 4"/>',
)
const FAST = icon('<path d="M2.5 4v8l5-4zM8.5 4v8l5-4z"/>')
const TRASH = icon(
  '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2"/>',
)
const NOTE = icon(
  '<path d="M6 12V3.5l7-1.5V10.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="10.5" r="1.5"/>',
)
const SPEAKER = icon('<path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/>')
const MUTED = icon('<path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="m11 6 3.5 4M14.5 6 11 10"/>')

const button = (html: string, run: () => void, on = false, kind = '') => {
  const b = document.createElement('button')
  b.type = 'button'
  b.innerHTML = html
  if (kind) b.className = kind
  pressed(b, on)
  b.onclick = run
  return b
}
const sep = () => Object.assign(document.createElement('i'), { className: 'sep' })

export function createPopover(
  container: HTMLElement,
  state: StudioState,
  actions: Actions,
): Popover {
  const box = document.createElement('div')
  box.id = 'popover'
  box.hidden = true
  box.setAttribute('role', 'dialog')
  container.appendChild(box)
  let target: Target | null = null
  let anchor: () => DOMRect | undefined = () => undefined
  let menu: Menu | undefined
  let syncVolume: (() => void) | undefined
  let built = ''
  // What the controls are built from: anything else, like the volume, changes in place.
  const shape = (t: Target) => {
    const m = actions.music()
    return JSON.stringify([t, m && m.track])
  }

  const remove = () => {
    if (target?.kind === 'edit') actions.edit({ steps: target.edit.steps, remove: true })
    if (target?.kind === 'highlight')
      actions.highlight({ step: target.highlight.step, remove: true })
    if (target?.kind === 'music') actions.setMusic(false)
    if (target?.kind === 'cover') actions.cover({ scene: target.cover.scene, remove: true })
    if (target?.kind === 'range') actions.edit({ from: target.from, to: target.to, cut: true })
  }
  const trash = () => {
    const b = button(TRASH, remove, false, 'only danger')
    b.title = 'Remove (Backspace)'
    b.setAttribute('aria-label', 'Remove')
    return b
  }

  const editControls = (t: Extract<Target, { kind: 'range' | 'edit' }>) => {
    const now = t.kind === 'edit' ? t.edit.speed : undefined
    const apply = (change: { cut: true } | { speed: number }) =>
      actions.edit(
        t.kind === 'edit'
          ? { steps: t.edit.steps, ...change }
          : { from: t.from, to: t.to, ...change },
      )
    // A new range starts on Speed with none chosen: picking one, or switching to Cut, makes the edit.
    menu = createMenu(now === 'cut' ? 'cut' : 'speed', [
      { value: 'cut', html: `${SCISSORS}Cut`, pick: () => apply({ cut: true }) },
      { value: 'speed', html: `${FAST}Speed`, pick: () => apply({ speed: SPEEDS[0] ?? 2 }) },
    ])
    const speeds =
      now === 'cut' ? [] : SPEEDS.map((n) => button(`${n}×`, () => apply({ speed: n }), now === n))
    return [menu.el, ...speeds]
  }

  const musicControls = () => {
    const m = actions.music()
    const names = [...state.tracks, ...(state.owned.music ? ['own'] : [])]
    const tracks = names.map((name) =>
      button(
        `${NOTE}${name === 'own' ? fileName(state.owned.music) : pretty(name)}`,
        () => actions.setMusic({ track: name, volume: m ? m.volume : 0.25 }),
        m !== false && m.track === name,
        'word',
      ),
    )
    if (!m) return tracks
    const volume = document.createElement('label')
    volume.className = 'volume'
    volume.innerHTML = `<input type="range" min="0" max="1" step="0.01" aria-label="Music volume"><output></output>`
    const slider = volume.querySelector('input')!
    const readout = volume.querySelector('output')!
    const fill = (v: number) => {
      slider.style.setProperty('--fill', v * 100 + '%')
      readout.textContent = Math.round(v * 100) + '%'
    }
    syncVolume = () => {
      const now = actions.music()
      if (!now || document.activeElement === slider) return
      slider.value = String(now.volume)
      fill(now.volume)
    }
    slider.value = String(m.volume)
    fill(m.volume)
    slider.oninput = () => {
      fill(Number(slider.value))
      const now = actions.music()
      if (now) actions.setMusic({ ...now, volume: Number(slider.value) })
    }
    return [...tracks, sep(), volume, sep(), trash()]
  }

  const coverControls = ({ scene, title, subtitle = '', hold }: ShownCover) => {
    const text = (value: string, label: string, key: 'title' | 'subtitle') => {
      const input = document.createElement('input')
      input.className = 'text'
      input.value = value
      input.placeholder = label
      input.setAttribute('aria-label', label)
      input.onchange = () => {
        const now = input.value.trim()
        if (now !== value && (now || key === 'subtitle')) actions.cover({ scene, [key]: now })
      }
      input.onkeydown = (e) => void (e.key === 'Enter' && input.blur())
      return input
    }
    const length = document.createElement('label')
    length.className = 'volume'
    length.innerHTML = `<input type="range" min="0.5" max="6" step="0.5" aria-label="How long the cover shows"><output></output>`
    const slider = length.querySelector('input')!
    const readout = length.querySelector('output')!
    const fill = (v: number) => {
      slider.style.setProperty('--fill', ((v - 0.5) / 5.5) * 100 + '%')
      readout.textContent = v + 's'
    }
    slider.value = String(hold)
    fill(hold)
    slider.oninput = () => fill(Number(slider.value))
    slider.onchange = () => actions.cover({ scene, hold: Number(slider.value) })
    return [
      text(title, 'Title', 'title'),
      text(subtitle, 'Subtitle', 'subtitle'),
      sep(),
      length,
      sep(),
      trash(),
    ]
  }

  // The label is read out for the pill, which shows only its controls.
  const contents = (t: Target): [string, HTMLElement[]] => {
    if (t.kind === 'range') return [`${clock(t.from)} – ${clock(t.to)}`, editControls(t)]
    if (t.kind === 'edit') {
      const { steps, speed } = t.edit
      const label = `${stepsName(steps)}, ${speed === 'cut' ? 'cut' : `${speed}×`}`
      return [label, [...editControls(t), sep(), trash()]]
    }
    if (t.kind === 'highlight') {
      const { step, style } = t.highlight
      const styles = STYLES.map((s) =>
        button(pretty(s), () => actions.highlight({ step, style: s }), s === style, 'word'),
      )
      return [`Step ${step + 1} highlight`, [...styles, sep(), trash()]]
    }
    if (t.kind === 'music') return ['Music', musicControls()]
    if (t.kind === 'cover') return [`${t.cover.title} cover`, coverControls(t.cover)]
    const { step, muted } = t
    const set = (click: boolean) => () => muted === click && actions.sound({ step, click })
    return [
      `Step ${step + 1} click`,
      [
        button(`${SPEAKER}On`, set(true), !muted, 'word'),
        button(`${MUTED}Muted`, set(false), muted, 'word'),
      ],
    ]
  }

  const place = () => {
    const at = anchor()
    if (!target || !at) return hide()
    const frame = container.getBoundingClientRect()
    box.hidden = false
    // Measured where it was last put, near an edge, it would come back squeezed to fit there.
    box.style.left = box.style.top = '0px'
    const { width, height } = box.getBoundingClientRect()
    const centre = at.left + at.width / 2 - frame.left
    const left = Math.min(Math.max(8, centre - width / 2), frame.width - width - 8)
    box.style.left = left + 'px'
    box.style.top = at.top - frame.top - height - 10 + 'px'
    box.style.setProperty('--arrow', Math.min(Math.max(14, centre - left), width - 14) + 'px')
  }

  const render = () => {
    menu?.close()
    menu = syncVolume = undefined
    if (!target) return
    built = shape(target)
    const [label, items] = contents(target)
    box.setAttribute('aria-label', label)
    box.replaceChildren(...items)
    place()
  }

  const hide = () => {
    menu?.close()
    target = null
    box.hidden = true
  }

  window.addEventListener('resize', place)

  return {
    get target() {
      return target
    },
    show: (next, from) => {
      target = next
      anchor = from
      render()
    },
    hide,
    refresh: () => {
      if (!target) return
      if (shape(target) !== built) render()
      else syncVolume?.()
    },
    note: (message) => {
      if (!target) return
      const note = document.createElement('div')
      note.className = 'note'
      note.setAttribute('role', 'alert')
      note.textContent = message
      box.querySelector('.note')?.remove()
      box.appendChild(note)
      place()
    },
    remove,
  }
}

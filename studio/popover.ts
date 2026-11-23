import type {
  EditRequest,
  HighlightRequest,
  Highlighted,
  SoundRequest,
  PageSettings,
  ShownEdit,
  StudioState,
} from './api.ts'
import type { Patch } from './settings.ts'
import { clock, fileName, pressed, pretty } from './ui.ts'

export type Target =
  | { kind: 'range'; from: number; to: number }
  | { kind: 'edit'; edit: ShownEdit }
  | { kind: 'highlight'; highlight: Highlighted }
  | { kind: 'music' }
  | { kind: 'click'; step: number; muted: boolean }

export interface Actions {
  edit(request: EditRequest): void
  highlight(request: HighlightRequest): void
  sound(request: SoundRequest): void
  look(): PageSettings
  change(patch: Patch): void
}

export interface Popover {
  readonly target: Target | null
  show(target: Target, anchor: () => DOMRect | undefined): void
  hide(): void
  refresh(): void
  note(message: string): void
  remove(): void
}

export const stepsName = (steps: number[]): string => {
  const [first = 0, last = first] = [steps[0], steps.at(-1)]
  return first === last ? `Step ${first + 1}` : `Steps ${first + 1}–${last + 1}`
}

const SPEEDS = [2, 4, 8]
const icon = (paths: string) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
const SCISSORS = icon(
  '<circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><path d="M5.6 5.2 14 12M5.6 10.8 14 4"/>',
)
const TRASH = icon(
  '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.2"/>',
)
const NOTE = icon(
  '<path d="M6 12V3.5l7-1.5V10.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="10.5" r="1.5"/>',
)
const SPEAKER = icon('<path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/>')
const FAST = icon('<path d="M2.5 4v8l5-4zM8.5 4v8l5-4z"/>')
const CHEVRON = `<span class="chevron">${icon('<path d="m5 6.5 3 3 3-3"/>')}</span>`
const CHECK = `<span class="check">${icon('<path d="m3.5 8.5 3 3 6-7"/>')}</span>`
const MUTED = icon('<path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="m11 6 3.5 4M14.5 6 11 10"/>')
const STYLES: Highlighted['style'][] = ['box', 'magnify', 'cursor']

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
  let shown = ''
  // What the popover's controls are built from; a change to anything else, like the volume, leaves them be.
  const shape = (t: Target) => {
    const { music, sound } = actions.look()
    return JSON.stringify([t, music && music.track, sound.click])
  }

  const button = (label: string, run: () => void, on = false, kind = '') => {
    const b = document.createElement('button')
    b.type = 'button'
    b.innerHTML = label
    if (kind) b.className = kind
    pressed(b, on)
    b.onclick = run
    return b
  }
  const sep = () => Object.assign(document.createElement('i'), { className: 'sep' })
  const trash = () => {
    const b = button(TRASH, () => remove(), false, 'only danger')
    b.title = 'Remove (Backspace)'
    b.setAttribute('aria-label', 'Remove')
    return b
  }

  // A menu of our own: a native select's list doesn't open in every browser the studio runs in.
  let closeMenu: (() => void) | undefined
  const menu = (now: string, options: { value: string; html: string; pick: () => void }[]) => {
    const wrap = document.createElement('span')
    wrap.className = 'kind'
    const current = options.find((o) => o.value === now) ?? options[0]
    const toggle = button(
      `${current?.html ?? ''}${CHEVRON}`,
      () => (closeMenu ? closeMenu() : open()),
      false,
      'word',
    )
    toggle.setAttribute('aria-haspopup', 'menu')
    toggle.setAttribute('aria-expanded', 'false')
    wrap.appendChild(toggle)
    const open = () => {
      const list = document.createElement('div')
      list.className = 'menu'
      list.setAttribute('role', 'menu')
      for (const o of options) {
        const item = button(
          `${o.html}${o.value === now ? CHECK : ''}`,
          () => {
            closeMenu?.()
            if (o.value !== now) o.pick()
          },
          false,
          'word',
        )
        item.setAttribute('role', 'menuitemradio')
        item.setAttribute('aria-checked', String(o.value === now))
        list.appendChild(item)
      }
      wrap.appendChild(list)
      toggle.setAttribute('aria-expanded', 'true')
      const outside = (e: PointerEvent) => {
        if (!wrap.contains(e.target as Node)) closeMenu?.()
      }
      document.addEventListener('pointerdown', outside, true)
      closeMenu = () => {
        list.remove()
        toggle.setAttribute('aria-expanded', 'false')
        document.removeEventListener('pointerdown', outside, true)
        closeMenu = undefined
      }
      ;(list.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus()
    }
    return wrap
  }

  const remove = () => {
    if (!target) return
    if (target.kind === 'edit') actions.edit({ steps: target.edit.steps, remove: true })
    if (target.kind === 'highlight')
      actions.highlight({ step: target.highlight.step, remove: true })
    if (target.kind === 'music') actions.change({ music: false })
    if (target.kind === 'range') actions.edit({ from: target.from, to: target.to, cut: true })
  }

  // The label is read out for the pill, which shows only its controls.
  const contents = (t: Target): [string, HTMLElement[]] => {
    if (t.kind === 'range' || t.kind === 'edit') {
      const now = t.kind === 'edit' ? t.edit.speed : undefined
      const apply = (change: { cut: true } | { speed: number }) =>
        actions.edit(
          t.kind === 'edit'
            ? { steps: t.edit.steps, ...change }
            : { from: t.from, to: t.to, ...change },
        )
      // A new range starts on Speed with no speed chosen: picking one, or switching to Cut, makes the edit.
      const cutting = now === 'cut'
      const kind = menu(cutting ? 'cut' : 'speed', [
        { value: 'cut', html: `${SCISSORS}Cut`, pick: () => apply({ cut: true }) },
        { value: 'speed', html: `${FAST}Speed`, pick: () => apply({ speed: SPEEDS[0] ?? 2 }) },
      ])
      const speeds = cutting
        ? []
        : SPEEDS.map((n) => button(`${n}×`, () => apply({ speed: n }), now === n))
      if (t.kind === 'range') return [`${clock(t.from)} – ${clock(t.to)}`, [kind, ...speeds]]
      const { steps, speed } = t.edit
      const label = `${stepsName(steps)}, ${speed === 'cut' ? 'cut' : `${speed}×`}`
      return [label, [kind, ...speeds, sep(), trash()]]
    }
    if (t.kind === 'highlight') {
      const { step, style } = t.highlight
      const styles = STYLES.map((s) =>
        button(pretty(s), () => actions.highlight({ step, style: s }), s === style, 'word'),
      )
      return [`Step ${step + 1} highlight`, [...styles, sep(), trash()]]
    }
    if (t.kind === 'music') {
      const m = actions.look().music
      const names = [...state.tracks, ...(state.owned.music ? ['own'] : [])]
      const tracks = names.map((name) =>
        button(
          `${NOTE}${name === 'own' ? fileName(state.owned.music) : pretty(name)}`,
          () => actions.change({ music: { track: name, volume: m ? m.volume : 0.25 } }),
          m !== false && m.track === name,
          'word',
        ),
      )
      if (!m) return ['Music, none', tracks]
      const volume = document.createElement('label')
      volume.className = 'volume'
      volume.innerHTML = `<input type="range" min="0" max="1" step="0.01" aria-label="Music volume"><output></output>`
      const slider = volume.querySelector('input')!
      const shown = volume.querySelector('output')!
      const fill = (v: number) => {
        slider.style.setProperty('--fill', v * 100 + '%')
        shown.textContent = Math.round(v * 100) + '%'
      }
      slider.value = String(m.volume)
      fill(m.volume)
      slider.addEventListener('sync', () => fill(Number(slider.value)))
      slider.oninput = () => {
        fill(Number(slider.value))
        const now = actions.look().music
        if (now) actions.change({ music: { ...now, volume: Number(slider.value) } })
      }
      return ['Music', [...tracks, sep(), volume, sep(), trash()]]
    }
    const { step, muted } = t
    return [
      `Step ${step + 1} click`,
      [
        button(`${SPEAKER}On`, () => muted && actions.sound({ step, click: true }), !muted, 'word'),
        button(
          `${MUTED}Muted`,
          () => muted || actions.sound({ step, click: false }),
          muted,
          'word',
        ),
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
    closeMenu?.()
    if (!target) return
    shown = shape(target)
    const [label, items] = contents(target)
    box.setAttribute('aria-label', label)
    box.replaceChildren(...items)
    place()
  }

  const hide = () => {
    closeMenu?.()
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
    refresh: () => {
      if (!target) return
      if (shape(target) !== shown) return render()
      const slider = box.querySelector<HTMLInputElement>('input[type=range]')
      const m = actions.look().music
      if (slider && m && document.activeElement !== slider) {
        slider.value = String(m.volume)
        slider.dispatchEvent(new Event('sync'))
      }
    },
    remove,
  }
}

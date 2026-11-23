import type { CoverRequest, ShownCover, StudioState, TimelineData } from './api.ts'
import { $, pressed } from './ui.ts'

// A cover's own page in the Configuration panel, opened from its clip on the timeline.

const DARK = '#15151f'
const COLOURS = [DARK, '#ffffff']

export interface CoverPanel {
  open(scene: number): void
  update(data: TimelineData): void
  close(): void
}

export function createCoverPanel(state: StudioState, closed: (scene: number) => void): CoverPanel {
  let covers: ShownCover[] = state.timeline.holds
  let scene: number | undefined
  const now = () => covers.find((c) => c.scene === scene)

  const send = async (change: Omit<CoverRequest, 'scene'>) => {
    if (scene === undefined) return
    const res = await fetch('/studio/cover', {
      method: 'POST',
      body: JSON.stringify({ scene, ...change }),
    })
    $('cover-note').textContent = res.ok ? '' : await res.text()
  }

  const title = $<HTMLInputElement>('cover-title')
  const subtitle = $<HTMLInputElement>('cover-subtitle')
  title.onchange = () => {
    const text = title.value.trim()
    if (text) void send({ title: text })
    else render()
  }
  subtitle.onchange = () => void send({ subtitle: subtitle.value.trim() })
  for (const input of [title, subtitle])
    input.onkeydown = (e) => void (e.key === 'Enter' && input.blur())

  const size = $<HTMLInputElement>('cover-size')
  const showSize = (px: number) => {
    size.style.setProperty('--fill', ((px - 32) / 168) * 100 + '%')
    $('cover-size-value').textContent = px + 'px'
  }
  size.oninput = () => showSize(Number(size.value))
  size.onchange = () => void send({ size: Number(size.value) })

  const swatch = (parent: HTMLElement, colour: string, pick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.dataset.colour = colour
    b.title = colour
    b.style.background = colour
    b.onclick = pick
    parent.appendChild(b)
  }
  const picker = (parent: HTMLElement, pick: (colour: string) => void) => {
    const label = document.createElement('label')
    label.title = 'Any colour'
    label.innerHTML = '<input type="color">'
    const input = label.querySelector('input')!
    input.onchange = () => pick(input.value)
    parent.appendChild(label)
    return { label, input }
  }
  for (const colour of COLOURS) swatch($('cover-colour'), colour, () => void send({ colour }))
  const ownText = picker($('cover-colour'), (colour) => void send({ colour }))

  const modes = ['Backdrop', 'Colour'].map((name) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = name
    $('cover-background').appendChild(b)
    return b
  })
  const [backdrop, flat] = modes as [HTMLButtonElement, HTMLButtonElement]
  const ownFill = picker($('cover-fill'), (background) => void send({ background }))
  backdrop.onclick = () => void send({ background: null })
  flat.onclick = () => void send({ background: ownFill.input.value })

  const render = () => {
    const c = now()
    if (!c) return close()
    $('cover-name').textContent = c.title
    if (document.activeElement !== title) title.value = c.title
    if (document.activeElement !== subtitle) subtitle.value = c.subtitle ?? ''
    const px = c.size ?? 88
    size.value = String(px)
    showSize(px)
    const text = c.colour ?? DARK
    const preset = COLOURS.includes(text)
    for (const b of $('cover-colour').querySelectorAll<HTMLElement>('button'))
      pressed(b, b.dataset.colour === text)
    pressed(ownText.label, !preset)
    ownText.label.style.background = preset ? '' : text
    ownText.input.value = text
    pressed(backdrop, !c.background)
    pressed(flat, !!c.background)
    $('cover-fill').hidden = !c.background
    ownFill.label.style.background = c.background ?? ''
    // A new background starts where the text still reads on it.
    ownFill.input.value = c.background ?? (text === DARK ? '#f4f1ea' : DARK)
  }

  const close = () => {
    const was = scene
    scene = undefined
    if (was !== undefined) closed(was)
    $('cover').hidden = true
    $('settings').hidden = false
  }
  $('cover-back').onclick = close

  return {
    open: (next) => {
      scene = next
      $('cover-note').textContent = ''
      for (const tab of document.querySelectorAll<HTMLElement>('[role=tab]'))
        tab.setAttribute('aria-selected', String(tab.dataset.tab === 'settings'))
      $('chat').hidden = $('settings').hidden = true
      $('cover').hidden = false
      render()
    },
    update: (data) => {
      covers = data.holds
      if (scene !== undefined) render()
    },
    close,
  }
}

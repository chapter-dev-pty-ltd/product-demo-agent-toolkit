// A menu of our own: a native select's list doesn't open in every browser the studio runs in.

export interface Option {
  value: string
  html: string
  pick: () => void
}

export interface Menu {
  readonly el: HTMLElement
  close(): void
}

const CHEVRON =
  '<span class="chevron"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 6.5 3 3 3-3"/></svg></span>'
const CHECK =
  '<span class="check"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg></span>'

const item = (html: string, run: () => void) => {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'word'
  b.innerHTML = html
  b.onclick = run
  return b
}

export function createMenu(now: string, options: Option[]): Menu {
  const el = document.createElement('span')
  el.className = 'kind'
  const current = options.find((o) => o.value === now) ?? options[0]
  const toggle = item(`${current?.html ?? ''}${CHEVRON}`, () => (list ? close() : open()))
  toggle.setAttribute('aria-haspopup', 'menu')
  toggle.setAttribute('aria-expanded', 'false')
  el.appendChild(toggle)

  let list: HTMLElement | undefined
  const outside = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) close()
  }
  const close = () => {
    list?.remove()
    list = undefined
    toggle.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', outside, true)
  }
  const open = () => {
    list = document.createElement('div')
    list.className = 'menu'
    list.setAttribute('role', 'menu')
    for (const o of options) {
      const chosen = o.value === now
      const b = item(`${o.html}${chosen ? CHECK : ''}`, () => {
        close()
        if (!chosen) o.pick()
      })
      b.setAttribute('role', 'menuitemradio')
      b.setAttribute('aria-checked', String(chosen))
      list.appendChild(b)
    }
    el.appendChild(list)
    toggle.setAttribute('aria-expanded', 'true')
    document.addEventListener('pointerdown', outside, true)
    list.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }

  return { el, close }
}

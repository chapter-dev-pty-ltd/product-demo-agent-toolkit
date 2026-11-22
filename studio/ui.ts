export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T

export const pretty = (name: string): string =>
  name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ')

export const fileName = (path: string | null): string => path?.split('/').pop() ?? ''

export const clock = (seconds: number): string => {
  const s = Math.max(0, seconds)
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + (s % 60).toFixed(1).padStart(4, '0')
}

export const pressed = (el: Element, on: boolean): void =>
  el.setAttribute('aria-pressed', String(on))

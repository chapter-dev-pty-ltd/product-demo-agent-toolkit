import type { StudioEvent, StudioState } from './api.ts'
import { createMixer } from './audio.ts'
import { createChat } from './chat.ts'
import { createExport } from './export.ts'
import { createPlayer } from './player.ts'
import { createSettings } from './settings.ts'
import { createTimeline } from './timeline.ts'
import { $ } from './ui.ts'

const state: StudioState = await (await fetch('/studio/state')).json()
const query = new URLSearchParams(location.search)

document.title = `${state.title} · Studio`
$('title').textContent = state.title
$('title').title = state.title

const mixer = createMixer(state, () => settings.look)
const player = createPlayer(state, mixer, Math.max(0, Number(query.get('t')) || 0))
const timeline = createTimeline(player, state, {
  look: () => settings.look,
  change: (patch) => settings.change(patch),
})
const settings = createSettings(state, player, timeline)
const exporter = createExport(state, () => settings.look)
const chat = createChat(state, player)

const tabs = document.querySelectorAll<HTMLElement>('[role=tab]')
for (const tab of tabs) {
  tab.onclick = () => {
    if (tab.getAttribute('aria-selected') === 'true') return
    for (const other of tabs) other.setAttribute('aria-selected', String(other === tab))
    const from = document.querySelector('.panel:not([hidden])')
    const swap = () => {
      from?.classList.remove('leaving')
      for (const name of ['settings', 'chat']) $(name).hidden = tab.dataset.tab !== name
    }
    if (!from || matchMedia('(prefers-reduced-motion: reduce)').matches) return swap()
    from.classList.add('leaving')
    setTimeout(swap, 90)
  }
}
const openTab = () =>
  document.querySelector<HTMLElement>('[role=tab][aria-selected=true]')?.dataset.tab ?? 'chat'
document.querySelector<HTMLElement>(`[role=tab][data-tab=${query.get('tab') || 'chat'}]`)?.click()

const refresh = () => location.replace(`/studio?t=${player.t.toFixed(2)}&tab=${openTab()}`)
new EventSource('/studio/events').onmessage = (e) => {
  const event: StudioEvent = JSON.parse(e.data)
  if ((event.type === 'hello' && event.boot !== state.boot) || event.type === 'config') {
    return exporter.whenIdle(refresh)
  }
  if (event.type === 'stage') {
    timeline.update(event.timeline)
    mixer.reloadSounds()
    return player.reload(true)
  }
  chat.update(event)
}

player.reload()

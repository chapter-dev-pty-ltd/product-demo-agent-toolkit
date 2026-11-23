import type { StudioEvent, StudioState } from './api.ts'
import { createMixer } from './audio.ts'
import { createChat } from './chat.ts'
import { createCoverPanel } from './cover.ts'
import { createDrag } from './drag.ts'
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

const mixer = createMixer(state, () => settings.look.music)
const player = createPlayer(state, mixer, Math.max(0, Number(query.get('t')) || 0))
const cover = createCoverPanel(state, (scene) => timeline.coverClosed(scene))
const timeline = createTimeline(
  player,
  state,
  (music) => settings.setMusic(music),
  (scene) => cover.open(scene),
)
const settings = createSettings(state, player, timeline)
const exporter = createExport(state, () => settings.look)
const chat = createChat(state, player)
createDrag(state, player, (x, y) => settings.place(x, y))

const tabs = document.querySelectorAll<HTMLElement>('[role=tab]')
for (const tab of tabs) {
  tab.onclick = () => {
    if (tab.getAttribute('aria-selected') === 'true') return
    for (const other of tabs) other.setAttribute('aria-selected', String(other === tab))
    const from = document.querySelector('.panel:not([hidden])')
    const swap = () => {
      from?.classList.remove('leaving')
      cover.close()
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
    cover.update(event.timeline)
    mixer.reloadSounds(event.stems, event.hold)
    return player.reload(true)
  }
  chat.update(event)
}

player.reload()

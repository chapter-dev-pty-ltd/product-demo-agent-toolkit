import type { ExportFormat, PageSettings, StudioState } from './api.ts'
import { $ } from './ui.ts'

export interface Exporter {
  whenIdle(fn: () => void): void
}

export function createExport(state: StudioState, look: () => PageSettings): Exporter {
  const picker = $<HTMLDialogElement>('export-picker')
  const format = $<HTMLSelectElement>('export-format')
  const button = $<HTMLButtonElement>('export')
  const status = $('export-status')
  const label = $('export-label')
  let downloading = false
  let pending: (() => void) | undefined
  let done: ReturnType<typeof setTimeout> | undefined

  button.onclick = () => picker.showModal()
  $('cancel-export').onclick = () => picker.close()
  picker.onclick = (e) => e.target === picker && picker.close()
  format.onchange = () => {
    $('start-export').textContent =
      'Export ' + (format.value === 'webm' ? 'WebM' : format.value.toUpperCase())
  }

  $('start-export').onclick = async () => {
    const chosen = format.value as ExportFormat
    picker.close()
    downloading = true
    button.disabled = true
    clearTimeout(done)
    delete button.dataset.done
    button.setAttribute('aria-busy', 'true')
    label.textContent = 'Exporting…'
    status.textContent = ''
    try {
      const res = await fetch('/studio/export', {
        method: 'POST',
        body: JSON.stringify({ ...look(), format: chosen }),
      })
      if (!res.ok) throw new Error(await res.text())
      const url = URL.createObjectURL(await res.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = `${state.video}.${chosen}`
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      button.dataset.done = ''
      done = setTimeout(() => {
        delete button.dataset.done
        label.textContent = 'Export'
      }, 3000)
    } catch (error) {
      status.textContent = 'Export failed. ' + (error as Error).message
    } finally {
      downloading = false
      button.disabled = false
      button.setAttribute('aria-busy', 'false')
      label.textContent = 'done' in button.dataset ? 'Exported' : 'Export'
      if (pending) setTimeout(pending, 1000)
      pending = undefined
    }
  }

  return {
    whenIdle: (fn) => (downloading ? void (pending = fn) : fn()),
  }
}

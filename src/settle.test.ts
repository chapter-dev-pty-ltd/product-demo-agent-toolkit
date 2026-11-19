import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Browser, Page } from 'playwright-core'
import { watch } from './settle.ts'
import { launchBrowser } from './tools.ts'

const PAGES: Record<string, string> = {
  '/late-navigation': `<button onclick="setTimeout(() => location.href = '/slow-page', 400)">Go</button>`,
  '/slow-page': `<h1>Arrived</h1>`,
  '/fetch': `<button onclick="fetch('/slow-data').then(r => r.text()).then(t => document.body.append(t))">Load</button>`,
  '/spinner': `<style>@keyframes spin{to{transform:rotate(1turn)}} .Spinner_x1{animation:spin 1s infinite;width:20px;height:20px}</style>
    <button onclick="
      const s = document.createElement('div'); s.className = 'Spinner_x1'; s.textContent = '...';
      document.body.append(s); setTimeout(() => { s.remove(); document.body.append('Done') }, 1200)">Save</button>`,
  '/transition': `<style>#panel{width:100px;height:100px;background:red;transition:transform 800ms}
      .open{transform:translateX(300px)}</style>
      <div id="panel"></div><button onclick="panel.classList.add('open')">Open</button>`,
  '/endless': `<style>@keyframes pulse{to{opacity:.2}} i{animation:pulse 1s infinite}</style>
      <i>live</i><button onclick="document.body.append('Clicked')">Press</button>`,
  '/scroll-fade': `<style>@keyframes fade{from{opacity:1}to{opacity:.3}}
      .list{height:120px;overflow:auto;animation:fade linear both;animation-timeline:scroll()}</style>
      <div class="list"><div style="height:600px">Items</div></div>
      <button onclick="document.body.append('Clicked')">Press</button>`,
  '/hidden-spinner': `<style>@keyframes spin{to{transform:rotate(1turn)}} svg{animation:spin 1s infinite}</style>
      <div class="Spinner" style="opacity:0"><svg width="20" height="20"></svg></div>
      <div class="spinner-box" style="visibility:hidden">...</div>
      <div class="SpinnerVisible" style="height:40px">Labels<svg width="20" height="20" style="display:none"></svg></div>
      <button onclick="document.body.append('Done')">Go</button>`,
  '/stuck': `<button onclick="
      const s = document.createElement('div'); s.setAttribute('aria-busy', 'true'); s.textContent = 'Loading';
      document.body.append(s)">Start</button>`,
  '/playing': `<span id="clock">0:00</span><div id="bar" style="width:0"></div>
      <script>let n = 0; setInterval(() => { clock.textContent = '0:' + ++n; bar.style.width = n + 'px' }, 150)
      setInterval(() => fetch('/chunk?n=' + n), 250)</script>
      <button onclick="fetch('/slow-data').then(r => r.text()).then(t => document.body.append(t))">Load</button>`,
  '/code-sample': `<pre><code>toast.promise(save, { <span>loading</span>: 'Loading...' })</code></pre>
      <button onclick="document.body.append('Saved')">Save</button>`,
  '/drawn-loading': `<canvas id="c" width="60" height="20"></canvas><div id="out"></div>
      <button onclick="
        out.textContent = 'Loading...'; let x = 0
        const draw = () => { const g = c.getContext('2d'); g.clearRect(0, 0, 60, 20); g.fillRect(x = (x + 4) % 60, 0, 10, 20); requestAnimationFrame(draw) }
        draw(); setTimeout(() => { out.textContent = 'Done' }, 3500)">Start</button>`,
  '/looping': `<canvas id="c" width="200" height="200"></canvas>
      <button onclick="let x = 0
        const draw = () => { const g = c.getContext('2d'); g.fillStyle = 'hsl(' + (x += 9) + ',80%,50%)'; g.fillRect(0, 0, 200, 200); requestAnimationFrame(draw) }
        draw(); document.body.append('Started')">Start</button>`,
  '/moving': `<canvas id="c" width="200" height="200"></canvas>
      <script>let x = 0; const draw = () => { const g = c.getContext('2d'); g.fillStyle = 'hsl(' + (x += 9) + ',80%,50%)'; g.fillRect(0, 0, 200, 200); requestAnimationFrame(draw) }; draw()</script>
      <button onclick="document.body.append('Clicked')">Press</button>`,
  '/typing': `<button onclick="
      let n = 0; const t = setInterval(() => { document.body.append('word '); if (++n === 8) clearInterval(t) }, 150)">Write</button>`,
}

let server: Server
let base: string
let browser: Browser

beforeAll(async () => {
  server = createServer((request, response) => {
    const delay = request.url === '/slow-page' ? 600 : request.url === '/slow-data' ? 900 : 0
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(request.url === '/slow-data' ? 'Data loaded' : (PAGES[request.url ?? ''] ?? ''))
    }, delay)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
  browser = await launchBrowser()
})
afterAll(async () => {
  await browser.close()
  server.close()
})

async function pressAndSettle(path: string, cap?: number) {
  const page: Page = await browser.newPage()
  const settler = watch(page)
  await page.goto(base + path)
  await settler.settled()
  await page.waitForTimeout(500)
  await settler.mark()
  await page.getByRole('button').click()
  const result = await settler.settled(cap ? { cap } : {})
  return { page, result }
}

test('waits for a navigation that only starts after the click', async () => {
  const { page, result } = await pressAndSettle('/late-navigation')
  expect(result.settled).toBe(true)
  expect(new URL(page.url()).pathname).toBe('/slow-page')
  expect(await page.textContent('h1')).toBe('Arrived')
})

test('waits for a slow request and what it draws', async () => {
  const { page, result } = await pressAndSettle('/fetch')
  expect(result.settled).toBe(true)
  expect(await page.textContent('body')).toContain('Data loaded')
})

test('waits for a spinner to go', async () => {
  const { page, result } = await pressAndSettle('/spinner')
  expect(result.settled).toBe(true)
  expect(await page.textContent('body')).toContain('Done')
})

test('waits for a transition to finish', async () => {
  const { page, result } = await pressAndSettle('/transition')
  expect(result.settled).toBe(true)
  const moved = await page.locator('#panel').evaluate((el) => getComputedStyle(el).transform)
  expect(moved).toContain('300')
})

test('waits for text that arrives in pieces', async () => {
  const { page, result } = await pressAndSettle('/typing')
  expect(result.settled).toBe(true)
  expect(((await page.textContent('body')) ?? '').match(/word/g)).toHaveLength(8)
})

test('is not held up by an animation that never ends', async () => {
  const start = performance.now()
  const { result } = await pressAndSettle('/endless')
  expect(result.settled).toBe(true)
  expect(performance.now() - start).toBeLessThan(3000)
})

test('is not held up by an animation tied to scrolling', async () => {
  const start = performance.now()
  const { result } = await pressAndSettle('/scroll-fade')
  expect(result.settled).toBe(true)
  expect(performance.now() - start).toBeLessThan(3000)
})

test('is not held up by a spinner kept in the page out of sight', async () => {
  const { result } = await pressAndSettle('/hidden-spinner')
  expect(result.settled).toBe(true)
})

test('is not held up by what was changing before, like a playing video', async () => {
  const start = performance.now()
  const { page, result } = await pressAndSettle('/playing')
  expect(result.settled).toBe(true)
  expect(await page.textContent('body')).toContain('Data loaded')
  expect(performance.now() - start).toBeLessThan(6000)
})

test('stops waiting within 3s on a page that keeps moving but is not loading', async () => {
  const page: Page = await browser.newPage()
  const settler = watch(page)
  await page.goto(base + '/endless')
  await settler.mark()
  await page.evaluate(() => setInterval(() => document.body.append('.'), 100))
  const start = performance.now()
  await settler.settled()
  expect(performance.now() - start).toBeLessThan(3500)
})

test('waits for loading shown only on screen, in words and a drawn animation, past 3s', async () => {
  const start = performance.now()
  const { page, result } = await pressAndSettle('/drawn-loading')
  expect(result.settled).toBe(true)
  expect(await page.textContent('#out')).toBe('Done')
  expect(performance.now() - start).toBeGreaterThan(3500)
})

test('is not fooled by "loading" in a code sample on the page', async () => {
  const start = performance.now()
  const { result } = await pressAndSettle('/code-sample')
  expect(result.settled).toBe(true)
  expect(performance.now() - start).toBeLessThan(2500)
})

test('is not held up long by an animation the action starts that never ends', async () => {
  const page: Page = await browser.newPage()
  const settler = watch(page)
  await page.goto(base + '/looping')
  await settler.settled()
  await settler.mark()
  await page.getByRole('button').click()
  const start = performance.now()
  const result = await settler.settled()
  expect(result.settled).toBe(true)
  expect(performance.now() - start).toBeLessThan(2200)
})

test('is not held up by what was already moving on screen', async () => {
  const page: Page = await browser.newPage()
  const settler = watch(page)
  await page.goto(base + '/moving')
  await settler.settled()
  await page.waitForTimeout(2000)
  await settler.mark()
  await page.getByRole('button').click()
  const start = performance.now()
  const result = await settler.settled()
  expect(result.settled).toBe(true)
  expect(await page.textContent('body')).toContain('Clicked')
  expect(performance.now() - start).toBeLessThan(1000)
})

test('gives up on something busy forever, and says what', async () => {
  const { result } = await pressAndSettle('/stuck', 1500)
  expect(result.settled).toBe(false)
  expect(result.waitingOn.join()).toContain('something on screen saying it is busy')
})

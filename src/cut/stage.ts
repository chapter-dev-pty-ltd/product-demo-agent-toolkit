import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import type { Config } from '../config.ts'
import { VIEWPORT, type Footage } from '../perform.ts'

// The stage: a web page that is the finished video. The footage's screenshots are the
// picture, and everything the cut adds (the backdrop, the window, the cursor, its dip on a
// click) is plain HTML and CSS on top. `stage.seek(t)` sets the page to second t of the
// video: the screenshot for that moment, the cursor where it was, and every CSS animation
// at its time. The renderer seeks it frame by frame and photographs it (cut.ts).
//
// An element with `data-at="2.5"` runs its CSS animations from 2.5s into the video, and
// with `data-for="0.6"` it shows only for those 0.6s. That's how an effect is added.

export const CANVAS = { width: 1920, height: 1080 }
const ORIGIN = 'https://stage.product-demo'
const COLOURS: Record<Config['cursor'], string> = { pink: '#ff7ccb', lime: '#b6f24f' }

/** What the stage is told, in video time (seconds from its start) and app pixels. */
export interface StageData {
  length: number
  frames: { file: string; at: number }[]
  pointer: { at: number; x: number; y: number }[]
  clicks: { at: number; x: number; y: number }[]
  title: string
}

/** Opens the stage for this footage. `extra` is HTML added on top, such as more effects. */
export async function openStage(
  browser: Browser,
  footageDir: string,
  footage: Footage,
  look: { backdrop: Config['backdrop']; cursor: Config['cursor'] },
  length: number,
  title: string,
  extra = '',
): Promise<Page> {
  const start = footage.frames[0]?.at ?? 0
  const time = <T extends { at: number }>(item: T): T => ({ ...item, at: item.at - start })
  const data: StageData = {
    length,
    frames: footage.frames.map(time),
    pointer: footage.pointer.map(time),
    clicks: footage.clicks.map(time),
    title,
  }
  const library = (path: string) => new URL(`../library/${path}`, import.meta.url)
  const files: Record<string, () => Promise<Buffer>> = {
    '/backdrop.jpg': () => readFile(library(`backdrops/${look.backdrop}.jpg`)),
  }
  const arrow = await readFile(library('cursors/arrow.svg'), 'utf8')

  const page = await browser.newPage({ viewport: CANVAS, deviceScaleFactor: 1 })
  // Served from one made-up origin: the page, the library's pictures and the footage.
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/') {
      return route.fulfill({ contentType: 'text/html', body: html(data, arrow, look, extra) })
    }
    const read =
      files[path] ?? (() => readFile(resolve(footageDir, decodeURIComponent(path.slice(1)))))
    const body = await read().catch(() => undefined)
    if (!body) return route.fulfill({ status: 404 })
    const type = extname(path) === '.png' ? 'image/png' : 'image/jpeg'
    return route.fulfill({ contentType: type, body, headers: { 'cache-control': 'no-store' } })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => document.fonts.ready)
  return page
}

function html(
  data: StageData,
  arrow: string,
  look: { cursor: Config['cursor'] },
  extra: string,
): string {
  const app = {
    x: (CANVAS.width - VIEWPORT.width) / 2,
    y: (CANVAS.height - VIEWPORT.height) / 2,
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: ${CANVAS.width}px; height: ${CANVAS.height}px; overflow: hidden; }
body { font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }
#backdrop { position: absolute; inset: 0; background: url(/backdrop.jpg) center / cover; }
#window {
  position: absolute; left: ${app.x}px; top: ${app.y}px;
  width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px;
  border-radius: 14px; overflow: hidden; background: #fff;
  box-shadow: 0 30px 80px rgb(20 20 60 / 0.28), 0 6px 18px rgb(20 20 60 / 0.16);
}
/* Everything that moves with the camera: the app and the cursor. */
#camera { position: absolute; inset: 0; transform-origin: 0 0; }
#shot { position: absolute; inset: 0; width: 100%; height: 100%; }
#cursor { position: absolute; left: -5px; top: -5px; width: 36px; height: 36px; color: ${COLOURS[look.cursor]}; }
#cursor svg { display: block; transform-origin: 5px 5px; animation: dip 250ms linear paused; }
/* A click: the arrow pressed in, then springing back past its size and settling. */
@keyframes dip {
  0% { transform: scale(1); animation-timing-function: cubic-bezier(.2,.7,.3,1); }
  36% { transform: scale(.9); animation-timing-function: ease-out; }
  68% { transform: scale(1.03); animation-timing-function: ease-in-out; }
  100% { transform: scale(1); }
}
</style></head><body>
<div id="backdrop"></div>
<div id="window"><div id="camera"><img id="shot" alt=""><div id="cursor">${arrow}</div></div></div>
<script>
const data = ${JSON.stringify(data)};
const shot = document.getElementById('shot');
const cursor = document.getElementById('cursor');
const dip = () => cursor.querySelector('svg').getAnimations()[0];

// The last of a list timed by 'at' that has started by t.
const lastBy = (list, t) => {
  let lo = 0, hi = list.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].at <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
};

window.stage = {
  data,
  async seek(t) {
    const frame = data.frames[Math.max(0, lastBy(data.frames, t))];
    if (frame && shot.getAttribute('src') !== frame.file) {
      shot.setAttribute('src', frame.file);
      await shot.decode().catch(() => {});
    }
    // The cursor between the two samples around t.
    const i = lastBy(data.pointer, t);
    const a = data.pointer[Math.max(0, i)], b = data.pointer[i + 1];
    if (a) {
      const k = b && i >= 0 ? Math.min(1, (t - a.at) / Math.max(1e-6, b.at - a.at)) : 0;
      const x = b ? a.x + (b.x - a.x) * k : a.x, y = b ? a.y + (b.y - a.y) * k : a.y;
      cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    }
    const click = data.clicks[lastBy(data.clicks, t)];
    const press = dip();
    if (press) press.currentTime = click ? Math.min(250, (t - click.at) * 1000) : 250;
    // Timed elements: their animations run from data-at, and data-for limits when they show.
    for (const el of document.querySelectorAll('[data-at]')) {
      const local = t - Number(el.dataset.at);
      if (el.dataset.for) el.style.visibility = local >= 0 && local < Number(el.dataset.for) ? 'visible' : 'hidden';
      for (const animation of el.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = Math.max(0, local * 1000);
      }
    }
    await new Promise((done) => requestAnimationFrame(() => done()));
  },
};
</script>
${extra}
</body></html>`
}

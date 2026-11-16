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

const CANVAS = { width: 1920, height: 1080 }
const ORIGIN = 'https://stage.product-demo'
const COLOURS: Record<Config['cursor'], string> = { pink: '#ff7ccb', lime: '#b6f24f' }

/** A highlight as the stage draws it, timed from the footage's start. */
export interface Highlighted {
  at: number
  until: number
  box: number[]
  zoom: number
  style: 'box' | 'magnify' | 'cursor'
  colour: string
}

/** What the stage is told, in video time (seconds from its start) and app pixels. */
interface StageData {
  length: number
  frames: { file: string; at: number }[]
  pointer: { at: number; x: number; y: number }[]
  clicks: { at: number; x: number; y: number }[]
  highlights: Highlighted[]
  title: string
}

/** Opens the stage for this footage. `extra` is HTML added on top, such as more effects. */
export async function openStage(
  browser: Browser,
  footageDir: string,
  footage: Footage,
  highlights: Highlighted[],
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
    highlights: highlights.map((h) => ({ ...h, at: h.at - start, until: h.until - start })),
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
#highlight { position: absolute; box-sizing: border-box; border: 3px solid; border-radius: 8px; opacity: 0; }
/* Magnify: a copy of the region, lifted off the dimmed screen. */
#dim { position: absolute; inset: 0; background: rgb(15 15 30); opacity: 0; }
#lift { position: absolute; overflow: hidden; border-radius: 12px; opacity: 0; transform-origin: center;
  box-shadow: 0 28px 70px rgb(0 0 0 / .32), 0 8px 20px rgb(0 0 0 / .18); }
#lift img { position: absolute; width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; max-width: none; }
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
<div id="window"><div id="camera"><img id="shot" alt=""><div id="highlight"></div><div id="dim"></div><div id="lift"><img alt=""></div><div id="cursor">${arrow}</div></div></div>
<script>
const data = ${JSON.stringify(data)};
const shot = document.getElementById('shot');
const cursor = document.getElementById('cursor');
const camera = document.getElementById('camera');
const box = document.getElementById('highlight');
const dim = document.getElementById('dim');
const lift = document.getElementById('lift');
const lens = lift.querySelector('img');
// Out past 1 and back: the lift's spring.
const pop = (k) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2;
const W = ${VIEWPORT.width}, H = ${VIEWPORT.height};
const ease = (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);

// A highlight at t. The camera zooms toward its box by its zoom (1 is the box filling the
// view), centred on it but never past the app's edges. Then either an outline in its colour
// fades in, the region is magnified (a copy of it lifts off the dimmed screen), or the cursor
// circles it from where it rests.
const highlightAt = async (t, rest) => {
  const h = data.highlights.find((h) => t >= h.at && t < h.until);
  if (!h) {
    box.style.opacity = dim.style.opacity = lift.style.opacity = 0;
    camera.style.transform = '';
    return;
  }
  const [x, y, w, h2] = h.box;
  const since = t - h.at, left = h.until - t;
  const inOut = Math.min(0.6, (h.until - h.at) / 3);
  const e = ease(Math.min(1, since / inOut, left / inOut));
  const full = Math.min(W / (w + 96), H / (h2 + 96));
  const scale = 1 + (Math.max(1, full) - 1) * h.zoom * e;
  const fx = W / 2 + (x + w / 2 - W / 2) * e, fy = H / 2 + (y + h2 / 2 - H / 2) * e;
  const tx = Math.min(0, Math.max(W - W * scale, W / 2 - fx * scale));
  const ty = Math.min(0, Math.max(H - H * scale, H / 2 - fy * scale));
  camera.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  const fade = Math.min(1, since / 0.25, left / 0.25);
  if (h.style === 'cursor') {
    box.style.opacity = dim.style.opacity = lift.style.opacity = 0;
    if (!rest) return;
    // Once round a ring about the box, clockwise, starting from the point nearest where the
    // cursor rests. The cursor eases onto the moving ring and off it again, so it flows into
    // and out of the loop rather than stopping to turn.
    const span = h.until - h.at, go = Math.min(0.45, span / 4);
    const cx = x + w / 2, cy = y + h2 / 2, rx = w / 2 + 20, ry = h2 / 2 + 20;
    const a0 = Math.atan2((rest.x - cx) / rx, -(rest.y - cy) / ry);
    const a = a0 + 2 * Math.PI * (0.5 - 0.5 * Math.cos((Math.PI * since) / span));
    const on = ease(Math.min(1, since / go, left / go));
    const px = rest.x + (cx + rx * Math.sin(a) - rest.x) * on;
    const py = rest.y + (cy - ry * Math.cos(a) - rest.y) * on;
    cursor.style.transform = 'translate(' + px + 'px,' + py + 'px)';
    return;
  }
  if (h.style === 'box') {
    const pad = 8;
    Object.assign(box.style, { left: x - pad + 'px', top: y - pad + 'px', width: w + pad * 2 + 'px', height: h2 + pad * 2 + 'px', borderColor: h.colour, opacity: fade });
    dim.style.opacity = lift.style.opacity = 0;
    return;
  }
  const pad = 6;
  Object.assign(lift.style, { left: x - pad + 'px', top: y - pad + 'px', width: w + pad * 2 + 'px', height: h2 + pad * 2 + 'px' });
  Object.assign(lens.style, { left: pad - x + 'px', top: pad - y + 'px' });
  if (lens.getAttribute('src') !== shot.getAttribute('src')) {
    lens.setAttribute('src', shot.getAttribute('src'));
    await lens.decode().catch(() => {});
  }
  const grow = Math.min(pop(Math.min(1, since / 0.45)), ease(Math.min(1, left / 0.3)));
  lift.style.transform = 'scale(' + (1 + 0.22 * grow) + ')';
  lift.style.opacity = Math.min(1, since / 0.1, left / 0.2);
  dim.style.opacity = 0.35 * e;
  box.style.opacity = 0;
};
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
    let rest;
    if (a) {
      const k = b && i >= 0 ? Math.min(1, (t - a.at) / Math.max(1e-6, b.at - a.at)) : 0;
      const x = b ? a.x + (b.x - a.x) * k : a.x, y = b ? a.y + (b.y - a.y) * k : a.y;
      cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      rest = { x, y };
    }
    await highlightAt(t, rest);
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

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
/**
 * Each cursor: its drawing, its size on the stage, where its tip is (from its top left, in
 * stage pixels) and its colour. The rounded arrow comes in colours; `macos` is a classic
 * pointer, black with a white edge.
 */
const CURSOR_LOOKS: Record<
  Config['cursor'],
  { file: string; width: number; height: number; tip: number; colour: string }
> = {
  black: { file: 'arrow.svg', width: 28.8, height: 28.8, tip: 4, colour: '#111111' },
  pink: { file: 'arrow.svg', width: 28.8, height: 28.8, tip: 4, colour: '#ff7ccb' },
  lime: { file: 'arrow.svg', width: 28.8, height: 28.8, tip: 4, colour: '#b6f24f' },
  macos: { file: 'macos.svg', width: 27.5, height: 38.75, tip: 1.875, colour: '#000000' },
}

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
  /** The address bar's text over time, for a browser frame. */
  addresses: { at: number; label: string }[]
  title: string
}

/** Opens the stage for this footage. `extra` is HTML added on top, such as more effects. */
export async function openStage(
  browser: Browser,
  footageDir: string,
  footage: Footage,
  highlights: Highlighted[],
  look: {
    backdrop: Config['backdrop']
    cursor: Config['cursor']
    cursorSize: number
    display: Config['display']
  },
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
    addresses: (footage.addresses ?? []).map((a) => ({ at: a.at - start, label: label(a.url) })),
    title,
  }
  const library = (path: string) => new URL(`../library/${path}`, import.meta.url)
  const files: Record<string, () => Promise<Buffer>> = {
    '/backdrop.jpg': () => readFile(library(`backdrops/${look.backdrop}.jpg`)),
  }
  const arrow = await readFile(library(`cursors/${CURSOR_LOOKS[look.cursor].file}`), 'utf8')

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

/** An address as an address bar shows it: no scheme, nothing trailing. */
function label(url: string): string {
  return url.replace(/^[a-z]+:\/\//, '').replace(/[/#]+$/, '')
}

/** A browser window's toolbar, as Chapter draws it: lights, back and forward, the address, share, new tab, tabs. */
function toolbar(): string {
  const light = (x: number, colour: string) =>
    `<i class="light" style="left:${x}px;background:${colour}"></i>`
  const icon = (x: number, paths: string, style = '') =>
    `<svg viewBox="0 0 18 18" style="left:${x}px;${style}">${paths}</svg>`
  return `<div id="glass"><div id="frost"></div><div id="bar">
${light(16, '#ff5f57')}${light(36, '#febc2e')}${light(56, '#28c840')}
${icon(95, '<path d="M12 3 6 9l6 6"/>')}${icon(121, '<path d="m6 3 6 6-6 6"/>', 'opacity:.5')}
<div id="address"><svg viewBox="0 0 14 14"><rect x="3" y="6.5" width="8" height="6" rx="1.5" fill="currentColor" stroke="none"/><path d="M4.8 6.5V5a2.2 2.2 0 0 1 4.4 0v1.5"/></svg><span id="address-text"></span></div>
<span style="position:absolute;right:0;top:0;width:120px;height:${BAR}px">
${icon(8, '<path d="M7 6H5v8h8V6h-2M9 11V2M6.5 4.5 9 2l2.5 2.5"/>')}
${icon(44, '<path d="M3 9h12M9 3v12"/>')}
${icon(80, '<rect x="3" y="6" width="9" height="9" rx="2"/><path d="M6 3h7a2 2 0 0 1 2 2v7"/>')}
</span></div></div>`
}

// A browser window's glass: a toolbar across the top and a rim at the sides and bottom.
const BAR = 46
const RIM = 10

function html(
  data: StageData,
  arrow: string,
  look: { cursor: Config['cursor']; cursorSize: number; display: Config['display'] },
  extra: string,
): string {
  const browser = look.display === 'browser'
  // The cursor at its own size, times the config's.
  const own = CURSOR_LOOKS[look.cursor]
  const pointer = {
    ...own,
    width: own.width * look.cursorSize,
    height: own.height * look.cursorSize,
    tip: own.tip * look.cursorSize,
  }
  // In a browser it's the whole window, toolbar and all, that's centred.
  const app = {
    x: (CANVAS.width - VIEWPORT.width) / 2,
    y: (CANVAS.height - VIEWPORT.height + (browser ? BAR - RIM : 0)) / 2,
  }
  const glass = {
    x: app.x - RIM,
    y: app.y - BAR,
    width: VIEWPORT.width + RIM * 2,
    height: VIEWPORT.height + BAR + RIM,
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: ${CANVAS.width}px; height: ${CANVAS.height}px; overflow: hidden; }
body { font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }
#backdrop { position: absolute; inset: 0; background: url(/backdrop.jpg) center / cover; }
#window {
  position: absolute; left: ${app.x}px; top: ${app.y}px;
  width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px;
  border-radius: ${browser ? 10 : 14}px; overflow: hidden; background: #fff;
  box-shadow: ${browser ? '0 1px 6px rgb(20 20 50 / 0.10)' : '0 30px 80px rgb(20 20 60 / 0.28), 0 6px 18px rgb(20 20 60 / 0.16)'};
}
/* A browser window of frosted glass: the backdrop blurred and milky behind its toolbar. */
#glass {
  position: absolute; left: ${glass.x}px; top: ${glass.y}px; width: ${glass.width}px; height: ${glass.height}px;
  border-radius: 16px; overflow: hidden; box-shadow: 0 30px 70px rgb(40 30 80 / .18), 0 0 0 0.5px rgb(30 30 60 / .12);
}
/* The frost: the backdrop itself, lined up with the one behind and blurred, clipped to the
   glass, so its edges are as even as its middle. Then a milky pane over it. */
#frost { position: absolute; left: ${-glass.x}px; top: ${-glass.y}px; width: ${CANVAS.width}px; height: ${CANVAS.height}px;
  background: url(/backdrop.jpg) center / cover; filter: blur(28px) saturate(1.3); }
#glass::after { content: ''; position: absolute; inset: 0; background: rgb(255 255 255 / .52); }
#bar { z-index: 1; }
#bar { position: absolute; left: 0; right: 0; top: 0; height: ${BAR}px; display: flex; align-items: center;
  color: rgb(40 40 55 / .55); }
#bar .light { position: absolute; top: ${BAR / 2 - 6}px; width: 12px; height: 12px; border-radius: 50%;
  box-shadow: inset 0 0 0 .75px rgb(0 0 0 / .12); }
#bar svg { position: absolute; top: ${BAR / 2 - 9}px; width: 18px; height: 18px; fill: none;
  stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
#address { position: absolute; left: 50%; top: ${BAR / 2 - 15}px; width: 460px; height: 30px; margin-left: -230px;
  box-sizing: border-box; border-radius: 9px; background: rgb(255 255 255 / .62); border: 1px solid rgb(255 255 255 / .9);
  display: flex; align-items: center; justify-content: center; gap: 7px; padding: 0 40px;
  font: 500 14px Inter, system-ui, -apple-system, sans-serif; color: rgb(30 30 40 / .8); }
#address span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#address svg { position: static; flex: none; width: 14px; height: 14px; }
/* Everything that moves with the camera: the app and the cursor. */
#camera { position: absolute; inset: 0; transform-origin: 0 0; }
#shot { position: absolute; inset: 0; width: 100%; height: 100%; }
#highlight { position: absolute; box-sizing: border-box; border: 3px solid; border-radius: 8px; opacity: 0; }
/* Magnify: a copy of the region, lifted off the dimmed screen. */
#dim { position: absolute; inset: 0; background: rgb(15 15 30); opacity: 0; }
#lift { position: absolute; overflow: hidden; border-radius: 12px; opacity: 0; transform-origin: center;
  box-shadow: 0 28px 70px rgb(0 0 0 / .32), 0 8px 20px rgb(0 0 0 / .18); }
#lift img { position: absolute; width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; max-width: none; }
/* The cursor with its tip on the pointer, and a soft shadow so it reads on any app. */
#cursor { position: absolute; left: -${pointer.tip}px; top: -${pointer.tip}px; width: ${pointer.width}px; height: ${pointer.height}px; color: ${pointer.colour}; }
#cursor svg { display: block; width: 100%; height: 100%; overflow: visible; transform-origin: ${pointer.tip}px ${pointer.tip}px; animation: dip 250ms linear paused;
  filter: drop-shadow(0 1.5px 2.5px rgb(0 0 0 / .28)); }
/* A click: the arrow pressed in, then springing back past its size and settling. */
@keyframes dip {
  0% { transform: scale(1); animation-timing-function: cubic-bezier(.2,.7,.3,1); }
  36% { transform: scale(.9); animation-timing-function: ease-out; }
  68% { transform: scale(1.03); animation-timing-function: ease-in-out; }
  100% { transform: scale(1); }
}
</style></head><body>
<div id="backdrop"></div>
${browser ? toolbar() : ''}
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
// view, but never past 2x: the frames are recorded at 1x), centred on it but never past the
// app's edges. It zooms about one fixed point, worked out from where it ends, so the box only
// ever moves one way on screen, never out and back. Then either an outline in its colour
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
  const inOut = Math.min(0.8, (h.until - h.at) / 3);
  const e = ease(Math.min(1, since / inOut, left / inOut));
  const full = Math.min(2, W / (w + 96), H / (h2 + 96));
  const end = 1 + (Math.max(1, full) - 1) * h.zoom;
  const endX = Math.min(0, Math.max(W - W * end, W / 2 - (x + w / 2) * end));
  const endY = Math.min(0, Math.max(H - H * end, H / 2 - (y + h2 / 2) * end));
  // The point that stays put: where it is on the page is where it ends on screen.
  const px = end > 1 ? endX / (1 - end) : 0, py = end > 1 ? endY / (1 - end) : 0;
  const scale = 1 + (end - 1) * e;
  camera.style.transform = 'translate(' + px * (1 - scale) + 'px,' + py * (1 - scale) + 'px) scale(' + scale + ')';
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
    const address = data.addresses[lastBy(data.addresses, t)];
    const bar = document.getElementById('address-text');
    if (bar && address && bar.textContent !== address.label) bar.textContent = address.label;
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

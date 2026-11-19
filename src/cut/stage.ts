import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { isHex, type Config, type CURSORS } from '../config.ts'
import type { Footage } from '../perform.ts'

export const CANVAS = { width: 1920, height: 1080 }
const ORIGIN = 'https://stage.product-demo'
interface CursorLook {
  file: string | URL
  width: number
  height: number
  tip: [number, number]
  colour: string
  label: { x: number; y: number; text: string }
}

const CURSOR_LOOKS: Record<(typeof CURSORS)[number], CursorLook> = {
  black: {
    file: library('cursors/arrow.svg'),
    width: 28.8,
    height: 28.8,
    tip: [4, 4],
    colour: '#111111',
    label: { x: 22.75, y: 20.5, text: '#ffffff' },
  },
  pink: {
    file: library('cursors/arrow.svg'),
    width: 28.8,
    height: 28.8,
    tip: [4, 4],
    colour: '#ff7ccb',
    label: { x: 22.75, y: 20.5, text: '#ffffff' },
  },
  lime: {
    file: library('cursors/arrow.svg'),
    width: 28.8,
    height: 28.8,
    tip: [4, 4],
    colour: '#b6f24f',
    label: { x: 22.75, y: 20.5, text: '#111111' },
  },
  macos: {
    file: library('cursors/macos.svg'),
    width: 27.5,
    height: 38.75,
    tip: [1.875, 1.875],
    colour: '#000000',
    label: { x: 24, y: 26, text: '#ffffff' },
  },
}

function library(path: string): URL {
  return new URL(`../library/${path}`, import.meta.url)
}

async function cursorFor(cursor: Config['cursor']): Promise<{ look: CursorLook; svg: string }> {
  const { style } = cursor
  if (typeof style !== 'object') {
    const look = cursorLook(style)
    return { look, svg: await readFile(look.file, 'utf8') }
  }
  const { width, height, unit } = svgSize(await readFile(style.file, 'utf8'))
  const [x = 0, y = 0] = cursor.tip ?? []
  const look = {
    ...CURSOR_LOOKS.black,
    file: style.file,
    width,
    height,
    tip: [x * unit, y * unit] satisfies [number, number],
    label: { x: width * 0.8, y: height * 0.7, text: '#ffffff' },
  }
  return { look, svg: '<img src="/cursor.svg" alt="">' }
}

function svgSize(svg: string): { width: number; height: number; unit: number } {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? ''
  const length = (name: string) => {
    const found = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i').exec(tag)
    return found ? Number(found[1]) || undefined : undefined
  }
  const numbers = (/\sviewBox\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  const [boxWidth = 0, boxHeight = 0] = numbers.slice(2)
  const box = boxWidth > 0 && boxHeight > 0 ? { width: boxWidth, height: boxHeight } : undefined
  let width = length('width')
  let height = length('height')
  if (width && !height) height = box ? (width * box.height) / box.width : width
  if (height && !width) width = box ? (height * box.width) / box.height : height
  if (!width || !height) {
    const own = box ?? { width: 32, height: 32 }
    const fit = 32 / Math.max(own.width, own.height)
    width = own.width * fit
    height = own.height * fit
  }
  return { width, height, unit: box ? width / box.width : 1 }
}

function cursorLook(style: Exclude<Config['cursor']['style'], object>): CursorLook {
  if (!isHex(style)) return CURSOR_LOOKS[style]
  const channel = (at: number) => parseInt(style.slice(at, at + 2), 16) / 255
  const light = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5) > 0.8
  const text = light ? '#111111' : '#ffffff'
  return { ...CURSOR_LOOKS.black, colour: style, label: { ...CURSOR_LOOKS.black.label, text } }
}

export interface Highlighted {
  at: number
  until: number
  box: number[]
  zoom: number
  style: 'box' | 'magnify' | 'cursor'
  colour: string
}

interface StageData {
  length: number
  frames: { file: string; at: number }[]
  pointer: { at: number; x: number; y: number }[]
  clicks: { at: number; x: number; y: number }[]
  highlights: Highlighted[]
  addresses: { at: number; label: string }[]
  title: string
}

export type Look = Pick<Config, 'backdrop' | 'cursor' | 'display' | 'window'>

export type StageFiles = (
  path: string,
) => Promise<{ contentType: string; body: Buffer | string } | undefined>

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

export function stageFiles(
  footageDir: string,
  footage: Footage,
  highlights: Highlighted[],
  look: () => Look,
  length: number,
  title: string,
  extra = '',
): StageFiles {
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
  const view = footage.viewport ?? { width: 1440, height: 900 }
  return async (path) => {
    const now = look()
    const { backdrop } = now
    const picture =
      typeof backdrop === 'object'
        ? backdrop.file
        : isHex(backdrop)
          ? undefined
          : library(`backdrops/${backdrop}.jpg`)
    const served =
      picture && `/backdrop${extname(typeof picture === 'string' ? picture : picture.pathname)}`
    if (path === '/') {
      const background = served ? `url(${served}) center / cover` : String(backdrop)
      const cursor = await cursorFor(now.cursor)
      return {
        contentType: 'text/html',
        body: html(data, cursor, background, now, extra, view),
      }
    }
    const { style } = now.cursor
    const asked = resolve(footageDir, decodeURIComponent(path.slice(1)))
    const inside = asked.startsWith(resolve(footageDir) + sep)
    const file =
      served && picture && path === served
        ? picture
        : path === '/cursor.svg' && typeof style === 'object'
          ? style.file
          : inside
            ? asked
            : undefined
    if (!file) return undefined
    const body = await readFile(file).catch(() => undefined)
    if (!body) return undefined
    return { contentType: IMAGE_TYPES[extname(path)] ?? 'image/jpeg', body }
  }
}

export async function openStage(
  browser: Browser,
  footageDir: string,
  footage: Footage,
  highlights: Highlighted[],
  look: Look,
  length: number,
  title: string,
  extra = '',
): Promise<Page> {
  const files = stageFiles(footageDir, footage, highlights, () => look, length, title, extra)
  const page = await browser.newPage({ viewport: CANVAS, deviceScaleFactor: 1 })
  await page.route(`${ORIGIN}/**`, async (route) => {
    const file = await files(new URL(route.request().url()).pathname)
    if (!file) return route.fulfill({ status: 404 })
    return route.fulfill({ ...file, headers: { 'cache-control': 'no-store' } })
  })
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => document.fonts.ready)
  return page
}

function label(url: string): string {
  return url.replace(/^[a-z]+:\/\//, '').replace(/[/#]+$/, '')
}

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

const BAR = 46
const RIM = 10

function html(
  data: StageData,
  cursor: { look: CursorLook; svg: string },
  background: string,
  look: { cursor: Config['cursor']; display: Config['display']; window: Config['window'] },
  extra: string,
  view: { width: number; height: number },
): string {
  const browser = look.display === 'browser'
  const arrow = cursor.svg
  const own = cursor.look
  const pointer = {
    ...own,
    width: own.width * look.cursor.size,
    height: own.height * look.cursor.size,
    tip: own.tip.map((at) => at * look.cursor.size),
  }
  const k = look.cursor.size
  const label = look.cursor.label
    ? `<div id="label">${look.cursor.label.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`
    : ''
  const { width: W, height: H } = view
  const chrome = browser ? { x: RIM * 2, y: BAR + RIM } : { x: 0, y: 0 }
  const fill = look.window.fill
  const s = Math.min(
    (CANVAS.width * fill - chrome.x) / W,
    (CANVAS.height * fill - chrome.y) / H,
    1.25,
  )
  const app = {
    x: (CANVAS.width - W * s) / 2,
    y: (CANVAS.height - H * s + (browser ? BAR - RIM : 0)) / 2,
  }
  const glass = {
    x: app.x - RIM,
    y: app.y - BAR,
    width: W * s + RIM * 2,
    height: H * s + BAR + RIM,
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; width: ${CANVAS.width}px; height: ${CANVAS.height}px; overflow: hidden; }
body { font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; }
#backdrop { position: absolute; inset: 0; background: ${background}; }
#window {
  position: absolute; left: ${app.x}px; top: ${app.y}px;
  width: ${W}px; height: ${H}px; transform: scale(${s}); transform-origin: 0 0;
  border-radius: ${(browser ? 10 : 14) / s}px; overflow: hidden; background: #fff;
  box-shadow: ${browser ? '0 1px 6px rgb(20 20 50 / 0.10)' : '0 30px 80px rgb(20 20 60 / 0.28), 0 6px 18px rgb(20 20 60 / 0.16)'};
}
#glass {
  position: absolute; left: ${glass.x}px; top: ${glass.y}px; width: ${glass.width}px; height: ${glass.height}px;
  border-radius: 16px; overflow: hidden; box-shadow: 0 30px 70px rgb(40 30 80 / .18), 0 0 0 0.5px rgb(30 30 60 / .12);
}
#frost { position: absolute; left: ${-glass.x}px; top: ${-glass.y}px; width: ${CANVAS.width}px; height: ${CANVAS.height}px;
  background: ${background}; filter: blur(28px) saturate(1.3); }
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
#camera { position: absolute; inset: 0; transform-origin: 0 0; }
#shot { position: absolute; inset: 0; width: 100%; height: 100%; }
#highlight { position: absolute; box-sizing: border-box; border: 3px solid; border-radius: 8px; opacity: 0; }
#dim { position: absolute; inset: 0; background: rgb(15 15 30); opacity: 0; }
#lift { position: absolute; overflow: hidden; border-radius: 12px; opacity: 0; transform-origin: center;
  box-shadow: 0 28px 70px rgb(0 0 0 / .32), 0 8px 20px rgb(0 0 0 / .18); }
#lift img { position: absolute; width: ${W}px; height: ${H}px; max-width: none; }
#cursor { position: absolute; left: -${pointer.tip[0]}px; top: -${pointer.tip[1]}px; width: ${pointer.width}px; height: ${pointer.height}px; color: ${pointer.colour}; }
#cursor > :first-child { display: block; width: 100%; height: 100%; overflow: visible; transform-origin: ${pointer.tip[0]}px ${pointer.tip[1]}px; animation: dip 250ms linear paused;
  filter: drop-shadow(0 1.5px 2.5px rgb(0 0 0 / .28)); }
#label { position: absolute; left: ${own.label.x * k}px; top: ${own.label.y * k}px; padding: ${4 * k}px ${8.25 * k}px;
  border-radius: 999px; background: ${own.colour}; color: ${own.label.text}; white-space: nowrap;
  font: 600 ${13.5 * k}px/${16.5 * k}px Inter, -apple-system, BlinkMacSystemFont, sans-serif; letter-spacing: -0.01em;
  box-shadow: 0 ${2 * k}px ${4 * k}px rgb(0 0 0 / .18); }
@keyframes dip {
  0% { transform: scale(1); animation-timing-function: cubic-bezier(.2,.7,.3,1); }
  36% { transform: scale(.9); animation-timing-function: ease-out; }
  68% { transform: scale(1.03); animation-timing-function: ease-in-out; }
  100% { transform: scale(1); }
}
</style></head><body>
<div id="backdrop"></div>
${browser ? toolbar() : ''}
<div id="window"><div id="camera"><img id="shot" alt=""><div id="highlight"></div><div id="dim"></div><div id="lift"><img alt=""></div><div id="cursor">${arrow}${label}</div></div></div>
<script>
const data = ${JSON.stringify(data)};
const shot = document.getElementById('shot');
const cursor = document.getElementById('cursor');
const camera = document.getElementById('camera');
const box = document.getElementById('highlight');
const dim = document.getElementById('dim');
const lift = document.getElementById('lift');
const lens = lift.querySelector('img');
const pop = (k) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2;
const W = ${W}, H = ${H};
const ease = (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2);

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
  const px = end > 1 ? endX / (1 - end) : 0, py = end > 1 ? endY / (1 - end) : 0;
  const scale = 1 + (end - 1) * e;
  camera.style.transform = 'translate(' + px * (1 - scale) + 'px,' + py * (1 - scale) + 'px) scale(' + scale + ')';
  const fade = Math.min(1, since / 0.25, left / 0.25);
  if (h.style === 'cursor') {
    box.style.opacity = dim.style.opacity = lift.style.opacity = 0;
    if (!rest) return;
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
const dip = () => cursor.firstElementChild.getAnimations()[0];

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

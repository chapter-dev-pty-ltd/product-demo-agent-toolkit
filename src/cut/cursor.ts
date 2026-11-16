import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import type { Cursor } from '../config.ts'
import type { Footage } from '../perform.ts'

// The cursor is drawn by the cut, along the path the shoot recorded, so its look can change
// without shooting again. It's the arrow from the Chapter site's hero, with the ripple each
// click sends out from its tip.

const COLOURS: Record<Cursor, string> = { pink: '#ff7ccb', lime: '#b6f24f' }
/** Where the arrow's tip sits in its picture. */
const TIP = 5
const RIPPLE = { size: 48, seconds: 0.45, fps: 60 }

/** Draws the cursor's pictures into `dir`: the arrow, and the ripple's frames. */
export async function drawCursor(page: Page, dir: string, cursor: Cursor): Promise<void> {
  const colour = COLOURS[cursor]
  const arrow = await readFile(new URL('../library/cursors/arrow.svg', import.meta.url), 'utf8')
  await page.setViewportSize({ width: 36, height: 36 })
  await page.setContent(`<body style="margin:0;color:${colour}">${arrow}</body>`)
  await page.screenshot({ path: join(dir, 'cursor.png'), omitBackground: true })

  const { size, seconds, fps } = RIPPLE
  await page.setViewportSize({ width: size, height: size })
  const frames = Math.round(seconds * fps)
  for (let i = 0; i <= frames; i++) {
    const r = i / frames
    const scale = 0.15 + (1 - (1 - r) ** 3) * 0.85
    const ring = `position:absolute;left:2px;top:2px;width:40px;height:40px;border-radius:50%;border:2px solid ${colour};background:${colour}14;opacity:${0.6 * (1 - r)};transform:scale(${scale})`
    await page.setContent(`<body style="margin:0"><div style="${ring}"></div></body>`)
    await page.screenshot({ path: join(dir, `ripple-${i}.png`), omitBackground: true })
  }
  // Nothing, for the time between ripples.
  await page.setContent('<body style="margin:0"></body>')
  await page.screenshot({ path: join(dir, 'ripple-none.png'), omitBackground: true })
}

/**
 * Writes the cursor's track into `dir`: when the arrow moves and where each ripple plays
 * (commands for ffmpeg's sendcmd), and the ripple's frames timed one after another. Returns
 * the filters that draw them over `[scene]`, offset by where the app sits on the canvas.
 */
export async function trackCursor(
  footage: Footage,
  dir: string,
  offset: { x: number; y: number },
  length: number,
): Promise<string> {
  const start = footage.frames[0]?.at ?? 0
  const time = (at: number) => Math.max(0, at - start).toFixed(3)
  const commands = footage.pointer.map(
    (p) =>
      `${time(p.at)} overlay@cursor x ${Math.round(p.x + offset.x - TIP)}, overlay@cursor y ${Math.round(p.y + offset.y - TIP)};`,
  )
  const { size, seconds, fps } = RIPPLE
  const frames = Math.round(seconds * fps)
  const ripple: string[] = []
  let at = 0
  for (const click of footage.clicks) {
    const from = Math.max(at, click.at - start)
    ripple.push(`file 'ripple-none.png'\nduration ${(from - at).toFixed(4)}`)
    for (let i = 0; i <= frames; i++)
      ripple.push(`file 'ripple-${i}.png'\nduration ${(1 / fps).toFixed(4)}`)
    commands.push(
      `${from.toFixed(3)} overlay@ripple x ${Math.round(click.x + offset.x - size / 2)}, overlay@ripple y ${Math.round(click.y + offset.y - size / 2)};`,
    )
    at = from + (frames + 1) / fps
  }
  ripple.push(`file 'ripple-none.png'\nduration ${Math.max(0.1, length - at).toFixed(4)}`)
  ripple.push(`file 'ripple-none.png'`)
  // sendcmd wants its commands in time order.
  commands.sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b))
  await writeFile(join(dir, 'cursor.txt'), commands.join('\n'))
  await writeFile(join(dir, 'ripple.txt'), ripple.join('\n'))
  return (
    `[scene]sendcmd=f=cursor.txt[cued];[3:v]fps=60,format=rgba[ripple];` +
    `[cued][ripple]overlay@ripple=x=-100:y=-100:eof_action=pass[rippled];` +
    `[rippled][4:v]overlay@cursor=x=-100:y=-100`
  )
}

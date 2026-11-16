import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Locator, Page } from 'playwright-core'
import { readConfig } from './config.ts'
import { findDrawn, type Drawn } from './drawn.ts'
import { describeStep, KEYS, type Key, type Point, type Step, type Target } from './film.ts'
import { LOG, readLog, startLog, writeLog } from './log.ts'
import { act, find, Hand, VIEWPORT, type Finder } from './perform.ts'
import { watch } from './settle.ts'
import { fingerprint } from './similo.ts'
import { launchBrowser } from './tools.ts'

// Exploring: the agent drives a browser one command at a time, off camera, to learn the
// app and find the path. A small process of ours holds the browser between commands, and
// every action the agent takes is logged and pinned, for it to write
// the film from afterwards (log.ts).

const DIR = join('.product-demo', 'explore')
const SESSION = join(DIR, 'session.json')
const IDLE_MS = 30 * 60_000

interface Session {
  port: number
  token: string
}

/** Starts a browser on `url` in the background and returns what's on screen. */
export async function explore(url: string): Promise<string> {
  if (existsSync(SESSION)) {
    throw new Error(
      'Already exploring. Run `product-demo-agent-toolkit end` first, or keep going with `look`.',
    )
  }
  await mkdir(DIR, { recursive: true })
  const log = openSync(join(DIR, 'browser.log'), 'w')
  const script = process.argv[1]
  if (!script)
    throw new Error(
      'Could not find the product-demo-agent-toolkit script to start the browser with.',
    )
  spawn(process.execPath, [script, '__serve', url], {
    detached: true,
    stdio: ['ignore', log, log],
  }).unref()
  for (let waited = 0; !existsSync(SESSION); waited += 200) {
    if (waited > 60_000)
      throw new Error(`The browser didn't start. See ${join(DIR, 'browser.log')}.`)
    await new Promise((done) => setTimeout(done, 200))
  }
  return send('look', [])
}

/** Runs one explore command in the background browser and returns its answer. */
export async function send(command: string, args: string[]): Promise<string> {
  let session: Session
  try {
    session = JSON.parse(await readFile(SESSION, 'utf8'))
  } catch {
    throw new Error('Not exploring. Start with `product-demo-agent-toolkit explore <url>`.')
  }
  const response = await fetch(`http://127.0.0.1:${session.port}/`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ command, args }),
  }).catch(async () => {
    await rm(SESSION, { force: true })
    throw new Error(
      'The explore browser has stopped. Start again with `product-demo-agent-toolkit explore <url>`.',
    )
  })
  const text = await response.text()
  if (!response.ok) throw new Error(text)
  return text
}

/** The background process: holds the browser and answers commands until `end`. */
export async function serve(url: string): Promise<void> {
  const config = await readConfig()
  const browser = await launchBrowser()
  let page = await browser.newPage({ viewport: VIEWPORT })
  let settler = watch(page)
  let hand = new Hand(page, true)
  await page.goto(url)
  await settler.settled()
  let looks = 0
  // What the last look found drawn on canvas-like surfaces, named d1, d2…; stale once an
  // action has run, since it may have changed the drawing.
  let drawn: Drawn[] = []
  let drawnChanged = false
  const target = async (name: string | undefined, at?: string) => {
    const ref = /^@?d(\d+)$/.exec(name ?? '')
    if (!ref) return aim(page, name, at)
    if (drawnChanged)
      throw new Error('The drawing has changed since the last look. Run look for fresh refs.')
    const thing = drawn[Number(ref[1]) - 1]
    if (!thing) throw new Error(`The last look found nothing drawn called ${name}.`)
    const where = at === undefined ? undefined : fractions(at)
    const x = where ? thing.x + thing.width * where.x : thing.grip.x
    const y = where ? thing.y + thing.height * where.y : thing.grip.y
    return aim(page, `${Math.round(x)},${Math.round(y)}`)
  }
  let idle = setTimeout(() => void stop(), IDLE_MS)

  const stop = async () => {
    await rm(SESSION, { force: true })
    await browser.close()
    process.exit(0)
  }

  // The log lives in the file, not here: the agent may add notes to it between commands, so
  // it is read back before every change and never overwritten from memory. A log that
  // doesn't parse stops the action before it happens.
  await startLog(url)
  const address = () => {
    const now = new URL(page.url())
    return `${now.pathname}${now.search}${now.hash}`
  }

  /**
   * Performs a step the way a shoot will, at once, then logs it. The
   * elements it names were just pinned, so they're used as they are, not found again.
   */
  const logged = async (step: Step, said: string, aimed: Aimed[] = []) => {
    const log = await readLog()
    const finder: Finder = async (target) => {
      const known = aimed.find((a) => a.target === target)
      if (!known) return find(page, target, config, () => {})
      await known.element.scrollIntoViewIfNeeded()
      return known.element
    }
    try {
      await settler.mark()
      await act(page, hand, url, step, finder)
      const settled = await settler.settled()
      if (drawn.length) drawnChanged = true
      const n = log.entries.length + 1
      const warning = settled.settled
        ? undefined
        : `The page hadn't settled after 10s: ${settled.waitingOn.join(', ')}.`
      log.entries.push({
        n,
        step,
        at: address(),
        ...(warning ? { warning } : {}),
      })
      await writeLog(log)
      return `${n}. ${said}${warning ? ` ${warning}` : ''}`
    } finally {
      for (const a of aimed) await a.release()
    }
  }

  const commands: Record<string, (args: string[]) => Promise<string>> = {
    look: async ([flag]) => {
      looks++
      const shot = join(DIR, `look-${looks}.png`)
      const snapshot = await page.ariaSnapshot({ mode: 'ai', boxes: true })
      drawn = await findDrawn(page)
      drawnChanged = false
      await screenshotWithRefs(page, snapshot, shot, drawn)
      const { text, above, below } =
        flag === '--all' ? { text: snapshot, above: 0, below: 0 } : onScreen(snapshot)
      const bare = text.replace(/ \[box=[\d.,-]+\]/g, '')
      const trimmed =
        bare.length > 40_000 ? `${bare.slice(0, 40_000)}\n… (cut at 40,000 characters)` : bare
      const off =
        above || below
          ? `\n\nOff screen: ${above} elements above, ${below} below. Scroll to them, or run \`look --all\` for the whole page.`
          : ''
      const things = drawn.map(
        (d, i) => `- drawn [ref=d${i + 1}] [box=${d.x},${d.y},${d.width},${d.height}] ${d.colour}`,
      )
      const canvas = things.length
        ? `\n\nDrawn on canvas-like areas, read from the screen (not in the tree above). Name them by ref; --at is a point on their box:\n${things.join('\n')}`
        : ''
      return `${page.url()} — "${await page.title()}"\n${trimmed}${off}${canvas}\n\nScreenshot with refs: ${shot}`
    },
    handles: async () => handles(page),
    click: async (args) => {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          at: { type: 'string' },
          double: { type: 'boolean' },
          right: { type: 'boolean' },
          with: { type: 'string' },
        },
      })
      const aimed = await target(positionals[0], values.at)
      const modifiers = keys(values.with)
      const step: Step = {
        click: aimed.target,
        ...(aimed.at ? { at: aimed.at } : {}),
        ...(values.double ? { double: true } : {}),
        ...(values.right ? { right: true } : {}),
        ...(modifiers.length ? { modifiers } : {}),
      }
      return logged(step, `${describeStep(step)}.`, [aimed])
    },
    fill: async ([ref, text]) => {
      if (text === undefined) throw new Error('Usage: product-demo-agent-toolkit fill <ref> "text"')
      const aimed = await target(ref)
      return logged({ fill: aimed.target, text }, `Filled ${aimed.target.locator}.`, [aimed])
    },
    select: async ([ref, option]) => {
      if (option === undefined)
        throw new Error('Usage: product-demo-agent-toolkit select <ref> "option"')
      const aimed = await target(ref)
      return logged({ select: aimed.target, option }, `Chose "${option}".`, [aimed])
    },
    type: async ([text]) => {
      if (text === undefined) throw new Error('Usage: product-demo-agent-toolkit type "text"')
      return logged({ type: text }, `Typed "${text}".`)
    },
    press: async ([key]) => {
      if (!key) throw new Error('Usage: product-demo-agent-toolkit press <key>')
      return logged({ press: key }, `Pressed ${key}.`)
    },
    hover: async (args) => {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { at: { type: 'string' }, for: { type: 'string' } },
      })
      const aimed = await target(positionals[0], values.at)
      const seconds = values.for === undefined ? undefined : Number(values.for)
      const step: Step = {
        hover: aimed.target,
        ...(aimed.at ? { at: aimed.at } : {}),
        ...(seconds ? { seconds } : {}),
      }
      return logged(step, `Hovered over ${aimed.target.locator}.`, [aimed])
    },
    drag: async (args) => {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { at: { type: 'string' }, 'to-at': { type: 'string' } },
      })
      if (positionals.length !== 2)
        throw new Error('Usage: product-demo-agent-toolkit drag <from> <to>')
      const from = await target(positionals[0], values.at)
      const to = await target(positionals[1], values['to-at']).catch(async (error: unknown) => {
        await from.release()
        throw error
      })
      const step: Step = {
        drag: from.target,
        ...(from.at ? { at: from.at } : {}),
        to: to.target,
        ...(to.at ? { toAt: to.at } : {}),
      }
      return logged(step, `${describeStep(step)}.`, [from, to])
    },
    scroll: async (args) => {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { in: { type: 'string' }, by: { type: 'string' } },
      })
      const [direction] = positionals
      if (direction !== 'up' && direction !== 'down')
        throw new Error(
          'Usage: product-demo-agent-toolkit scroll up|down [--in <ref>] [--by <pixels>]',
        )
      const pane = values.in === undefined ? undefined : await target(values.in)
      const step: Step = {
        scroll: direction,
        ...(pane ? { in: pane.target } : {}),
        ...(values.by ? { pixels: Number(values.by) } : {}),
      }
      return logged(step, `${describeStep(step)}.`, pane ? [pane] : [])
    },
    upload: async ([file, ref]) => {
      if (!file)
        throw new Error(
          'Usage: product-demo-agent-toolkit upload <file> [<ref of the upload control>]',
        )
      const control = ref === undefined ? undefined : await target(ref)
      const step: Step = { upload: file, ...(control ? { into: control.target } : {}) }
      return logged(step, `Uploaded ${file}.`, control ? [control] : [])
    },
    visit: async ([path]) => {
      if (!path) throw new Error('Usage: product-demo-agent-toolkit visit <path>')
      return logged({ visit: path }, `Opened ${path}.`)
    },
    wait: async (args) => {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { gone: { type: 'boolean' } },
      })
      const [what] = positionals
      if (!what)
        throw new Error('Usage: product-demo-agent-toolkit wait "text" [--gone] | <seconds>')
      const seconds = Number(what)
      if (Number.isFinite(seconds)) return logged({ wait: seconds }, `Waited ${seconds}s.`)
      const step: Step = { wait: { text: what, ...(values.gone ? { gone: true } : {}) } }
      return logged(step, values.gone ? `"${what}" has gone.` : `"${what}" is on screen.`)
    },
    back: async () => {
      // A browser can't undo a click, so going back marks the last step undone and replays
      // the rest in a fresh browser, quickly and off camera. The log keeps every step.
      const log = await readLog()
      const last = log.entries.filter((e) => !e.undone).at(-1)
      if (!last) throw new Error('There are no steps to go back from.')
      last.undone = true
      await writeLog(log)
      await page.close()
      page = await browser.newPage({ viewport: VIEWPORT })
      settler = watch(page)
      hand = new Hand(page, true)
      await page.goto(url)
      await settler.settled()
      const path = log.entries.filter((e) => !e.undone)
      for (const entry of path) {
        await settler.mark()
        await act(page, hand, url, entry.step, (target) =>
          find(page, target, config, () => {}),
        ).catch((error: unknown) => {
          throw new Error(
            `Marked step ${last.n} undone, but couldn't replay step ${entry.n} (${describeStep(entry.step)}): ${error instanceof Error ? error.message : String(error)}`,
          )
        })
        await settler.settled()
      }
      return `Marked step ${last.n} (${describeStep(last.step)}) undone and replayed the ${path.length} steps before it. The screen is as it was before it; run look.`
    },
    end: async () => {
      const log = await readLog()
      setTimeout(() => void stop(), 100)
      return `Closed the browser. The log, with ${log.entries.length} steps, is ${LOG}: write film.json from it.`
    },
  }

  const token = randomBytes(24).toString('hex')
  const server = createServer(async (request, response) => {
    clearTimeout(idle)
    idle = setTimeout(() => void stop(), IDLE_MS)
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end('Not allowed.')
      return
    }
    try {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const { command, args }: { command: string; args: string[] } = JSON.parse(body)
      const run = commands[command]
      if (!run) throw new Error(`No explore command named ${command}.`)
      // Run first: a header sent before the command fails can't be taken back.
      const answer = await run(args)
      response.writeHead(200).end(answer)
    } catch (error) {
      response.writeHead(400).end(error instanceof Error ? error.message : String(error))
    }
  })
  server.listen(0, '127.0.0.1', async () => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    await writeFile(SESSION, JSON.stringify({ port, token } satisfies Session))
  })
}

/** An element named by a ref from `look` or by a point on the screen, pinned. */
interface Aimed {
  element: Locator
  target: Target & { locator: string }
  /** Where on it, for a point or `--at`. */
  at?: Point
  /** Takes off the mark a point leaves on its element while the step uses it. */
  release: () => Promise<void>
}

async function aim(page: Page, name: string | undefined, at?: string): Promise<Aimed> {
  const xy = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(name ?? '')
  if (!xy) {
    if (!name || !/^@?\w*e\d+$/.test(name))
      throw new Error(
        'Name an element by its ref from `look`, like @e12, or a point on its screenshot, like 640,320.',
      )
    const element = page.getByRef(name.replace('@', ''))
    const where = at === undefined ? undefined : fractions(at)
    return {
      element,
      target: await pin(element),
      ...(where ? { at: where } : {}),
      release: async () => {},
    }
  }
  // A point: the element drawn there (inside open shadow roots too), pinned like any other,
  // and where on it the point falls, so a layout that shifts doesn't move the step.
  const x = Number(xy[1])
  const y = Number(xy[2])
  const mark = randomBytes(4).toString('hex')
  const box = await page.evaluate(
    ({ x, y, mark }) => {
      let element = document.elementFromPoint(x, y)
      while (element?.shadowRoot) {
        const inner = element.shadowRoot.elementFromPoint(x, y)
        if (!inner || inner === element) break
        element = inner
      }
      if (!element) return null
      const marks = element.getAttribute('data-product-demo-at') ?? ''
      element.setAttribute('data-product-demo-at', `${marks} ${mark}`.trim())
      const { left, top, width, height } = element.getBoundingClientRect()
      return { left, top, width, height }
    },
    { x, y, mark },
  )
  if (!box || !box.width || !box.height) throw new Error(`Nothing is drawn at ${x},${y}.`)
  const element = page.locator(`[data-product-demo-at~="${mark}"]`)
  // Takes off only this mark, at once: both ends of a drag can be on one canvas.
  const release = () =>
    page
      .evaluate((mark) => {
        for (const el of document.querySelectorAll(`[data-product-demo-at~="${mark}"]`)) {
          const rest = (el.getAttribute('data-product-demo-at') ?? '').replace(mark, '').trim()
          if (rest) el.setAttribute('data-product-demo-at', rest)
          else el.removeAttribute('data-product-demo-at')
        }
      }, mark)
      .catch(() => {})
  const round = (n: number) => Math.round(n * 1000) / 1000
  try {
    return {
      element,
      target: await pin(element),
      at: { x: round((x - box.left) / box.width), y: round((y - box.top) / box.height) },
      release,
    }
  } catch (error) {
    await release()
    throw error
  }
}

/** `0.9,0.5`: where on an element, as fractions of its box. */
function fractions(at: string): Point {
  const [x, y] = at.split(',').map(Number)
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y))
    throw new Error('--at takes fractions of the element, like 0.9,0.5 for near its right edge.')
  return { x, y }
}

/** `Shift+Meta`: the keys held through a click. */
function keys(held: string | undefined): Key[] {
  if (!held) return []
  return held.split('+').map((name) => {
    const key = KEYS.find((k) => k.toLowerCase() === name.toLowerCase())
    if (!key) throw new Error(`--with takes ${KEYS.join(', ')}, joined by +.`)
    return key
  })
}

/**
 * The small grab handles on screen (resize, rotate, slider knobs, drag grips) and where
 * each one's middle is. Editors draw them as tiny elements named or classed for what they
 * do, often with no accessible name, so the snapshot doesn't list them.
 */
async function handles(page: Page): Promise<string> {
  const found = await page.evaluate(() => {
    const words = /handle|resize|rotat|knob|grip|thumb|anchor|corner|gap|spacing/i
    const out: string[] = []
    for (const element of document.querySelectorAll('body *')) {
      const box = element.getBoundingClientRect()
      if (box.width < 3 || box.height < 3 || box.width > 48 || box.height > 48) continue
      if (box.bottom < 0 || box.top > innerHeight) continue
      const style = getComputedStyle(element)
      // Some are marked only by a data attribute, with a see-through hit area.
      const marks = [...element.attributes]
        .filter((a) => a.name.startsWith('data-') && words.test(`${a.name} ${a.value}`))
        .map((a) => `${a.name}=${a.value}`)
        .join(' ')
      if (style.visibility === 'hidden' || style.display === 'none') continue
      if (Number(style.opacity) === 0 && !marks) continue
      const className = element.getAttribute('class') ?? ''
      const name = [
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        className,
        marks,
      ]
        .filter(Boolean)
        .join(' ')
      if (!words.test(name) && !/resize|move|grab|crosshair/.test(style.cursor)) continue
      const x = Math.round(box.x + box.width / 2)
      const y = Math.round(box.y + box.height / 2)
      out.push(
        `${x},${y}  ${Math.round(box.width)}x${Math.round(box.height)}, cursor ${style.cursor}: ${name.slice(0, 100)}`,
      )
      if (out.length >= 40) break
    }
    return out
  })
  return found.length
    ? `Handles on screen, at their middles:\n${found.join('\n')}`
    : 'No small handles on screen. Select the thing first, or look at the screenshot.'
}

/** The locator Playwright's codegen would write for the element, and its fingerprint. */
async function pin(element: Locator): Promise<Target & { locator: string }> {
  const best = await element.normalize()
  // Playwright offers the normalized locator as code; its selector is what replays it.
  const selector: unknown = Reflect.get(best, '_selector')
  if (typeof selector !== 'string') throw new Error('Could not read the locator Playwright chose.')
  return { locator: best.toString(), selector, fingerprint: await fingerprint(element) }
}

/**
 * The snapshot cut down to what's on screen. A line with a box is kept when its box is in
 * the viewport; a line without one (its text, its link) goes with the line it belongs to.
 * Off-screen elements with refs are counted above and below instead.
 */
function onScreen(snapshot: string): { text: string; above: number; below: number } {
  const kept: string[] = []
  const parents: { indent: number; kept: boolean }[] = []
  let above = 0
  let below = 0
  for (const line of snapshot.split('\n')) {
    const indent = line.length - line.trimStart().length
    while (parents.length && (parents.at(-1)?.indent ?? 0) >= indent) parents.pop()
    const box = /\[box=([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)\]/.exec(line)
    let keep = parents.at(-1)?.kept ?? true
    if (box) {
      const top = Number(box[2])
      const bottom = top + Number(box[4])
      keep = bottom > 0 && top < VIEWPORT.height
      if (!keep && line.includes('[ref=')) {
        if (bottom <= 0) above++
        else below++
      }
    }
    parents.push({ indent, kept: keep })
    if (keep) kept.push(line)
  }
  return { text: kept.join('\n'), above, below }
}

const PRESSABLE =
  /^(button|link|textbox|searchbox|checkbox|radio|combobox|menuitem|menuitemcheckbox|menuitemradio|tab|option|treeitem|switch|slider|spinbutton)$/

/**
 * A screenshot with each pressable element's ref drawn on it, so the picture and the tree
 * line up: a pressable role, or anything the page gives a pointer cursor.
 */
async function screenshotWithRefs(
  page: Page,
  snapshot: string,
  path: string,
  drawn: Drawn[],
): Promise<void> {
  const labels: { ref: string; x: number; y: number; width: number; height: number }[] = drawn.map(
    (d, i) => ({ ref: `d${i + 1}`, x: d.x, y: d.y, width: d.width, height: d.height }),
  )
  for (const line of snapshot.split('\n')) {
    const match =
      /- '?(\w+)\b.*\[ref=(\w*e\d+)\].*\[box=([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)\]/.exec(line)
    if (!match) continue
    if (!PRESSABLE.test(match[1] ?? '') && !line.includes('[cursor=pointer]')) continue
    const [x, y, width, height] = match.slice(3, 7).map(Number)
    if (x === undefined || y === undefined || !width || !height) continue
    if (y > VIEWPORT.height || y + height < 0) continue
    labels.push({ ref: match[2] ?? '', x, y, width, height })
  }
  await page.evaluate((all) => {
    const layer = document.createElement('div')
    layer.id = '__product_demo_refs'
    layer.dataset.productDemo = 'refs'
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
    for (const { ref, x, y, width, height } of all) {
      const box = document.createElement('div')
      box.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;outline:1.5px solid #e5484d`
      const tag = document.createElement('span')
      tag.textContent = ref
      tag.style.cssText =
        'position:absolute;left:-1px;top:-15px;font:600 10px/14px monospace;color:#fff;background:#e5484d;padding:0 3px;border-radius:2px'
      box.append(tag)
      layer.append(box)
    }
    document.documentElement.append(layer)
  }, labels)
  await page.screenshot({ path })
  await page.evaluate(() => document.getElementById('__product_demo_refs')?.remove())
}

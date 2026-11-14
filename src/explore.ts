import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright-core'
import { before, effectSince, settle } from './effect.ts'
import type { Film, Step, Target } from './film.ts'
import { VIEWPORT } from './record.ts'
import { fingerprint } from './similo.ts'
import { launchBrowser } from './tools.ts'

// Exploring: the agent drives a browser one command at a time, off camera. A small
// process in the background holds the browser between commands, and every action the
// agent takes is pinned into a draft film it can edit and then record.

const DIR = join('.product-demo', 'explore')
const SESSION = join(DIR, 'session.json')
const DRAFT = join(DIR, 'film.json')
const IDLE_MS = 30 * 60_000

interface Session {
  port: number
  token: string
}

/** Starts a browser on `url` in the background and returns what's on screen. */
export async function explore(url: string): Promise<string> {
  if (existsSync(SESSION)) {
    throw new Error('Already exploring. Run `product-demo end` first, or keep going with `look`.')
  }
  await mkdir(DIR, { recursive: true })
  const log = openSync(join(DIR, 'browser.log'), 'w')
  const script = process.argv[1]
  if (!script) throw new Error('Could not find the product-demo script to start the browser with.')
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
    throw new Error('Not exploring. Start with `product-demo explore <url>`.')
  }
  const response = await fetch(`http://127.0.0.1:${session.port}/`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ command, args }),
  }).catch(async () => {
    await rm(SESSION, { force: true })
    throw new Error(
      'The explore browser has stopped. Start again with `product-demo explore <url>`.',
    )
  })
  const text = await response.text()
  if (!response.ok) throw new Error(text)
  return text
}

/** The background process: holds the browser and answers commands until `end`. */
export async function serve(url: string): Promise<void> {
  const browser = await launchBrowser()
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.goto(url)
  await settle(page, 0)
  const film: Film = { app: url, steps: [] }
  let looks = 0
  let idle = setTimeout(() => void stop(), IDLE_MS)

  const stop = async () => {
    await rm(SESSION, { force: true })
    await browser.close()
    process.exit(0)
  }

  const add = async (step: Step) => {
    film.steps.push(step)
    await writeFile(DRAFT, JSON.stringify(film, null, 2))
  }

  /** Runs an action, then adds it to the draft with what it did. */
  const act = async (step: Step, run: () => Promise<void>, said: string) => {
    const was = await before(page)
    await run()
    await settle(page, 0)
    const effect = await effectSince(page, was)
    await add(effect ? { ...step, effect } : step)
    return `${said}${effect?.url ? ` Now at ${effect.url}.` : ''}`
  }

  const commands: Record<string, (args: string[]) => Promise<string>> = {
    look: async () => {
      looks++
      const shot = join(DIR, `look-${looks}.png`)
      const snapshot = await page.ariaSnapshot({ mode: 'ai', boxes: true })
      await screenshotWithRefs(page, snapshot, shot)
      const text = snapshot.replace(/ \[box=[\d.,-]+\]/g, '')
      const trimmed =
        text.length > 40_000 ? `${text.slice(0, 40_000)}\n… (cut at 40,000 characters)` : text
      return `${page.url()} — "${await page.title()}"\n${trimmed}\n\nScreenshot with refs: ${shot}`
    },
    click: async ([ref]) => {
      const element = byRef(page, ref)
      const target = await pin(element)
      return act({ click: target }, () => element.click(), `Clicked ${target.locator}.`)
    },
    fill: async ([ref, text]) => {
      if (text === undefined) throw new Error('Usage: product-demo fill <ref> "text"')
      const element = byRef(page, ref)
      const target = await pin(element)
      return act({ fill: target, text }, () => element.fill(text), `Filled ${target.locator}.`)
    },
    press: async ([key]) => {
      if (!key) throw new Error('Usage: product-demo press <key>')
      return act({ press: key }, () => page.keyboard.press(key), `Pressed ${key}.`)
    },
    scroll: async ([direction]) => {
      if (direction !== 'up' && direction !== 'down')
        throw new Error('Usage: product-demo scroll up|down')
      return act(
        { scroll: direction },
        () => page.mouse.wheel(0, direction === 'down' ? 600 : -600),
        `Scrolled ${direction}.`,
      )
    },
    visit: async ([path]) => {
      if (!path) throw new Error('Usage: product-demo visit <path>')
      return act(
        { visit: path },
        async () => void (await page.goto(new URL(path, url).href)),
        `Opened ${path}.`,
      )
    },
    wait: async ([what]) => {
      if (!what) throw new Error('Usage: product-demo wait "text" | <seconds>')
      const seconds = Number(what)
      if (Number.isFinite(seconds)) {
        await add({ wait: seconds })
        return `Added a ${seconds}s wait.`
      }
      await page.getByText(what).first().waitFor({ timeout: 30_000 })
      await add({ wait: { text: what } })
      return `"${what}" is on screen.`
    },
    end: async ([out = 'film.json']) => {
      if (film.steps.length === 0)
        throw new Error('Nothing was done, so there is no film to write.')
      await writeFile(out, JSON.stringify(film, null, 2))
      setTimeout(() => void stop(), 100)
      return `Wrote ${out} with ${film.steps.length} steps. Edit it, then: product-demo record ${out}`
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
      response.writeHead(200).end(await run(args))
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

function byRef(page: Page, ref: string | undefined): Locator {
  if (!ref || !/^@?\w*e\d+$/.test(ref))
    throw new Error('Name an element by its ref from `look`, like @e12.')
  return page.getByRef(ref.replace('@', ''))
}

/** The locator Playwright's codegen would write for the element, and its fingerprint. */
async function pin(element: Locator): Promise<Target & { locator: string }> {
  const best = await element.normalize()
  // Playwright offers the normalized locator as code; its selector is what replays it.
  const selector: unknown = Reflect.get(best, '_selector')
  if (typeof selector !== 'string') throw new Error('Could not read the locator Playwright chose.')
  return { locator: best.toString(), selector, fingerprint: await fingerprint(element) }
}

const PRESSABLE =
  /^(button|link|textbox|searchbox|checkbox|radio|combobox|menuitem|tab|option|switch|slider|spinbutton)$/

/** A screenshot with each pressable element's ref drawn on it, so the picture and the tree line up. */
async function screenshotWithRefs(page: Page, snapshot: string, path: string): Promise<void> {
  const labels: { ref: string; x: number; y: number; width: number; height: number }[] = []
  for (const line of snapshot.split('\n')) {
    const match = /- (\w+)\b.*\[ref=(e\d+)\].*\[box=([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)\]/.exec(
      line,
    )
    if (!match || !PRESSABLE.test(match[1] ?? '')) continue
    const [x, y, width, height] = match.slice(3, 7).map(Number)
    if (x === undefined || y === undefined || !width || !height) continue
    if (y > VIEWPORT.height || y + height < 0) continue
    labels.push({ ref: match[2] ?? '', x, y, width, height })
  }
  await page.evaluate((all) => {
    const layer = document.createElement('div')
    layer.id = '__product_demo_refs'
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

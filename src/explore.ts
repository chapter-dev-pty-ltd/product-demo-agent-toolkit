import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, openSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright-core'
import { readConfig } from './config.ts'
import { describeStep, type Step, type Target } from './film.ts'
import { readLog, startLog, writeLog } from './log.ts'
import { before, outcomeSince } from './outcome.ts'
import { find, VIEWPORT } from './perform.ts'
import { watch } from './settle.ts'
import { fingerprint } from './similo.ts'
import { launchBrowser } from './tools.ts'

// Exploring: the agent drives a browser one command at a time, off camera, to learn the
// app and find the path. A small process of ours holds the browser between commands, and
// every action the agent takes is logged, pinned and with its outcome, for it to write
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
  const config = await readConfig()
  const browser = await launchBrowser()
  let page = await browser.newPage({ viewport: VIEWPORT })
  let settler = watch(page)
  await page.goto(url)
  await settler.settled()
  let looks = 0
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

  /** Runs an action, then logs it with what it changed. */
  const act = async (step: Step, run: () => Promise<void>, said: string) => {
    const log = await readLog()
    const was = await before(page)
    await settler.mark()
    await run()
    const settled = await settler.settled()
    const outcome = await outcomeSince(page, was)
    const n = log.entries.length + 1
    const warning = settled.settled
      ? undefined
      : `The page hadn't settled after 10s: ${settled.waitingOn.join(', ')}.`
    log.entries.push({
      n,
      step: outcome ? { ...step, outcome } : step,
      at: address(),
      ...(warning ? { warning } : {}),
    })
    await writeLog(log)
    return `${n}. ${said}${outcome?.url ? ` Now at ${outcome.url}.` : ''}${warning ? ` ${warning}` : ''}`
  }

  const commands: Record<string, (args: string[]) => Promise<string>> = {
    look: async ([flag]) => {
      looks++
      const shot = join(DIR, `look-${looks}.png`)
      const snapshot = await page.ariaSnapshot({ mode: 'ai', boxes: true })
      await screenshotWithRefs(page, snapshot, shot)
      const { text, above, below } =
        flag === '--all' ? { text: snapshot, above: 0, below: 0 } : onScreen(snapshot)
      const bare = text.replace(/ \[box=[\d.,-]+\]/g, '')
      const trimmed =
        bare.length > 40_000 ? `${bare.slice(0, 40_000)}\n… (cut at 40,000 characters)` : bare
      const off =
        above || below
          ? `\n\nOff screen: ${above} elements above, ${below} below. Scroll to them, or run \`look --all\` for the whole page.`
          : ''
      return `${page.url()} — "${await page.title()}"\n${trimmed}${off}\n\nScreenshot with refs: ${shot}`
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
        return act(
          { wait: seconds },
          () => page.waitForTimeout(seconds * 1000),
          `Waited ${seconds}s.`,
        )
      }
      return act(
        { wait: { text: what } },
        () => page.getByText(what).first().waitFor({ timeout: 30_000 }),
        `"${what}" is on screen.`,
      )
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
      await page.goto(url)
      await settler.settled()
      const path = log.entries.filter((e) => !e.undone)
      for (const entry of path) {
        await settler.mark()
        await replay(page, url, entry.step, (target) => find(page, target, config, () => {})).catch(
          (error: unknown) => {
            throw new Error(
              `Marked step ${last.n} undone, but couldn't replay step ${entry.n} (${describeStep(entry.step)}): ${error instanceof Error ? error.message : String(error)}`,
            )
          },
        )
        await settler.settled()
      }
      return `Marked step ${last.n} (${describeStep(last.step)}) undone and replayed the ${path.length} steps before it. The screen is as it was before it; run look.`
    },
    end: async () => {
      const log = await readLog()
      setTimeout(() => void stop(), 100)
      return `Closed the browser. The log has ${log.entries.length} steps: run \`product-demo log\` to list them, then \`product-demo compose <numbers>\` to start film.json from the ones the demo needs.`
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

/** Performs a step at once, with no pointer or typing to watch: for replaying, not filming. */
async function replay(
  page: Page,
  app: string,
  step: Step,
  find: (target: Target) => Promise<Locator>,
): Promise<void> {
  if ('visit' in step) await page.goto(new URL(step.visit, app).href)
  else if ('click' in step) await (await find(step.click)).click()
  else if ('fill' in step) await (await find(step.fill)).fill(step.text)
  else if ('press' in step) await page.keyboard.press(step.press)
  else if ('scroll' in step) await page.mouse.wheel(0, step.scroll === 'down' ? 600 : -600)
  else if (typeof step.wait !== 'number') {
    await page.getByText(step.wait.text).first().waitFor({ timeout: 30_000 })
  }
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
  /^(button|link|textbox|searchbox|checkbox|radio|combobox|menuitem|tab|option|switch|slider|spinbutton)$/

/** A screenshot with each pressable element's ref drawn on it, so the picture and the tree line up. */
async function screenshotWithRefs(page: Page, snapshot: string, path: string): Promise<void> {
  const labels: { ref: string; x: number; y: number; width: number; height: number }[] = []
  for (const line of snapshot.split('\n')) {
    const match =
      /- (\w+)\b.*\[ref=(\w*e\d+)\].*\[box=([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+)\]/.exec(line)
    if (!match || !PRESSABLE.test(match[1] ?? '')) continue
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

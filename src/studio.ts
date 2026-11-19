import { spawn } from 'node:child_process'
import { openSync, watch } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import {
  BACKDROPS,
  CURSORS,
  DISPLAYS,
  MUSIC,
  isHex,
  readConfig,
  type Config,
  type Music,
  type ProjectFile,
} from './config.ts'
import { prepare } from './cut/cut.ts'
import { readFilm, type Film, type Highlight, type Step, type Target } from './film.ts'
import type { Footage } from './perform.ts'
import { CANVAS, stageFiles, type Look } from './cut/stage.ts'

// The studio: plays footage on the stage in a local page, with a panel beside it to change the
// look (backdrop, frame, cursor) and the music, and see and hear it at once. The stage is the
// same page the cut photographs, served over HTTP, so what plays is what the cut renders.
//
// It is also where the user talks to their agent. The server runs on its own, in the
// background, and keeps the chat in .product-demo/studio/chat.json. The agent runs `studio`,
// which starts the server if it isn't running, waits for the user's next message, prints it
// and exits: an agent that's woken when a background command ends is woken by the message.
// Changes the agent makes to the config show in the page as they're saved.

const CONFIG_FILE = join('.product-demo', 'config.json')
const STUDIO_DIR = join('.product-demo', 'studio')
const CHAT_FILE = join(STUDIO_DIR, 'chat.json')
const PORT = 4321

/** What the studio changes: the look, and the music under it. */
interface Settings extends Look {
  music: Music | false
}

/**
 * Settings as the page holds them: plain strings, with `"own"` for the project's own file from
 * the config (its backdrop picture, cursor SVG or music), which the page can't name otherwise.
 */
interface PageSettings {
  backdrop: string
  display: string
  /** How much of the video the window fills, 0.5 to 1. */
  fill: number
  cursor: { style: string; size: number; label?: string | undefined; tip?: [number, number] }
  music: false | { track: string; volume: number }
}

/** A message in the chat: from the user in the page, or from the agent. */
export interface StudioMessage {
  from: 'you' | 'agent'
  text: string
  /** Where in the take the user was when they sent it, in seconds. */
  at?: number
  sent: string
  /** Whether an agent has been given it (the user's messages only). */
  read?: boolean
  /** Changes to the film the user attached from the script, which need a reshoot. */
  changes?: string[]
  /** The film they're to, when there are changes. */
  film?: string
}

/** A step of the film as the script tab shows it. */
interface ScriptStep {
  /** What it does, in words: "Click", "Type into". */
  action: string
  /** What it does it to: the element, the key, the address. */
  what?: string
  /** What it types, for a step that types (editable, with a reshoot). */
  text?: string
  say?: string
  note?: string
  /** When it starts in the take, if the shoot recorded it. */
  at?: number
  /** Its highlight as the film has it now, which changes with another cut. */
  highlight?: Highlight
}

/** Who is listening: names the agent gave, for the page to show. */
interface Agent {
  session?: string | undefined
  agent?: string | undefined
}

const own = (value: unknown): value is ProjectFile => typeof value === 'object' && value !== null

/**
 * The project's own files the page can pick (its backdrop picture, cursor SVG and music): the
 * config's, and any it named before, so picking another backdrop doesn't lose your own.
 */
interface Own {
  backdrop?: ProjectFile | undefined
  cursor?: ProjectFile | undefined
  tip?: [number, number] | undefined
  music?: ProjectFile | undefined
}

/** What the page is built from, out of the config. */
function fromConfig(config: Config, hold: number, was: Own = {}) {
  const settings: Settings = {
    backdrop: config.backdrop,
    cursor: config.cursor,
    display: config.display,
    window: config.window,
    music: config.music,
  }
  const mine: Own = {
    backdrop: own(config.backdrop) ? config.backdrop : was.backdrop,
    cursor: own(config.cursor.style) ? config.cursor.style : was.cursor,
    tip: own(config.cursor.style) ? config.cursor.tip : was.tip,
    music: config.music && own(config.music.track) ? config.music.track : was.music,
  }
  const extras = {
    owned: {
      backdrop: mine.backdrop ? relative(process.cwd(), mine.backdrop.file) : null,
      cursor: mine.cursor ? relative(process.cwd(), mine.cursor.file) : null,
      music: mine.music ? relative(process.cwd(), mine.music.file) : null,
    },
    music: MUSIC,
    hold,
  }
  return { settings, mine, extras }
}

/** Serves the studio for this footage and returns its address. */
export async function studio(
  footageDir: string,
  config: Config,
  port: number = PORT,
): Promise<string> {
  const { footage, highlights, length, title } = await prepare(footageDir)
  const hold = Math.max(1, footage.film.ending?.hold ?? 2)
  let { settings, mine, extras } = fromConfig(config, hold)
  // Each change is saved to the config as it's made, one write after another.
  let saving = Promise.resolve()
  const staged = (lit: typeof highlights) =>
    stageFiles(footageDir, footage, lit, () => settings, length, title)
  let stage = staged(highlights)
  // The film the take was shot from: its highlights change with a cut, so the stage follows it.
  let filmText = await readFile(footage.source, 'utf8').catch(() => '')
  const restage = async () => void (stage = staged((await prepare(footageDir)).highlights))
  const library = (path: string) => new URL(`../library/${path}`, import.meta.url)

  // The chat, the pages open on it, and the agents waiting for the user's next message.
  const boot = Date.now().toString(36)
  await mkdir(STUDIO_DIR, { recursive: true })
  const chat: StudioMessage[] = await readFile(CHAT_FILE, 'utf8').then(JSON.parse, () => [])
  const saveChat = () => writeFile(CHAT_FILE, `${JSON.stringify(chat, null, 2)}\n`)
  const pages = new Set<ServerResponse>()
  const waiters: { res: ServerResponse; who: Agent }[] = []
  let agent: (Agent & { listening: boolean }) | null = null
  const emit = (event: object) => {
    for (const page of pages) page.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  // Gives the user's unread messages to the agent that's been waiting longest.
  const deliver = async () => {
    const unread = chat.filter((m) => m.from === 'you' && !m.read)
    const waiter = waiters.shift()
    if (!waiter) return
    if (!unread.length) return void waiters.unshift(waiter)
    for (const m of unread) m.read = true
    await saveChat()
    waiter.res.end(JSON.stringify(unread))
    agent = { ...waiter.who, listening: waiters.length > 0 }
    emit({ type: 'chat', chat })
    emit({ type: 'agent', agent })
  }

  // The config, as the agent (or anyone) saves it: the page reloads to show it.
  let settling: NodeJS.Timeout | undefined
  const watcher = watch('.product-demo', (_, name) => {
    if (name !== 'config.json') return
    clearTimeout(settling)
    settling = setTimeout(async () => {
      const next = await readConfig().catch((error: Error) => void console.log(error.message))
      if (!next) return
      const fresh = fromConfig(next, hold, mine)
      const same = (a: typeof fresh) => JSON.stringify([toPage(a.settings), a.extras])
      // The studio's own saves come back here too, and change nothing.
      if (same(fresh) === same({ settings, mine, extras })) return
      ;({ settings, mine, extras } = fresh)
      emit({ type: 'config' })
    }, 150)
  })

  // The film, as the agent edits it: the page reloads to show it. The studio's own edits
  // (a highlight's look) come back here too, and change nothing.
  const filmWatcher = watch(dirname(footage.source), (_, name) => {
    if (name !== basename(footage.source)) return
    setTimeout(async () => {
      const text = await readFile(footage.source, 'utf8').catch(() => filmText)
      if (text === filmText) return
      filmText = text
      await restage().catch((error: Error) => void console.log(error.message))
      emit({ type: 'config' })
    }, 150)
  })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://studio')
    const path = url.pathname
    const send = (status: number, contentType: string, body: Buffer | string) => {
      res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
      res.end(body)
    }
    try {
      if (path === '/studio') {
        const now = toPage(settings)
        return send(200, 'text/html', page(now, extras, footageDir, boot))
      }
      if (path === '/studio/ping') {
        return send(200, 'application/json', JSON.stringify({ footage: resolve(footageDir) }))
      }
      if (path === '/studio/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.write(`data: ${JSON.stringify({ type: 'hello', boot, chat, agent })}\n\n`)
        pages.add(res)
        req.on('close', () => pages.delete(res))
        return
      }
      if (path === '/studio/chat' && req.method === 'POST') {
        const raw = JSON.parse(await body(req))
        const text = String(raw.text ?? '').trim()
        const changes = Array.isArray(raw.changes)
          ? raw.changes.map(String).filter(Boolean).slice(0, 50)
          : []
        if (!text && !changes.length) return send(400, 'text/plain', 'Nothing to send')
        const from = raw.from === 'agent' ? 'agent' : 'you'
        const at = Number(raw.at)
        chat.push({
          from,
          text,
          ...(Number.isFinite(at) ? { at: Math.round(at * 10) / 10 } : {}),
          sent: new Date().toISOString(),
          ...(changes.length ? { changes, film: relative(process.cwd(), footage.source) } : {}),
          ...(from === 'you' ? { read: false } : {}),
        })
        await saveChat()
        emit({ type: 'chat', chat })
        await deliver()
        return send(200, 'application/json', '{}')
      }
      if (path === '/studio/wait') {
        const who = {
          session: url.searchParams.get('session') ?? undefined,
          agent: url.searchParams.get('agent') ?? undefined,
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        const waiter = { res, who }
        waiters.push(waiter)
        agent = { ...who, listening: true }
        emit({ type: 'agent', agent })
        // An agent that stops waiting (it was stopped, or quit) isn't listening any more.
        res.on('close', () => {
          const i = waiters.indexOf(waiter)
          if (i < 0) return
          waiters.splice(i, 1)
          const last = waiters.at(-1)
          agent = last ? { ...last.who, listening: true } : null
          emit({ type: 'agent', agent })
        })
        return await deliver()
      }
      if (path === '/studio/stop' && req.method === 'POST') {
        send(200, 'application/json', '{}')
        watcher.close()
        filmWatcher.close()
        for (const open of [...pages, ...waiters.map((w) => w.res)]) open.end()
        server.closeAllConnections()
        return server.close()
      }
      if (path === '/studio/script') {
        const film = await readFilm(footage.source).catch(() => footage.film)
        const script = {
          source: relative(process.cwd(), footage.source),
          steps: scriptOf(footage, film),
        }
        return send(200, 'application/json', JSON.stringify(script))
      }
      // A highlight's look (style, colour, zoom) only needs a cut: it's saved to the film.
      if (path === '/studio/highlight' && req.method === 'POST') {
        const change = JSON.parse(await body(req))
        const raw = JSON.parse(await readFile(footage.source, 'utf8'))
        const lit = raw.steps?.[Number(change.step)]?.highlight
        if (!lit) return send(400, 'text/plain', 'That step has no highlight.')
        if (['box', 'magnify', 'cursor'].includes(change.style)) lit.style = change.style
        if (isHex(String(change.colour))) lit.colour = change.colour
        const zoom = Number(change.zoom)
        if (change.zoom !== undefined && Number.isFinite(zoom)) {
          lit.zoom = Math.round(Math.min(1, Math.max(0, zoom)) * 100) / 100
        }
        const text = `${JSON.stringify(raw, null, 2)}\n`
        await writeFile(footage.source, text)
        const valid = await readFilm(footage.source).then(
          () => true,
          () => false,
        )
        if (!valid) {
          await writeFile(footage.source, filmText)
          return send(400, 'text/plain', 'That highlight is not valid.')
        }
        filmText = text
        await restage()
        return send(200, 'application/json', JSON.stringify(lit))
      }
      if (path === '/studio/settings' && req.method === 'POST') {
        settings = fromPage(JSON.parse(await body(req)), settings, mine)
        saving = saving.then(() => saveSettings(settings)).catch((e) => void console.log(e))
        await saving
        return send(200, 'application/json', JSON.stringify(toPage(settings)))
      }
      const thumb = path.match(/^\/studio\/backdrops\/([a-z-]+)\.jpg$/)
      if (thumb?.[1] && (BACKDROPS as readonly string[]).includes(thumb[1])) {
        return send(200, 'image/jpeg', await readFile(library(`backdrops/${thumb[1]}.jpg`)))
      }
      // The project's own files, and our music, for the page to show and play.
      const kind = path.match(/^\/studio\/own\/(backdrop|cursor|music)$/)?.[1] as
        'backdrop' | 'cursor' | 'music' | undefined
      const file = kind && mine[kind]?.file
      if (file) {
        return send(
          200,
          MEDIA[extname(file).toLowerCase()] ?? 'application/octet-stream',
          await readFile(file),
        )
      }
      const track = path.match(/^\/studio\/music\/([a-z-]+)$/)?.[1]
      if (track && (MUSIC as readonly string[]).includes(track)) {
        return send(200, 'audio/mpeg', await readFile(library(`music/${track}.mp3`)))
      }
      const served = await stage(path)
      if (!served) return send(404, 'text/plain', 'Not found')
      return send(200, served.contentType, served.body)
    } catch (error) {
      send(400, 'text/plain', error instanceof Error ? error.message : String(error))
    }
  })
  // The page's events and a waiting agent stay open for as long as they need.
  server.requestTimeout = 0
  server.timeout = 0
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', done)
  })
  return `http://localhost:${port}/studio`
}

/**
 * Makes sure the studio is running on this footage, starting its server in the background with
 * `serve` (the command that runs it) if it isn't, and returns its address. A studio on other
 * footage, such as the take before a reshoot, is stopped first.
 */
export async function openStudio(
  footageDir: string,
  serve: string[],
  port: number = PORT,
): Promise<string> {
  const address = `http://localhost:${port}/studio`
  const running = await call(port, 'GET', '/studio/ping').then(
    (text) => JSON.parse(text) as { footage: string },
    () => undefined,
  )
  if (running?.footage === resolve(footageDir)) return address
  if (running) await stopStudio(port)
  await mkdir(STUDIO_DIR, { recursive: true })
  const logFile = join(STUDIO_DIR, 'server.log')
  const log = openSync(logFile, 'a')
  const [command = process.execPath, ...args] = serve
  spawn(command, args, { detached: true, stdio: ['ignore', log, log] }).unref()
  for (let i = 0; i < 100; i++) {
    await new Promise((done) => setTimeout(done, 150))
    if (await call(port, 'GET', '/studio/ping').catch(() => undefined)) return address
  }
  throw new Error(`The studio didn't start. See ${logFile}`)
}

/** Stops the studio running in the background, if one is. */
export async function stopStudio(port: number = PORT): Promise<boolean> {
  return call(port, 'POST', '/studio/stop').then(
    () => true,
    () => false,
  )
}

/** Puts the agent's message in the studio's chat. */
export async function sayInStudio(text: string, port: number = PORT): Promise<void> {
  await call(port, 'POST', '/studio/chat', JSON.stringify({ from: 'agent', text }))
}

/** Waits for the user's next messages in the studio (or returns any not yet read). */
export async function waitForStudio(who: Agent, port: number = PORT): Promise<StudioMessage[]> {
  const query = new URLSearchParams(
    Object.entries(who).filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
  // Nothing back means the studio stopped while it waited.
  const text = await call(port, 'GET', `/studio/wait?${query}`)
  return text ? JSON.parse(text) : []
}

/** A request to the studio's server, with no timeout: a wait can last as long as the user. */
function call(port: number, method: string, path: string, payload?: string): Promise<string> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => ((res.statusCode ?? 500) < 400 ? done(text) : fail(new Error(text))))
      res.on('error', fail)
    })
    req.on('error', fail)
    req.end(payload)
  })
}

/** The take's steps in words, timed from the shoot, with the film's highlights as they are now. */
function scriptOf(footage: Footage, film: Film): ScriptStep[] {
  const start = footage.frames[0]?.at ?? 0
  return footage.film.steps.map((step, i) => {
    const at = footage.steps?.[i]
    const highlight = film.steps[i]?.highlight
    return {
      ...words(step),
      ...(step.say ? { say: step.say } : {}),
      ...(step.note ? { note: step.note } : {}),
      ...(at !== undefined ? { at: Math.max(0, at - start) } : {}),
      ...(highlight ? { highlight } : {}),
    }
  })
}

/** A step as a person would say it. */
function words(step: Step): Pick<ScriptStep, 'action' | 'what' | 'text'> {
  if ('visit' in step) return { action: 'Open', what: step.visit }
  if ('click' in step) {
    const how = step.right ? 'Right-click' : step.double ? 'Double-click' : 'Click'
    const held = step.modifiers?.length ? ` holding ${step.modifiers.join('+')}` : ''
    return { action: how, what: nameOf(step.click) + held }
  }
  if ('fill' in step) return { action: 'Type into', what: nameOf(step.fill), text: step.text }
  if ('select' in step) return { action: `Choose "${step.option}" in`, what: nameOf(step.select) }
  if ('type' in step) return { action: 'Type', text: step.type }
  if ('press' in step) return { action: 'Press', what: step.press }
  if ('hover' in step) return { action: 'Hover over', what: nameOf(step.hover) }
  if ('drag' in step)
    return { action: 'Drag', what: `${nameOf(step.drag)} onto ${nameOf(step.to)}` }
  if ('scroll' in step) {
    return {
      action: `Scroll ${step.scroll}`,
      ...(step.in ? { what: `in ${nameOf(step.in)}` } : {}),
    }
  }
  if ('upload' in step) return { action: 'Upload', what: basename(step.upload) }
  if (typeof step.wait === 'number') return { action: 'Wait', what: `${step.wait}s` }
  return { action: step.wait.gone ? 'Wait for this to go:' : 'Wait for', what: step.wait.text }
}

/** An element's name for people: its label or text, never its selector if there's better. */
function nameOf(target: Target): string {
  if ('fingerprint' in target) {
    const { label, text, name, alt } = target.fingerprint
    const best = [label, text, alt, name].find((value) => value?.trim())
    if (best) return best.trim().length > 48 ? `${best.trim().slice(0, 46)}…` : best.trim()
  }
  if ('role' in target) return target.name || target.role
  if ('text' in target) return target.text
  if ('css' in target) {
    // .ytp-volume-slider-handle → "volume slider handle": the words in the selector.
    const words = target.css
      .replace(/^[#.]/, '')
      .split(/[-_\s.#]+/)
      .filter((w) => w.length > 3 || /^(add|new|tab|nav|bar|row|box|key|up)$/.test(w))
    return words.length ? words.join(' ') : target.css
  }
  return target.locator
}

const MEDIA: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    let text = ''
    req.on('data', (chunk) => (text += chunk))
    req.on('end', () => done(text))
    req.on('error', fail)
  })
}

/** The settings as the page holds them, with the project's own files as "own". */
function toPage(settings: Settings): PageSettings {
  const { cursor, music } = settings
  return {
    backdrop: own(settings.backdrop) ? 'own' : settings.backdrop,
    display: settings.display,
    fill: settings.window.fill,
    cursor: {
      style: own(cursor.style) ? 'own' : cursor.style,
      size: cursor.size,
      ...(cursor.label ? { label: cursor.label } : {}),
      ...(own(cursor.style) && cursor.tip ? { tip: cursor.tip } : {}),
    },
    music: music && { track: own(music.track) ? 'own' : music.track, volume: music.volume },
  }
}

/**
 * Settings from the page, checked the way the config checks them: "own" is the project's own
 * file, and anything off keeps what was.
 */
function fromPage(raw: Partial<PageSettings>, was: Settings, mine: Own): Settings {
  const cursor: Partial<PageSettings['cursor']> = raw.cursor ?? {}
  const style = String(cursor.style)
  const size = Number(cursor.size ?? was.cursor.size)
  const label = typeof cursor.label === 'string' ? cursor.label.trim().slice(0, 30) : ''
  const backdrop = String(raw.backdrop)
  const music = raw.music
  const track = music ? String(music.track) : ''
  const volume = music ? Number(music.volume) : NaN
  const fill = Number(raw.fill)
  return {
    window: {
      ...was.window,
      fill: Number.isFinite(fill)
        ? Math.round(Math.min(1, Math.max(0.5, fill)) * 100) / 100
        : was.window.fill,
    },
    backdrop:
      backdrop === 'own' && mine.backdrop
        ? mine.backdrop
        : (BACKDROPS as readonly string[]).includes(backdrop) || isHex(backdrop)
          ? (backdrop as Look['backdrop'])
          : was.backdrop,
    display: (DISPLAYS as readonly string[]).includes(String(raw.display))
      ? (raw.display as Look['display'])
      : was.display,
    cursor: {
      style:
        style === 'own' && mine.cursor
          ? mine.cursor
          : (CURSORS as readonly string[]).includes(style) || isHex(style)
            ? (style as Config['cursor']['style'])
            : was.cursor.style,
      size: Number.isFinite(size) ? Math.min(3, Math.max(0.5, size)) : was.cursor.size,
      ...(label ? { label } : {}),
      // An SVG of the project's own keeps the tip the config gave it.
      ...(style === 'own' && mine.tip ? { tip: mine.tip } : {}),
    },
    music:
      music === false
        ? false
        : !music
          ? was.music
          : {
              track:
                track === 'own' && mine.music
                  ? mine.music
                  : (MUSIC as readonly string[]).includes(track)
                    ? (track as Music['track'])
                    : was.music
                      ? was.music.track
                      : 'lofi',
              volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0.25,
            },
  }
}

/** A setting as the config writes it: the project's own files by their path from the project. */
const written = <T>(value: T | ProjectFile): T | string =>
  own(value) ? relative(process.cwd(), value.file) : value

/** Writes the settings into the project's config, keeping everything else in it. */
async function saveSettings(settings: Settings): Promise<void> {
  const raw = await readFile(CONFIG_FILE, 'utf8').then(JSON.parse, () => ({}))
  const { size, label, tip } = settings.cursor
  const style = written(settings.cursor.style)
  raw.backdrop = written(settings.backdrop)
  raw.display = settings.display
  // The window's size stays as the config has it: only how much of the video it fills changes.
  if (raw.window || settings.window.fill !== 0.92) {
    raw.window = { ...raw.window, fill: settings.window.fill }
  }
  raw.cursor =
    size === 1 && !label && !tip
      ? style
      : { style, size, ...(label ? { label } : {}), ...(tip ? { tip } : {}) }
  const { music } = settings
  raw.music = !music
    ? false
    : music.volume === 0.25
      ? written(music.track)
      : { track: written(music.track), volume: music.volume }
  await writeFile(CONFIG_FILE, `${JSON.stringify(raw, null, 2)}\n`)
}

/** The studio page: the stage over a timeline, and the look's settings on the right. */
function page(
  look: PageSettings,
  extras: { owned: Record<string, string | null>; music: readonly string[]; hold: number },
  footageDir: string,
  boot: string,
): string {
  const take = basename(footageDir).replace(/</g, '&lt;')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Studio · ${take}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #ffffff; --soft: #fafafa; --muted: #f4f4f5; --line: #ebebeb; --line-strong: #dcdcdc;
  --text: #0a0a0a; --dim: #737373; --faint: #a3a3a3;
  --pink-bg: #fce7f3; --pink: #ec4899; --blue-bg: #dbeafe; --blue: #60a5fa; --blue-text: #1e3a8a;
  --violet-bg: #ede9fe; --violet: #8b5cf6; --green: #22c55e; --amber: #f59e0b;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
  font: 13px/1.45 Inter, -apple-system, BlinkMacSystemFont, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; }
body { display: grid; grid-template-columns: 1fr 340px; height: 100vh; }

.primary { height: 32px; padding: 0 14px; border: 0; border-radius: 8px; background: var(--text); color: #fff;
  font-weight: 500; cursor: pointer; }
.primary:hover { background: #262626; }
.primary:disabled { background: var(--muted); color: var(--faint); cursor: default; }

/* Editor: the preview over the transport and the timeline */
.editor { display: grid; grid-template-rows: 1fr auto auto; min-width: 0; min-height: 0; }
#viewer { position: relative; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 20px 24px 12px; }
#screen { position: relative; overflow: hidden; border-radius: 12px; background: #111;
  box-shadow: 0 0 0 1px rgb(0 0 0 / .06), 0 12px 32px rgb(0 0 0 / .08); }
#screen iframe { position: absolute; left: 0; top: 0; width: ${CANVAS.width}px; height: ${CANVAS.height}px; border: 0; transform-origin: 0 0; }
#screen iframe.loading { visibility: hidden; }
.transport { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 6px 16px;
  border-top: 1px solid var(--line); }
.transport .left { display: flex; gap: 4px; }
.icon { width: 30px; height: 30px; border: 0; background: none; border-radius: 8px; display: grid; place-items: center; cursor: pointer; color: var(--dim); }
.icon:hover { background: var(--muted); color: var(--text); }
.icon svg { width: 16px; height: 16px; }
#play { width: 40px; height: 40px; border-radius: 50%; border: 0; background: var(--text); color: #fff; display: grid; place-items: center; cursor: pointer; }
#play:hover { background: #262626; }
#play svg { width: 16px; height: 16px; }
#time { justify-self: end; font: 500 13px var(--mono); }
.icon[aria-pressed="true"] { color: var(--text); }
.clip.music { background: #dcfce7; border-color: #4ade80; color: #14532d; }
.clip.music.off { opacity: .35; }
.grid .colour { position: relative; background: conic-gradient(#f87171, #fbbf24, #4ade80, #22d3ee, #818cf8, #e879f9, #f87171); border-radius: 7px; }
.grid .colour input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.grid .colour[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--text); }
.grid .own, .swatches .own { background-size: contain !important; background-repeat: no-repeat !important; background-position: center !important; background-color: var(--muted) !important; }
.grid .own { background-size: cover !important; }
.field[hidden] { display: none; }
#time span { color: var(--faint); }

/* Timeline */
.timeline { --label: 148px; position: relative; border-top: 1px solid var(--line); user-select: none; padding-bottom: 10px; }
.ruler, .track { display: grid; grid-template-columns: var(--label) 1fr; }
.ruler { height: 28px; }
.ruler .lane { position: relative; border-bottom: 1px solid var(--line); }
.tick { position: absolute; bottom: 0; height: 6px; border-left: 1px solid var(--line-strong); }
.tick span { position: absolute; bottom: 8px; left: -1px; transform: translateX(-50%); font: 10px var(--mono); color: var(--faint); white-space: nowrap; }
.tick.minor { height: 3px; }
.track { height: 36px; }
.track .name { display: flex; align-items: center; gap: 8px; padding: 0 16px; color: var(--text); font-size: 12px; border-right: 1px solid var(--line); }
.track .name small { color: var(--faint); font-size: 11px; }
.track .name svg { width: 14px; height: 14px; color: var(--dim); flex: none; }
.ruler .lane, .track .lane { margin: 0 24px 0 16px; }
.track .lane { position: relative; background: var(--soft); border-bottom: 1px solid #fff; }
.clip { position: absolute; top: 5px; bottom: 5px; border-radius: 6px; border: 1px solid; overflow: hidden;
  font-size: 11px; line-height: 24px; padding: 0 8px; white-space: nowrap; text-overflow: ellipsis; }
.clip.page { background: var(--blue-bg); border-color: var(--blue); color: var(--blue-text); }
.clip.highlight { background: var(--violet-bg); border-color: var(--violet); color: #4c1d95; }
.mark { position: absolute; top: 8px; bottom: 8px; width: 4px; margin-left: -2px; border-radius: 2px; background: var(--pink); }
.lane .empty { position: absolute; left: 8px; top: 0; line-height: 36px; color: var(--faint); font-size: 11px; }
#lanes { position: relative; cursor: text; }
#playhead { position: absolute; top: 0; bottom: 10px; width: 0; pointer-events: none; z-index: 2; }
#playhead::before { content: ''; position: absolute; top: 0; bottom: 0; left: -0.5px; border-left: 1px solid var(--text); }
#playhead::after { content: ''; position: absolute; top: 16px; left: -6px; border: 6px solid transparent; border-top: 8px solid var(--text); }

/* Settings panel */
aside { border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.tabs { display: flex; gap: 18px; padding: 0 20px; border-bottom: 1px solid var(--line); }
.tabs button { border: 0; background: none; padding: 12px 0 10px; color: var(--dim); font-weight: 500; cursor: pointer; border-bottom: 1.5px solid transparent; margin-bottom: -1px; }
.tabs button[aria-selected="true"] { color: var(--text); border-color: var(--text); }
.panel { flex: 1; overflow-y: auto; padding: 18px 20px 24px; }
.panel[hidden] { display: none; }
.field { margin-bottom: 22px; }
.field > label, .field > .label { display: flex; justify-content: space-between; align-items: baseline; font-weight: 500; margin-bottom: 8px; }
.field > label small, .field > .label small { color: var(--dim); font-weight: 400; font-size: 12px; font-family: var(--mono); }
.picker { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 10px 7px 7px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--bg); cursor: pointer; text-align: left; }
.picker:hover { border-color: var(--line-strong); }
.picker .thumb { width: 44px; height: 28px; border-radius: 6px; background: center / cover; box-shadow: inset 0 0 0 1px rgb(0 0 0 / .06); }
.picker .text { flex: 1; font-weight: 500; }
.picker svg { width: 14px; height: 14px; color: var(--dim); transition: transform .15s; }
.picker[aria-expanded="true"] svg { transform: rotate(90deg); }
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 8px; }
.grid[hidden] { display: none; }
.grid button { aspect-ratio: 16 / 10; border-radius: 7px; border: 0; padding: 0; background: center / cover; cursor: pointer;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / .06); }
.grid button[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--text); }
.segmented { display: flex; padding: 3px; background: var(--muted); border-radius: 10px; }
.segmented button { flex: 1; height: 30px; border: 0; border-radius: 7px; background: none; color: var(--dim); font-weight: 500; cursor: pointer; }
.segmented button[aria-pressed="true"] { background: var(--bg); color: var(--text); box-shadow: 0 1px 2px rgb(0 0 0 / .08), 0 0 0 1px rgb(0 0 0 / .04); }
.swatches { display: flex; gap: 10px; align-items: center; }
.swatches button, .swatches label { width: 28px; height: 28px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; position: relative;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / .1); }
.swatches [aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--text); }
.swatches label { background: conic-gradient(#f87171, #fbbf24, #4ade80, #22d3ee, #818cf8, #e879f9, #f87171); }
.swatches label input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.range-ends { display: flex; justify-content: space-between; color: var(--faint); font-size: 11px; margin-top: 2px; }
input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 18px; background: none; margin: 0; cursor: pointer; }
input[type=range]::-webkit-slider-runnable-track { height: 2px; border-radius: 2px;
  background: linear-gradient(var(--text), var(--text)) 0 / var(--fill, 50%) 100% no-repeat, var(--line-strong); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -6px; border-radius: 50%; background: var(--text); border: 2px solid #fff; box-shadow: 0 0 0 1px rgb(0 0 0 / .08); }
input[type=text] { width: 100%; height: 36px; padding: 0 11px; border: 1px solid var(--line); border-radius: 10px; font: inherit; color: var(--text); outline: none; }
input[type=text]:focus { border-color: var(--text); box-shadow: 0 0 0 3px rgb(0 0 0 / .05); }

/* Chat with the agent */
.panel.chat:not([hidden]) { display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.agent { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-bottom: 1px solid var(--line); color: var(--dim); font-size: 12px; }
.agent i { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); flex: none; }
.agent.listening i { background: var(--green); }
.agent.working i { background: var(--amber); }
.agent b { color: var(--text); font-weight: 500; }
#messages { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; }
#messages .empty { color: var(--faint); font-size: 12px; text-align: center; margin: auto 12px; }
.msg { max-width: 88%; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.you { align-self: flex-end; background: var(--muted); padding: 8px 12px; border-radius: 14px 14px 4px 14px; }
.msg.agent { align-self: flex-start; }
.msg .meta { display: flex; gap: 6px; align-items: center; margin-top: 4px; color: var(--faint); font-size: 11px; }
.msg.you .meta { justify-content: flex-end; }
.msg .at { border: 0; padding: 1px 6px; border-radius: 6px; background: var(--bg); font: 11px var(--mono); color: var(--dim); cursor: pointer; }
.msg .at:hover { color: var(--text); }
.composer { margin: 0 12px 12px; border: 1px solid var(--line); border-radius: 14px; padding: 8px; }
.composer:focus-within { border-color: var(--line-strong); box-shadow: 0 0 0 3px rgb(0 0 0 / .04); }
.composer textarea { width: 100%; border: 0; outline: none; resize: none; font: inherit; color: var(--text); padding: 4px 6px; min-height: 40px; }
.composer .row { display: flex; justify-content: space-between; align-items: center; }
.composer .row small { color: var(--faint); font: 11px var(--mono); padding-left: 6px; }
.composer .primary { height: 28px; padding: 0 12px; }
.attached { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; padding: 5px 6px 5px 10px; background: #fef3c7; color: #92400e; border-radius: 8px; font-size: 12px; }
.attached[hidden] { display: none; }
.attached span { flex: 1; }
.msg ul.changes { margin: 6px 0 0; padding-left: 16px; font-size: 12px; color: var(--dim); }
.x { border: 0; background: none; color: inherit; opacity: .6; cursor: pointer; padding: 0 4px; font-size: 15px; line-height: 1; }
.x:hover { opacity: 1; }

/* The script */
.panel.script:not([hidden]) { display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.script-head { display: flex; justify-content: space-between; gap: 8px; padding: 12px 20px; border-bottom: 1px solid var(--line); color: var(--dim); font-size: 12px; }
.script-head span:first-child { font-family: var(--mono); }
.script-head [hidden] { display: none; }
#steps { flex: 1; overflow-y: auto; padding: 8px 12px 16px; }
.step .head { width: 100%; display: flex; gap: 10px; align-items: flex-start; text-align: left; border: 0; background: none; padding: 8px; border-radius: 10px; cursor: pointer; }
.step .head:hover { background: var(--soft); }
.step.current .head { background: var(--muted); }
.step .n { flex: none; width: 20px; height: 20px; border-radius: 6px; background: var(--muted); color: var(--dim); font: 500 11px/20px var(--mono); text-align: center; }
.step.current .n { background: var(--text); color: #fff; }
.step .line { flex: 1; min-width: 0; color: var(--dim); overflow-wrap: anywhere; }
.step .line b { color: var(--text); font-weight: 500; }
.step .line q { color: var(--text); font: 12px var(--mono); }
.step .at { font: 11px var(--mono); color: var(--faint); padding-top: 2px; }
.step.deleted .line { text-decoration: line-through; }
.step .chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 8px 8px 38px; margin-top: -2px; }
.chip { font-size: 11px; padding: 1px 7px; border-radius: 6px; background: var(--soft); border: 1px solid var(--line); color: var(--dim); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.lit { background: var(--violet-bg); border-color: transparent; color: #4c1d95; }
.chip.edited { background: #fef3c7; border-color: transparent; color: #92400e; }
.step .editor { margin: 0 8px 10px 38px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; display: flex; flex-direction: column; gap: 14px; }
.editor .f { display: flex; justify-content: space-between; font-weight: 500; font-size: 12px; margin-bottom: 6px; }
.editor .f small { color: var(--faint); font-weight: 400; }
.editor textarea { width: 100%; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; font: inherit; color: var(--text); outline: none; resize: vertical; }
.editor textarea:focus { border-color: var(--text); }
.editor .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.editor .row + .row { margin-top: 8px; }
.editor input[type=color] { width: 30px; height: 28px; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: none; cursor: pointer; }
.small { height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); font-weight: 500; font-size: 12px; cursor: pointer; }
.small:hover { border-color: var(--line-strong); }
.small:disabled { color: var(--faint); cursor: default; border-color: var(--line); }
.small.danger { color: #dc2626; }
#tray { border-top: 1px solid var(--line); padding: 12px 16px; background: var(--soft); }
#tray[hidden] { display: none; }
#tray .top { display: flex; justify-content: space-between; align-items: center; font-weight: 500; }
#tray .top .primary { height: 30px; }
#tray ul { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 132px; overflow-y: auto; }
#tray li { display: flex; gap: 6px; font-size: 12px; color: var(--dim); align-items: flex-start; }
#tray li span { flex: 1; }
</style></head><body>

<section class="editor">
  <div id="viewer"><div id="screen"></div></div>
  <div class="transport">
    <div class="left">
      <button class="icon" id="sound" title="Sound on" aria-pressed="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path id="waves" d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/></svg></button>
      <button class="icon" id="restart" title="To start"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v10M12 3.5 6.5 8l5.5 4.5z"/></svg></button>
    </div>
    <button id="play" title="Play (space)"></button>
    <div id="time"></div>
  </div>
  <div class="timeline">
    <div class="ruler"><div></div><div class="lane" id="ruler"></div></div>
    <div id="tracks"></div>
    <div id="playhead"></div>
  </div>
</section>

<aside>
  <div class="tabs" role="tablist">
    <button role="tab" aria-selected="true" data-tab="chat">Agent</button>
    <button role="tab" aria-selected="false" data-tab="script">Script</button>
    <button role="tab" aria-selected="false" data-tab="settings">Configuration</button>
  </div>
  <div class="panel chat" id="chat">
    <div class="agent" id="agent"><i></i><span></span></div>
    <div id="messages"></div>
    <form class="composer" id="composer">
      <div class="attached" id="attached" hidden></div>
      <textarea id="draft" rows="2" placeholder="Ask your agent for a change…"></textarea>
      <div class="row"><small id="draft-at"></small><button class="primary" type="submit">Send</button></div>
    </form>
  </div>
  <div class="panel script" id="script" hidden>
    <div class="script-head"><span id="script-source"></span><span id="script-hint" hidden>Shoot again to link steps to the video</span></div>
    <div id="steps"></div>
    <div id="tray" hidden>
      <div class="top"><span id="tray-count"></span><button class="primary" id="tray-send">Send to agent</button></div>
      <ul id="tray-list"></ul>
    </div>
  </div>
  <div class="panel" id="settings" hidden>
    <div class="field">
      <div class="label">Backdrop</div>
      <button class="picker" id="backdrop-picker" aria-expanded="false">
        <span class="thumb" id="backdrop-thumb"></span><span class="text" id="backdrop-name"></span>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>
      </button>
      <div class="grid" id="backdrops" hidden></div>
    </div>
    <div class="field">
      <div class="label">Frame</div>
      <div class="segmented" id="display"></div>
    </div>
    <div class="field">
      <label for="fill">Window size <small id="fill-value"></small></label>
      <input id="fill" type="range" min="0.5" max="1" step="0.01">
      <div class="range-ends"><span>Smaller</span><span>Fills the video</span></div>
    </div>
    <div class="field">
      <div class="label">Cursor <small id="cursor-name" style="font-family: inherit"></small></div>
      <div class="swatches" id="cursor"></div>
    </div>
    <div class="field">
      <label for="size">Cursor size <small id="size-value"></small></label>
      <input id="size" type="range" min="0.5" max="3" step="0.05">
      <div class="range-ends"><span>Smaller</span><span>Larger</span></div>
    </div>
    <div class="field">
      <label for="label">Cursor label</label>
      <input id="label" type="text" maxlength="30" placeholder="e.g. Agent">
    </div>
    <div class="field">
      <div class="label">Background music</div>
      <div class="segmented" id="music"></div>
    </div>
    <div class="field" id="volume-field">
      <label for="volume">Music volume <small id="volume-value"></small></label>
      <input id="volume" type="range" min="0" max="1" step="0.01">
      <div class="range-ends"><span>Quieter</span><span>Louder</span></div>
    </div>
  </div>
</aside>

<script>
let look = ${JSON.stringify(look)};
const BACKDROPS = ${JSON.stringify(BACKDROPS)};
const OWNED = ${JSON.stringify(extras.owned)};
const TRACKS = ${JSON.stringify(extras.music)};
const HOLD = ${extras.hold};
const BOOT = ${JSON.stringify(boot)};
const fileName = (path) => path.split('/').pop();
const CURSORS = { black: '#111111', pink: '#ff7ccb', lime: '#b6f24f', macos: 'linear-gradient(135deg,#000 50%,#fff 50%)' };
const $ = (id) => document.getElementById(id);
const pretty = (name) => name[0].toUpperCase() + name.slice(1).replace(/-/g, ' ');
const thumb = (name) => name === 'own' ? 'url(/studio/own/backdrop)' : name.startsWith('#') ? 'linear-gradient(' + name + ',' + name + ')' : 'url(/studio/backdrops/' + name + '.jpg)';
const backdropName = (name) => name === 'own' ? fileName(OWNED.backdrop) : name.startsWith('#') ? name : pretty(name);
const clock = (s) => { s = Math.max(0, s); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + (s % 60).toFixed(1).padStart(4, '0'); };
const ICON_PLAY = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.3-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" rx=".8"/><rect x="9.5" y="2.5" width="3" height="11" rx=".8"/></svg>';

const viewer = $('viewer'), screen = $('screen');
let frame, data, length = 0, t = 0, playing = false, last = 0;

// The stage is 1920x1080; the screen is that, scaled to fit the viewer.
const fit = () => {
  const w = viewer.clientWidth - 48, h = viewer.clientHeight - 32;
  const k = Math.max(0.05, Math.min(w / ${CANVAS.width}, h / ${CANVAS.height}));
  screen.style.width = ${CANVAS.width} * k + 'px';
  screen.style.height = ${CANVAS.height} * k + 'px';
  for (const f of screen.querySelectorAll('iframe')) f.style.transform = 'scale(' + k + ')';
};
new ResizeObserver(fit).observe(viewer);

// A new look loads a fresh stage behind the one showing, seeks it to now, then swaps it in.
let loading = false, again = false;
const load = () => {
  if (loading) return void (again = true);
  loading = true;
  const next = document.createElement('iframe');
  next.className = 'loading';
  next.src = '/?v=' + Date.now();
  next.onload = async () => {
    await next.contentWindow.stage.seek(t);
    if (!data) { data = next.contentWindow.stage.data; length = data.length; timeline(); }
    frame?.remove();
    frame = next;
    next.className = '';
    loading = false;
    show();
    if (again) { again = false; load(); }
  };
  screen.appendChild(next);
  fit();
};

// The timeline: the pages the take visits, its clicks, and any highlights.
const lanes = [];
let musicClip;
const pct = (s) => (s / length) * 100 + '%';
const track = (name, sub, icon) => {
  const row = document.createElement('div');
  row.className = 'track';
  row.innerHTML = '<div class="name">' + icon + '<span>' + name + (sub ? ' <small>' + sub + '</small>' : '') + '</span></div><div class="lane"></div>';
  $('tracks').appendChild(row);
  const lane = row.querySelector('.lane');
  lanes.push(lane);
  return lane;
};
const timeline = () => {
  const ruler = $('ruler');
  const step = [1, 2, 5, 10, 15, 30, 60].find((s) => length / s <= 12) || 60;
  for (let s = 0; s <= length; s += step / 2) {
    const tick = document.createElement('div');
    const major = Math.round(s / step * 2) % 2 === 0;
    tick.className = 'tick' + (major ? '' : ' minor');
    tick.style.left = pct(s);
    if (major) tick.innerHTML = '<span>' + clock(s).slice(0, 5) + '</span>';
    ruler.appendChild(tick);
  }
  const globe = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>';
  const pointer = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="m3 3 10 3.6-4.6 1.8L6.6 13z"/></svg>';
  const spark = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="4" width="11" height="8" rx="2"/></svg>';
  const pages = track('Page', '', globe);
  const addresses = data.addresses.length ? data.addresses : [{ at: 0, label: 'Screen' }];
  addresses.forEach((a, i) => {
    const end = addresses[i + 1]?.at ?? length;
    const clip = document.createElement('div');
    clip.className = 'clip page';
    clip.style.left = 'calc(' + pct(a.at) + ' + 1px)';
    clip.style.width = 'calc(' + pct(end - a.at) + ' - 2px)';
    clip.textContent = a.label;
    clip.title = a.label;
    pages.appendChild(clip);
  });
  const clicks = track('Clicks', String(data.clicks.length), pointer);
  for (const c of data.clicks) {
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.style.left = pct(c.at);
    clicks.appendChild(mark);
  }
  const note = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12V3.5l7-1.5V10.5"/><circle cx="4.5" cy="12" r="1.5"/><circle cx="11.5" cy="10.5" r="1.5"/></svg>';
  const tune = track('Music', '', note);
  musicClip = document.createElement('div');
  musicClip.className = 'clip music';
  musicClip.style.left = '1px';
  musicClip.style.width = 'calc(100% - 2px)';
  tune.appendChild(musicClip);
  const lights = track('Highlights', '', spark);
  if (!data.highlights.length) lights.innerHTML = '<span class="empty">None in this take</span>';
  for (const h of data.highlights) {
    const clip = document.createElement('div');
    clip.className = 'clip highlight';
    clip.style.left = pct(h.at);
    clip.style.width = pct(h.until - h.at);
    clip.textContent = h.style;
    lights.appendChild(clip);
  }
  render();
  show();
};

// Click or drag anywhere on the timeline to move the playhead.
const timelineEl = document.querySelector('.timeline');
const scrubTo = (e) => {
  const lane = $('ruler').getBoundingClientRect();
  t = Math.min(length, Math.max(0, ((e.clientX - lane.left) / lane.width) * length));
  seek();
};
timelineEl.addEventListener('pointerdown', (e) => {
  if (e.clientX < $('ruler').getBoundingClientRect().left) return;
  timelineEl.setPointerCapture(e.pointerId);
  scrubTo(e);
  timelineEl.onpointermove = scrubTo;
});
timelineEl.addEventListener('pointerup', () => (timelineEl.onpointermove = null));

const show = () => {
  $('time').innerHTML = clock(t) + ' <span>/ ' + clock(length) + '</span>';
  $('draft-at').textContent = 'At ' + clock(t);
  if (typeof showCurrent === 'function') showCurrent();
  // Only when it changes: an icon swapped between press and release loses the click.
  const icon = playing ? ICON_PAUSE : ICON_PLAY;
  if ($('play').dataset.icon !== String(playing)) { $('play').dataset.icon = String(playing); $('play').innerHTML = icon; }
  const lane = $('ruler').getBoundingClientRect(), box = timelineEl.getBoundingClientRect();
  if (length) $('playhead').style.left = lane.left - box.left + (t / length) * lane.width + 'px';
};
window.addEventListener('resize', show);
const seek = async () => { if (frame) await frame.contentWindow.stage.seek(t); show(); audio(); };

// The music under the take, as the cut mixes it: looped, at its volume (the cut lifts the
// voiceover by 1.6 rather than lowering this), and faded out over the ending's hold.
const player = new Audio();
player.loop = true;
let heard = true;
const audio = () => {
  const on = playing && heard && look.music;
  if (!on) { player.pause(); return; }
  const src = look.music.track === 'own' ? '/studio/own/music' : '/studio/music/' + look.music.track;
  if (player.dataset.src !== src) { player.dataset.src = src; player.src = src; }
  const fade = Math.min(HOLD, length);
  player.volume = Math.max(0, Math.min(1, look.music.volume * Math.min(1, (length - t) / fade)));
  const at = player.duration ? t % player.duration : t;
  if (player.paused || Math.abs(player.currentTime - at) > 0.3) player.currentTime = at;
  if (player.paused) player.play().catch(() => {});
};
$('sound').onclick = () => {
  heard = !heard;
  pressed($('sound'), heard);
  $('sound').title = heard ? 'Sound on' : 'Sound off';
  $('waves').style.display = heard ? '' : 'none';
  audio();
};
const tick = async (now) => {
  if (!playing) return;
  t += (now - last) / 1000;
  last = now;
  if (t >= length) { t = length; playing = false; }
  if (frame) await frame.contentWindow.stage.seek(t);
  show();
  if (!playing || Math.floor(t * 4) !== Math.floor((t - 0.02) * 4)) audio();
  if (playing) requestAnimationFrame(tick);
};
const toggle = () => {
  if (!playing && t >= length) t = 0;
  playing = !playing;
  show();
  if (playing) { last = performance.now(); requestAnimationFrame(tick); }
  audio();
};
$('play').onclick = toggle;
$('restart').onclick = () => { t = 0; seek(); };
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  if (e.code === 'ArrowLeft') { t = Math.max(0, t - 1); seek(); }
  if (e.code === 'ArrowRight') { t = Math.min(length, t + 1); seek(); }
});

// The panel.
const visual = (l) => JSON.stringify([l.backdrop, l.display, l.fill, l.cursor]);
let shown = visual(look);
const send = async () => {
  render();
  audio();
  const res = await fetch('/studio/settings', { method: 'POST', body: JSON.stringify(look) });
  look = await res.json();
  render();
  // Only a change to how it looks needs a fresh stage; the music is played here.
  if (visual(look) !== shown) { shown = visual(look); load(); }
};
const change = (patch) => {
  look = { ...look, ...patch, cursor: { ...look.cursor, ...(patch.cursor || {}) } };
  send();
};
const pressed = (el, on) => el.setAttribute('aria-pressed', String(on));
const render = () => {
  $('backdrop-thumb').style.backgroundImage = thumb(look.backdrop);
  $('backdrop-name').textContent = backdropName(look.backdrop);
  for (const b of document.querySelectorAll('#backdrops button')) pressed(b, b.dataset.name === look.backdrop);
  const flat = look.backdrop.startsWith('#');
  pressed(flatTile, flat);
  if (flat) flatPicker.value = look.backdrop;
  for (const b of document.querySelectorAll('#display button')) pressed(b, b.dataset.name === look.display);
  const hex = look.cursor.style.startsWith('#');
  for (const b of document.querySelectorAll('#cursor button')) pressed(b, b.dataset.name === look.cursor.style);
  pressed(custom, hex);
  if (hex) { custom.style.background = look.cursor.style; colour.value = look.cursor.style; } else custom.style.background = '';
  $('cursor-name').textContent = hex ? look.cursor.style : look.cursor.style === 'own' ? fileName(OWNED.cursor) : look.cursor.style === 'macos' ? 'macOS' : pretty(look.cursor.style);
  const m = look.music;
  for (const b of document.querySelectorAll('#music button')) pressed(b, m ? b.dataset.name === m.track : b.dataset.name === 'none');
  $('volume-field').hidden = !m;
  if (m) {
    volume.value = m.volume;
    volume.style.setProperty('--fill', m.volume * 100 + '%');
    $('volume-value').textContent = Math.round(m.volume * 100) + '%';
  }
  if (musicClip) {
    musicClip.className = 'clip music' + (m ? '' : ' off');
    musicClip.textContent = m ? (m.track === 'own' ? fileName(OWNED.music) : pretty(m.track)) + ' · ' + Math.round(m.volume * 100) + '%' : 'No music';
  }
  fillInput.value = look.fill;
  fillInput.style.setProperty('--fill', ((look.fill - 0.5) / 0.5) * 100 + '%');
  $('fill-value').textContent = Math.round(look.fill * 100) + '%';
  size.value = look.cursor.size;
  size.style.setProperty('--fill', ((look.cursor.size - 0.5) / 2.5) * 100 + '%');
  $('size-value').textContent = Number(look.cursor.size).toFixed(2) + '×';
  if (document.activeElement !== labelInput) labelInput.value = look.cursor.label || '';
};
const make = (parent, name, init, tag = 'button') => {
  const el = document.createElement(tag);
  el.dataset.name = name;
  el.title = pretty(name);
  init(el);
  parent.appendChild(el);
  return el;
};
$('backdrop-picker').onclick = () => {
  const open = $('backdrops').hidden;
  $('backdrops').hidden = !open;
  $('backdrop-picker').setAttribute('aria-expanded', String(open));
};
if (OWNED.backdrop) {
  make($('backdrops'), 'own', (b) => { b.className = 'own'; b.title = OWNED.backdrop; b.style.backgroundImage = thumb('own'); b.onclick = () => change({ backdrop: 'own' }); });
}
for (const name of BACKDROPS) {
  make($('backdrops'), name, (b) => { b.style.backgroundImage = thumb(name); b.onclick = () => change({ backdrop: name }); });
}
const flatTile = make($('backdrops'), 'colour', (l) => { l.className = 'colour'; l.title = 'Any colour'; l.innerHTML = '<input type="color" value="#f4f1ea">'; }, 'label');
const flatPicker = flatTile.querySelector('input');
flatPicker.oninput = () => change({ backdrop: flatPicker.value });
for (const name of ['none', 'browser']) {
  make($('display'), name, (b) => { b.textContent = name === 'none' ? 'None' : 'Browser window'; b.onclick = () => change({ display: name }); });
}
for (const [name, fill] of Object.entries(CURSORS)) {
  make($('cursor'), name, (b) => { b.style.background = fill; b.onclick = () => change({ cursor: { style: name } }); });
}
if (OWNED.cursor) {
  make($('cursor'), 'own', (b) => { b.className = 'own'; b.title = OWNED.cursor; b.style.backgroundImage = 'url(/studio/own/cursor)'; b.onclick = () => change({ cursor: { style: 'own' } }); });
}
const custom = make($('cursor'), 'custom', (l) => { l.title = 'Any colour'; l.innerHTML = '<input type="color" value="#8fd3ff">'; }, 'label');
const colour = custom.querySelector('input');
colour.oninput = () => change({ cursor: { style: colour.value } });
const tracks = ['none', ...TRACKS, ...(OWNED.music ? ['own'] : [])];
for (const name of tracks) {
  make($('music'), name, (b) => {
    b.textContent = name === 'none' ? 'None' : name === 'own' ? fileName(OWNED.music) : pretty(name);
    b.onclick = () => change({ music: name === 'none' ? false : { track: name, volume: look.music ? look.music.volume : 0.25 } });
  });
}
const volume = $('volume');
volume.oninput = () => change({ music: { ...look.music, volume: Number(volume.value) } });
const fillInput = $('fill');
fillInput.oninput = () => change({ fill: Number(fillInput.value) });
const size = $('size');
size.oninput = () => change({ cursor: { size: Number(size.value) } });
const labelInput = $('label');
labelInput.oninput = () => change({ cursor: { label: labelInput.value } });
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.onclick = () => {
    for (const other of document.querySelectorAll('[role=tab]')) other.setAttribute('aria-selected', String(other === tab));
    for (const name of ['settings', 'chat', 'script']) $(name).hidden = tab.dataset.tab !== name;
  };
}
const openTab = () => document.querySelector('[role=tab][aria-selected=true]').dataset.tab;

// The agent: who's listening, the chat, and the config changes it makes.
let chat = [], agent = null;
const esc = (text) => text.replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
const showAgent = () => {
  const who = agent && esc([agent.session, agent.agent].filter(Boolean).join(' · '));
  $('agent').className = 'agent' + (agent ? (agent.listening ? ' listening' : ' working') : '');
  $('agent').querySelector('span').innerHTML = !agent ? 'No agent connected. Ask yours to open the studio.'
    : agent.listening ? 'Connected to <b>' + (who || 'your agent') + '</b>'
    : '<b>' + (who || 'Your agent') + '</b> is working on it…';
};
const showChat = () => {
  const list = $('messages');
  list.innerHTML = chat.length ? '' : '<div class="empty">Messages go to your agent, with the moment in the take you were at.</div>';
  for (const m of chat) {
    const el = document.createElement('div');
    el.className = 'msg ' + m.from;
    el.textContent = m.text;
    if (m.changes) {
      const ul = document.createElement('ul');
      ul.className = 'changes';
      for (const c of m.changes) { const li = document.createElement('li'); li.textContent = c; ul.appendChild(li); }
      el.appendChild(ul);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (typeof m.at === 'number') {
      const at = document.createElement('button');
      at.className = 'at';
      at.textContent = clock(m.at);
      at.onclick = () => { t = Math.min(length, m.at); seek(); };
      meta.appendChild(at);
    }
    if (m.from === 'you' && !m.read) meta.append('Not read yet');
    if (meta.childNodes.length) el.appendChild(meta);
    list.appendChild(el);
  }
  list.scrollTop = list.scrollHeight;
};
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('draft').value.trim();
  if (!text && !attached.length) return;
  const changes = attached;
  $('draft').value = '';
  const res = await fetch('/studio/chat', { method: 'POST', body: JSON.stringify({ text, at: t, changes }) });
  if (!res.ok) return;
  // Sent changes leave the script's tray: the agent has them now.
  for (const [key, c] of Object.entries(pending)) if (changes.includes(c.label)) delete pending[key];
  attached = [];
  keep(':pending', pending);
  keep(':attached', attached);
  showAttached();
  showScript();
};
$('draft').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
};
// The script: the film's steps in words. A highlight's look shows at once (it only needs a
// cut); the other changes need a reshoot, so they wait in the tray to go to the agent.
const TAKE = ${JSON.stringify(take)};
let script = { steps: [] }, expanded = -1, current = -1;
const kept = (key, fallback) => { try { return JSON.parse(sessionStorage.getItem(TAKE + key)) ?? fallback; } catch { return fallback; } };
const keep = (key, value) => { try { sessionStorage.setItem(TAKE + key, JSON.stringify(value)); } catch {} };
let pending = kept(':pending', {});
let attached = kept(':attached', []);
const sentence = (s) => s.action + (s.what ? ' ' + s.what : '') + (s.text !== undefined ? ' "' + s.text + '"' : '');
const about = (i) => 'step ' + (i + 1) + ' (' + sentence(script.steps[i]) + ')';
const LABELS = {
  text: (i, v) => 'Type "' + v + '" in ' + about(i),
  say: (i, v) => v ? 'Make the voiceover of ' + about(i) + ' "' + v + '"' : 'Remove the voiceover from ' + about(i),
  delete: (i) => 'Delete ' + about(i),
  move: (i, v) => 'Move ' + about(i) + (v < 0 ? ' up ' : ' down ') + Math.abs(v) + (Math.abs(v) === 1 ? ' place' : ' places'),
  highlight: (i, v) => (v === 'add' ? 'Add a highlight to ' : 'Remove the highlight from ') + about(i),
};
const propose = (i, kind, value) => {
  const key = i + ':' + kind;
  if (value === undefined) delete pending[key];
  else pending[key] = { step: i, kind, value, label: LABELS[kind](i, value) };
  keep(':pending', pending);
  showScript();
};
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
};
const button = (text, onclick, className = 'small') => { const b = node('button', className, text); b.type = 'button'; b.onclick = onclick; return b; };
const setHighlight = async (i, change) => {
  const res = await fetch('/studio/highlight', { method: 'POST', body: JSON.stringify({ step: i, ...change }) });
  if (!res.ok) return;
  script.steps[i].highlight = await res.json();
  showScript();
  // A fresh stage, and the timeline drawn again from it, for the highlight's new look.
  $('tracks').innerHTML = $('ruler').innerHTML = '';
  lanes.length = 0;
  data = undefined;
  load();
};
const editor = (i, s) => {
  const box = node('div', 'editor');
  const field = (name, value, placeholder, commit) => {
    const wrap = node('div');
    const label = node('div', 'f', name);
    label.appendChild(node('small', '', 'Needs a reshoot'));
    const input = node('textarea');
    input.rows = 2;
    input.value = value;
    input.placeholder = placeholder;
    input.onchange = () => commit(input.value.trim());
    wrap.append(label, input);
    box.appendChild(wrap);
  };
  if (s.text !== undefined) field('Typed text', pending[i + ':text']?.value ?? s.text, '', (v) => propose(i, 'text', v === s.text || !v ? undefined : v));
  field('Voiceover', pending[i + ':say']?.value ?? s.say ?? '', 'No voiceover on this step', (v) => propose(i, 'say', v === (s.say ?? '') ? undefined : v));
  const lit = node('div');
  const head = node('div', 'f', 'Highlight');
  lit.appendChild(head);
  const change = pending[i + ':highlight'];
  if (change) {
    lit.appendChild(node('div', 'row')).append(node('span', 'chip edited', change.value === 'add' ? 'Added, needs a reshoot' : 'Removed, needs a reshoot'), button('Undo', () => propose(i, 'highlight')));
  } else if (s.highlight) {
    head.appendChild(node('small', '', 'Shows now'));
    const style = s.highlight.style || 'box';
    const seg = node('div', 'segmented');
    for (const name of ['box', 'magnify', 'cursor']) {
      const b = button(pretty(name), () => setHighlight(i, { style: name }), '');
      pressed(b, name === style);
      seg.appendChild(b);
    }
    lit.appendChild(seg);
    const row = lit.appendChild(node('div', 'row'));
    if (style === 'box') {
      const colour = node('input');
      colour.type = 'color';
      colour.value = s.highlight.colour || '#ff3b30';
      colour.onchange = () => setHighlight(i, { colour: colour.value });
      row.appendChild(colour);
    }
    if (style !== 'cursor') {
      const zoom = node('input');
      zoom.type = 'range'; zoom.min = 0; zoom.max = 1; zoom.step = 0.05;
      zoom.value = s.highlight.zoom ?? 0;
      zoom.title = 'Zoom';
      zoom.style.flex = '1';
      const fill = () => zoom.style.setProperty('--fill', zoom.value * 100 + '%');
      fill();
      zoom.oninput = fill;
      zoom.onchange = () => setHighlight(i, { zoom: Number(zoom.value) });
      row.append(node('span', 'chip', 'Zoom'), zoom);
    }
    lit.appendChild(node('div', 'row')).appendChild(button('Remove highlight', () => propose(i, 'highlight', 'remove')));
  } else {
    lit.appendChild(node('div', 'row')).appendChild(button('Add highlight', () => propose(i, 'highlight', 'add')));
  }
  box.appendChild(lit);
  const moved = pending[i + ':move']?.value || 0;
  const move = (d) => propose(i, 'move', moved + d || undefined);
  const actions = node('div', 'row');
  const up = button('Move up', () => move(-1)), down = button('Move down', () => move(1));
  up.disabled = i + moved <= 0;
  down.disabled = i + moved >= script.steps.length - 1;
  const gone = pending[i + ':delete'];
  actions.append(up, down, gone ? button('Keep step', () => propose(i, 'delete')) : button('Delete step', () => propose(i, 'delete', true), 'small danger'));
  box.appendChild(actions);
  return box;
};
const showScript = () => {
  const list = $('steps');
  list.innerHTML = '';
  $('script-source').textContent = script.source || '';
  $('script-hint').hidden = !script.steps.length || script.steps.some((s) => s.at !== undefined);
  script.steps.forEach((s, i) => {
    const row = node('div', 'step' + (i === current ? ' current' : '') + (pending[i + ':delete'] ? ' deleted' : ''));
    const head = button('', () => {
      expanded = expanded === i ? -1 : i;
      if (s.at !== undefined) { t = Math.min(length, s.at); seek(); }
      showScript();
    }, 'head');
    head.appendChild(node('span', 'n', String(i + 1)));
    const line = head.appendChild(node('span', 'line', s.action + ' '));
    if (s.what) line.appendChild(node('b', '', s.what));
    const typed = pending[i + ':text']?.value ?? s.text;
    if (typed !== undefined) line.append(' ', node('q', '', typed));
    if (s.at !== undefined) head.appendChild(node('span', 'at', clock(s.at)));
    row.appendChild(head);
    const chips = node('div', 'chips');
    const say = pending[i + ':say'] ? pending[i + ':say'].value : s.say;
    if (say) chips.appendChild(node('span', 'chip', '“' + say + '”')).title = say;
    if (s.highlight && !pending[i + ':highlight']) chips.appendChild(node('span', 'chip lit', pretty(s.highlight.style || 'box')));
    if (Object.values(pending).some((c) => c.step === i)) chips.appendChild(node('span', 'chip edited', 'Needs a reshoot'));
    if (chips.childNodes.length) row.appendChild(chips);
    if (expanded === i) row.appendChild(editor(i, s));
    list.appendChild(row);
  });
  const changes = Object.entries(pending);
  $('tray').hidden = !changes.length;
  $('tray-count').textContent = changes.length + (changes.length === 1 ? ' change needs' : ' changes need') + ' a reshoot';
  $('tray-list').innerHTML = '';
  for (const [key, c] of changes) {
    const li = node('li');
    li.append(node('span', '', c.label), button('×', () => { delete pending[key]; keep(':pending', pending); showScript(); }, 'x'));
    $('tray-list').appendChild(li);
  }
};
// The step playing now, lit as the take plays.
const showCurrent = () => {
  let now = -1;
  script.steps.forEach((s, i) => { if (s.at !== undefined && s.at <= t + 0.01) now = i; });
  if (now === current) return;
  current = now;
  $('steps').querySelectorAll('.step').forEach((row, i) => row.classList.toggle('current', i === current));
  if (playing && !$('script').hidden) $('steps').children[current]?.scrollIntoView({ block: 'nearest' });
};
const showAttached = () => {
  const el = $('attached');
  el.hidden = !attached.length;
  el.innerHTML = '';
  if (!attached.length) return;
  const label = node('span', '', attached.length + (attached.length === 1 ? ' script change' : ' script changes') + ' attached');
  label.title = attached.join('\\n');
  el.append(label, button('×', () => { attached = []; keep(':attached', attached); showAttached(); }, 'x'));
};
$('tray-send').onclick = () => {
  attached = Object.values(pending).map((c) => c.label);
  keep(':attached', attached);
  document.querySelector('[role=tab][data-tab=chat]').click();
  showAttached();
  $('draft').focus();
};
fetch('/studio/script').then((r) => r.json()).then((x) => { script = x; showScript(); showCurrent(); });
showAttached();

const events = new EventSource('/studio/events');
events.onmessage = (e) => {
  const event = JSON.parse(e.data);
  // A restarted studio (a new take), or a config the agent changed: show it, at the same moment.
  if ((event.type === 'hello' && event.boot !== BOOT) || event.type === 'config') {
    return location.replace('/studio?t=' + t.toFixed(2) + '&tab=' + openTab());
  }
  if ('chat' in event) { chat = event.chat; showChat(); }
  if ('agent' in event) { agent = event.agent; showAgent(); }
};
const query = new URLSearchParams(location.search);
t = Math.max(0, Number(query.get('t')) || 0);
document.querySelector('[role=tab][data-tab=' + (query.get('tab') || 'chat') + ']')?.click();

render();
load();
</script>
</body></html>`
}

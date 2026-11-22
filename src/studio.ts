import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, openSync, watch } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  BACKDROPS,
  CURSORS,
  DISPLAYS,
  MUSIC,
  isHex,
  lookToRaw,
  readConfig,
  soundOn,
  type Config,
  type Music,
  type ProjectFile,
} from './config.ts'
import { cut, LIMIT, prepare, STEM_GAIN, stems, stemsOf, type Stem } from './cut/cut.ts'
import { convertExport } from './cut/export.ts'
import { CANVAS, stageFiles, type Look } from './cut/stage.ts'
import { filesOf, latestTake, type Video } from './videos.ts'

function placesOf(video: Video) {
  const dir = filesOf(video).studio
  return {
    dir,
    chat: filesOf(video).chat,
    server: join(dir, 'server.json'),
    log: join(dir, 'server.log'),
  }
}
const IDLE_MS = 30 * 60_000
// From 4000: 3000 is usually the app being filmed.
const PORTS = Array.from({ length: 100 }, (_, i) => 4000 + i)

interface Settings extends Look {
  music: Music | false
}

interface PageSettings {
  backdrop: string
  display: string
  fill: number
  cursor: { style: string; size: number; label?: string | undefined; tip?: [number, number] }
  music: false | { track: string; volume: number }
}

export interface StudioMessage {
  from: 'you' | 'agent'
  text: string
  at?: number
  sent: string
  read?: boolean
  delivered?: boolean
  by?: string
}

interface Agent {
  session?: string | undefined
  agent?: string | undefined
}

const own = (value: unknown): value is ProjectFile => typeof value === 'object' && value !== null

interface Own {
  backdrop?: ProjectFile | undefined
  cursor?: ProjectFile | undefined
  tip?: [number, number] | undefined
  music?: ProjectFile | undefined
}

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
    sound: config.sound,
  }
  return { settings, mine, extras }
}

// Host turns away DNS rebinding; Origin turns away other sites' pages. The agent's
// commands send no Origin, and must also carry the token to act as the agent.
export function trusted(
  port: number,
  host: string | undefined,
  origin: string | undefined,
): boolean {
  const names = [`localhost:${port}`, `127.0.0.1:${port}`]
  if (!host || !names.includes(host)) return false
  return !origin || names.some((name) => origin === `http://${name}`)
}

export async function studio(
  video: Video,
  footageDir: string,
  ports: number[] = PORTS,
): Promise<string> {
  const places = placesOf(video)
  const lookFile = filesOf(video).look
  const config = await readConfig(lookFile)
  const { footage, highlights, length, title } = await prepare(footageDir)
  const hold = Math.max(1, footage.film.ending?.hold ?? 2)
  const sounds = stems(footageDir, footage, length).catch(
    (error: Error): Partial<Record<Stem, string>> => (console.log(error.message), {}),
  )
  let { settings, mine, extras } = fromConfig(config, hold)
  let saving = Promise.resolve()
  let exporting = false
  const staged = (lit: typeof highlights) =>
    stageFiles(footageDir, footage, lit, () => settings, length, title)
  let stage = staged(highlights)
  let filmText = await readFile(footage.source, 'utf8').catch(() => '')
  const restage = async () => void (stage = staged((await prepare(footageDir)).highlights))
  const library = (path: string) => new URL(`../library/${path}`, import.meta.url)

  const boot = Date.now().toString(36)
  await mkdir(places.dir, { recursive: true })
  const chat: StudioMessage[] = await readFile(places.chat, 'utf8').then(JSON.parse, () => [])
  const saveChat = () => writeFile(places.chat, `${JSON.stringify(chat, null, 2)}\n`)
  const pages = new Set<ServerResponse>()
  const waiters: { res: ServerResponse; who: Agent }[] = []
  let agent: (Agent & { listening: boolean }) | null = null
  const emit = (event: object) => {
    for (const page of pages) page.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  const deliver = async () => {
    const unread = chat.filter((m) => m.from === 'you' && !m.read)
    const waiter = waiters.shift()
    if (!waiter) return
    if (!unread.length) return void waiters.unshift(waiter)
    whileIdle()
    for (const m of unread) m.delivered = true
    await saveChat()
    waiter.res.end(JSON.stringify(unread))
    agent = { ...waiter.who, listening: waiters.length > 0 }
    emit({ type: 'chat', chat })
    emit({ type: 'agent', agent })
  }

  let settling: NodeJS.Timeout | undefined
  const watcher = watch(video.dir, (_, name) => {
    if (name !== 'look.json') return
    clearTimeout(settling)
    settling = setTimeout(async () => {
      const next = await readConfig(lookFile).catch(
        (error: Error) => void console.log(error.message),
      )
      if (!next) return
      const fresh = fromConfig(next, hold, mine)
      const same = (a: typeof fresh) => JSON.stringify([toPage(a.settings), a.extras])
      if (same(fresh) === same({ settings, mine, extras })) return
      ;({ settings, mine, extras } = fresh)
      emit({ type: 'config' })
    }, 150)
  })

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

  let port: number | undefined
  const token = randomBytes(24).toString('hex')
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://studio')
    const path = url.pathname
    const send = (status: number, contentType: string, body: Buffer | string) => {
      res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
      res.end(body)
    }
    if (port === undefined || !trusted(port, req.headers.host, req.headers.origin)) {
      return send(403, 'text/plain', 'Not allowed.')
    }
    const fromAgent = req.headers.authorization === `Bearer ${token}`
    try {
      // The studio's frame loads the stage from /, so only a tab is sent on to the studio.
      if (path === '/' && req.headers['sec-fetch-dest'] === 'document') {
        res.writeHead(302, { location: '/studio' })
        return res.end()
      }
      if (path === '/studio') {
        const now = toPage(settings)
        const audible = stemsOf(footage).filter(
          (stem) => stem === 'voice' || soundOn(stem, extras.sound),
        )
        return send(200, 'text/html', page(now, extras, video, footageDir, boot, audible))
      }
      if (path === '/studio/ping') {
        const about = {
          studio: true,
          video: video.id,
          footage: resolve(footageDir),
          pid: process.pid,
        }
        return send(200, 'application/json', JSON.stringify(about))
      }
      if (path === '/studio/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        res.write(`data: ${JSON.stringify({ type: 'hello', boot, chat, agent })}\n\n`)
        pages.add(res)
        whileIdle()
        req.on('close', () => {
          pages.delete(res)
          whileIdle()
        })
        return
      }
      if (path === '/studio/chat' && req.method === 'POST') {
        const raw = JSON.parse(await body(req))
        if (raw.from === 'agent' && !fromAgent) return send(403, 'text/plain', 'Not allowed.')
        const text = String(raw.text ?? '').trim()
        if (!text) return send(400, 'text/plain', 'Nothing to send')
        const from = raw.from === 'agent' ? 'agent' : 'you'
        if (from === 'agent') {
          for (const m of chat) if (m.from === 'you' && m.delivered) m.read = true
        }
        const at = Number(raw.at)
        chat.push({
          from,
          text,
          ...(Number.isFinite(at) ? { at: Math.round(at * 10) / 10 } : {}),
          sent: new Date().toISOString(),
          ...(from === 'you' ? { read: false } : {}),
          ...(from === 'agent' && agent?.agent ? { by: agent.agent } : {}),
        })
        await saveChat()
        emit({ type: 'chat', chat })
        await deliver()
        return send(200, 'application/json', '{}')
      }
      if (path === '/studio/wait') {
        if (!fromAgent) return send(403, 'text/plain', 'Not allowed.')
        const who = {
          session: url.searchParams.get('session') ?? undefined,
          agent: url.searchParams.get('agent') ?? undefined,
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        const waiter = { res, who }
        waiters.push(waiter)
        whileIdle()
        agent = { ...who, listening: true }
        emit({ type: 'agent', agent })
        res.on('close', () => {
          const i = waiters.indexOf(waiter)
          if (i < 0) return
          waiters.splice(i, 1)
          whileIdle()
          const last = waiters.at(-1)
          agent = last ? { ...last.who, listening: true } : null
          emit({ type: 'agent', agent })
        })
        return await deliver()
      }
      if (path === '/studio/stop' && req.method === 'POST') {
        if (!fromAgent) return send(403, 'text/plain', 'Not allowed.')
        send(200, 'application/json', '{}')
        return await close()
      }
      if (path === '/studio/settings' && req.method === 'POST') {
        settings = fromPage(JSON.parse(await body(req)), settings, mine)
        saving = saving.then(() => saveLook(lookFile, settings)).catch((e) => void console.log(e))
        await saving
        return send(200, 'application/json', JSON.stringify(toPage(settings)))
      }
      if (path === '/studio/export' && req.method === 'POST') {
        const raw = JSON.parse(await body(req))
        const format: unknown = raw.format ?? 'mp4'
        if (format !== 'mp4' && format !== 'webm' && format !== 'gif') {
          return send(400, 'text/plain', 'Choose MP4, WebM, or GIF.')
        }
        if (exporting)
          return send(
            409,
            'text/plain',
            'An export is already running. Try again when it finishes.',
          )
        exporting = true
        const temporary = join(places.dir, `export-${randomBytes(8).toString('hex')}.mp4`)
        const converted = `${temporary}.${format}`
        try {
          const snapshot = fromPage(raw, settings, mine)
          await saving
          await cut(footageDir, temporary, { ...(await readConfig(lookFile)), ...snapshot })
          if (format !== 'mp4') await convertExport(temporary, converted, format)
          await rename(temporary, filesOf(video).cut)
          const output = join(video.dir, `video.${format}`)
          if (format !== 'mp4') await rename(converted, output)
          res.writeHead(200, {
            'content-type': { mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif' }[format],
            'content-disposition': `attachment; filename="${video.id}.${format}"`,
            'cache-control': 'no-store',
          })
          await pipeline(createReadStream(output), res)
        } finally {
          exporting = false
          await Promise.all([temporary, converted].map((file) => rm(file, { force: true })))
        }
        return
      }
      const thumb = path.match(/^\/studio\/backdrops\/([a-z-]+)\.jpg$/)
      if (thumb?.[1] && (BACKDROPS as readonly string[]).includes(thumb[1])) {
        return send(200, 'image/jpeg', await readFile(library(`backdrops/${thumb[1]}.jpg`)))
      }
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
      const stem = path.match(/^\/studio\/sound\/(click|typing|voice)$/)?.[1] as Stem | undefined
      const sound = stem && (await sounds)[stem]
      if (sound) return send(200, 'audio/mp4', await readFile(sound))
      const served = await stage(path)
      if (!served) return send(404, 'text/plain', 'Not found')
      return send(200, served.contentType, served.body)
    } catch (error) {
      console.log(error)
      if (!res.headersSent) send(400, 'text/plain', `That didn't work. See ${places.log}`)
    }
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    clearTimeout(idle)
    watcher.close()
    filmWatcher.close()
    for (const open of [...pages, ...waiters.map((w) => w.res)]) open.end()
    server.closeAllConnections()
    // A newer studio for this video may have written its own record over this one's.
    const record = await readFile(places.server, 'utf8').then(JSON.parse, () => undefined)
    if (record?.pid === process.pid) await rm(places.server, { force: true })
    server.close()
  }
  let idle: NodeJS.Timeout | undefined
  function whileIdle() {
    clearTimeout(idle)
    if (closed) return
    if (pages.size === 0 && waiters.length === 0) idle = setTimeout(() => void close(), IDLE_MS)
  }
  whileIdle()

  // Node ends a request after 5 minutes by default; the event stream and a wait last as
  // long as the user takes.
  server.requestTimeout = 0
  server.timeout = 0
  let found: number | undefined
  for (const next of ports) {
    const free = await new Promise<boolean>((done, fail) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'EADDRINUSE' ? done(false) : fail(error),
      )
      server.listen(next, '127.0.0.1', () => done(true))
    })
    if (free) {
      found = next
      break
    }
  }
  if (found === undefined) throw new Error(`No free port for the studio in ${ports.join(', ')}.`)
  port = found
  server.removeAllListeners('error')
  server.on('error', (error) => console.log(error))
  const about = { port, pid: process.pid, token }
  // writeFile's mode only applies to a new file, and this one holds the token.
  await rm(places.server, { force: true })
  await writeFile(places.server, `${JSON.stringify(about)}\n`, { mode: 0o600 })
  return `http://localhost:${port}/studio`
}

interface Running {
  port: number
  token: string
}

async function runningPort(video: Video): Promise<Running | undefined> {
  const running = await readFile(placesOf(video).server, 'utf8').then(
    (text) => {
      const { port, token } = JSON.parse(text)
      return { port: Number(port), token: String(token ?? '') }
    },
    () => undefined,
  )
  if (!running?.port) return undefined
  const about = await call(running, 'GET', '/studio/ping').then(JSON.parse, () => undefined)
  return about?.studio && about.video === video.id ? running : undefined
}

async function studioPort(video: Video): Promise<Running> {
  const port = await runningPort(video)
  if (!port) {
    throw new Error(
      `The studio for ${video.id} isn't open. Open it with: product-demo-agent-toolkit studio ${video.id}`,
    )
  }
  return port
}

export async function openStudio(video: Video, serve: string[]): Promise<string> {
  const take = await latestTake(video)
  const port = await runningPort(video)
  const running =
    port &&
    (await call(port, 'GET', '/studio/ping').then(
      (text) => JSON.parse(text) as { footage: string },
      () => undefined,
    ))
  if (port && running && running.footage === resolve(take.dir)) {
    return `http://localhost:${port.port}/studio`
  }
  if (running) await stopStudio(video)
  const places = placesOf(video)
  await mkdir(places.dir, { recursive: true })
  const log = openSync(places.log, 'a')
  const [command = process.execPath, ...args] = serve
  spawn(command, args, { detached: true, stdio: ['ignore', log, log] }).unref()
  for (let i = 0; i < 100; i++) {
    await new Promise((done) => setTimeout(done, 150))
    const started = await runningPort(video)
    if (started) return `http://localhost:${started.port}/studio`
  }
  throw new Error(`The studio didn't start. See ${places.log}`)
}

export async function stopStudio(video: Video): Promise<boolean> {
  const port = await runningPort(video)
  if (!port) return false
  return call(port, 'POST', '/studio/stop').then(
    () => true,
    () => false,
  )
}

export async function sayInStudio(video: Video, text: string): Promise<void> {
  const payload = JSON.stringify({ from: 'agent', text })
  await call(await studioPort(video), 'POST', '/studio/chat', payload)
}

export async function waitForStudio(video: Video, who: Agent): Promise<StudioMessage[]> {
  const query = new URLSearchParams(
    Object.entries(who).filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
  const text = await call(await studioPort(video), 'GET', `/studio/wait?${query}`)
  return text ? JSON.parse(text) : []
}

export async function recentChat(video: Video, count: number): Promise<StudioMessage[]> {
  const chat: StudioMessage[] = await readFile(placesOf(video).chat, 'utf8').then(
    JSON.parse,
    () => [],
  )
  return chat.slice(-count)
}

function call(
  { port, token }: Running,
  method: string,
  path: string,
  payload?: string,
): Promise<string> {
  return new Promise((done, fail) => {
    const headers = { authorization: `Bearer ${token}` }
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
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

function fromPage(raw: Partial<PageSettings>, was: Settings, mine: Own): Settings {
  const cursor: Partial<PageSettings['cursor']> = raw.cursor ?? {}
  const style = String(cursor.style)
  const size = Number(cursor.size ?? was.cursor.size)
  // Left out, the label stays; only an empty one clears it.
  const label =
    typeof cursor.label === 'string' ? cursor.label.trim().slice(0, 30) : (was.cursor.label ?? '')
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

async function saveLook(lookFile: string, settings: Settings): Promise<void> {
  const config = await readConfig(lookFile)
  const look = lookToRaw({ ...config, ...settings })
  await writeFile(lookFile, `${JSON.stringify(look, null, 2)}\n`)
}

function page(
  look: PageSettings,
  extras: { owned: Record<string, string | null>; music: readonly string[]; hold: number },
  video: Video,
  footageDir: string,
  boot: string,
  audible: Stem[],
): string {
  const escape = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  const title = escape(video.title)
  const take = escape(basename(footageDir))
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} · Studio</title>
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
body { display: grid; grid-template-columns: minmax(0, 1fr) 340px; height: 100vh; }

.primary { height: 32px; padding: 0 14px; border: 0; border-radius: 8px; background: var(--text); color: #fff;
  font-weight: 500; cursor: pointer; }
.primary:hover { background: #262626; }
.primary:disabled { background: var(--muted); color: var(--faint); cursor: default; }

.editor { display: grid; grid-template-rows: auto 1fr auto auto; min-width: 0; min-height: 0; }
#viewer { position: relative; min-width: 0; min-height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; padding: 20px 24px 12px; }
#screen { position: relative; flex: none; border-radius: 10px; box-shadow: 0 12px 32px rgb(0 0 0 / .08), 0 2px 6px rgb(0 0 0 / .04); }
#screen iframe { position: absolute; left: 0; top: 0; width: ${CANVAS.width}px; height: ${CANVAS.height}px; border: 0; transform-origin: 0 0; }
#screen iframe.loading { visibility: hidden; }
.transport { display: flex; justify-content: space-between; align-items: center; height: 44px; padding: 0 16px 0 12px;
  border-top: 1px solid var(--line); }
.transport .left { display: flex; align-items: center; gap: 4px; }
.icon { width: 30px; height: 30px; border: 0; background: none; border-radius: 8px; display: grid; place-items: center; cursor: pointer; color: var(--dim); }
.icon:hover { background: var(--muted); color: var(--text); }
.icon svg { width: 16px; height: 16px; }
#play { width: 28px; height: 28px; margin-right: 2px; border-radius: 50%; border: 0; background: var(--text); color: #fff; display: grid; place-items: center; cursor: pointer; }
#play:hover { background: #262626; }
#play svg { width: 12px; height: 12px; }
#time { padding-left: 6px; font: 500 12px var(--mono); }
.icon[aria-pressed="true"] { color: var(--text); }
.grid .colour { position: relative; background: conic-gradient(#f87171, #fbbf24, #4ade80, #22d3ee, #818cf8, #e879f9, #f87171); border-radius: 7px; }
.grid .colour input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.grid .colour[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3.5px var(--text); }
.grid .own, .swatches .own { background-size: contain !important; background-repeat: no-repeat !important; background-position: center !important; background-color: var(--muted) !important; }
.grid .own { background-size: cover !important; }
.field[hidden] { display: none; }
#time span { color: var(--faint); }

.timeline { --label: 148px; position: relative; border-top: 1px solid var(--line); user-select: none; padding-bottom: 10px; }
.ruler, .track { display: grid; grid-template-columns: var(--label) 1fr; }
.ruler { height: 28px; }
.ruler .lane { position: relative; border-bottom: 1px solid var(--line); }
.tick { position: absolute; bottom: 0; }
.tick span { position: absolute; bottom: 8px; left: 0; transform: translateX(-50%); font: 10px var(--mono); color: var(--faint); white-space: nowrap; }
.tick.minor { bottom: 13px; width: 2px; height: 2px; margin-left: -1px; border-radius: 1px; background: var(--line-strong); }
.track { height: 36px; }
.track .name { display: flex; align-items: center; gap: 8px; padding: 0 16px; color: var(--text); font-size: 12px; border-right: 1px solid var(--line); }
.track .name small { color: var(--faint); font-size: 11px; }
.track .name svg { width: 14px; height: 14px; color: var(--dim); flex: none; }
.ruler .lane, .track .lane { margin: 0 24px 0 16px; }
.track .lane { position: relative; background: var(--soft); border-bottom: 1px solid #fff; }
.clip { position: absolute; top: 4px; bottom: 4px; display: flex; align-items: center; gap: 6px; border-radius: 6px; overflow: hidden;
  font-size: 11px; font-weight: 500; line-height: 28px; padding: 0 8px; white-space: nowrap; }
.clip > span { overflow: hidden; text-overflow: ellipsis; }
.clip > svg, .clip > img { width: 14px; height: 14px; flex: none; }
.clip.page { background: var(--blue-bg); color: var(--blue-text); }
.clip.page small { font-size: inherit; font-weight: 400; color: #3b5ba9; }
.clip.page img { border-radius: 3px; }
.clip.music { padding: 0; background: #dcf5e4; color: #14532d; }
.clip.music > span { position: relative; padding: 0 8px; background: inherit; }
.clip.music > svg { position: absolute; left: 0; top: 4px; width: 100%; height: 20px; color: #16a34a; opacity: .35; }
.clip.music.off { opacity: .35; }
.clip.highlight { background: var(--violet); color: #fff; }
.clip.highlight > svg { width: 13px; height: 13px; }
.mark { position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%;
  background: var(--pink); border: 2px solid #fff; box-shadow: 0 1px 3px rgb(236 72 153 / .4); }
.lane .empty { position: absolute; left: 8px; top: 0; line-height: 36px; color: var(--faint); font-size: 11px; }
#lanes { position: relative; cursor: text; }
#playhead { position: absolute; top: 0; bottom: 10px; width: 0; pointer-events: none; z-index: 2; }
#playhead::before { content: ''; position: absolute; top: 0; bottom: 0; left: -0.5px; border-left: 1px solid var(--text); }
#playhead span { position: absolute; top: 5px; left: 0; transform: translateX(-50%); height: 18px; padding: 0 6px; border-radius: 5px;
  background: var(--text); color: #fff; font: 500 10px/18px var(--mono); white-space: nowrap; }

aside { border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.video { height: 44px; padding: 0 24px; display: flex; align-items: center; gap: 12px; min-width: 0; }
.video b { flex: 1; }
#export-status { color: var(--dim); font-size: 12px; max-width: 240px; }
#export { height: 32px; margin-right: -4px; padding: 0 10px; border: 0; border-radius: 8px; background: none; color: var(--text); cursor: pointer; display: inline-flex; align-items: center; gap: 7px; font-weight: 500; }
#export:hover { background: var(--muted); }
#export:disabled { cursor: wait; }
#export svg { width: 14px; height: 14px; }
.export-spinner { display: none; width: 14px; height: 14px; border: 1.5px solid var(--line-strong); border-top-color: var(--dim); border-radius: 50%; animation: export-spin .8s linear infinite; }
.export-done { display: none; }
#export[aria-busy=true] svg, #export[data-done] svg { display: none; }
#export[data-done] .export-done { display: block; }
#export[aria-busy=true] .export-spinner { display: block; }
@keyframes export-spin { to { transform: rotate(360deg); } }
#export-picker { width: min(400px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 0; border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 24px 80px #0002, 0 4px 16px #0001; color: var(--text); }
#export-picker::backdrop { background: rgb(10 10 10 / .16); backdrop-filter: blur(1.5px); }
.export-heading { position: relative; padding: 24px 24px 20px; }
.export-heading h2 { margin: 0 0 6px; font-size: 18px; font-weight: 600; letter-spacing: -.025em; }
.export-heading p { margin: 0; color: var(--dim); font-size: 12px; }
#cancel-export { position: absolute; top: 17px; right: 17px; }
.export-field { padding: 0 24px 8px; }
.export-field label { display: block; margin-bottom: 8px; font-size: 12px; font-weight: 500; }
.export-select { position: relative; display: flex; align-items: center; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--bg); box-shadow: 0 1px 2px #00000004; transition: border-color .15s, box-shadow .15s; }
.export-select:hover { border-color: #b8b8bc; }
.export-select:focus-within { border-color: var(--text); box-shadow: 0 0 0 3px #00000008; }
.export-select svg { position: absolute; pointer-events: none; width: 16px; height: 16px; color: var(--dim); }
.export-select .file-icon { left: 13px; }
.export-select .chevron { right: 12px; width: 14px; height: 14px; }
#export-format { appearance: none; width: 100%; height: 44px; border: 0; border-radius: inherit; background: transparent; padding: 0 36px 0 39px; outline: none; font: 500 13px Inter, sans-serif; color: var(--text); cursor: pointer; }
#export-picker footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 24px 24px; }
#export-picker footer small { color: var(--dim); font-size: 11px; }
#start-export { height: 36px; padding: 0 16px; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .export-spinner { animation: none; } .export-select { transition: none; } }
.video b { font-size: 15px; line-height: 20px; font-weight: 600; letter-spacing: -0.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tabs { display: flex; gap: 14px; padding: 0 18px; border-bottom: 1px solid var(--line); }
.tabs button { border: 0; background: none; padding: 12px 2px 10px; color: var(--dim); font-weight: 500; cursor: pointer; border-bottom: 1.5px solid transparent; margin-bottom: -1px; transition: color 0.15s, border-color 0.15s; }
.panel:not([hidden]) { animation: panel-in 0.24s cubic-bezier(0.2, 0, 0, 1); }
.panel.leaving { opacity: 0; transform: translateY(-4px); filter: blur(0.5px); transition: opacity 0.09s, transform 0.09s, filter 0.09s; }
@keyframes panel-in { from { opacity: 0; transform: translateY(8px); filter: blur(0.5px); } }
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

.panel.chat:not([hidden]) { display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.status { flex: none; box-sizing: border-box; display: flex; align-items: center; gap: 8px; height: 32px; padding: 12px 12px 0 20px; overflow: hidden; color: var(--dim); font-size: 12px; transition: opacity 0.25s, height 0.25s 0.25s, padding 0.25s 0.25s; }
.status.gone { opacity: 0; height: 0; padding-top: 0; }
.status:not(.gone) + #messages { padding-top: 10px; }
.status .label { flex: 1; }
.status .close { border: 0; background: none; padding: 2px 6px; border-radius: 6px; color: var(--faint); font-size: 15px; line-height: 1; cursor: pointer; opacity: 0; transition: opacity 0.15s; }
.status:hover .close { opacity: 1; }
.status .close:hover { color: var(--text); background: var(--muted); }
.status .avatar { width: 14px; height: 14px; border: 0; background: none; }
.status .avatar:empty { display: none; }
.status .avatar svg { width: 13px; height: 13px; }
.status.off .avatar { filter: grayscale(1); opacity: 0.4; }
.avatar { width: 24px; height: 24px; border-radius: 7px; display: grid; place-items: center; flex: none; background: var(--bg); border: 1px solid var(--line); transition: filter 0.3s, opacity 0.3s; }
.avatar svg { width: 14px; height: 14px; fill: var(--text); }
.avatar.claude svg { fill: #d97757; }
.msg .avatar { width: 20px; height: 20px; border-radius: 6px; }
.msg .avatar svg { width: 12px; height: 12px; }
.msg .avatar.claude { background: #d97757; border-color: transparent; }
.msg .avatar.claude svg { fill: #fff; }
.avatar span { font-size: 11px; font-weight: 600; color: var(--text); }
#messages { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 14px; transition: padding-top 0.25s 0.25s; }
#messages .empty { color: var(--faint); font-size: 12px; text-align: center; margin: auto 12px; }
.msg { max-width: 88%; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.you { align-self: flex-end; background: var(--muted); padding: 8px 12px; border-radius: 14px 14px 4px 14px; }
.msg.agent { align-self: flex-start; display: flex; gap: 10px; max-width: 94%; }
.msg.agent .body { min-width: 0; padding-top: 1px; }
.msg.agent .who { font-size: 12px; font-weight: 500; color: var(--dim); margin-bottom: 2px; }
.msg .dots { display: flex; gap: 4px; padding: 8px 0 4px; }
.msg .dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--dim); animation: typing 1.2s infinite ease-in-out; }
.msg .dots i:nth-child(2) { animation-delay: 0.15s; }
.msg .dots i:nth-child(3) { animation-delay: 0.3s; }
@keyframes typing { 0%, 60%, 100% { opacity: 0.25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .panel:not([hidden]) { animation: none; } .panel.leaving { transition: none; } .msg .dots i { animation: none; } .status { transition: none; } .msg .dots i { opacity: 0.6; } }
.msg .meta { display: flex; gap: 6px; align-items: center; margin-top: 4px; color: var(--faint); font-size: 11px; }
.msg.you .meta { justify-content: flex-end; }
.msg .at { border: 0; padding: 0; background: none; font: 11px var(--mono); color: var(--faint); cursor: pointer; }
.msg .at:hover { color: var(--dim); text-decoration: underline; }
.composer { margin: 0 12px 12px; border: 1px solid var(--line); border-radius: 14px; padding: 8px; }
.composer:focus-within { border-color: var(--line-strong); box-shadow: 0 0 0 3px rgb(0 0 0 / .04); }
.composer textarea { width: 100%; border: 0; outline: none; resize: none; font: inherit; color: var(--text); padding: 4px 6px; min-height: 40px; }
.composer .row { display: flex; justify-content: space-between; align-items: center; }
.composer .row small { color: var(--faint); font: 11px var(--mono); padding-left: 6px; }
.composer .primary { height: 28px; padding: 0 12px; }

</style></head><body>

<section class="editor">
  <div class="video"><b title="${title}">${title}</b><span id="export-status" role="status"></span><button id="export" aria-haspopup="dialog"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8m-3-3 3 3 3-3M3 10v3h10v-3"/></svg><span class="export-spinner" aria-hidden="true"></span><svg class="export-done" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="#16a34a"/><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span id="export-label">Export</span></button></div>
  <div id="viewer"><div id="screen"></div></div>
  <div class="transport">
    <div class="left">
      <button id="play" title="Play (space)"></button>
      <button class="icon" id="restart" title="To start"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v10M12 3.5 6.5 8l5.5 4.5z"/></svg></button>
      <div id="time"></div>
    </div>
    <button class="icon" id="sound" title="Sound on" aria-pressed="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path id="waves" d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/></svg></button>
  </div>
  <div class="timeline">
    <div class="ruler"><div></div><div class="lane" id="ruler"></div></div>
    <div id="tracks"></div>
    <div id="playhead"><span id="playhead-time"></span></div>
  </div>
</section>

<dialog id="export-picker" aria-labelledby="export-picker-title">
  <header class="export-heading"><h2 id="export-picker-title">Export video</h2><p>Download a copy with your current edits.</p><button class="icon" id="cancel-export" aria-label="Close export"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></header>
  <div class="export-field">
    <label for="export-format">File format</label>
    <div class="export-select">
      <svg class="file-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9.5 2Z"/><path d="M9 2v4h4M5.5 9h5M5.5 11h3"/></svg>
      <select id="export-format"><option value="mp4">MP4</option><option value="webm">WebM</option><option value="gif">GIF</option></select>
      <svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 6.5 3 3 3-3"/></svg>
    </div>
  </div>
  <footer><small>Saved to your downloads</small><button class="primary" id="start-export">Export MP4</button></footer>
</dialog>
<aside>
  <div class="tabs" role="tablist">
    <button role="tab" aria-selected="true" data-tab="chat">Agent</button>
    <button role="tab" aria-selected="false" data-tab="settings">Configuration</button>
  </div>
  <div class="panel chat" id="chat">
    <div class="status gone" id="agent"><span class="avatar"></span><span class="label"></span><button class="close" type="button" aria-label="Dismiss">×</button></div>
    <div id="messages"></div>
    <form class="composer" id="composer">
      <textarea id="draft" rows="2" placeholder="Ask your agent for a change…"></textarea>
      <div class="row"><small id="draft-at"></small><button class="primary" type="submit">Send</button></div>
    </form>
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
      <div class="range-ends"><span>Smaller</span><span>Larger</span></div>
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
const STEMS = ${JSON.stringify(audible)};
const STEM_GAIN = ${STEM_GAIN};
const LIMIT = ${LIMIT};
const BOOT = ${JSON.stringify(boot)};
const fileName = (path) => path.split('/').pop();
const CURSORS = { black: '#111111', pink: '#ff7ccb', lime: '#b6f24f', macos: 'linear-gradient(135deg,#000 50%,#fff 50%)' };
const $ = (id) => document.getElementById(id);
const exportPicker = $('export-picker');
let downloading = false, refreshAfterExport = false, exportDone;
$('export').onclick = () => exportPicker.showModal();
$('cancel-export').onclick = () => exportPicker.close();
exportPicker.onclick = (e) => { if (e.target === exportPicker) exportPicker.close(); };
const exportFormat = () => $('export-format').value;
$('export-format').onchange = () => {
  $('start-export').textContent = 'Export ' + (exportFormat() === 'webm' ? 'WebM' : exportFormat().toUpperCase());
};
$('start-export').onclick = async () => {
  const format = exportFormat();
  exportPicker.close();
  downloading = true;
  const button = $('export'), status = $('export-status');
  button.disabled = true;
  clearTimeout(exportDone);
  delete button.dataset.done;
  button.setAttribute('aria-busy', 'true');
  $('export-label').textContent = 'Exporting…';
  status.textContent = '';
  try {
    const res = await fetch('/studio/export', { method: 'POST', body: JSON.stringify({ ...look, format }) });
    if (!res.ok) throw new Error(await res.text());
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = ${JSON.stringify(video.id)} + '.' + format;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    button.dataset.done = '';
    exportDone = setTimeout(() => { delete button.dataset.done; $('export-label').textContent = 'Export'; }, 3000);
  } catch (error) {
    status.textContent = 'Export failed. ' + error.message;
  } finally {
    downloading = false;
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
    $('export-label').textContent = 'done' in button.dataset ? 'Exported' : 'Export';
    if (refreshAfterExport) setTimeout(refresh, 1000);
  }
};
const pretty = (name) => name[0].toUpperCase() + name.slice(1).replace(/-/g, ' ');
const thumb = (name) => name === 'own' ? 'url(/studio/own/backdrop)' : name.startsWith('#') ? 'linear-gradient(' + name + ',' + name + ')' : 'url(/studio/backdrops/' + name + '.jpg)';
const backdropName = (name) => name === 'own' ? fileName(OWNED.backdrop) : name.startsWith('#') ? name : pretty(name);
const clock = (s) => { s = Math.max(0, s); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + (s % 60).toFixed(1).padStart(4, '0'); };
const ICON_PLAY = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.3-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="2.5" width="3" height="11" rx=".8"/><rect x="9.5" y="2.5" width="3" height="11" rx=".8"/></svg>';

const viewer = $('viewer'), screen = $('screen');
let frame, data, length = 0, t = 0, playing = false;

const fit = () => {
  const w = viewer.clientWidth - 48, h = viewer.clientHeight - 32;
  const k = Math.max(0.05, Math.min(w / ${CANVAS.width}, h / ${CANVAS.height}));
  // Whole, even pixels: a fractional box shows what's behind it at its edges.
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  const width = even(${CANVAS.width} * k), height = even(${CANVAS.height} * k);
  screen.style.width = width + 'px';
  screen.style.height = height + 'px';
  const sx = width / ${CANVAS.width}, sy = height / ${CANVAS.height};
  for (const f of screen.querySelectorAll('iframe')) {
    f.style.transform = 'scale(' + sx + ',' + sy + ')';
    f.style.clipPath = 'inset(0 round ' + 10 / sx + 'px / ' + 10 / sy + 'px)';
  }
};
new ResizeObserver(fit).observe(viewer);

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
  const per = step % 5 === 0 ? 5 : 2;
  for (let i = 0; (i * step) / per <= length; i++) {
    const s = (i * step) / per;
    const tick = document.createElement('div');
    const major = i % per === 0;
    tick.className = 'tick' + (major ? '' : ' minor');
    tick.style.left = pct(s);
    if (major) tick.innerHTML = '<span>' + clock(s).slice(0, 5) + '</span>';
    ruler.appendChild(tick);
  }
  const globe = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>';
  const pointer = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="m3 3 10 3.6-4.6 1.8L6.6 13z"/></svg>';
  const spark = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="4" width="11" height="8" rx="2"/></svg>';
  const pages = track('Page', '', globe);
  const addresses = (data.addresses.length ? data.addresses : [{ at: 0, label: 'Screen' }])
    .filter((a, i, all) => i === 0 || a.label !== all[i - 1].label);
  addresses.forEach((a, i) => {
    const end = addresses[i + 1]?.at ?? length;
    const clip = document.createElement('div');
    clip.className = 'clip page';
    clip.style.left = 'calc(' + pct(a.at) + ' + 1px)';
    clip.style.width = 'calc(' + pct(end - a.at) + ' - 2px)';
    clip.title = a.label;
    const slash = a.label.indexOf('/');
    const host = slash < 0 ? a.label : a.label.slice(0, slash);
    const name = document.createElement('span');
    name.textContent = host.replace(/^www\\./, '');
    if (slash >= 0) {
      const rest = document.createElement('small');
      rest.textContent = ' ' + a.label.slice(slash);
      name.appendChild(rest);
    }
    if (host.includes('.') || host.startsWith('localhost')) {
      const icon = document.createElement('img');
      icon.alt = '';
      icon.referrerPolicy = 'no-referrer';
      icon.src = '//' + host + '/favicon.ico';
      icon.onerror = () => icon.replaceWith(Object.assign(document.createElement('span'), { innerHTML: globe }).firstChild);
      clip.appendChild(icon);
    }
    clip.appendChild(name);
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
  musicClip.innerHTML = '<span></span>';
  tune.appendChild(musicClip);
  const lights = track('Highlights', '', spark);
  if (!data.highlights.length) lights.innerHTML = '<span class="empty">None in this take</span>';
  const lens = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.4 10.4 14 14M5 7h4M7 5v4"/></svg>';
  const styles = { magnify: lens, box: spark, cursor: pointer };
  for (const h of data.highlights) {
    const clip = document.createElement('div');
    clip.className = 'clip highlight';
    clip.style.left = pct(h.at);
    clip.style.width = pct(h.until - h.at);
    clip.innerHTML = (styles[h.style] || spark) + '<span></span>';
    clip.lastChild.textContent = pretty(h.style);
    lights.appendChild(clip);
  }
  render();
  show();
};

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
  $('playhead-time').textContent = clock(t);
  $('draft-at').textContent = 'At ' + clock(t);
  const icon = playing ? ICON_PAUSE : ICON_PLAY;
  // The icon is only swapped when it changes: swapped between press and release, the click is lost.
  if ($('play').dataset.icon !== String(playing)) { $('play').dataset.icon = String(playing); $('play').innerHTML = icon; }
  const lane = $('ruler').getBoundingClientRect(), box = timelineEl.getBoundingClientRect();
  if (length) $('playhead').style.left = lane.left - box.left + (t / length) * lane.width + 'px';
};
window.addEventListener('resize', show);
const seek = async () => { if (playing) play(); if (frame) await frame.contentWindow.stage.seek(t); show(); };

const musicSrc = (m) => m.track === 'own' ? '/studio/own/music' : '/studio/music/' + m.track;

const wave = async (src) => {
  if (musicClip.dataset.wave === (src || '')) return;
  musicClip.dataset.wave = src || '';
  musicClip.querySelector('svg')?.remove();
  if (!src) return;
  try {
    const sound = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await (await fetch(src)).arrayBuffer());
    if (musicClip.dataset.wave !== src) return;
    const samples = sound.getChannelData(0), rate = sound.sampleRate;
    const n = Math.max(40, Math.floor(musicClip.clientWidth / 4));
    const peaks = [];
    for (let i = 0; i < n; i++) {
      const from = Math.floor((i / n) * length * rate), to = Math.floor(((i + 1) / n) * length * rate);
      let peak = 0;
      for (let s = from; s < to; s += Math.max(1, Math.floor((to - from) / 256))) peak = Math.max(peak, Math.abs(samples[s % samples.length]));
      peaks.push(peak);
    }
    const top = Math.max(...peaks) || 1;
    const bars = peaks.map((p, i) => { const h = 3 + (p / top) * 17; return '<rect x="' + i * 4 + '" y="' + (10 - h / 2) + '" width="2" height="' + h + '" rx="1"/>'; });
    musicClip.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 ' + n * 4 + ' 20" preserveAspectRatio="none" fill="currentColor">' + bars.join('') + '</svg>');
  } catch {}
};
let heard = true;
const mixer = new AudioContext();
const master = mixer.createGain();
master.connect(mixer.destination);
const limiter = mixer.createDynamicsCompressor();
const limits = { threshold: 20 * Math.log10(LIMIT), knee: 0, ratio: 20, attack: 0.001, release: 0.05 };
for (const [name, value] of Object.entries(limits)) limiter[name].value = value;
limiter.connect(master);
const restore = mixer.createGain();
restore.gain.value = 1 / STEM_GAIN;
restore.connect(limiter);
const musicLevel = mixer.createGain();
musicLevel.connect(limiter);
const decode = (url) => fetch(url).then((r) => r.arrayBuffer()).then((b) => mixer.decodeAudioData(b)).catch(() => null);
const stemBuffers = Promise.all(STEMS.map((stem) => decode('/studio/sound/' + stem)));
const musicBuffers = {};
const musicKey = () => look.music ? musicSrc(look.music) : null;

// The playhead is read from the audio clock while playing, so picture and sound can't drift.
let sources = [], generation = 0, origin = 0, startedAt = 0, playingMusic = null;
const audioNow = () => origin + mixer.currentTime - startedAt;
const stop = () => {
  generation++;
  for (const s of sources) s.stop();
  sources = [];
};
const start = (buffer, to, when, offset) => {
  const s = mixer.createBufferSource();
  s.buffer = buffer;
  s.connect(to);
  s.start(when, offset);
  sources.push(s);
  return s;
};
const level = () => {
  const g = musicLevel.gain, volume = look.music ? look.music.volume : 0, fade = Math.min(HOLD, length);
  const at = (time) => startedAt + time - origin;
  g.cancelScheduledValues(0);
  g.setValueAtTime(volume * Math.max(0, Math.min(1, (length - audioNow()) / fade)), mixer.currentTime);
  if (audioNow() < length - fade) g.setValueAtTime(volume, at(length - fade));
  g.linearRampToValueAtTime(0, at(length));
};
const play = async () => {
  stop();
  const go = generation;
  origin = t;
  startedAt = mixer.currentTime;
  await mixer.resume();
  const key = musicKey();
  const music = key && (musicBuffers[key] ??= decode(key));
  const [stems, track] = await Promise.all([stemBuffers, music]);
  if (go !== generation || !playing) return;
  const when = mixer.currentTime, at = audioNow();
  for (const b of stems) if (b && at < b.duration) start(b, restore, when, at);
  if (track) start(track, musicLevel, when, at % track.duration).loop = true;
  playingMusic = key;
  level();
};
const audio = () => {
  if (!playing) return;
  if (playingMusic !== musicKey()) play();
  else level();
};
$('sound').onclick = () => {
  heard = !heard;
  pressed($('sound'), heard);
  $('sound').title = heard ? 'Sound on' : 'Sound off';
  $('waves').style.display = heard ? '' : 'none';
  master.gain.value = heard ? 1 : 0;
};
const tick = async () => {
  if (!playing) return;
  t = audioNow();
  if (t >= length) { t = length; playing = false; stop(); }
  if (frame) await frame.contentWindow.stage.seek(t);
  show();
  if (playing) requestAnimationFrame(tick);
};
const toggle = () => {
  if (!playing && t >= length) t = 0;
  playing = !playing;
  show();
  if (playing) { play(); requestAnimationFrame(tick); }
  else stop();
};
$('play').onclick = toggle;
$('restart').onclick = () => { t = 0; seek(); };
document.addEventListener('keydown', (e) => {
  if (exportPicker.open || e.target.closest('button')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  if (e.code === 'ArrowLeft') { t = Math.max(0, t - 1); seek(); }
  if (e.code === 'ArrowRight') { t = Math.min(length, t + 1); seek(); }
});

const visual = (l) => JSON.stringify([l.backdrop, l.display, l.fill, l.cursor]);
let shown = visual(look);
const send = async () => {
  render();
  audio();
  const res = await fetch('/studio/settings', { method: 'POST', body: JSON.stringify(look) });
  look = await res.json();
  render();
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
    musicClip.querySelector('span').textContent = m ? (m.track === 'own' ? fileName(OWNED.music) : pretty(m.track)) + ' · ' + Math.round(m.volume * 100) + '%' : 'No music';
    wave(m && musicSrc(m));
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
  make($('display'), name, (b) => { b.textContent = name === 'none' ? 'None' : 'Browser'; b.onclick = () => change({ display: name }); });
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
    if (tab.getAttribute('aria-selected') === 'true') return;
    for (const other of document.querySelectorAll('[role=tab]')) other.setAttribute('aria-selected', String(other === tab));
    const from = document.querySelector('.panel:not([hidden])');
    const swap = () => {
      from?.classList.remove('leaving');
      for (const name of ['settings', 'chat']) $(name).hidden = tab.dataset.tab !== name;
    };
    if (!from || matchMedia('(prefers-reduced-motion: reduce)').matches) return swap();
    from.classList.add('leaving');
    setTimeout(swap, 90);
  };
}
const openTab = () => document.querySelector('[role=tab][aria-selected=true]').dataset.tab;

let chat = [], agent = null, lastAgent = '', wasConnected = false, fading;
$('agent').querySelector('.close').onclick = () => { clearTimeout(fading); $('agent').classList.add('gone'); };
const esc = (text) => text.replace(/[&<>"]/g, (c) => '&#' + c.charCodeAt(0) + ';');
const ICONS = { claude: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", openai: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" };
const avatar = (el, name) => {
  const brand = /claude/i.test(name) ? 'claude' : /codex|gpt|openai/i.test(name) ? 'openai' : '';
  el.className = 'avatar' + (brand ? ' ' + brand : '');
  el.innerHTML = brand ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICONS[brand] + '"/></svg>'
    : '<span>' + esc((name || 'A').trim().charAt(0).toUpperCase()) + '</span>';
  return el;
};
const showAgent = () => {
  if (agent?.agent) lastAgent = agent.agent;
  const status = $('agent');
  if (agent?.agent || lastAgent) avatar(status.querySelector('.avatar'), agent?.agent || lastAgent);
  status.title = agent ? [agent.agent || 'Your agent', agent.session].filter(Boolean).join(' · ') : '';
  if (!agent) {
    clearTimeout(fading);
    status.className = 'status off';
    status.querySelector('.label').textContent = 'Not connected. Ask your agent to open the studio.';
  } else if (status.classList.contains('off') || !wasConnected) {
    status.className = 'status';
    status.querySelector('.label').textContent = 'Connected';
    clearTimeout(fading);
    fading = setTimeout(() => status.classList.add('gone'), 5000);
  }
  wasConnected = Boolean(agent);
};
const agentRow = (name) => {
  const el = document.createElement('div');
  el.className = 'msg agent';
  el.appendChild(avatar(document.createElement('div'), name));
  const body = document.createElement('div');
  body.className = 'body';
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = name || 'Your agent';
  body.appendChild(who);
  el.appendChild(body);
  return [el, body];
};
const showChat = () => {
  const list = $('messages');
  list.innerHTML = chat.length ? '' : '<div class="empty">Messages go to your agent, with the moment in the take you were at.</div>';
  for (const m of chat) {
    const [el, body] = m.from === 'agent' ? agentRow(m.by || agent?.agent || lastAgent) : [document.createElement('div')];
    const box = body || el;
    if (!body) el.className = 'msg you';
    box.append(m.text);
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (typeof m.at === 'number') {
      const at = document.createElement('button');
      at.className = 'at';
      at.textContent = clock(m.at);
      at.onclick = () => { t = Math.min(length, m.at); seek(); };
      meta.appendChild(at);
    }
    if (m.from === 'you' && !m.read && !m.delivered) meta.append('Not read yet');
    if (meta.childNodes.length) box.appendChild(meta);
    list.appendChild(el);
  }
  if (agent && !agent.listening && chat.some((m) => m.from === 'you' && !m.read)) {
    const [typing, body] = agentRow(agent.agent || lastAgent);
    typing.title = 'Working on it';
    body.insertAdjacentHTML('beforeend', '<div class="dots"><i></i><i></i><i></i></div>');
    list.appendChild(typing);
  }
  list.scrollTop = list.scrollHeight;
};
$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('draft').value.trim();
  if (!text) return;
  $('draft').value = '';
  keep(':draft', '');
  await fetch('/studio/chat', { method: 'POST', body: JSON.stringify({ text, at: t }) });
};
$('draft').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
};
const TAKE = ${JSON.stringify(take)};
const kept = (key, fallback) => { try { return JSON.parse(sessionStorage.getItem(TAKE + key)) ?? fallback; } catch { return fallback; } };
const keep = (key, value) => { try { sessionStorage.setItem(TAKE + key, JSON.stringify(value)); } catch {} };

$('draft').value = kept(':draft', '');
$('draft').oninput = () => keep(':draft', $('draft').value);

const events = new EventSource('/studio/events');
const refresh = () => location.replace('/studio?t=' + t.toFixed(2) + '&tab=' + openTab());
events.onmessage = (e) => {
  const event = JSON.parse(e.data);
  if ((event.type === 'hello' && event.boot !== BOOT) || event.type === 'config') {
    if (downloading) { refreshAfterExport = true; return; }
    return refresh();
  }
  if ('chat' in event) { chat = event.chat; showChat(); }
  if ('agent' in event) { agent = event.agent; showAgent(); showChat(); }
};
const query = new URLSearchParams(location.search);
t = Math.max(0, Number(query.get('t')) || 0);
document.querySelector('[role=tab][data-tab=' + (query.get('tab') || 'chat') + ']')?.click();

render();
load();
</script>
</body></html>`
}

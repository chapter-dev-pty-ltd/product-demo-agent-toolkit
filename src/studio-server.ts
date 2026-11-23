import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createReadStream, openSync, watch } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { stripTypeScriptTypes } from 'node:module'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import {
  BACKDROPS,
  CURSORS,
  DISPLAYS,
  MUSIC,
  cursorSizeSchema,
  fillSchema,
  isHex,
  lookToRaw,
  readConfig,
  soundOn,
  volumeSchema,
  type Config,
  type Music,
  type ProjectFile,
} from './config.ts'
import {
  clearOldSounds,
  cut,
  LIMIT,
  prepare,
  STEM_GAIN,
  stems,
  stemsOf,
  type Stem,
} from './cut/cut.ts'
import {
  planEdit,
  Refused,
  writeClickSound,
  writeCover,
  writeHighlight,
  writePlan,
} from './cut/edits.ts'
import { convertExport } from './cut/export.ts'
import { CANVAS, stageFiles, type Look } from './cut/stage.ts'
import { timelineOf } from './cut/timeline.ts'
import type {
  Agent,
  AgentStatus,
  PageSettings,
  StudioEvent,
  StudioMessage,
  StudioState,
} from '../studio/api.ts'
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
const UI = new URL('../studio/', import.meta.url)
// From 4000: 3000 is usually the app being filmed.
const PORTS = Array.from({ length: 100 }, (_, i) => 4000 + i)

interface Settings extends Look {
  music: Music | false
}

export type { StudioMessage }

const own = (value: unknown): value is ProjectFile => typeof value === 'object' && value !== null

interface Own {
  backdrop?: ProjectFile | undefined
  cursor?: ProjectFile | undefined
  tip?: [number, number] | undefined
  music?: ProjectFile | undefined
}

function fromConfig(config: Config, was: Own = {}) {
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
    tracks: MUSIC,
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
  let { footage, recorded, film, edits, holds, covers, highlights, length, ending, title } =
    await prepare(footageDir)
  const soundsNow = () => {
    const made = stems(footageDir, footage, length).catch(
      (error: Error): Partial<Record<Stem, string>> => (console.log(error.message), {}),
    )
    // Each set of edits makes its own sound files; once the newest is made, the rest go.
    void made
      .then((files) => (made === sounds ? clearOldSounds(footageDir, files) : undefined))
      .catch((error: Error) => void console.log(error.message))
    return made
  }
  let sounds = soundsNow()
  let { settings, mine, extras } = fromConfig(config)
  let saving = Promise.resolve()
  let writing: NodeJS.Timeout | undefined
  const flush = () => {
    if (writing) {
      clearTimeout(writing)
      writing = undefined
      saving = saving.then(() => saveLook(lookFile, settings)).catch((e) => void console.log(e))
    }
    return saving
  }
  let exporting = false
  const writeEdit = (file: string, now: typeof film, raw: unknown) =>
    writePlan(file, planEdit(now, recorded, raw))
  const staged = () =>
    stageFiles(footageDir, footage, highlights, () => settings, length, title, covers)
  let stage = staged()
  let filmText = await readFile(footage.source, 'utf8').catch(() => '')
  const restage = async () => {
    ;({ footage, recorded, film, edits, holds, covers, highlights, length, ending, title } =
      await prepare(footageDir))
    stage = staged()
    sounds = soundsNow()
  }
  const audible = () =>
    stemsOf(footage).filter((stem) => stem === 'voice' || soundOn(stem, extras.sound))
  const stageEvent = (): StudioEvent => ({
    type: 'stage',
    timeline: timelineOf(recorded, film, edits, holds),
    stems: audible(),
    hold: Math.max(1, ending),
  })
  // One change to the film at a time: each is planned against the film the last one left.
  let changing = Promise.resolve()
  const changeFilm = (write: () => Promise<string>) => {
    const done = changing.then(async () => {
      filmText = await write()
      await restage()
      emit(stageEvent())
    })
    changing = done.catch(() => {})
    return done
  }
  const library = (path: string) => new URL(`../library/${path}`, import.meta.url)

  const boot = Date.now().toString(36)
  await mkdir(places.dir, { recursive: true })
  const chat: StudioMessage[] = await readFile(places.chat, 'utf8').then(JSON.parse, () => [])
  const saveChat = () => writeFile(places.chat, `${JSON.stringify(chat, null, 2)}\n`)
  const pages = new Set<ServerResponse>()
  const waiters: { res: ServerResponse; who: Agent }[] = []
  let agent: AgentStatus | null = null
  const emit = (event: StudioEvent) => {
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
      // Our own write is about to replace whatever this read.
      if (!next || writing) return
      const fresh = fromConfig(next, mine)
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
      await changeFilm(async () => text).catch((error: Error) => void console.log(error.message))
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
        return send(200, 'text/html', await readFile(new URL('index.html', UI)))
      }
      if (path === '/studio/state') {
        const state: StudioState = {
          title: video.title,
          video: video.id,
          take: basename(footageDir),
          boot,
          look: toPage(settings),
          backdrops: BACKDROPS,
          owned: extras.owned,
          tracks: extras.tracks,
          hold: Math.max(1, ending),
          stems: audible(),
          stemGain: STEM_GAIN,
          limit: LIMIT,
          canvas: CANVAS,
          timeline: timelineOf(recorded, film, edits, holds),
        }
        return send(200, 'application/json', JSON.stringify(state))
      }
      const ui = path.match(/^\/studio\/([a-z-]+\.(?:ts|css))$/)?.[1]
      if (ui) {
        const source = await readFile(new URL(ui, UI), 'utf8').catch(() => undefined)
        if (source === undefined) return send(404, 'text/plain', 'Not found')
        if (ui.endsWith('.css')) return send(200, 'text/css', source)
        // Stripped per request, not built, so users and their agents can edit studio/ and see the change on refresh.
        return send(200, 'text/javascript', stripTypeScriptTypes(source))
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
        const hello: StudioEvent = { type: 'hello', boot, chat, agent }
        res.write(`data: ${JSON.stringify(hello)}\n\n`)
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
        clearTimeout(writing)
        writing = setTimeout(flush, 150)
        return send(200, 'application/json', JSON.stringify(toPage(settings)))
      }
      const writers = {
        edits: writeEdit,
        sound: writeClickSound,
        highlight: writeHighlight,
        cover: writeCover,
      }
      const change = path.match(/^\/studio\/(edits|sound|highlight|cover)$/)?.[1] as
        keyof typeof writers | undefined
      if (change && req.method === 'POST') {
        const raw = JSON.parse(await body(req))
        await changeFilm(() => writers[change](footage.source, film, raw))
        return send(200, 'application/json', '{}')
      }
      if (path === '/studio/export' && req.method === 'POST') {
        const { format = 'mp4', ...look }: { format?: unknown } = JSON.parse(await body(req))
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
          const snapshot = fromPage(look, settings, mine)
          await flush()
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
      if (error instanceof z.ZodError && !res.headersSent) {
        return send(400, 'text/plain', z.prettifyError(error))
      }
      if (error instanceof Refused && !res.headersSent)
        return send(400, 'text/plain', error.message)
      console.log(error)
      if (!res.headersSent) send(400, 'text/plain', `That didn't work. See ${places.log}`)
    }
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    clearTimeout(idle)
    await flush()
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
    x: settings.window.x,
    y: settings.window.y,
    cursor: {
      style: own(cursor.style) ? 'own' : cursor.style,
      size: cursor.size,
      ...(cursor.label ? { label: cursor.label } : {}),
      ...(own(cursor.style) && cursor.tip ? { tip: cursor.tip } : {}),
    },
    music: music && { track: own(music.track) ? 'own' : music.track, volume: music.volume },
  }
}

const HEX = { is: isHex, hint: 'a hex colour like "#8fd3ff"' }

function choice<T extends string, X extends string = never>(
  kind: string,
  list: readonly T[],
  file: ProjectFile | undefined,
  extra?: { is: (value: string) => value is X; hint: string },
) {
  const options = [...list, ...(extra ? [extra.hint] : []), ...(file ? ['own'] : [])]
  return z.string().transform((value, context): T | X | ProjectFile => {
    if (value === 'own' && file) return file
    if ((list as readonly string[]).includes(value)) return value as T
    if (extra?.is(value)) return value
    context.addIssue({
      code: 'custom',
      message:
        value === 'own'
          ? `There's no ${kind} of your own to use.`
          : `"${value}" isn't a ${kind}: use ${options.join(', ')}.`,
    })
    return z.NEVER
  })
}

function pageSchema(mine: Own) {
  return z
    .strictObject({
      backdrop: choice('backdrop', BACKDROPS, mine.backdrop, HEX),
      display: z.enum(DISPLAYS),
      fill: fillSchema.transform((fill) => Math.round(fill * 100) / 100),
      x: z.number().int().min(-CANVAS.width).max(CANVAS.width).nullable(),
      y: z.number().int().min(-CANVAS.height).max(CANVAS.height).nullable(),
      cursor: z
        .strictObject({
          style: choice('cursor', CURSORS, mine.cursor, HEX),
          size: cursorSizeSchema,
          label: z.string().trim().max(30),
          tip: z.tuple([z.number(), z.number()]),
        })
        .partial(),
      music: z
        .preprocess(
          (music) => (music === false ? null : music),
          z
            .strictObject({
              track: choice('music track', MUSIC, mine.music),
              volume: volumeSchema,
            })
            .nullable(),
        )
        .transform((music) => music ?? false),
    })
    .partial()
}

// Left out, a setting stays as it was; only an empty label or a null position clears it.
export function fromPage(raw: unknown, was: Settings, mine: Own): Settings {
  const page = pageSchema(mine).parse(raw)
  const style = page.cursor?.style ?? was.cursor.style
  const label = page.cursor?.label ?? was.cursor.label
  return {
    window: {
      ...was.window,
      fill: page.fill ?? was.window.fill,
      x: page.x === undefined ? was.window.x : (page.x ?? undefined),
      y: page.y === undefined ? was.window.y : (page.y ?? undefined),
    },
    backdrop: page.backdrop ?? was.backdrop,
    display: page.display ?? was.display,
    cursor: {
      style,
      size: page.cursor?.size ?? was.cursor.size,
      ...(label ? { label } : {}),
      ...(own(style) && mine.tip ? { tip: mine.tip } : {}),
    },
    music: page.music ?? was.music,
  }
}

async function saveLook(lookFile: string, settings: Settings): Promise<void> {
  const config = await readConfig(lookFile)
  const look = lookToRaw({ ...config, ...settings })
  await writeFile(lookFile, `${JSON.stringify(look, null, 2)}\n`)
}

#!/usr/bin/env node
import { cp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import {
  cut,
  explore,
  init,
  loadKeys,
  readFootage,
  readSecret,
  saveKey,
  review,
  videoLength,
  latestRun,
  NeedsDecision,
  newRun,
  readConfig,
  readFilm,
  rehearse,
  send,
  serve,
  shoot,
  speakLines,
  wordAt,
  type Spoken,
  version,
  type Footage,
} from './index.ts'

const USAGE = `product-demo ${version}

0. Get the project ready, and see what's missing (run it first):
  product-demo init
  product-demo key elevenlabs [key]   Save a voice provider's key for every project (asks for it, hidden, if not given)

1. Explore the app, off camera, to learn it and find the path. Every action is logged, pinned.
   Name an element by its ref from look (@e12), or by a point on look's screenshot (640,320):
  product-demo explore <url>          Open the app in a background browser and show the screen
  product-demo look [--all]           What's on screen as an accessibility tree with refs, and a screenshot
  product-demo handles                The small grab handles on screen (resize, rotate, sliders) and where they are
  product-demo click <el> [--double] [--right] [--with Shift+Meta] [--at 0.9,0.5]
  product-demo fill <el> "text"       Click into a field and type, replacing what's there
  product-demo select <el> "option"   Choose an option in a native <select>
  product-demo type "text"            Type where the caret is, like "@Sam" to open a mention menu
  product-demo press <key>            Press a key, like Enter or Meta+K
  product-demo hover <el> [--for 2]   Rest the pointer on an element, to show it or open what it reveals
  product-demo drag <el> <el> [--at x,y] [--to-at x,y]
  product-demo scroll up|down [--in <el>] [--by 600]
  product-demo upload <file> [<el>]   Upload a file through the control that opens the picker
  product-demo visit <path>
  product-demo wait "text" [--gone] | <seconds>
  product-demo back                   Mark the last step undone and return to the screen before it
  product-demo end                    Close the browser

2. Write film.json from the log (.product-demo/explore/log.json), then rehearse it until it's right:
  product-demo voice <film.json>      Speak the film's lines, and show when each step's word lands
  product-demo rehearse <film.json>   A full run without the camera, with a still after each step

3. Shoot it, and cut the footage into a video:
  product-demo shoot <film.json>
  product-demo cut [footage] [--out video.mp4]
  product-demo review [footage | video.mp4]  An image of frames from across the video, to check it by

Set up: product-demo skills [dir]   Copy the skills into ~/.claude/skills (or dir) for your agent

Settings live in .product-demo/config.json: mode (just_do_it | ask), backdrop (halo | sky | violet), display (none | browser),
cursor (black | pink | lime | macos, or { style, size }), sound (true | false | { click }, default true),
keep (rehearsals and shoots kept per film, default 10), review (cut also makes the review image, default false).`

// Keys, such as ELEVENLABS_API_KEY: the environment, then the project's .env, then ~/.product-demo/.env.
loadKeys()

const EXPLORE = new Set([
  'look',
  'handles',
  'click',
  'fill',
  'select',
  'type',
  'press',
  'hover',
  'drag',
  'scroll',
  'upload',
  'visit',
  'wait',
  'back',
  'end',
])

// Explore commands take their own options, read by the browser process.
const raw = process.argv.slice(2)
const exploring = EXPLORE.has(raw[0] ?? '')
const { values, positionals } = parseArgs({
  args: exploring ? [] : raw,
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
})
const [command, ...args] = exploring ? raw : positionals
const [input] = args

const warn = (warnings: string[]) => {
  for (const warning of warnings) console.log(`Check: ${warning}`)
}

try {
  if (values.version) {
    console.log(version)
  } else if (command === '__serve' && input) {
    await serve(input)
  } else if (command === 'explore' && input) {
    console.log(await explore(input))
  } else if (command && EXPLORE.has(command)) {
    console.log(await send(command, args))
  } else if (command === 'rehearse' && input) {
    const config = await readConfig()
    const dir = await newRun('rehearsals', input, config.keep)
    const rehearsal = await rehearse(await readFilm(input), dir, config)
    warn(rehearsal.warnings)
    console.log(
      `Rehearsed ${rehearsal.film.steps.length} steps. Look at each still before shooting:`,
    )
    for (const still of rehearsal.stills) console.log(`  ${still.file}  ${still.step}`)
  } else if (command === 'shoot' && input) {
    const config = await readConfig()
    const film = await readFilm(input)
    let footage: Footage | undefined
    let dir = ''
    for (let attempt = 1; !footage; attempt++) {
      dir = await newRun('footage', input, config.keep)
      try {
        footage = await shoot(film, resolve(input), dir, config)
      } catch (error) {
        // A rehearsed film that fails on camera usually flaked (a slow request): one more
        // try. A decision someone has to make won't change on a second try.
        if (attempt > 1 || error instanceof NeedsDecision) throw error
        const why = error instanceof Error ? error.message : String(error)
        console.log(`The shoot failed, trying once more. ${why}`)
      }
    }
    warn(footage.warnings)
    console.log(`Shot ${footage.end.toFixed(1)}s into ${dir}. Next: product-demo cut ${dir}`)
  } else if (command === 'cut') {
    const config = await readConfig()
    const from = input ?? (await latestRun('footage', 'footage.json'))
    const out = values.out ?? join(from, 'video.mp4')
    const seconds = await cut(from, out, config)
    console.log(`Cut ${out} (${seconds.toFixed(1)}s)`)
    if (config.review) console.log(`Review it: ${await review(out, seconds)}`)
  } else if (command === 'voice' && input) {
    const config = await readConfig()
    const film = await readFilm(input)
    const spoken = await speakLines(
      film.steps.flatMap((s) => (s.say ? [s.say] : [])),
      config.voice,
    )
    // Each line, how long it runs, and when each step's word lands in it.
    let current: Spoken | undefined
    for (const [i, step] of film.steps.entries()) {
      if (step.say) {
        current = spoken.get(step.say)
        console.log(`Step ${i + 1} says (${current?.seconds.toFixed(1)}s): ${step.say}`)
      }
      if (step.on) {
        const at = current ? wordAt(current, step.on) : undefined
        console.log(
          at === undefined
            ? `Check: step ${i + 1} lands on "${step.on}", which isn't in the line being spoken.`
            : `Step ${i + 1} lands on "${step.on}" at ${at.toFixed(2)}s`,
        )
      }
    }
  } else if (command === 'init') {
    for (const line of await init()) console.log(line)
  } else if (command === 'key' && input) {
    const key = args[1] ?? (await readSecret(`Paste your ${input} key (it won't show): `))
    console.log(await saveKey(input, key))
  } else if (command === 'skills') {
    const to = input ?? join(homedir(), '.claude', 'skills')
    await cp(fileURLToPath(new URL('../skills', import.meta.url)), to, { recursive: true })
    console.log(`Copied the product-demo skills into ${to}. Start a new session to load them.`)
  } else if (command === 'review') {
    if (input?.endsWith('.mp4')) {
      console.log(await review(input))
    } else {
      const from = input ?? (await latestRun('footage', 'footage.json'))
      console.log(await review(join(from, 'video.mp4'), videoLength(await readFootage(from))))
    }
  } else {
    console.log(USAGE)
    if (command) process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}

#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  cut,
  explore,
  init,
  installSkills,
  setup,
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

const USAGE = `product-demo-agent-toolkit ${version}

0. Get the project ready, and see what's missing (run it first):
  product-demo-agent-toolkit init
  product-demo-agent-toolkit key elevenlabs         Save a voice provider's key for every project (asks for it, hidden, or reads it piped in)

1. Explore the app, off camera, to learn it and find the path. Every action is logged, pinned.
   Name an element by its ref from look (@e12), or by a point on look's screenshot (640,320):
  product-demo-agent-toolkit explore <url>          Open the app in a background browser and show the screen
  product-demo-agent-toolkit look [--all]           What's on screen as an accessibility tree with refs, and a screenshot
  product-demo-agent-toolkit handles                The small grab handles on screen (resize, rotate, sliders) and where they are
  product-demo-agent-toolkit click <el> [--double] [--right] [--with Shift+Meta] [--at 0.9,0.5]
  product-demo-agent-toolkit fill <el> "text"       Click into a field and type, replacing what's there
  product-demo-agent-toolkit select <el> "option"   Choose an option in a native <select>
  product-demo-agent-toolkit type "text"            Type where the caret is, like "@Sam" to open a mention menu
  product-demo-agent-toolkit press <key>            Press a key, like Enter or Meta+K
  product-demo-agent-toolkit hover <el> [--for 2]   Rest the pointer on an element, to show it or open what it reveals
  product-demo-agent-toolkit drag <el> <el> [--at x,y] [--to-at x,y]
  product-demo-agent-toolkit scroll up|down [--in <el>] [--by 600]
  product-demo-agent-toolkit upload <file> [<el>]   Upload a file through the control that opens the picker
  product-demo-agent-toolkit visit <path>
  product-demo-agent-toolkit wait "text" [--gone] | <seconds>
  product-demo-agent-toolkit back                   Mark the last step undone and return to the screen before it
  product-demo-agent-toolkit end                    Close the browser

2. Write film.json from the log (.product-demo/explore/log.json), then rehearse it until it's right:
  product-demo-agent-toolkit voice <film.json>      Speak the film's lines, and show when each step's word lands
  product-demo-agent-toolkit rehearse <film.json>   A full run without the camera, with a still after each step

3. Shoot it, and cut the footage into a video:
  product-demo-agent-toolkit shoot <film.json>
  product-demo-agent-toolkit cut [footage] [--out video.mp4]
  product-demo-agent-toolkit review [footage | video.mp4]  An image of frames from across the video, to check it by

Set up, once: product-demo-agent-toolkit setup   Install the command for good, and the skills for Claude Code
             product-demo-agent-toolkit skills [dir]   Copy just the skills into ~/.claude/skills (or dir)

Settings live in .product-demo/config.json: mode (just_do_it | ask), backdrop (sky, any of the 22 in library/backdrops, a hex, or a path to your own .jpg/.png/.webp), display (none | browser),
cursor (black | pink | lime | macos | a hex | a path to your own .svg, or { style, size, label, tip }), sound (true | false | { click }, default true),
music (false | lofi | a path to an audio file, or { track, volume }, default false),
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
const parsed = (() => {
  try {
    return parseArgs({
      args: exploring ? [] : raw,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n\n${USAGE}`)
    process.exit(1)
  }
})()
const { values, positionals } = parsed
const help = values.help || (exploring && raw.some((arg) => arg === '--help' || arg === '-h'))
const [command, ...args] = exploring ? raw : positionals
const [input] = args

const warn = (warnings: string[]) => {
  for (const warning of warnings) console.log(`Check: ${warning}`)
}

try {
  if (help) {
    console.log(USAGE)
  } else if (values.version) {
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
    console.log(
      `Shot ${footage.end.toFixed(1)}s into ${dir}. Next: product-demo-agent-toolkit cut ${dir}`,
    )
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
    if (args[1])
      throw new Error(
        `Don't put the key on the command line. Run product-demo-agent-toolkit key ${input} and paste it, or pipe it in.`,
      )
    const key = await readSecret(`Paste your ${input} key (it won't show): `)
    console.log(await saveKey(input, key))
  } else if (command === 'setup') {
    for (const line of await setup()) console.log(line)
  } else if (command === 'skills') {
    const to = await installSkills(input)
    console.log(`Copied the product-demo skills into ${to}. Start a new session to load them.`)
  } else if (command === 'review') {
    if (input?.endsWith('.mp4')) {
      if (!existsSync(input)) throw new Error(`There's no video at ${input}.`)
      console.log(await review(input))
    } else {
      const from = input ?? (await latestRun('footage', 'footage.json'))
      const video = join(from, 'video.mp4')
      if (!existsSync(video)) {
        throw new Error(
          `${from} hasn't been cut yet: product-demo-agent-toolkit cut ${from}. If it was cut to another file, review that: product-demo-agent-toolkit review <video.mp4>`,
        )
      }
      console.log(await review(video, videoLength(await readFootage(from))))
    }
  } else {
    console.log(USAGE)
    if (command) process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}

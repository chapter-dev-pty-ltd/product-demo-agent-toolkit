#!/usr/bin/env node
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  cut,
  explore,
  readFootage,
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
  version,
  type Footage,
} from './index.ts'

const USAGE = `product-demo ${version}

1. Explore the app, off camera, to learn it and find the path. Every action is logged, pinned:
  product-demo explore <url>          Open the app in a background browser and show the screen
  product-demo look [--all]           What's on screen as an accessibility tree with refs, and a screenshot
  product-demo click <ref>            Click an element by its ref from look, like @e12
  product-demo fill <ref> "text"      Type into a field
  product-demo press <key>            Press a key, like Enter
  product-demo scroll up|down
  product-demo visit <path>
  product-demo wait "text"|<seconds>  Wait for text to appear, or add a pause
  product-demo back                   Mark the last step undone and return to the screen before it
  product-demo end                    Close the browser

2. Write film.json from the log (.product-demo/explore/log.json), then rehearse it until it's right:
  product-demo rehearse <film.json>   A full run without the camera, with a still after each step

3. Shoot it, and cut the footage into a video:
  product-demo shoot <film.json>
  product-demo cut [footage] [--out video.mp4]
  product-demo review [footage]      An image of frames from across the video, to check it by

Settings live in .product-demo/config.json: mode (ask | just_do_it), backdrop (halo | sky | violet),
keep (rehearsals and shoots kept per film, default 10), review (cut also makes the review image, default false).`

const EXPLORE = new Set([
  'look',
  'click',
  'fill',
  'press',
  'scroll',
  'visit',
  'wait',
  'back',
  'end',
])

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    all: { type: 'boolean' },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
})
const [command, ...args] = positionals
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
    console.log(await send(command, values.all ? ['--all'] : args))
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
        footage = await shoot(film, dir, config)
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
  } else if (command === 'review') {
    const from = input ?? (await latestRun('footage', 'footage.json'))
    const video = join(from, 'video.mp4')
    console.log(await review(video, videoLength(await readFootage(from))))
  } else {
    console.log(USAGE)
    if (command) process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}

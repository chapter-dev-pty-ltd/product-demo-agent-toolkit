#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { join } from 'node:path'
import {
  cut,
  explore,
  latestFootage,
  newFootage,
  readConfig,
  readFilm,
  record,
  send,
  serve,
  version,
} from './index.ts'

const USAGE = `product-demo ${version}

Explore an app, off camera. Each action is added, pinned, to a draft film:
  product-demo explore <url>          Open the app in a background browser and show the screen
  product-demo look                   The screen as an accessibility tree with refs, and a screenshot
  product-demo click <ref>            Click an element by its ref from look, like @e12
  product-demo fill <ref> "text"      Type into a field
  product-demo press <key>            Press a key, like Enter
  product-demo scroll up|down
  product-demo visit <path>
  product-demo wait "text"|<seconds>  Wait for text to appear, or add a pause
  product-demo end [--out film.json]  Close the browser and write the film

Film it:
  product-demo record <film.json>                  Perform the film on camera; prints where the footage went
  product-demo cut [footage] [--out video.mp4]     Cut footage (the latest, by default) into a video

Settings live in .product-demo/config.json: mode (ask | just_do_it), backdrop (halo | sky | violet),
footage.keep (recordings kept per film, default 10).`

const EXPLORE = new Set(['look', 'click', 'fill', 'press', 'scroll', 'visit', 'wait', 'end'])

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
})
const [command, ...args] = positionals
const [input] = args

try {
  if (values.version) {
    console.log(version)
  } else if (command === '__serve' && input) {
    await serve(input)
  } else if (command === 'explore' && input) {
    console.log(await explore(input))
  } else if (command && EXPLORE.has(command)) {
    console.log(await send(command, command === 'end' && values.out ? [values.out] : args))
  } else if (command === 'record' && input) {
    const config = await readConfig()
    const out = values.out ?? (await newFootage(input, config.footage.keep))
    const footage = await record(await readFilm(input), out, config)
    for (const note of footage.notes) console.log(`Note: ${note}`)
    console.log(`Recorded ${footage.frames.length} frames, ${footage.end.toFixed(1)}s, into ${out}`)
  } else if (command === 'cut') {
    const from = input ?? (await latestFootage())
    const out = values.out ?? join(from, 'video.mp4')
    await cut(from, out, await readConfig())
    console.log(`Cut ${out}`)
  } else {
    console.log(USAGE)
    if (command) process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}

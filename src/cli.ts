#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { cut, readFilm, record, version } from './index.ts'

const USAGE = `product-demo ${version}

Usage:
  product-demo record <film.json> [--out footage]   Perform the film in a browser and keep the footage
  product-demo cut <footage> [--out demo.mp4]       Cut the footage into a video`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
})
const [command, input] = positionals

try {
  if (values.version) {
    console.log(version)
  } else if (command === 'record' && input) {
    const out = values.out ?? 'footage'
    const footage = await record(await readFilm(input), out)
    console.log(`Recorded ${footage.frames.length} frames, ${footage.end.toFixed(1)}s, into ${out}/`)
  } else if (command === 'cut' && input) {
    const out = values.out ?? 'demo.mp4'
    await cut(input, out)
    console.log(`Cut ${out}`)
  } else {
    console.log(USAGE)
    if (command) process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
